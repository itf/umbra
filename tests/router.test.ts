/**
 * Routing layer: the PURE screen↔URL mapping (`screenToUrl` / `urlToScreen`) and
 * the `Router`'s history/popstate behavior driven through injected fakes (no real
 * DOM/history). Covers reload-restore (URL → screen) and Back (popstate → screen).
 *
 * URLs are REAL PATHS now (/, /play, /level/<id>, /progress). Base is `/` under
 * vitest (import.meta.env.BASE_URL defaults to '/'), so tests read as plain paths.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  screenToUrl,
  urlToScreen,
  sameScreen,
  Router,
  type ScreenState,
} from '../src/ui/router';

describe('screenToUrl', () => {
  it('maps landing to the app root', () => {
    expect(screenToUrl({ screen: 'landing' })).toBe('/');
  });
  it('maps the picker to /play', () => {
    expect(screenToUrl({ screen: 'picker' })).toBe('/play');
  });
  it('maps a level to /level/<id>', () => {
    expect(screenToUrl({ screen: 'level', level: 'foo' })).toBe('/level/foo');
  });
  it('maps progress to /progress', () => {
    expect(screenToUrl({ screen: 'progress' })).toBe('/progress');
  });
  it('preserves unrelated params (engine, debug) and drops legacy routing params', () => {
    const out = screenToUrl({ screen: 'level', level: 'bar' }, '?engine=steam&level=old&debug=1');
    const [path, query] = out.split('?');
    expect(path).toBe('/level/bar');
    const p = new URLSearchParams(query);
    expect(p.get('engine')).toBe('steam');
    expect(p.get('debug')).toBe('1');
    expect(p.get('level')).toBeNull(); // legacy routing param stripped
  });
  it('drops stale legacy routing params when going to the picker', () => {
    expect(screenToUrl({ screen: 'picker' }, '?level=old')).toBe('/play');
    expect(screenToUrl({ screen: 'picker' }, '?engine=steam&screen=progress'))
      .toBe('/play?engine=steam');
  });
  it('url-encodes a level id with special characters', () => {
    expect(screenToUrl({ screen: 'level', level: 'a b/c' })).toBe('/level/a%20b%2Fc');
  });
  it('maps calibration steps to /calibrate[/…] paths', () => {
    expect(screenToUrl({ screen: 'calibrate', calStep: 'intro' })).toBe('/calibrate');
    expect(screenToUrl({ screen: 'calibrate' })).toBe('/calibrate'); // defaults to intro
    expect(screenToUrl({ screen: 'calibrate', calStep: 'orientation' })).toBe('/calibrate/orientation');
    expect(screenToUrl({ screen: 'calibrate', calStep: 'headphones' })).toBe('/calibrate/headphones');
    expect(screenToUrl({ screen: 'calibrate', calStep: 'tune' })).toBe('/calibrate/tune');
    expect(screenToUrl({ screen: 'calibrate', calStep: 'localize' })).toBe('/calibrate/tune/localize');
    expect(screenToUrl({ screen: 'calibrate', calStep: 'knobs' })).toBe('/calibrate/tune/knobs');
    expect(screenToUrl({ screen: 'calibrate', calStep: 'guided' })).toBe('/calibrate/tune/guided');
    expect(screenToUrl({ screen: 'calibrate', calStep: 'pca' })).toBe('/calibrate/tune/pca');
    expect(screenToUrl({ screen: 'calibrate', calStep: 'compcheck' })).toBe('/calibrate/compcheck');
    expect(screenToUrl({ screen: 'calibrate', calStep: 'loudness' })).toBe('/calibrate/loudness');
  });
});

describe('urlToScreen', () => {
  it('bare / → landing', () => {
    expect(urlToScreen('/')).toEqual({ screen: 'landing' });
    expect(urlToScreen('')).toEqual({ screen: 'landing' });
  });
  it('/play → picker', () => {
    expect(urlToScreen('/play')).toEqual({ screen: 'picker' });
  });
  it('/level/<id> → that level (deep-link)', () => {
    expect(urlToScreen('/level/current')).toEqual({ screen: 'level', level: 'current' });
  });
  it('/progress → progress', () => {
    expect(urlToScreen('/progress')).toEqual({ screen: 'progress' });
  });
  it('decodes an encoded level id', () => {
    expect(urlToScreen('/level/a%20b')).toEqual({ screen: 'level', level: 'a b' });
  });
  it('ignores a query string on the path', () => {
    expect(urlToScreen('/level/foo?engine=steam')).toEqual({ screen: 'level', level: 'foo' });
  });
  it('/clicks, /credits, /train are real screens', () => {
    expect(urlToScreen('/clicks')).toEqual({ screen: 'clicks' });
    expect(urlToScreen('/credits')).toEqual({ screen: 'credits' });
    expect(urlToScreen('/train')).toEqual({ screen: 'train' });
  });
  it('/calibrate and its sub-steps map to the calibrate screen', () => {
    expect(urlToScreen('/calibrate')).toEqual({ screen: 'calibrate', calStep: 'intro' });
    expect(urlToScreen('/calibrate/orientation')).toEqual({ screen: 'calibrate', calStep: 'orientation' });
    expect(urlToScreen('/calibrate/headphones')).toEqual({ screen: 'calibrate', calStep: 'headphones' });
    expect(urlToScreen('/calibrate/tune')).toEqual({ screen: 'calibrate', calStep: 'tune' });
    expect(urlToScreen('/calibrate/tune/localize')).toEqual({ screen: 'calibrate', calStep: 'localize' });
    expect(urlToScreen('/calibrate/tune/knobs')).toEqual({ screen: 'calibrate', calStep: 'knobs' });
    expect(urlToScreen('/calibrate/tune/guided')).toEqual({ screen: 'calibrate', calStep: 'guided' });
    expect(urlToScreen('/calibrate/tune/pca')).toEqual({ screen: 'calibrate', calStep: 'pca' });
    expect(urlToScreen('/calibrate/compcheck')).toEqual({ screen: 'calibrate', calStep: 'compcheck' });
    expect(urlToScreen('/calibrate/loudness')).toEqual({ screen: 'calibrate', calStep: 'loudness' });
  });
  it('an unknown calibrate sub-step falls back to the intro (not landing)', () => {
    expect(urlToScreen('/calibrate/bogus')).toEqual({ screen: 'calibrate', calStep: 'intro' });
  });
  it('unknown paths fall back to landing, not throw', () => {
    expect(urlToScreen('/nope/nope')).toEqual({ screen: 'landing' });
    expect(urlToScreen('/random')).toEqual({ screen: 'landing' });
  });
  it('round-trips through screenToUrl for every screen', () => {
    const states: ScreenState[] = [
      { screen: 'landing' },
      { screen: 'picker' },
      { screen: 'level', level: 'demo' },
      { screen: 'level', level: 'a b/c' },
      { screen: 'progress' },
      { screen: 'clicks' },
      { screen: 'credits' },
      { screen: 'train' },
      { screen: 'calibrate', calStep: 'intro' },
      { screen: 'calibrate', calStep: 'orientation' },
      { screen: 'calibrate', calStep: 'headphones' },
      { screen: 'calibrate', calStep: 'tune' },
      { screen: 'calibrate', calStep: 'localize' },
      { screen: 'calibrate', calStep: 'knobs' },
      { screen: 'calibrate', calStep: 'guided' },
      { screen: 'calibrate', calStep: 'pca' },
      { screen: 'calibrate', calStep: 'loudness' },
    ];
    for (const s of states) expect(urlToScreen(screenToUrl(s))).toEqual(s);
  });
});

describe('sameScreen', () => {
  it('compares screen + level', () => {
    expect(sameScreen({ screen: 'level', level: 'a' }, { screen: 'level', level: 'a' })).toBe(true);
    expect(sameScreen({ screen: 'level', level: 'a' }, { screen: 'level', level: 'b' })).toBe(false);
    expect(sameScreen({ screen: 'picker' }, { screen: 'progress' })).toBe(false);
    expect(sameScreen({ screen: 'landing' }, { screen: 'picker' })).toBe(false);
  });
  it('distinguishes calibration steps by calStep', () => {
    expect(sameScreen(
      { screen: 'calibrate', calStep: 'intro' },
      { screen: 'calibrate', calStep: 'intro' },
    )).toBe(true);
    expect(sameScreen(
      { screen: 'calibrate', calStep: 'intro' },
      { screen: 'calibrate', calStep: 'headphones' },
    )).toBe(false);
  });
});

/** A minimal History/location/window fake to drive the Router without a DOM. */
function makeEnv(initialPath = '/', initialSearch = '') {
  let pathname = initialPath;
  let search = initialSearch;
  const pushed: Array<{ state: unknown; url: string }> = [];
  const replaced: Array<{ state: unknown; url: string }> = [];
  let popHandler: (() => void) | null = null;
  const apply = (url: string) => {
    const u = new URL(url, 'http://x');
    pathname = u.pathname;
    search = u.search;
  };
  let backCalls = 0;
  const history = {
    pushState: (state: unknown, _t: string, url: string) => {
      pushed.push({ state, url });
      apply(url);
    },
    replaceState: (state: unknown, _t: string, url: string) => {
      replaced.push({ state, url });
      apply(url);
    },
    back: () => { backCalls++; },
  } as unknown as History;
  const location = {
    get pathname() { return pathname; },
    get search() { return search; },
  };
  const win = { addEventListener: (_e: string, h: () => void) => { popHandler = h; } };
  return {
    history, location, win, pushed, replaced,
    setLocation: (p: string, s = '') => { pathname = p; search = s; },
    pop: () => popHandler?.(),
    backCalls: () => backCalls,
  };
}

describe('Router', () => {
  it('start() renders the initial URL screen and replaces (not pushes) the entry', () => {
    const env = makeEnv('/level/demo');
    const render = vi.fn();
    const r = new Router({ render, history: env.history, location: env.location, window: env.win });
    r.start();
    expect(render).toHaveBeenCalledWith({ screen: 'level', level: 'demo' }, false);
    expect(env.pushed).toHaveLength(0);
    expect(env.replaced).toHaveLength(1);
  });

  it('start() on / renders the landing page', () => {
    const env = makeEnv('/');
    const render = vi.fn();
    new Router({ render, history: env.history, location: env.location, window: env.win }).start();
    expect(render).toHaveBeenCalledWith({ screen: 'landing' }, false);
  });

  it('go() pushes a history entry and renders', () => {
    const env = makeEnv('/');
    const render = vi.fn();
    const r = new Router({ render, history: env.history, location: env.location, window: env.win });
    r.go({ screen: 'level', level: 'foo' });
    expect(env.pushed).toHaveLength(1);
    expect(env.pushed[0].url).toBe('/level/foo');
    expect(render).toHaveBeenCalledWith({ screen: 'level', level: 'foo' }, false);
  });

  it('go() to the same place replaces instead of stacking a duplicate', () => {
    const env = makeEnv('/level/foo');
    const r = new Router({ render: vi.fn(), history: env.history, location: env.location, window: env.win });
    r.go({ screen: 'level', level: 'foo' });
    expect(env.pushed).toHaveLength(0);
    expect(env.replaced).toHaveLength(1);
  });

  it('popstate renders the screen for the new URL without pushing (Back)', () => {
    const env = makeEnv('/level/foo');
    const render = vi.fn();
    new Router({ render, history: env.history, location: env.location, window: env.win });
    env.setLocation('/play'); // browser walked Back to the picker URL
    env.pop();
    expect(render).toHaveBeenCalledWith({ screen: 'picker' }, true);
    expect(env.pushed).toHaveLength(0);
  });

  it('Back from /play to / renders landing (popstate)', () => {
    const env = makeEnv('/play');
    const render = vi.fn();
    new Router({ render, history: env.history, location: env.location, window: env.win });
    env.setLocation('/');
    env.pop();
    expect(render).toHaveBeenCalledWith({ screen: 'landing' }, true);
  });

  it('back() uses history.back when there is an in-app previous screen', () => {
    const env = makeEnv('/');
    const render = vi.fn();
    const r = new Router({ render, history: env.history, location: env.location, window: env.win });
    r.go({ screen: 'clicks' }); // pushed one entry (depth 1)
    r.back();
    expect(env.backCalls()).toBe(1); // returns to the actual previous screen
  });

  it('back() falls back to Home (replace) on a fresh deep-link with no in-app history', () => {
    const env = makeEnv('/clicks'); // arrived directly, nothing pushed
    const render = vi.fn();
    const r = new Router({ render, history: env.history, location: env.location, window: env.win });
    r.back();
    expect(env.backCalls()).toBe(0); // no history to pop
    expect(render).toHaveBeenLastCalledWith({ screen: 'landing' }, false);
  });

  it('back() respects a custom fallback', () => {
    const env = makeEnv('/clicks');
    const render = vi.fn();
    const r = new Router({ render, history: env.history, location: env.location, window: env.win });
    r.back({ screen: 'picker' });
    expect(render).toHaveBeenLastCalledWith({ screen: 'picker' }, false);
  });
});
