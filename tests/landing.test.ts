/**
 * Landing / About screen render + wiring. The project has no jsdom in its test env,
 * so we drive `renderLandingScreen` against a MINIMAL fake `document` — just enough
 * of the createElement/append/query surface the module touches — to assert the
 * structure (an h1, primary Play/Train actions, a "How it works" list, progress +
 * credits links), that the actions call the right callbacks, that the first action is
 * focused (eyes-free), and that it announces an overview.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** A tiny DOM node good enough for landing.ts (no layout, no real events beyond click). */
class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  className = '';
  href = '';
  type = '';
  textContent = '';
  focused = false;
  private handlers: Record<string, Array<() => void>> = {};
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }
  appendChild(c: FakeEl) { this.children.push(c); return c; }
  append(...cs: FakeEl[]) { this.children.push(...cs); }
  replaceChildren() { this.children = []; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  addEventListener(t: string, h: () => void) { (this.handlers[t] ??= []).push(h); }
  click() { (this.handlers.click ?? []).forEach((h) => h()); }
  focus() { this.focused = true; }
  /** Depth-first flatten (self + descendants). */
  all(): FakeEl[] { return [this, ...this.children.flatMap((c) => c.all())]; }
  find(pred: (e: FakeEl) => boolean): FakeEl | undefined { return this.all().find(pred); }
  byClass(cls: string): FakeEl | undefined {
    return this.find((e) => e.className.split(/\s+/).includes(cls));
  }
}

beforeEach(() => {
  (globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => new FakeEl(tag),
  };
});
afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

// Imported AFTER the document stub exists is unnecessary (it only touches document at
// call time), but keep the import at top per module rules.
import { renderLandingScreen } from '../src/ui/landing';

function render(overrides: Partial<Parameters<typeof renderLandingScreen>[1]> = {}) {
  const host = new FakeEl('section');
  const say = vi.fn();
  const onPlay = vi.fn();
  const onTrain = vi.fn();
  const onProgress = vi.fn();
  const play = renderLandingScreen(host as unknown as HTMLElement, {
    onPlay, onTrain, onProgress, say, ...overrides,
  }) as unknown as FakeEl;
  return { host, play, say, onPlay, onTrain, onProgress };
}

describe('renderLandingScreen', () => {
  it('has a single top-level heading and a hero paragraph', () => {
    const { host } = render();
    const h1s = host.all().filter((e) => e.tagName === 'H1');
    expect(h1s).toHaveLength(1);
    expect(host.byClass('landing-hero')?.textContent).toMatch(/echolocation trainer/i);
  });

  it('exposes Play and Train primary actions with aria-labels', () => {
    const { host } = render();
    const play = host.byClass('landing-play')!;
    const train = host.byClass('landing-train')!;
    expect(play.tagName).toBe('BUTTON');
    expect(play.getAttribute('aria-label')).toMatch(/play/i);
    expect(train.getAttribute('aria-label')).toMatch(/train/i);
  });

  it('renders a "How it works" section with a few grounded points', () => {
    const { host } = render();
    const how = host.byClass('landing-how')!;
    expect(how.find((e) => e.tagName === 'H2')?.textContent).toMatch(/how it works/i);
    const items = how.all().filter((e) => e.tagName === 'LI');
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items.some((li) => /binaural|HRTF/i.test(li.textContent))).toBe(true);
    expect(items.some((li) => /echo/i.test(li.textContent))).toBe(true);
  });

  it('links to progress and credits', () => {
    const { host } = render();
    expect(host.byClass('landing-progress')).toBeDefined();
    const credits = host.byClass('landing-credits')!;
    expect(credits.tagName).toBe('A');
    expect(credits.href).toBe('credits'); // relative → resolves under BASE_URL
  });

  it('wires the actions to their callbacks', () => {
    const { host, onPlay, onTrain, onProgress } = render();
    host.byClass('landing-play')!.click();
    host.byClass('landing-train')!.click();
    host.byClass('landing-progress')!.click();
    expect(onPlay).toHaveBeenCalledTimes(1);
    expect(onTrain).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });

  it('focuses the first action and announces an overview (eyes-free)', () => {
    const { play, say } = render();
    expect(play.focused).toBe(true);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0][0]).toMatch(/headphones/i);
  });

  it('returns the Play button', () => {
    const { play } = render();
    expect(play.className).toContain('landing-play');
  });
});
