/**
 * Tiny screen-routing layer for the main app.
 *
 * The app is a set of full-screen "screens" (landing/about, picker, a level's Begin
 * screen, the progress screen). This module owns the PURE mapping between a screen +
 * optional level id and the URL (a REAL PATH) that represents it, plus its inverse —
 * so the URL is the single source of truth for "where am I", reload restores the same
 * place, and the browser Back button (popstate) can drive the right screen.
 *
 * The pure functions (`screenToUrl` / `urlToScreen`) carry NO DOM and NO history
 * side-effects, so they're unit-testable in isolation. The thin `Router` class
 * wires them to `history.pushState` / `popstate`.
 *
 * Routes (relative to Vite's BASE_URL, which is `/` in dev but may be a sub-path in
 * production — every path is built/parsed through `BASE`, so it works under any base):
 *   /            → landing / about page
 *   /play        → the level picker
 *   /level/<id>  → a specific level's Begin screen (the deep-link)
 *   /progress    → the read-only progress screen
 * Non-routing query params (engine, hrtf, debug, companion…) are PRESERVED across
 * navigation — only the PATH encodes the screen now.
 *
 * Calibration IS routed: each step gets its own URL (/calibrate, /calibrate/orientation,
 * …/headphones, …/tune[/localize|knobs|guided|pca], …/loudness) so a refresh restores the
 * step and the browser Back button walks the flow. The step is carried in `calStep`. The
 * live audio graph and per-step in-memory answers can't survive a reload (audio needs a user
 * gesture), so a cold load lands on the step and re-arms audio there — see mountCalibration.
 * The tutorial stays an unrouted transient gate for now.
 */

/** The routable screens. `level` carries an id; `calStep` a calibration sub-step. */
export type ScreenName =
  | 'landing' | 'picker' | 'level' | 'progress'
  | 'clicks' | 'credits' | 'train'
  | 'calibrate';

/** The calibration sub-steps that each get their own URL. */
export type CalStep =
  | 'intro'        // /calibrate
  | 'orientation'  // /calibrate/orientation  (the L/R + volume check)
  | 'headphones'   // /calibrate/headphones
  | 'tune'         // /calibrate/tune         (3D-audio tuning chooser menu)
  | 'localize'     // /calibrate/tune/localize
  | 'knobs'        // /calibrate/tune/knobs
  | 'guided'       // /calibrate/tune/guided
  | 'pca'          // /calibrate/tune/pca
  | 'compcheck'    // /calibrate/compcheck   (objective headphone-comp ON/OFF A/B, over-ear)
  | 'loudness';    // /calibrate/loudness

export interface ScreenState {
  screen: ScreenName;
  /** Present iff screen === 'level': the level id to (re)load. */
  level?: string;
  /** Present iff screen === 'calibrate': which calibration step to show. */
  calStep?: CalStep;
}

/** Sub-path fragment for each calibration step ('' = the /calibrate root). */
const CAL_SUBPATH: Record<CalStep, string> = {
  intro: '',
  orientation: 'orientation',
  headphones: 'headphones',
  tune: 'tune',
  localize: 'tune/localize',
  knobs: 'tune/knobs',
  guided: 'tune/guided',
  pca: 'tune/pca',
  compcheck: 'compcheck',
  loudness: 'loudness',
};
/** Inverse of CAL_SUBPATH: sub-path fragment → step. */
const CAL_STEP_BY_SUBPATH: Record<string, CalStep> = Object.fromEntries(
  (Object.entries(CAL_SUBPATH) as [CalStep, string][]).map(([step, sub]) => [sub, step]),
) as Record<string, CalStep>;

/**
 * The app's base path (Vite's `import.meta.env.BASE_URL`), normalized to always end
 * in a single "/". `/` in dev; a sub-path (e.g. `/audio/`) if the app is deployed
 * under one. All route paths are built and parsed relative to this so deep links keep
 * working under any base.
 */
function baseUrl(): string {
  const raw =
    typeof import.meta !== 'undefined' && (import.meta as { env?: { BASE_URL?: string } }).env
      ? (import.meta as { env?: { BASE_URL?: string } }).env!.BASE_URL
      : '/';
  const b = raw || '/';
  return b.endsWith('/') ? b : `${b}/`;
}

/** Strip the base prefix off a pathname, returning the route-relative path (no leading /). */
function stripBase(pathname: string, base = baseUrl()): string {
  let p = pathname;
  if (base !== '/' && p.startsWith(base)) {
    p = p.slice(base.length);
  } else if (base !== '/' && p === base.slice(0, -1)) {
    // Exactly the base with no trailing slash (e.g. "/audio" for base "/audio/").
    p = '';
  } else {
    // base === '/', or a path that doesn't carry the prefix: drop one leading slash.
    p = p.replace(/^\//, '');
  }
  return p.replace(/^\/+|\/+$/g, ''); // trim surrounding slashes → "", "play", "level/foo"
}

/**
 * PURE: build the full URL (path + preserved query) for a screen state.
 *   landing  → "<base>"           (the app root)
 *   picker   → "<base>play"
 *   level    → "<base>level/<id>"
 *   progress → "<base>progress"
 * Extra params already on the page (engine, hrtf, debug, companion…) are PRESERVED by
 * threading the current search in; the PATH now encodes the routing (no ?level/?screen).
 */
export function screenToUrl(state: ScreenState, currentSearch = ''): string {
  const base = baseUrl();
  const params = new URLSearchParams(currentSearch);
  // Legacy routing params must never leak back into the URL now that the path owns routing.
  params.delete('level');
  params.delete('screen');
  let path: string;
  if (state.screen === 'level' && state.level) {
    path = `${base}level/${encodeURIComponent(state.level)}`;
  } else if (state.screen === 'progress') {
    path = `${base}progress`;
  } else if (state.screen === 'clicks') {
    path = `${base}clicks`;
  } else if (state.screen === 'credits') {
    path = `${base}credits`;
  } else if (state.screen === 'train') {
    path = `${base}train`;
  } else if (state.screen === 'calibrate') {
    const sub = CAL_SUBPATH[state.calStep ?? 'intro'];
    path = sub ? `${base}calibrate/${sub}` : `${base}calibrate`;
  } else if (state.screen === 'picker') {
    path = `${base}play`;
  } else {
    path = base; // landing
  }
  const q = params.toString();
  return q ? `${path}?${q}` : path;
}

/**
 * PURE: parse a location (pathname + search) back into the screen state it represents.
 * Accepts either a pathname, or a full "path?query" string. Unknown paths map to the
 * landing page rather than throwing. `level/<id>` is the deep-link.
 */
export function urlToScreen(pathname: string, _search = ''): ScreenState {
  // Allow callers to pass a combined "path?query"; the query is irrelevant to routing.
  const path = stripBase(pathname.split('?')[0] ?? '');
  if (path === '') return { screen: 'landing' };
  if (path === 'play') return { screen: 'picker' };
  if (path === 'progress') return { screen: 'progress' };
  if (path === 'clicks') return { screen: 'clicks' };
  if (path === 'credits') return { screen: 'credits' };
  if (path === 'train') return { screen: 'train' };
  if (path === 'calibrate') return { screen: 'calibrate', calStep: 'intro' };
  if (path.startsWith('calibrate/')) {
    const step = CAL_STEP_BY_SUBPATH[path.slice('calibrate/'.length)];
    // Unknown sub-path (typo) → the calibration intro rather than throwing.
    return { screen: 'calibrate', calStep: step ?? 'intro' };
  }
  if (path.startsWith('level/')) {
    const id = decodeURIComponent(path.slice('level/'.length));
    if (id) return { screen: 'level', level: id };
  }
  // Anything else (a typo) falls back to landing — never throws.
  return { screen: 'landing' };
}

/** Whether two screen states denote the same place (so we don't push dupes). */
export function sameScreen(a: ScreenState, b: ScreenState): boolean {
  return (
    a.screen === b.screen &&
    (a.level ?? null) === (b.level ?? null) &&
    (a.calStep ?? null) === (b.calStep ?? null)
  );
}

export interface RouterOptions {
  /** Apply a screen state to the DOM (show/hide screens, render, focus, announce). */
  render: (state: ScreenState, viaPopstate: boolean) => void;
  /** Indirection for tests; defaults to the real History/location. */
  history?: History;
  location?: Pick<Location, 'pathname' | 'search'>;
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
  private loc: Pick<Location, 'pathname' | 'search'>;
  /** How many entries WE pushed this session — so `back()` knows whether a real
   *  in-app previous screen exists to return to (else it goes Home). */
  private depth = 0;

  constructor(opts: RouterOptions) {
    this.render = opts.render;
    this.hist = opts.history ?? window.history;
    this.loc = opts.location ?? window.location;
    const win = opts.window ?? window;
    win.addEventListener('popstate', () => {
      if (this.depth > 0) this.depth--;
      this.render(this.current(), true);
    });
  }

  /** The screen the current URL denotes (used to seed the app on load). */
  current(): ScreenState {
    return urlToScreen(this.loc.pathname, this.loc.search);
  }

  /**
   * Navigate to `state`: push a history entry with its URL (unless it's already
   * the current URL — avoids dup entries), then render it. `replace` swaps the
   * current entry instead of pushing (used for the initial load so Back doesn't
   * land on a blank pre-app entry).
   */
  go(state: ScreenState, opts: { replace?: boolean } = {}): void {
    const url = screenToUrl(state, this.loc.search);
    const cur = this.current();
    const entry = { screen: state.screen, level: state.level, calStep: state.calStep };
    if (opts.replace) {
      this.hist.replaceState(entry, '', url);
    } else if (!sameScreen(cur, state)) {
      this.hist.pushState(entry, '', url);
      this.depth++;
    } else {
      // Same place — keep the URL but don't stack a duplicate entry.
      this.hist.replaceState(entry, '', url);
    }
    this.render(state, false);
  }

  /**
   * Go BACK to where we came from: if we pushed at least one in-app entry this
   * session, use the browser history (returns to the actual previous screen); else
   * there's nowhere in-app to go back to, so navigate to `fallback` (Home by default).
   * This powers every screen's "Back" so it means "back to where I was", not a
   * hardcoded target — with a sensible Home fallback on a fresh deep-link.
   */
  back(fallback: ScreenState = { screen: 'landing' }): void {
    if (this.depth > 0) {
      this.hist.back(); // popstate handler re-renders + decrements depth
    } else {
      this.go(fallback, { replace: true });
    }
  }

  /** Render the screen for the initial URL, replacing the entry so it's canonical. */
  start(): void {
    const state = this.current();
    this.go(state, { replace: true });
  }
}
