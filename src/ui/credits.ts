/**
 * Credits / licenses screen. Renders the third-party attributions the app is
 * obligated to show — chiefly the CC-BY-SA 3.0 tongue-click recordings from Wikimedia
 * Commons (CC0 needs none but is credited anyway), plus the HRTF and audio-engine
 * credits. Kept as a small, accessible, DOM-building module mirroring landing.ts /
 * progress.ts: semantic headings, keyboard/touch operable, announces on open.
 *
 * The click attributions are derived from the same manifest the game loads
 * (public/audio/clicks/manifest.json), so this screen and the actual assets can't
 * drift. CREDITS.md at the repo root carries the canonical text version.
 */

import { loadClicksManifest } from '../game/clicksManifest';

interface ClickCredit {
  label: string;
  author: string;
  license: string;
  licenseUrl: string;
  sourceUrl: string;
}

interface CreditsDeps {
  /** Click attributions (from the clicks manifest). */
  clicks: ClickCredit[];
  onBack: () => void;
  say?: (msg: string) => void;
}

/** Static, always-shown credits beyond the click recordings. */
const CORE_CREDITS: { title: string; body: string; url?: string }[] = [
  {
    title: 'Binaural HRTF',
    body: 'SADIE II head-related impulse responses (University of York), used for 3D audio.',
    url: 'https://www.york.ac.uk/sadie-project/database.html',
  },
  {
    title: 'Steam Audio',
    body: 'Optional high-fidelity spatial-audio engine (Valve), via three-steam-audio.',
  },
  {
    title: 'Mouth-click probe model',
    body: 'Synthetic echolocation click after Reich/Thaler/Antoniou (2017), PLOS Comput. Biol. — doi:10.1371/journal.pcbi.1005670 (CC BY).',
    url: 'https://doi.org/10.1371/journal.pcbi.1005670',
  },
];

/**
 * Build the credits DOM into `host` (cleared first). Pure w.r.t. audio/fetch — the
 * caller passes the click attributions — so it's unit-testable with a fake document.
 */
export function buildCreditsDom(host: HTMLElement, deps: CreditsDeps): HTMLElement {
  const doc = host.ownerDocument;
  host.innerHTML = '';

  const h1 = doc.createElement('h1');
  h1.textContent = 'Credits & licenses';
  h1.tabIndex = -1; // focus target on open (eyes-free)
  host.appendChild(h1);

  const intro = doc.createElement('p');
  intro.textContent =
    'This project uses third-party sounds and data. Recordings under Creative Commons ' +
    'Attribution-ShareAlike are credited below; any trimmed/normalized versions we ship ' +
    'are likewise released under CC BY-SA 3.0.';
  host.appendChild(intro);

  // --- Click recordings ---
  const h2clicks = doc.createElement('h2');
  h2clicks.textContent = 'Tongue-click recordings (Wikimedia Commons)';
  host.appendChild(h2clicks);

  const list = doc.createElement('ul');
  list.className = 'credits-list';
  for (const c of deps.clicks) {
    const li = doc.createElement('li');
    const name = doc.createElement('strong');
    name.textContent = c.label;
    li.appendChild(name);
    li.appendChild(doc.createTextNode(` — ${c.author} — `));
    const lic = doc.createElement('a');
    lic.href = c.licenseUrl;
    lic.textContent = c.license;
    lic.rel = 'noopener';
    lic.target = '_blank';
    li.appendChild(lic);
    li.appendChild(doc.createTextNode(' — '));
    const src = doc.createElement('a');
    src.href = c.sourceUrl;
    src.textContent = 'source';
    src.rel = 'noopener';
    src.target = '_blank';
    li.appendChild(src);
    list.appendChild(li);
  }
  host.appendChild(list);

  // --- Core credits ---
  const h2core = doc.createElement('h2');
  h2core.textContent = 'Audio engine & data';
  host.appendChild(h2core);
  const coreList = doc.createElement('ul');
  coreList.className = 'credits-list';
  for (const c of CORE_CREDITS) {
    const li = doc.createElement('li');
    const name = doc.createElement('strong');
    name.textContent = c.title;
    li.appendChild(name);
    li.appendChild(doc.createTextNode(`: ${c.body} `));
    if (c.url) {
      const a = doc.createElement('a');
      a.href = c.url;
      a.textContent = 'link';
      a.rel = 'noopener';
      a.target = '_blank';
      li.appendChild(a);
    }
    coreList.appendChild(li);
  }
  host.appendChild(coreList);

  const back = doc.createElement('button');
  back.type = 'button';
  back.className = 'secondary';
  back.textContent = 'Back';
  back.setAttribute('aria-label', 'Back to the previous screen');
  back.addEventListener('click', () => deps.onBack());
  host.appendChild(back);

  return host;
}

/** Fetch the clicks manifest → click credits, build the screen, focus + announce. */
export async function renderCreditsScreen(
  host: HTMLElement,
  opts: { onBack: () => void; say?: (m: string) => void },
): Promise<void> {
  const manifest = await loadClicksManifest(); // shared, cached, BASE_URL-aware
  const clicks: ClickCredit[] = manifest.map((m) => ({
    label: m.label,
    author: m.author ?? 'unknown',
    license: m.license ?? 'unknown license',
    licenseUrl: m.licenseUrl ?? '#',
    sourceUrl: m.sourceUrl ?? '#',
  }));
  buildCreditsDom(host, { clicks, onBack: opts.onBack, say: opts.say });
  (host.querySelector('h1') as HTMLElement | null)?.focus();
  opts.say?.('Credits and licenses. Third-party sound and data attributions.');
}
