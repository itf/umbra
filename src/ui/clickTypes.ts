/**
 * "Types of clicks" help screen — an accessible, eyes-free reference for the
 * tongue/mouth clicks used in human echolocation. Renders CLICK_TYPES from
 * src/content/clickTypes.ts as a list of cards; each card shows the name, IPA,
 * how-to-make, articulation, acoustics and probe suitability, an ORIGINAL inline
 * SVG articulation placeholder, a "?" disclosure with the fine articulation
 * detail, and two audio controls: play the recorded sample (from the clicks
 * manifest) and play the synthetic probe (src/game/clickProbe.ts).
 *
 * Attribution: recorded clips carry per-file credit + license from the manifest.
 * The CC BY-SA 3.0 clips REQUIRE attribution, so a credit line (author + license,
 * linking to the source page) is rendered whenever a card has a manifest match.
 *
 * Mirrors landing.ts / progress.ts: a thin, screen-reader-first DOM mounted into a
 * host <section>, real <h1>/headings, every control a real button with an
 * aria-label and a 44px min target, focus + a spoken overview on open.
 *
 * The builder is split into a PURE `buildClickTypesDom(host, deps)` (no Web Audio,
 * injectable audio/say hooks) so it is unit-testable against a fake document, and a
 * thin `mountClickTypes(host)` that wires real audio + the app's say(). Reached via
 * the `/clicks` route (main.ts `showClicks`) and the landing "types of clicks" link.
 */
import { CLICK_TYPES, type ClickType } from '../content/clickTypes';
import { mouthClickBuffer, playMouthClick } from '../game/clickProbe';
import { loadClicksManifest } from '../game/clicksManifest';
import { type ClickManifestEntry } from '../game/probeCatalog';

/** Injectable hooks so the builder stays pure/testable (no Web Audio, no fetch). */
export interface ClickTypesDeps {
  /** Recordings catalogue keyed by manifest id (assetId → entry). */
  manifest: ClickManifestEntry[];
  /** Play the recorded sample for this manifest entry. */
  onPlaySample: (entry: ClickManifestEntry) => void;
  /** Play the synthetic mouth-click probe. */
  onPlayProbe: () => void;
  /** Return to wherever the user came from (e.g. landing). */
  onBack?: () => void;
  /** Polite live-region announcer (the app's say()). */
  say: (msg: string) => void;
}

/** A CC0 license needs no attribution; anything else (CC BY-SA) does. An absent
 *  license is treated as needing attribution (fail safe). */
export function requiresAttribution(license: string | undefined): boolean {
  if (!license) return true;
  return !/^\s*cc0\b/i.test(license) && !/public\s*domain/i.test(license);
}

/**
 * Original, minimal mid-sagittal SVG placeholder for a click. Clearly our own
 * schematic line-art (an open-mouth outline + a release marker), NOT a sourced
 * diagram, so there is no licensing question. Small and decorative — the real
 * articulatory content is the text in the card and the "?" disclosure. The
 * `imageHint` is surfaced as the accessible label / caption.
 */
export function articulationSvg(doc: Document, click: ClickType): SVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg') as SVGElement;
  svg.setAttribute('viewBox', '0 0 120 90');
  svg.setAttribute('width', '120');
  svg.setAttribute('height', '90');
  svg.setAttribute('class', 'click-diagram');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `Schematic mouth cross-section. ${click.imageHint}`);

  // Head/mouth outline (a simple opened-mouth profile) — our own line-art.
  const outline = doc.createElementNS(NS, 'path');
  outline.setAttribute(
    'd',
    'M8,45 C8,20 40,10 70,14 L112,14 M8,45 C8,70 40,80 70,76 L112,76',
  );
  outline.setAttribute('fill', 'none');
  outline.setAttribute('stroke', '#7fbf95');
  outline.setAttribute('stroke-width', '2');
  svg.appendChild(outline);

  // Tongue body — a rough blob near the mouth floor.
  const tongue = doc.createElementNS(NS, 'path');
  tongue.setAttribute('d', 'M30,62 Q60,50 90,58 Q75,70 45,70 Z');
  tongue.setAttribute('fill', '#2f7d45');
  tongue.setAttribute('opacity', '0.5');
  svg.appendChild(tongue);

  // Release marker: a small labelled dot at the constriction. Its x-position
  // hints where the contact/release is (front for dental, back for palatal…).
  const spot = markerX(click.id);
  const dot = doc.createElementNS(NS, 'circle');
  dot.setAttribute('cx', String(spot));
  dot.setAttribute('cy', '30');
  dot.setAttribute('r', '5');
  dot.setAttribute('fill', '#e8b23a');
  svg.appendChild(dot);

  const arrow = doc.createElementNS(NS, 'path');
  arrow.setAttribute('d', `M${spot},36 L${spot},52`);
  arrow.setAttribute('stroke', '#e8b23a');
  arrow.setAttribute('stroke-width', '2');
  svg.appendChild(arrow);

  return svg;
}

/** Rough front(low x)→back(high x) placement of the release marker per click id. */
function markerX(id: string): number {
  switch (id) {
    case 'dental':
      return 100; // pinpoint at the teeth (front of mouth = right side of profile)
    case 'bilabial':
      return 110; // lips, frontmost
    case 'kish-palatal':
    case 'alveolar-lateral':
      return 78;
    case 'palatal':
      return 62; // broad, further back
    case 'percussive-sublingual':
    default:
      return 70;
  }
}

/** Build a labelled control button with an aria-label and a stable class. */
function button(
  doc: Document,
  label: string,
  ariaLabel: string,
  cls: string,
  onClick: () => void,
): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = label;
  b.setAttribute('aria-label', ariaLabel);
  b.addEventListener('click', onClick);
  return b;
}

/**
 * PURE builder. Renders the screen into `host` using the injected deps. Returns the
 * top <h1> (for tests / focus). No Web Audio, no fetch — audio goes through deps.
 */
export function buildClickTypesDom(host: HTMLElement, deps: ClickTypesDeps): HTMLElement {
  const doc = host.ownerDocument ?? (globalThis as unknown as { document: Document }).document;
  const byId = new Map(deps.manifest.map((m) => [m.id, m]));
  host.replaceChildren();

  const h1 = doc.createElement('h1');
  h1.textContent = 'Types of clicks';
  host.appendChild(h1);

  const intro = doc.createElement('p');
  intro.className = 'click-intro';
  intro.textContent =
    'A reference for the tongue and mouth clicks used in echolocation. Every true click is ' +
    'made on a mouth-suction (velaric) airstream: seal the back of the tongue to the soft ' +
    'palate, make a second closure forward, pull the tongue to lower the pressure, then release ' +
    'the front closure so air pops in. For each click you can hear its recording, read how to ' +
    'make it, and open a "?" for the fine detail.';
  host.appendChild(intro);

  // ONE shared synthetic probe for the whole page: the app synthesizes a single
  // canonical mouth click (the 2017 Thaler/Reich model, EE1) — not a separate synth per
  // consonant — so it lives here once rather than as a misleading per-card button.
  const synthRow = doc.createElement('p');
  synthRow.className = 'click-synth-row';
  const synthLabel = doc.createElement('span');
  synthLabel.textContent = 'The app’s synthetic echolocation probe (one canonical mouth click): ';
  synthRow.appendChild(synthLabel);
  synthRow.appendChild(
    button(
      doc,
      'Play synthetic probe',
      'Play the app’s synthetic echolocation probe — one canonical modelled mouth click',
      'click-play-probe',
      () => deps.onPlayProbe(),
    ),
  );
  host.appendChild(synthRow);

  const list = doc.createElement('ul');
  list.className = 'click-list';
  list.setAttribute('role', 'list');
  list.setAttribute('aria-label', 'Click types');
  host.appendChild(list);

  for (const click of CLICK_TYPES) {
    const li = doc.createElement('li');
    li.className = 'click-card';
    li.setAttribute('data-click-id', click.id);

    const h2 = doc.createElement('h2');
    h2.className = 'click-name';
    h2.textContent = click.ipa ? `${click.name} — ${click.ipa}` : click.name;
    li.appendChild(h2);

    // Original SVG placeholder diagram.
    li.appendChild(articulationSvg(doc, click) as unknown as HTMLElement);

    // Probe-suitability badge (spoken via text, not colour alone).
    const badge = doc.createElement('p');
    badge.className = click.goodProbe ? 'click-probe-good' : 'click-probe-poor';
    badge.textContent = click.goodProbe ? 'Good echolocation probe' : 'Not a good probe';
    li.appendChild(badge);

    const acoustics = doc.createElement('p');
    acoustics.className = 'click-acoustics';
    acoustics.textContent = click.acoustics;
    li.appendChild(acoustics);

    const probeNote = doc.createElement('p');
    probeNote.className = 'click-probe-note';
    probeNote.textContent = click.probeNote;
    li.appendChild(probeNote);

    // Audio controls.
    const controls = doc.createElement('div');
    controls.className = 'click-controls';
    controls.setAttribute('role', 'group');
    controls.setAttribute('aria-label', `Hear the ${click.name}`);

    const entry = click.assetId ? byId.get(click.assetId) : undefined;
    if (entry) {
      controls.appendChild(
        button(
          doc,
          'Play recording',
          `Play the recorded ${click.name}`,
          'click-play-sample',
          () => deps.onPlaySample(entry),
        ),
      );
    } else {
      const noRec = doc.createElement('span');
      noRec.className = 'click-no-recording';
      noRec.textContent = 'No dedicated recording';
      controls.appendChild(noRec);
    }

    // NOTE: no per-card synthetic probe. There is ONE synthetic mouth-click model
    // (clickProbe.ts, EE1) — not a distinct synth per consonant — so a per-card
    // "synthetic probe" would falsely imply each click type is separately synthesized.
    // The single shared synthetic probe lives once, in the page intro (see below).
    // The per-card RECORDINGS above ARE the genuinely-distinct per-type sounds.
    li.appendChild(controls);

    // Attribution / credit line for recordings. REQUIRED for CC BY-SA files.
    if (entry) {
      const author = entry.author ?? 'unknown';
      const license = entry.license ?? 'unknown license';
      const credit = doc.createElement('p');
      credit.className = 'click-credit';
      if (requiresAttribution(entry.license)) {
        credit.classList.add('click-credit-required');
      }
      const a = doc.createElement('a');
      a.className = 'click-source-link';
      a.href = entry.sourceUrl ?? '#';
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      a.textContent = entry.label;
      const lic = doc.createElement('a');
      lic.href = entry.licenseUrl ?? '#';
      lic.setAttribute('target', '_blank');
      lic.setAttribute('rel', 'noopener noreferrer');
      lic.textContent = license;
      credit.appendChild(doc.createTextNode('Recording: '));
      credit.appendChild(a);
      credit.appendChild(doc.createTextNode(` by ${author}, licensed `));
      credit.appendChild(lic);
      credit.appendChild(doc.createTextNode('.'));
      credit.setAttribute('aria-label', `Recording ${entry.label} by ${author}, licensed ${license}.`);
      li.appendChild(credit);
    }

    // Per-click "?" disclosure with the how-to-make + articulation detail.
    const details = doc.createElement('details');
    details.className = 'click-details';
    const summary = doc.createElement('summary');
    summary.className = 'click-help-toggle';
    summary.textContent = 'How to make it';
    summary.setAttribute('aria-label', `How to make the ${click.name} — show details`);
    details.appendChild(summary);

    const how = doc.createElement('p');
    how.className = 'click-howto';
    how.textContent = click.howToMake;
    details.appendChild(how);

    const artic = doc.createElement('p');
    artic.className = 'click-articulation';
    artic.textContent = `Place: ${click.articulation.place}. Mechanism: ${click.articulation.mechanism}.`;
    details.appendChild(artic);
    li.appendChild(details);

    list.appendChild(li);
  }

  if (deps.onBack) {
    const back = button(doc, 'Back', 'Go back', 'secondary click-back', deps.onBack);
    host.appendChild(back);
  }

  // Eyes-free: focus the heading and announce a concise overview.
  h1.setAttribute('tabindex', '-1');
  h1.focus();
  deps.say(
    `Types of clicks. ${CLICK_TYPES.length} tongue and mouth clicks for echolocation. ` +
      'For each one you can play its recording and open its help for how to make it. ' +
      'One shared synthetic probe is at the top.',
  );

  return h1;
}

// ---------------------------------------------------------------------------
// Real audio wiring (thin; not covered by the DOM-less tests).
// ---------------------------------------------------------------------------

let sharedCtx: AudioContext | null = null;
function audioCtx(): AudioContext {
  if (!sharedCtx) {
    const Ctor = (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext);
    sharedCtx = new Ctor();
  }
  if (sharedCtx.state === 'suspended') void sharedCtx.resume();
  return sharedCtx;
}

const sampleCache = new Map<string, AudioBuffer | null>();

/** Fetch + decode (cached) and play a recorded click sample through the context. */
async function playSample(entry: ClickManifestEntry, say: (m: string) => void): Promise<void> {
  const ctx = audioCtx();
  // Manifest paths are absolute-from-web-root; respect the Vite base if deployed.
  const base = (import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const url = entry.file.replace(/^\//, base.replace(/\/?$/, '/'));
  try {
    let buf = sampleCache.get(url);
    if (buf === undefined) {
      const bytes = await fetch(url).then((r) => r.arrayBuffer());
      buf = await ctx.decodeAudioData(bytes);
      sampleCache.set(url, buf);
    }
    if (!buf) return;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 1;
    src.connect(g).connect(ctx.destination);
    src.start();
  } catch {
    sampleCache.set(url, null);
    say('Could not load that recording.');
  }
}

/**
 * Mount the "Types of clicks" screen into `host` with real audio + the app's say().
 * Loads the manifest, wires sample playback (fetch + decodeAudioData) and the
 * synthetic probe (playMouthClick), then builds the DOM. Called by main.ts's
 * `showClicks` (the /clicks route).
 */
export async function mountClickTypes(
  host: HTMLElement,
  opts: { say?: (m: string) => void; onBack?: () => void } = {},
): Promise<void> {
  const say = opts.say ?? (() => {});
  const manifest = await loadClicksManifest(); // shared, cached, BASE_URL-aware

  buildClickTypesDom(host, {
    manifest,
    say,
    onBack: opts.onBack,
    onPlaySample: (entry) => void playSample(entry, say),
    onPlayProbe: () => {
      const ctx = audioCtx();
      // Warm the buffer (decodes lazily) then fire the one-shot probe.
      mouthClickBuffer(ctx);
      playMouthClick(ctx, ctx.destination, { gain: 0.9 });
    },
  });
}

/**
 * Convenience hook mirroring the `showXxx()` pattern: reveal the screen section and
 * mount it. The caller (main.ts) owns hiding the OTHER sections; this only un-hides
 * and mounts its own section. Safe no-op if the section is absent.
 */
export function showClickTypes(opts: { say?: (m: string) => void; onBack?: () => void } = {}): void {
  const section = document.getElementById('click-types-screen');
  if (!section) return;
  section.hidden = false;
  void mountClickTypes(section, opts);
}
