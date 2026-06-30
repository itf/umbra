/**
 * Tiny screen-routing layer for the main app.
 *
 * The app is a set of full-screen "screens" (picker, a level's Begin screen, the
 * progress screen). This module owns the PURE mapping between a screen + optional
 * level id and the URL that represents it, plus its inverse — so the URL is the
 * single source of truth for "where am I", reload restores the same place, and the
 * browser Back button (popstate) can drive the right screen.
 *
 * The pure functions (`screenToUrl` / `urlToScreen`) carry NO DOM and NO history
 * side-effects, so they're unit-testable in isolation. The thin `Router` class
 * wires them to `history.pushState` / `popstate`.
 *
 * Onboarding screens (calibration, tutorial) are deliberately NOT routes — they're
 * transient gates in front of a level's Begin screen, so they never get their own
 * history entry (mirrors the gateOnboarding design in main.ts).
 */

/** The routable screens. `level` carries an id (builtin id, or 'current'). */
export type ScreenName = 'picker' | 'level' | 'progress';

export interface ScreenState {
  screen: ScreenName;
  /** Present iff screen === 'level': the level id to (re)load. */
  level?: string;
}

/**
 * PURE: build the URL search string (e.g. "?level=foo") for a screen state.
 * - picker  → "" (the clean default, "/")
 * - level   → "?level=<id>" (the existing deep-link, unchanged)
 * - progress→ "?screen=progress"
 * Extra params already on the page (engine, hrtf, debug, companion…) are PRESERVED
 * by threading the current search in; only the routing params are rewritten.
 */
export function screenToUrl(state: ScreenState, currentSearch = ''): string {
  const params = new URLSearchParams(currentSearch);
  // Clear the routing-owned params; everything else (engine, debug…) is kept.
  params.delete('level');
  params.delete('screen');
  if (state.screen === 'level' && state.level) {
    params.set('level', state.level);
  } else if (state.screen === 'progress') {
    params.set('screen', 'progress');
  }
  const q = params.toString();
  return q ? `?${q}` : '';
}

/**
 * PURE: parse a URL search string back into the screen state it represents.
 * `?level=<id>` → a level (the deep-link); `?screen=progress` → progress; anything
 * else (including bare "/") → the picker. `?level` wins over `?screen` if both are
 * somehow present (a level is the more specific intent).
 */
export function urlToScreen(search: string): ScreenState {
  const params = new URLSearchParams(search);
  const level = params.get('level');
  if (level) return { screen: 'level', level };
  if (params.get('screen') === 'progress') return { screen: 'progress' };
  return { screen: 'picker' };
}

/** Whether two screen states denote the same place (so we don't push dupes). */
export function sameScreen(a: ScreenState, b: ScreenState): boolean {
  return a.screen === b.screen && (a.level ?? null) === (b.level ?? null);
}

export interface RouterOptions {
  /** Apply a screen state to the DOM (show/hide screens, render, focus, announce). */
  render: (state: ScreenState, viaPopstate: boolean) => void;
  /** Indirection for tests; defaults to the real History/location. */
  history?: History;
  location?: Pick<Location, 'search'>;
  /** Only `addEventListener('popstate', …)` is used; typed loosely for test fakes. */
  window?: { addEventListener: (type: string, listener: () => void) => void };
}

/**
 * Drives screen transitions through the History API. `go(state)` renders the
 * screen AND pushes a matching history entry; a `popstate` (Back/Forward) renders
 * the screen for the new URL WITHOUT pushing (it's already in history). `start()`
 * renders the screen for the initial URL.
 */
export class Router {
  private render: RouterOptions['render'];
  private hist: History;
  private loc: Pick<Location, 'search'>;

  constructor(opts: RouterOptions) {
    this.render = opts.render;
    this.hist = opts.history ?? window.history;
    this.loc = opts.location ?? window.location;
    const win = opts.window ?? window;
    win.addEventListener('popstate', () => {
      this.render(urlToScreen(this.loc.search), true);
    });
  }

  /** The screen the current URL denotes (used to seed the app on load). */
  current(): ScreenState {
    return urlToScreen(this.loc.search);
  }

  /**
   * Navigate to `state`: push a history entry with its URL (unless it's already
   * the current URL — avoids dup entries), then render it. `replace` swaps the
   * current entry instead of pushing (used for the initial load so Back doesn't
   * land on a blank pre-app entry).
   */
  go(state: ScreenState, opts: { replace?: boolean } = {}): void {
    const url = screenToUrl(state, this.loc.search) || location.pathname;
    const cur = this.current();
    if (opts.replace) {
      this.hist.replaceState({ screen: state.screen, level: state.level }, '', url);
    } else if (!sameScreen(cur, state)) {
      this.hist.pushState({ screen: state.screen, level: state.level }, '', url);
    } else {
      // Same place — keep the URL but don't stack a duplicate entry.
      this.hist.replaceState({ screen: state.screen, level: state.level }, '', url);
    }
    this.render(state, false);
  }

  /** Render the screen for the initial URL, replacing the entry so it's canonical. */
  start(): void {
    const state = this.current();
    this.go(state, { replace: true });
  }
}
