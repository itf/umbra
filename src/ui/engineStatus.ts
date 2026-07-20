/**
 * ENGINE STATUS LINE — a small, always-present readout at the bottom of the page
 * telling you which spatial-audio engine is ACTUALLY live, and — crucially — WHY,
 * when the high-fidelity (Steam Audio) engine was wanted but we fell back to our own.
 *
 * The Steam path can silently fall back to our engine on any init failure (no WASM,
 * decode error, unsupported browser, out-of-memory on a phone). That fallback used to
 * be an invisible `console.warn`, so on a device where Steam won't load you'd get the
 * cheaper-but-heavier engine with no idea why. This surfaces it.
 *
 * Pure DOM + a tiny state enum; no audio deps, so it's trivially testable.
 */

export type EngineKind = 'steam' | 'ours';

export interface EngineStatus {
  /** The engine actually running. */
  engine: EngineKind;
  /** True iff the user WANTED Steam but we ended up on 'ours' (an involuntary fallback). */
  fellBack: boolean;
  /** Human-readable reason for a fallback (empty when not a fallback). */
  reason: string;
}

/** PURE: the label + detail shown for a given status. Exported for unit tests. */
export function statusText(s: EngineStatus): { label: string; detail: string; warn: boolean } {
  if (s.engine === 'steam') {
    return { label: 'High-fidelity audio (Steam Audio)', detail: '', warn: false };
  }
  if (s.fellBack) {
    return {
      label: 'Standard audio — high-fidelity unavailable here',
      detail: s.reason ? `Reason: ${s.reason}` : '',
      warn: true,
    };
  }
  return { label: 'Standard audio', detail: '', warn: false };
}

/**
 * Mount a fixed status line at the bottom of `parent` (default document.body) and
 * return an `update` handle. Idempotent: re-mounting reuses the existing element so
 * calling this on every level start doesn't stack lines.
 */
export function mountEngineStatus(parent: HTMLElement = document.body): {
  update: (s: EngineStatus) => void;
  element: HTMLElement;
} {
  const ID = 'engine-status';
  let el = document.getElementById(ID);
  if (!el) {
    el = document.createElement('div');
    el.id = ID;
    // Non-interactive, out of the tab order, but readable by AT via role=status so a
    // screen-reader user is told (politely) which engine is live / why it fell back.
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    parent.appendChild(el);
  }
  const element = el;

  const update = (s: EngineStatus) => {
    const { label, detail, warn } = statusText(s);
    element.textContent = detail ? `${label}. ${detail}` : label;
    element.dataset.engine = s.engine;
    element.dataset.fellBack = String(s.fellBack);
    // A data attribute drives styling (see styles.css #engine-status[data-warn]).
    element.dataset.warn = String(warn);
  };

  return { update, element };
}
