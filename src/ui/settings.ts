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
