/**
 * A VISIBLE full-screen loading overlay for the sighted player.
 *
 * The high-fidelity (Steam Audio) engine dynamically fetches a ~6 MB WASM bundle +
 * three.js on first use; on a phone or slow link that's several seconds during which
 * the Begin screen sits unchanged. Without a visible cue the game looks frozen. The
 * spoken `say()` cue only reaches the screen-reader live region, so a distinct VISIBLE
 * element is needed here. Shown right before the (possibly slow) engine build, hidden
 * the moment the game screen takes over (or on failure/fallback).
 *
 * Deliberately dependency-free (just DOM) so it's testable and can't itself be the
 * thing that's slow to load.
 */

let el: HTMLElement | null = null;
let msgEl: HTMLElement | null = null;

function ensure(): { root: HTMLElement; msg: HTMLElement } {
  // Reuse the cached node only if it's still attached to the document; if it was
  // removed (e.g. a re-render tore down body), fall through and remount.
  if (el && msgEl && el.isConnected) return { root: el, msg: msgEl };
  const root = document.createElement('div');
  root.id = 'loading-overlay';
  root.hidden = true;
  // Announce politely for AT too, but the on-screen text is the point here.
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');

  const spinner = document.createElement('div');
  spinner.className = 'loading-spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const msg = document.createElement('p');
  msg.className = 'loading-msg';

  root.appendChild(spinner);
  root.appendChild(msg);
  document.body.appendChild(root);
  el = root;
  msgEl = msg;
  return { root, msg };
}

/** Show the overlay with a message. Idempotent; updates the message if already shown. */
export function showLoading(message: string): void {
  const { root, msg } = ensure();
  msg.textContent = message;
  root.hidden = false;
}

/** Update the visible message without toggling visibility. */
export function setLoadingMessage(message: string): void {
  const { msg } = ensure();
  msg.textContent = message;
}

/** Hide the overlay. Safe to call when it was never shown. */
export function hideLoading(): void {
  if (el) el.hidden = true;
}
