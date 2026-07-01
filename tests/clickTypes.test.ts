/**
 * "Types of clicks" help screen. No jsdom in the test env, so we drive the PURE
 * `buildClickTypesDom` against a MINIMAL fake `document` (mirroring landing.test.ts)
 * — enough createElement / createElementNS / createTextNode surface — and assert:
 *  - a card per CLICK_TYPES entry,
 *  - CC BY-SA recordings render an attribution/credit line, CC0 ones do not,
 *  - the correct assetId is wired to the play-sample control,
 *  - eyes-free basics (focus + spoken overview).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CLICK_TYPES } from '../src/content/clickTypes';
import manifest from '../public/audio/clicks/manifest.json';

class FakeEl {
  tagName: string;
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  className = '';
  href = '';
  type = '';
  textContent = '';
  focused = false;
  ownerDocument: unknown;
  private handlers: Record<string, Array<() => void>> = {};
  classList = {
    add: (c: string) => {
      this.className = (this.className + ' ' + c).trim();
    },
  };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  appendChild(c: FakeEl) {
    this.children.push(c);
    return c;
  }
  append(...cs: FakeEl[]) {
    this.children.push(...cs);
  }
  replaceChildren() {
    this.children = [];
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
    if (k === 'class') this.className = v; // real DOM: class attr mirrors className
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  addEventListener(t: string, h: () => void) {
    (this.handlers[t] ??= []).push(h);
  }
  click() {
    (this.handlers.click ?? []).forEach((h) => h());
  }
  focus() {
    this.focused = true;
  }
  all(): FakeEl[] {
    return [this, ...this.children.flatMap((c) => c.all())];
  }
  find(pred: (e: FakeEl) => boolean): FakeEl | undefined {
    return this.all().find(pred);
  }
  byClass(cls: string): FakeEl | undefined {
    return this.find((e) => e.className.split(/\s+/).includes(cls));
  }
  allByClass(cls: string): FakeEl[] {
    return this.all().filter((e) => e.className.split(/\s+/).includes(cls));
  }
}

const fakeDoc = {
  createElement: (tag: string) => {
    const el = new FakeEl(tag);
    el.ownerDocument = fakeDoc;
    return el;
  },
  createElementNS: (_ns: string, tag: string) => {
    const el = new FakeEl(tag);
    el.ownerDocument = fakeDoc;
    return el;
  },
  createTextNode: (text: string) => {
    const el = new FakeEl('#text');
    el.textContent = text;
    return el;
  },
};

beforeEach(() => {
  (globalThis as unknown as { document: unknown }).document = fakeDoc;
});
afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document;
});

import { buildClickTypesDom, requiresAttribution } from '../src/ui/clickTypes';

function render(overrides: Record<string, unknown> = {}) {
  const host = fakeDoc.createElement('section') as unknown as FakeEl;
  const say = vi.fn();
  const onPlaySample = vi.fn();
  const onPlayProbe = vi.fn();
  const deps = {
    manifest: manifest as never,
    say,
    onPlaySample,
    onPlayProbe,
    ...overrides,
  };
  buildClickTypesDom(host as unknown as HTMLElement, deps as never);
  return { host, say, onPlaySample, onPlayProbe };
}

describe('buildClickTypesDom', () => {
  it('has a single h1 and renders one card per CLICK_TYPES entry', () => {
    const { host } = render();
    expect(host.all().filter((e) => e.tagName === 'H1')).toHaveLength(1);
    expect(host.allByClass('click-card')).toHaveLength(CLICK_TYPES.length);
  });

  it('renders an original inline SVG diagram per card with a descriptive label', () => {
    const { host } = render();
    const svgs = host.allByClass('click-diagram');
    expect(svgs).toHaveLength(CLICK_TYPES.length);
    expect(svgs[0].getAttribute('role')).toBe('img');
    expect(svgs[0].getAttribute('aria-label')).toMatch(/cross-section/i);
  });

  it('renders a required attribution/credit line for CC BY-SA recordings', () => {
    const { host } = render();
    // dental → CC BY-SA 3.0 recording, requires attribution.
    const card = host.find((e) => e.getAttribute('data-click-id') === 'dental')!;
    const credit = card.byClass('click-credit')!;
    expect(credit.className).toContain('click-credit-required');
    expect(credit.textContent + credit.all().map((c) => c.textContent).join(' ')).toMatch(
      /Isotalo/i,
    );
    expect(credit.all().some((c) => /CC BY-SA/i.test(c.textContent))).toBe(true);
    // link points at the Commons source page.
    const link = credit.byClass('click-source-link')!;
    expect(link.tagName).toBe('A');
    expect(link.href).toMatch(/commons\.wikimedia\.org/);
  });

  it('does NOT flag CC0 recordings as attribution-required', () => {
    const { host } = render();
    // percussive-sublingual → percussive-alveolar asset, CC0.
    const card = host.find((e) => e.getAttribute('data-click-id') === 'percussive-sublingual')!;
    const credit = card.byClass('click-credit')!;
    expect(credit.className).not.toContain('click-credit-required');
    expect(requiresAttribution('CC0 1.0')).toBe(false);
    expect(requiresAttribution('CC BY-SA 3.0')).toBe(true);
  });

  it('wires the correct assetId to the play-recording control', () => {
    const { host, onPlaySample } = render();
    const card = host.find((e) => e.getAttribute('data-click-id') === 'dental')!;
    card.byClass('click-play-sample')!.click();
    expect(onPlaySample).toHaveBeenCalledTimes(1);
    expect((onPlaySample.mock.calls[0][0] as { id: string }).id).toBe('dental');
  });

  it('shows "no recording" for clicks without an assetId (kish-palatal)', () => {
    const { host } = render();
    const card = host.find((e) => e.getAttribute('data-click-id') === 'kish-palatal')!;
    expect(card.byClass('click-play-sample')).toBeUndefined();
    expect(card.byClass('click-no-recording')).toBeDefined();
  });

  it('has a synthetic-probe button on every card wired to onPlayProbe', () => {
    const { host, onPlayProbe } = render();
    const probes = host.allByClass('click-play-probe');
    expect(probes).toHaveLength(CLICK_TYPES.length);
    probes[0].click();
    expect(onPlayProbe).toHaveBeenCalledTimes(1);
  });

  it('provides a per-click "?" disclosure with how-to + articulation', () => {
    const { host } = render();
    const card = host.find((e) => e.getAttribute('data-click-id') === 'dental')!;
    const details = card.find((e) => e.tagName === 'DETAILS')!;
    expect(details.byClass('click-howto')?.textContent).toMatch(/tongue tip/i);
    expect(details.byClass('click-articulation')?.textContent).toMatch(/Place:/);
  });

  it('is eyes-free: focuses the heading and announces an overview', () => {
    const { host, say } = render();
    const h1 = host.find((e) => e.tagName === 'H1')!;
    expect(h1.focused).toBe(true);
    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0][0]).toMatch(/types of clicks/i);
  });
});
