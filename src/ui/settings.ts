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
 * high-fidelity (Steam Audio) engine choice, L/R swap, and reset-progress. The pure persistence lives
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

  /**
   * Room CLUTTER (0..1): adds scattering + absorption to tame a hard, fluttery room
   * (affects BOTH audio engines). Applies on the next level load. Setter persists.
   */
  getClutter: () => number;
  setClutter: (v: number) => void;

  /**
   * High-fidelity audio (Steam Audio) engine on/off. The setter PERSISTS the
   * preference; it does not hot-swap the live audio graph (the backend is built at
   * level start), so the change applies on the next level / restart.
   */
  getSteamEngine: () => boolean;
  setSteamEngine: (on: boolean) => void;

  /**
   * Steam HRTF choice: ON ⇒ our measured SADIE HRTF in Steam; OFF ⇒ Steam's generic.
   * Only affects the Steam path; baked at world creation, so Apply rebuilds to switch.
   */
  getSteamSofaHrtf: () => boolean;
  setSteamSofaHrtf: (on: boolean) => void;

  /**
   * Steam reflected-field Ambisonic order (1..3): higher = sharper reflection
   * directionality, more CPU. Baked at world creation, so Apply rebuilds to switch.
   */
  getSteamReflectionOrder: () => number;
  setSteamReflectionOrder: (order: number) => void;

  /**
   * Steam per-source REFLECTION WET level in [0,1]. Only affects the Steam Audio
   * engine; Apply rebuilds the sources so the baked reflected `wet` changes.
   */
  getSteamReflectionWet: () => number;
  setSteamReflectionWet: (v: number) => void;
  /** Steam REFLECTION BUS level in [0,1] (bus wet + reflect send); live on Apply. */
  getSteamReflectionBus: () => number;
  setSteamReflectionBus: (v: number) => void;
  /** Steam REVERB BUS level in [0,1] (bus wet + reverb send); live on Apply. */
  getSteamReverbBus: () => number;
  setSteamReverbBus: (v: number) => void;

  /**
   * Apply the Steam Audio settings (engine on/off + reverb/reflection levels) to the
   * RUNNING level NOW, without restarting it. Optional: when absent the "Apply now"
   * button is hidden (the changes still apply on the next level start). main.ts wires
   * it to a LIGHT live level change (engine unchanged) or a HEAVY backend rebuild
   * (engine toggled); it announces the outcome itself.
   */
  applySteamNow?: () => void;

  /** L/R channel swap on/off. */
  getSwap: () => boolean;
  setSwap: (on: boolean) => void;

  /**
   * Per-user multi-band LOUDNESS-EQ calibration. `runLoudnessEq` launches the SAME
   * equal-loudness flow the onboarding calibration uses, standalone, applying +
   * persisting the result; the panel closes while it runs and the host reopens it.
   * `hasLoudnessEq`/`clearLoudnessEq` drive the "reset EQ" affordance. OPTIONAL: when
   * `runLoudnessEq` is absent the whole block is hidden (no live audio graph yet).
   */
  runLoudnessEq?: () => void;
  hasLoudnessEq?: () => boolean;
  clearLoudnessEq?: () => void;

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
 * A 0..100% range row backed by a 0..1 value. `onInput` receives the 0..1 level;
 * announcements are throttled so dragging doesn't machine-gun the live region.
 */
function levelRow(
  id: string,
  labelText: string,
  ariaLabel: string,
  value01: number,
  say: (m: string) => void,
  announce: (pct: number) => string,
  onInput: (v01: number) => void,
): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'settings-row';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'range';
  input.id = id;
  input.min = '0';
  input.max = '100';
  input.step = '1';
  input.value = String(Math.round(value01 * 100));
  input.setAttribute('aria-label', ariaLabel);
  let timer: ReturnType<typeof setTimeout> | null = null;
  input.addEventListener('input', () => {
    const pct = Number(input.value);
    onInput(pct / 100);
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(() => say(announce(pct)), 200);
  });
  wrap.append(label, input);
  return wrap;
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

  // --- Room clutter (both engines) ---
  // Adds scattering + absorption to tame a hard, fluttery/echoey room. Baked into the
  // room geometry at load, so it applies on the NEXT level (re-enter to hear a change).
  dialog.append(levelRow(
    'set-clutter',
    'Room clutter (softer echoes)',
    'Room clutter percent',
    hooks.getClutter(),
    hooks.say,
    (pct) => `Room clutter ${pct} percent. Applies on the next level.`,
    (v) => hooks.setClutter(v),
  ));

  // --- High-fidelity audio engine (Steam Audio) ---
  // Persisted preference, NOT a live hot-swap: the audio backend is constructed at
  // level start, so we announce that the change applies on the next level/restart.
  const engine = checkboxRow('High-fidelity audio (Steam Audio)', hooks.getSteamEngine(), (on) => {
    hooks.setSteamEngine(on);
    hooks.say(on
      ? 'High-fidelity audio on. Press Apply Steam settings to switch the running level, or it applies on the next one.'
      : 'High-fidelity audio off. Press Apply Steam settings to switch the running level, or it applies on the next one.');
  });
  dialog.append(engine.row);

  // --- Steam Audio HRTF: our SADIE vs Steam's generic ---
  // Baked at world creation, so (like the engine toggle) it applies on the next level
  // or via Apply (which rebuilds the backend). Only meaningful when Steam is on.
  const sofa = checkboxRow('Use our SADIE HRTF in Steam (vs generic)', hooks.getSteamSofaHrtf(), (on) => {
    hooks.setSteamSofaHrtf(on);
    hooks.say(on
      ? 'Steam will use our SADIE HRTF. Press Apply Steam settings to switch the running level, or it applies on the next one.'
      : 'Steam will use its generic HRTF. Press Apply Steam settings to switch the running level, or it applies on the next one.');
  });
  dialog.append(sofa.row);

  // --- Steam reflected-field Ambisonic order (1..3) ---
  // Higher order = sharper reflection directionality (order-1 is "blobby"), more CPU.
  // Baked at world creation, so it applies on the next level or via Apply (rebuild).
  {
    const row = document.createElement('label');
    row.className = 'settings-row';
    const span = document.createElement('span');
    span.textContent = 'Steam reflection sharpness (Ambisonic order)';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Steam reflection Ambisonic order');
    for (const [val, label] of [[1, '1 — soft / least CPU'], [2, '2 — sharper'], [3, '3 — sharpest / most CPU']] as const) {
      const opt = document.createElement('option');
      opt.value = String(val);
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = String(hooks.getSteamReflectionOrder());
    sel.addEventListener('change', () => {
      const v = Number(sel.value);
      hooks.setSteamReflectionOrder(v);
      hooks.say(`Steam reflection order ${v}. Press Apply Steam settings to switch the running level, or it applies on the next one.`);
    });
    row.append(span, sel);
    dialog.append(row);
  }

  // --- Steam Audio reflection / bus levels (THREE knobs) ---
  // These ONLY affect the Steam Audio engine. Each is a 0..100% of the CURRENT (full)
  // Steam level, defaulting to 100% (today's behavior); lower them to localize rooms
  // that otherwise sound "everywhere". Minimum on all three = truly no reflected/reverb
  // energy. Apply: the per-source reflection level rebuilds the sources; the two bus
  // levels are live.
  dialog.append(levelRow(
    'set-steam-reflection-wet',
    'Steam reflection level (per-source)',
    'Steam reflection level per-source percent',
    hooks.getSteamReflectionWet(),
    hooks.say,
    (pct) => `Steam reflection level ${pct} percent. Press Apply Steam settings to hear it now.`,
    (v) => hooks.setSteamReflectionWet(v),
  ));
  dialog.append(levelRow(
    'set-steam-reflection-bus',
    'Steam reflection bus level',
    'Steam reflection bus level percent',
    hooks.getSteamReflectionBus(),
    hooks.say,
    (pct) => `Steam reflection bus ${pct} percent. Press Apply Steam settings to hear it now.`,
    (v) => hooks.setSteamReflectionBus(v),
  ));
  dialog.append(levelRow(
    'set-steam-reverb-bus',
    'Steam reverb bus level',
    'Steam reverb bus level percent',
    hooks.getSteamReverbBus(),
    hooks.say,
    (pct) => `Steam reverb bus ${pct} percent. Press Apply Steam settings to hear it now.`,
    (v) => hooks.setSteamReverbBus(v),
  ));

  // --- Apply Steam settings to the running level NOW (live hot-swap) ---
  // Per-control handlers above only PERSIST; this button is what makes the Steam
  // engine + reverb/reflection changes live on the current level. Shown only when the
  // host wired `applySteamNow` (i.e. a level is running through setupSettings).
  if (hooks.applySteamNow) {
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'settings-apply-steam';
    apply.textContent = 'Apply Steam settings now';
    apply.addEventListener('click', () => hooks.applySteamNow?.());
    dialog.append(apply);
  }

  // --- L/R channel swap ---
  const swap = checkboxRow('Swap left and right channels', hooks.getSwap(), (on) => {
    hooks.setSwap(on);
    hooks.say(on ? 'Left and right channels swapped.' : 'Left and right channels normal.');
  });
  dialog.append(swap.row);

  // --- Loudness / hearing EQ calibration (per-user multi-band) ---
  // Re-runnable equal-loudness check; the same flow runs once during onboarding. The
  // block is shown only when the host wired a live audio graph (runLoudnessEq).
  let eqStatus: HTMLElement | null = null;
  let clearEqBtn: HTMLButtonElement | null = null;
  const refreshEq = () => {
    if (!eqStatus) return;
    const has = hooks.hasLoudnessEq?.() ?? false;
    eqStatus.textContent = has
      ? 'A personal loudness correction is active.'
      : 'No loudness correction yet.';
    if (clearEqBtn) clearEqBtn.hidden = !has;
  };
  if (hooks.runLoudnessEq) {
    const group = document.createElement('div');
    group.className = 'settings-eq';
    eqStatus = document.createElement('p');
    eqStatus.className = 'settings-eq-status';

    const run = document.createElement('button');
    run.type = 'button';
    run.className = 'settings-eq-run';
    run.textContent = 'Re-run hearing / EQ calibration';
    run.addEventListener('click', () => hooks.runLoudnessEq?.());

    clearEqBtn = document.createElement('button');
    clearEqBtn.type = 'button';
    clearEqBtn.className = 'settings-eq-clear';
    clearEqBtn.textContent = 'Reset loudness EQ';
    clearEqBtn.addEventListener('click', () => {
      hooks.clearLoudnessEq?.();
      hooks.alert('Loudness EQ reset to flat.');
      refreshEq();
    });

    refreshEq();
    group.append(eqStatus, run, clearEqBtn);
    dialog.append(group);
  }

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
    engine.input.checked = hooks.getSteamEngine();
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
      engine.input.checked = hooks.getSteamEngine();
      swap.input.checked = hooks.getSwap();
      refreshEq();
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
