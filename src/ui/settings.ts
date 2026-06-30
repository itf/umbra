/**
 * Settings panel (6C) — a spoken, fully keyboard/screen-reader-operable surface
 * for the audio mix + preferences. Built from standard labeled HTML controls
 * (real <label> + <input>/<button>), focus-managed (focus moves in on open,
 * Escape/Close returns it to the opener), and every change is ANNOUNCED via the
 * caller's live-region `say`/`alert` so an eyes-free player hears the effect.
 *
 * This module owns ONLY the DOM wiring + focus/announce behaviour. Every control
 * is wired to an existing hook passed in by main.ts (the single source of truth
 * for applying + persisting each pref): master volume, companion voice, the
 * "getting warmer" cue, L/R swap, and reset-progress. The pure persistence lives
 * in settingsStore.ts / onboardingStore.ts.
 */

export interface SettingsHooks {
  /** Polite live-region announce. */
  say: (msg: string) => void;
  /** Assertive live-region announce (used for the reset confirm/result). */
  alert: (msg: string) => void;

  /** Current master volume in [0,1]; setter applies (smoothed) + persists. */
  getMasterVolume: () => number;
  setMasterVolume: (v: number) => void;

  /** Companion voice on/off (onboardingStore-backed). */
  getCompanion: () => boolean;
  setCompanion: (on: boolean) => void;

  /** "Getting warmer" proximity cue on/off. */
  getWarmerCue: () => boolean;
  setWarmerCue: (on: boolean) => void;

  /** L/R channel swap on/off. */
  getSwap: () => boolean;
  setSwap: (on: boolean) => void;

  /** Wipe trainer + streak + onboarding/primer flags; returns after clearing. */
  resetProgress: () => void;

  // --- Spoken voice (Web Speech / TTS), 8A. OPTIONAL: when `ttsSupported()` is
  // false the whole block is hidden (graceful fallback to live-region-only). ---
  /** Whether a real speech engine exists in this browser. */
  ttsSupported: () => boolean;
  /** TTS on/off (default OFF, opt-in). */
  getTtsEnabled: () => boolean;
  setTtsEnabled: (on: boolean) => void;
  /** Voices to offer in the picker (may be empty until the engine loads them). */
  availableVoices: () => { name: string; lang: string }[];
  /** Preferred voice name ('' ⇒ auto-pick). */
  getTtsVoice: () => string;
  setTtsVoice: (name: string) => void;
  /** Speech rate (~0.5..2). */
  getTtsRate: () => number;
  setTtsRate: (r: number) => void;
  /** Speech pitch (0..2). */
  getTtsPitch: () => number;
  setTtsPitch: (p: number) => void;
  /** Speak a sample line so the user can audition the voice/rate/pitch. */
  testVoice: (line: string) => void;
}

/** Public handle so the opener (a key / button) can toggle the panel. */
export interface SettingsPanel {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  toggle: () => void;
}

function checkboxRow(labelText: string, checked: boolean, onChange: (on: boolean) => void): {
  row: HTMLElement;
  input: HTMLInputElement;
} {
  const label = document.createElement('label');
  label.className = 'settings-row';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const span = document.createElement('span');
  span.textContent = labelText;
  label.append(input, span);
  return { row: label, input };
}

/**
 * Mount the settings panel into `host` (the #settings-screen section) and return a
 * handle. The panel is built once; open()/close() toggle visibility + focus. The
 * panel is hidden until opened.
 */
export function mountSettings(host: HTMLElement, hooks: SettingsHooks): SettingsPanel {
  host.innerHTML = '';
  host.hidden = true;

  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Settings');
  dialog.className = 'settings-dialog';

  // Re-sync the TTS controls from prefs on open (set when the TTS block exists).
  let ttsRefresh: (() => void) | null = null;

  const heading = document.createElement('h2');
  heading.textContent = 'Settings';
  heading.tabIndex = -1; // focus target on open (announced by SRs)
  dialog.append(heading);

  // --- Master volume slider (0..100%) ---
  const volWrap = document.createElement('div');
  volWrap.className = 'settings-row';
  const volLabel = document.createElement('label');
  volLabel.htmlFor = 'set-master-volume';
  volLabel.textContent = 'Master volume';
  const vol = document.createElement('input');
  vol.type = 'range';
  vol.id = 'set-master-volume';
  vol.min = '0';
  vol.max = '100';
  vol.step = '1';
  vol.value = String(Math.round(hooks.getMasterVolume() * 100));
  vol.setAttribute('aria-label', 'Master volume percent');
  // Throttle spoken announcements so dragging doesn't machine-gun the live region.
  let volAnnTimer: ReturnType<typeof setTimeout> | null = null;
  vol.addEventListener('input', () => {
    const pct = Number(vol.value);
    hooks.setMasterVolume(pct / 100);
    if (volAnnTimer != null) clearTimeout(volAnnTimer);
    volAnnTimer = setTimeout(() => hooks.say(`Master volume ${pct} percent.`), 200);
  });
  volWrap.append(volLabel, vol);
  dialog.append(volWrap);

  // --- Companion voice ---
  const companion = checkboxRow('Companion voice', hooks.getCompanion(), (on) => {
    hooks.setCompanion(on);
    hooks.say(on ? 'Companion voice on.' : 'Companion voice off.');
  });
  dialog.append(companion.row);

  // --- Getting-warmer cue ---
  const warmer = checkboxRow('“Getting warmer” cue', hooks.getWarmerCue(), (on) => {
    hooks.setWarmerCue(on);
    hooks.say(on ? 'Getting warmer cue on.' : 'Getting warmer cue off.');
  });
  dialog.append(warmer.row);

  // --- L/R channel swap ---
  const swap = checkboxRow('Swap left and right channels', hooks.getSwap(), (on) => {
    hooks.setSwap(on);
    hooks.say(on ? 'Left and right channels swapped.' : 'Left and right channels normal.');
  });
  dialog.append(swap.row);

  // --- Spoken voice (Web Speech / TTS), 8A ---
  // Shown ONLY when the browser supports speechSynthesis; otherwise omitted entirely
  // so the panel degrades gracefully to live-region-only (no dead controls).
  const SAMPLE = 'This is the spoken voice. You can adjust the rate and pitch.';
  if (hooks.ttsSupported()) {
    const ttsGroup = document.createElement('div');
    ttsGroup.className = 'settings-tts';

    // Voice / rate / pitch sub-controls live in a container that's only shown when
    // TTS is enabled (keeps the panel quiet when the feature is off).
    const ttsControls = document.createElement('div');
    ttsControls.className = 'settings-tts-controls';

    // Voice picker.
    const voiceWrap = document.createElement('div');
    voiceWrap.className = 'settings-row';
    const voiceLabel = document.createElement('label');
    voiceLabel.htmlFor = 'set-tts-voice';
    voiceLabel.textContent = 'Voice';
    const voiceSel = document.createElement('select');
    voiceSel.id = 'set-tts-voice';
    voiceSel.setAttribute('aria-label', 'Spoken voice selection');
    const populateVoices = () => {
      const current = hooks.getTtsVoice();
      voiceSel.innerHTML = '';
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = 'Automatic (default voice)';
      voiceSel.append(auto);
      for (const v of hooks.availableVoices()) {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.lang})`;
        voiceSel.append(opt);
      }
      voiceSel.value = current;
    };
    populateVoices();
    voiceSel.addEventListener('change', () => {
      hooks.setTtsVoice(voiceSel.value);
      hooks.say('Voice changed.');
      hooks.testVoice(SAMPLE); // audition the new voice
    });
    voiceWrap.append(voiceLabel, voiceSel);
    ttsControls.append(voiceWrap);

    // Rate slider (0.5..2, step 0.1).
    const rateWrap = document.createElement('div');
    rateWrap.className = 'settings-row';
    const rateLabel = document.createElement('label');
    rateLabel.htmlFor = 'set-tts-rate';
    rateLabel.textContent = 'Voice speed';
    const rate = document.createElement('input');
    rate.type = 'range';
    rate.id = 'set-tts-rate';
    rate.min = '0.5';
    rate.max = '2';
    rate.step = '0.1';
    rate.value = String(hooks.getTtsRate());
    rate.setAttribute('aria-label', 'Voice speed');
    let rateTimer: ReturnType<typeof setTimeout> | null = null;
    rate.addEventListener('input', () => {
      hooks.setTtsRate(Number(rate.value));
      if (rateTimer != null) clearTimeout(rateTimer);
      rateTimer = setTimeout(() => {
        hooks.say(`Voice speed ${rate.value}.`);
        hooks.testVoice(SAMPLE);
      }, 250);
    });
    rateWrap.append(rateLabel, rate);
    ttsControls.append(rateWrap);

    // Pitch slider (0..2, step 0.1).
    const pitchWrap = document.createElement('div');
    pitchWrap.className = 'settings-row';
    const pitchLabel = document.createElement('label');
    pitchLabel.htmlFor = 'set-tts-pitch';
    pitchLabel.textContent = 'Voice pitch';
    const pitch = document.createElement('input');
    pitch.type = 'range';
    pitch.id = 'set-tts-pitch';
    pitch.min = '0';
    pitch.max = '2';
    pitch.step = '0.1';
    pitch.value = String(hooks.getTtsPitch());
    pitch.setAttribute('aria-label', 'Voice pitch');
    let pitchTimer: ReturnType<typeof setTimeout> | null = null;
    pitch.addEventListener('input', () => {
      hooks.setTtsPitch(Number(pitch.value));
      if (pitchTimer != null) clearTimeout(pitchTimer);
      pitchTimer = setTimeout(() => {
        hooks.say(`Voice pitch ${pitch.value}.`);
        hooks.testVoice(SAMPLE);
      }, 250);
    });
    pitchWrap.append(pitchLabel, pitch);
    ttsControls.append(pitchWrap);

    // Explicit "test voice" button (in addition to the on-change auditions).
    const testBtn = document.createElement('button');
    testBtn.type = 'button';
    testBtn.className = 'settings-tts-test';
    testBtn.textContent = 'Test voice';
    testBtn.addEventListener('click', () => hooks.testVoice(SAMPLE));
    ttsControls.append(testBtn);

    const reflectTtsControls = (on: boolean) => {
      ttsControls.hidden = !on;
    };

    // Enable checkbox (the gate). When on, reveal the sub-controls + speak a sample.
    const tts = checkboxRow('Spoken voice (text-to-speech)', hooks.getTtsEnabled(), (on) => {
      hooks.setTtsEnabled(on);
      reflectTtsControls(on);
      hooks.say(on ? 'Spoken voice on.' : 'Spoken voice off.');
      if (on) {
        // Refresh in case the engine loaded voices late, then audition.
        populateVoices();
        hooks.testVoice(SAMPLE);
      }
    });
    reflectTtsControls(hooks.getTtsEnabled());

    ttsGroup.append(tts.row, ttsControls);
    dialog.append(ttsGroup);

    // Expose a refresh hook so open() can re-sync these controls from prefs.
    ttsRefresh = () => {
      tts.input.checked = hooks.getTtsEnabled();
      populateVoices();
      rate.value = String(hooks.getTtsRate());
      pitch.value = String(hooks.getTtsPitch());
      reflectTtsControls(hooks.getTtsEnabled());
    };
  }

  // --- Reset progress (two-step, spoken confirm) ---
  let resetArmed = false;
  let resetTimer: ReturnType<typeof setTimeout> | null = null;
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'settings-reset';
  reset.textContent = 'Reset progress';
  const disarmReset = () => {
    resetArmed = false;
    reset.textContent = 'Reset progress';
    if (resetTimer != null) { clearTimeout(resetTimer); resetTimer = null; }
  };
  reset.addEventListener('click', () => {
    if (!resetArmed) {
      resetArmed = true;
      reset.textContent = 'Confirm reset progress';
      hooks.alert('Reset all progress? This clears trainer results, your daily streak, ' +
        'and replays onboarding. Press Confirm reset to continue, or Escape to cancel.');
      if (resetTimer != null) clearTimeout(resetTimer);
      resetTimer = setTimeout(disarmReset, 8000); // auto-disarm so a stray press can't wipe later
      return;
    }
    disarmReset();
    hooks.resetProgress();
    // Reflect the cleared prefs back into the live controls.
    companion.input.checked = hooks.getCompanion();
    warmer.input.checked = hooks.getWarmerCue();
    swap.input.checked = hooks.getSwap();
    hooks.alert('Progress reset.');
  });
  dialog.append(reset);

  // --- Close ---
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'settings-close';
  close.textContent = 'Close settings';
  close.addEventListener('click', () => panel.close());
  dialog.append(close);

  host.append(dialog);

  let opener: HTMLElement | null = null;

  // Escape closes (or cancels an armed reset first), and a simple focus trap keeps
  // Tab inside the dialog while it's modal.
  dialog.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (resetArmed) { disarmReset(); hooks.say('Reset cancelled.'); return; }
      panel.close();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = dialog.querySelectorAll<HTMLElement>(
        'input, button, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });

  const panel: SettingsPanel = {
    open: () => {
      if (!host.hidden) return;
      opener = (document.activeElement as HTMLElement) ?? null;
      // Refresh control state from the hooks in case prefs changed elsewhere.
      vol.value = String(Math.round(hooks.getMasterVolume() * 100));
      companion.input.checked = hooks.getCompanion();
      warmer.input.checked = hooks.getWarmerCue();
      swap.input.checked = hooks.getSwap();
      ttsRefresh?.();
      disarmReset();
      host.hidden = false;
      hooks.say('Settings opened.');
      heading.focus();
    },
    close: () => {
      if (host.hidden) return;
      disarmReset();
      host.hidden = true;
      hooks.say('Settings closed.');
      opener?.focus?.();
      opener = null;
    },
    isOpen: () => !host.hidden,
    toggle: () => (host.hidden ? panel.open() : panel.close()),
  };

  return panel;
}
