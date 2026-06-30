/**
 * Routing layer: the PURE screen↔URL mapping (`screenToUrl` / `urlToScreen`) and
 * the `Router`'s history/popstate behavior driven through injected fakes (no real
 * DOM/history). Covers reload-restore (URL → screen) and Back (popstate → screen).
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
  it('maps picker to the clean default (no query)', () => {
    expect(screenToUrl({ screen: 'picker' })).toBe('');
  });
  it('maps a level to the existing ?level deep-link', () => {
    expect(screenToUrl({ screen: 'level', level: 'foo' })).toBe('?level=foo');
  });
  it('maps progress to ?screen=progress', () => {
    expect(screenToUrl({ screen: 'progress' })).toBe('?screen=progress');
  });
  it('preserves unrelated params (engine, debug) and rewrites only routing params', () => {
    const out = screenToUrl({ screen: 'level', level: 'bar' }, '?engine=steam&level=old&debug=1');
    const p = new URLSearchParams(out);
    expect(p.get('engine')).toBe('steam');
    expect(p.get('debug')).toBe('1');
    expect(p.get('level')).toBe('bar');
  });
  it('drops stale routing params when going to the picker', () => {
    expect(screenToUrl({ screen: 'picker' }, '?level=old')).toBe('');
    expect(screenToUrl({ screen: 'picker' }, '?engine=steam&screen=progress'))
      .toBe('?engine=steam');
  });
});

describe('urlToScreen', () => {
  it('bare / → picker', () => {
    expect(urlToScreen('')).toEqual({ screen: 'picker' });
  });
  it('?level=<id> → that level (deep-link)', () => {
    expect(urlToScreen('?level=current')).toEqual({ screen: 'level', level: 'current' });
  });
  it('?screen=progress → progress', () => {
    expect(urlToScreen('?screen=progress')).toEqual({ screen: 'progress' });
  });
  it('a level wins over progress if both present', () => {
    expect(urlToScreen('?level=foo&screen=progress')).toEqual({ screen: 'level', level: 'foo' });
  });
  it('round-trips through screenToUrl', () => {
    const states: ScreenState[] = [
      { screen: 'picker' },
      { screen: 'level', level: 'demo' },
      { screen: 'progress' },
    ];
    for (const s of states) expect(urlToScreen(screenToUrl(s))).toEqual(s);
  });
});

describe('sameScreen', () => {
  it('compares screen + level', () => {
    expect(sameScreen({ screen: 'level', level: 'a' }, { screen: 'level', level: 'a' })).toBe(true);
    expect(sameScreen({ screen: 'level', level: 'a' }, { screen: 'level', level: 'b' })).toBe(false);
    expect(sameScreen({ screen: 'picker' }, { screen: 'progress' })).toBe(false);
  });
});

/** A minimal History/location/window fake to drive the Router without a DOM. */
function makeEnv(initialSearch = '') {
  let search = initialSearch;
  const pushed: Array<{ state: unknown; url: string }> = [];
  const replaced: Array<{ state: unknown; url: string }> = [];
  let popHandler: (() => void) | null = null;
  const history = {
    pushState: (state: unknown, _t: string, url: string) => {
      pushed.push({ state, url });
      search = new URL(url, 'http://x').search;
    },
    replaceState: (state: unknown, _t: string, url: string) => {
      replaced.push({ state, url });
      search = new URL(url, 'http://x').search;
    },
  } as unknown as History;
  const location = { get search() { return search; } };
  const win = { addEventListener: (_e: string, h: () => void) => { popHandler = h; } };
  return {
    history, location, win, pushed, replaced,
    setSearch: (s: string) => { search = s; },
    pop: () => popHandler?.(),
  };
}

describe('Router', () => {
  it('start() renders the initial URL screen and replaces (not pushes) the entry', () => {
    const env = makeEnv('?level=demo');
    const render = vi.fn();
    const r = new Router({ render, history: env.history, location: env.location, window: env.win });
    r.start();
    expect(render).toHaveBeenCalledWith({ screen: 'level', level: 'demo' }, false);
    expect(env.pushed).toHaveLength(0);
    expect(env.replaced).toHaveLength(1);
  });

  it('go() pushes a history entry and renders', () => {
    const env = makeEnv('');
    const render = vi.fn();
    const r = new Router({ render, history: env.history, location: env.location, window: env.win });
    r.go({ screen: 'level', level: 'foo' });
    expect(env.pushed).toHaveLength(1);
    expect(env.pushed[0].url).toContain('level=foo');
    expect(render).toHaveBeenCalledWith({ screen: 'level', level: 'foo' }, false);
  });

  it('go() to the same place replaces instead of stacking a duplicate', () => {
    const env = makeEnv('?level=foo');
    const r = new Router({ render: vi.fn(), history: env.history, location: env.location, window: env.win });
    r.go({ screen: 'level', level: 'foo' });
    expect(env.pushed).toHaveLength(0);
    expect(env.replaced).toHaveLength(1);
  });

  it('popstate renders the screen for the new URL without pushing (Back)', () => {
    const env = makeEnv('?level=foo');
    const render = vi.fn();
    new Router({ render, history: env.history, location: env.location, window: env.win });
    env.setSearch(''); // browser walked Back to the picker URL
    env.pop();
    expect(render).toHaveBeenCalledWith({ screen: 'picker' }, true);
    expect(env.pushed).toHaveLength(0);
  });
});
