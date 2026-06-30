/**
 * Level picker for the game's start screen.
 *
 * Lists the bundled demo levels (from `builtinLevels()`) and the player's saved
 * levels (from IndexedDB `listLevels()`), and lets them choose one to play.
 * This game is played eyes-closed, so the markup is screen-reader-first: a
 * `<ul role="list">` of real `<button>`s with descriptive labels, focusable and
 * announced, grouped under headings.
 *
 * The selection plumbing is split so it can be unit-tested without a DOM:
 *   - `buildPickerModel()` is PURE — it merges builtins + saved names into a
 *     flat, ordered list of `PickerItem`s.
 *   - `renderLevelPicker()` is the thin DOM wiring around that model.
 */
import type { BuiltinInfo } from '../level/builtins';
import type { BuiltinCategory } from '../levels';
import {
  SANDBOX_MODES,
  DIFFICULTIES,
  parseSeed,
  parseShareString,
  sandboxShareString,
  type SandboxMode,
  type Difficulty,
} from '../game/sandbox';

/** One selectable row in the picker. */
export interface PickerItem {
  /** `builtin:<id>` or `saved:<name>` — a stable selection key. */
  key: string;
  source: 'builtin' | 'saved';
  /** The id (builtin) or saved name used to load the level. */
  ref: string;
  label: string;
  description: string;
  /** Mode/showcase grouping (builtins only; saved levels are 'saved'). */
  category: BuiltinCategory | 'saved';
}

/**
 * Picker section headings, in display order. Builtins are grouped by mode so a
 * player can find "more <mode> levels"; saved levels come last.
 */
export const PICKER_GROUPS: Array<{ category: BuiltinCategory | 'saved'; heading: string }> = [
  { category: 'showcase', heading: 'Acoustics tour' },
  { category: 'beacon', heading: 'Beacon — navigate to a sound' },
  { category: 'absorber', heading: 'Absorber — find the dead spot' },
  { category: 'sonar', heading: 'Sonar — clap on a budget' },
  { category: 'stealth', heading: 'Stealth — escape the hunter' },
  { category: 'saved', heading: 'Your saved levels' },
];

/**
 * Merge the bundled levels and the saved level names into one ordered list.
 * Builtins come first (a curated tour), saved levels after. Pure — no DOM, no
 * IndexedDB — so the ordering/labelling is unit-testable.
 */
export function buildPickerModel(builtins: BuiltinInfo[], savedNames: string[]): PickerItem[] {
  const items: PickerItem[] = builtins.map((b) => ({
    key: `builtin:${b.id}`,
    source: 'builtin',
    ref: b.id,
    label: b.name,
    description: b.description,
    category: b.category,
  }));
  for (const name of savedNames) {
    items.push({
      key: `saved:${name}`,
      source: 'saved',
      ref: name,
      label: name,
      description: 'Your saved level (from the editor).',
      category: 'saved',
    });
  }
  return items;
}

/** What a picker selection asks the host page to load. */
export interface PickerSelection {
  source: 'builtin' | 'saved' | 'generated';
  ref: string;
  label: string;
  /** Present when source === 'generated': the seed-driven generator inputs. */
  sandbox?: { mode: SandboxMode; difficulty: Difficulty; seed: number };
}

/** Human labels for the sandbox mode dropdown. */
export const SANDBOX_MODE_LABELS: Record<SandboxMode, string> = {
  beacon: 'Beacon — navigate to a sound',
  absorber: 'Absorber — find the dead spot',
  sonar: 'Sonar — clap on a budget',
  stealth: 'Stealth — escape the hunter',
};

/**
 * PURE: a random-ish but SEED-ONLY new seed for the "Another" button, derived
 * from a counter the caller advances. Keeps the generator's no-clock contract:
 * the host passes a fresh integer (e.g. an incrementing counter) and we spread it
 * across the 32-bit space so consecutive seeds give visibly different levels.
 */
export function spreadSeed(n: number): number {
  return (Math.imul(n >>> 0, 2654435761) ^ 0x9e3779b9) >>> 0;
}

/**
 * PURE: build the source:'generated' selection for a sandbox roll. Extracted from
 * the DOM wiring so the (mode, difficulty, seedCounter) → PickerSelection mapping
 * is unit-testable without a DOM. `seedCounter` is spread to a 32-bit seed.
 */
export function sandboxSelection(
  mode: SandboxMode,
  difficulty: Difficulty,
  seedCounter: number,
): PickerSelection {
  const seed = spreadSeed(seedCounter);
  return {
    source: 'generated',
    ref: `${mode}:${difficulty}:${seed}`,
    label: `Sandbox ${mode} (d${difficulty})`,
    sandbox: { mode, difficulty, seed },
  };
}

/**
 * PURE: build a source:'generated' selection directly from explicit generator
 * inputs (a parsed share string, or a bare seed + the current mode/difficulty).
 * Used by the seed-entry flow, where the inputs are already resolved (not a
 * counter to spread).
 */
export function sandboxSelectionFor(
  mode: SandboxMode,
  difficulty: Difficulty,
  seed: number,
): PickerSelection {
  const s = seed >>> 0;
  return {
    source: 'generated',
    ref: `${mode}:${difficulty}:${s}`,
    label: `Sandbox ${mode} (d${difficulty})`,
    sandbox: { mode, difficulty, seed: s },
  };
}

/**
 * PURE: resolve free-text the player typed into the seed box into a generated
 * selection. Accepts a full share string ("papasangre sandbox <mode> d<diff>
 * #<seed>" — overrides the current mode/difficulty) OR a bare seed (a number,
 * `#base36`, or any string, hashed) replayed under the CURRENTLY selected mode +
 * difficulty. Returns null on empty input so the caller can announce a friendly
 * error. (Bare strings always parse to *some* seed via `parseSeed`, so only a
 * malformed share string — which falls through to the bare-seed path — or empty
 * input fails to produce a selection.)
 */
export function selectionFromSeedText(
  text: string,
  mode: SandboxMode,
  difficulty: Difficulty,
): PickerSelection | null {
  const t = text.trim();
  if (!t) return null;
  // A full share string carries its own mode + difficulty.
  if (/papasangre\s+sandbox/i.test(t)) {
    const parsed = parseShareString(t);
    if (!parsed) return null; // looks like a share string but is malformed
    return sandboxSelectionFor(parsed.mode, parsed.difficulty, parsed.seed);
  }
  // Otherwise a bare seed under the current mode/difficulty.
  return sandboxSelectionFor(mode, difficulty, parseSeed(t));
}

/** The share string for a selection (for the displayed/copyable code). */
export function shareStringFor(sel: PickerSelection): string | null {
  if (!sel.sandbox) return null;
  return sandboxShareString(sel.sandbox);
}

export interface RenderOptions {
  builtins: BuiltinInfo[];
  savedNames: string[];
  onSelect: (sel: PickerSelection) => void;
  /**
   * Optional per-level BEST readout ("Best: 42 seconds, 6 claps") keyed by the
   * level's load id/name — surfaced on each card so the player sees their record to
   * beat. Returns '' (or undefined) for levels never completed. Purely additive.
   */
  bestFor?: (item: PickerItem) => string | undefined;
}

/**
 * Render the picker into `container` as a scrollable LIST of level cards. Returns
 * the model used (for tests/debug). The picker is its OWN screen (not sharing the
 * viewport with the game controls), so it can list every level as a card; if the
 * list is taller than the viewport, the screen scrolls (see `#app` overflow-y in
 * styles.css). Each card is a focusable `<button>` with a screen-reader label,
 * grouped under headings. Empty groups are omitted.
 */
export function renderLevelPicker(container: HTMLElement, opts: RenderOptions): PickerItem[] {
  const model = buildPickerModel(opts.builtins, opts.savedNames);
  container.replaceChildren();

  // Sandbox / Freeplay first (the new endless-content entry), if enabled.
  if (opts.onSelect) renderSandboxSection(container, opts.onSelect);

  for (const g of PICKER_GROUPS) {
    const rows = model.filter((m) => m.category === g.category);
    if (rows.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'picker-group';
    const h = document.createElement('h2');
    h.textContent = g.heading;
    h.id = `picker-h-${g.category}`;
    section.appendChild(h);

    const list = document.createElement('ul');
    list.className = 'picker-list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-labelledby', h.id);

    for (const item of rows) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'picker-item';
      const best = opts.bestFor?.(item) ?? '';
      btn.setAttribute('aria-label', `${item.label}. ${item.description}${best ? ` ${best}.` : ''}`);

      const title = document.createElement('span');
      title.className = 'picker-title';
      title.textContent = item.label;
      const desc = document.createElement('span');
      desc.className = 'picker-desc';
      desc.textContent = item.description;
      btn.append(title, desc);
      if (best) {
        const bestEl = document.createElement('span');
        bestEl.className = 'picker-best';
        bestEl.textContent = best;
        btn.append(bestEl);
      }

      btn.addEventListener('click', () =>
        opts.onSelect({ source: item.source, ref: item.ref, label: item.label }),
      );
      li.appendChild(btn);
      list.appendChild(li);
    }
    section.appendChild(list);
    container.appendChild(section);
  }

  return model;
}

/**
 * The SANDBOX / FREEPLAY section: a mode dropdown, a difficulty selector, and a
 * "Generate & play" button plus an "Another" (new seed) button. Accessible —
 * labeled controls, a live status region announcing the rolled level + seed. The
 * generation itself is PURE (in src/game/sandbox.ts); this is the thin DOM that
 * collects (mode, difficulty, seed) and hands them to `onSelect` as a
 * source:'generated' selection. A starting seed counter advances on "Another".
 */
export function renderSandboxSection(
  container: HTMLElement,
  onSelect: (sel: PickerSelection) => void,
): void {
  const section = document.createElement('section');
  section.className = 'picker-group sandbox-group';
  const h = document.createElement('h2');
  h.textContent = 'Sandbox — endless seeded levels';
  h.id = 'picker-h-sandbox';
  section.appendChild(h);

  const p = document.createElement('p');
  p.className = 'picker-desc';
  p.textContent = 'Pick a mode and difficulty, then generate a fresh, solvable level. Same seed always replays the same level.';
  section.appendChild(p);

  const form = document.createElement('div');
  form.className = 'sandbox-form';

  // Mode dropdown.
  const modeId = 'sandbox-mode';
  const modeLabel = document.createElement('label');
  modeLabel.htmlFor = modeId;
  modeLabel.textContent = 'Mode';
  const modeSel = document.createElement('select');
  modeSel.id = modeId;
  for (const m of SANDBOX_MODES) {
    const o = document.createElement('option');
    o.value = m;
    o.textContent = SANDBOX_MODE_LABELS[m];
    modeSel.appendChild(o);
  }

  // Difficulty dropdown.
  const diffId = 'sandbox-difficulty';
  const diffLabel = document.createElement('label');
  diffLabel.htmlFor = diffId;
  diffLabel.textContent = 'Difficulty';
  const diffSel = document.createElement('select');
  diffSel.id = diffId;
  for (const d of DIFFICULTIES) {
    const o = document.createElement('option');
    o.value = String(d);
    o.textContent = `${d} — ${['very easy', 'easy', 'medium', 'hard', 'very hard'][d - 1]}`;
    if (d === 3) o.selected = true;
    diffSel.appendChild(o);
  }

  modeLabel.appendChild(modeSel);
  diffLabel.appendChild(diffSel);
  form.append(modeLabel, diffLabel);

  // Seed counter — advanced on each "Another" so the host stays clock-free.
  let seedCounter = 1;
  const status = document.createElement('p');
  status.className = 'sandbox-status';
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  const read = () => ({
    mode: modeSel.value as SandboxMode,
    difficulty: Number(diffSel.value) as Difficulty,
  });

  // --- Seed readout + copy. Surfaced whenever a level is generated, so an
  // eyes-free player hears the exact seed/share code and can copy + share it. ---
  const seedOut = document.createElement('div');
  seedOut.className = 'sandbox-seed-out';
  seedOut.hidden = true;
  const seedText = document.createElement('p');
  seedText.className = 'sandbox-seed-text';
  seedText.setAttribute('role', 'status');
  seedText.setAttribute('aria-live', 'polite');
  const copyRow = document.createElement('div');
  copyRow.className = 'sandbox-copy-row';
  const copySeedBtn = document.createElement('button');
  copySeedBtn.type = 'button';
  copySeedBtn.className = 'picker-item sandbox-copy';
  copySeedBtn.textContent = 'Copy seed';
  const copyShareBtn = document.createElement('button');
  copyShareBtn.type = 'button';
  copyShareBtn.className = 'picker-item sandbox-copy';
  copyShareBtn.textContent = 'Copy share code';
  copyRow.append(copySeedBtn, copyShareBtn);
  seedOut.append(seedText, copyRow);

  // The currently displayed roll's share inputs (for the copy buttons).
  let current: PickerSelection | null = null;

  const copy = async (value: string, what: string) => {
    if (!navigator.clipboard) {
      status.textContent = `Clipboard unavailable. ${what}: ${value}`;
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      status.textContent = `Copied ${what}: ${value}`;
    } catch {
      status.textContent = `Could not copy. ${what}: ${value}`;
    }
  };
  copySeedBtn.addEventListener('click', () => {
    if (current?.sandbox) void copy(current.sandbox.seed.toString(36), 'seed');
  });
  copyShareBtn.addEventListener('click', () => {
    const code = current && shareStringFor(current);
    if (code) void copy(code, 'share code');
  });

  /** Surface a generated selection: display its seed + share code, then play it. */
  const announceAndPlay = (sel: PickerSelection) => {
    current = sel;
    const { mode, difficulty, seed } = sel.sandbox!;
    const share = shareStringFor(sel) ?? '';
    seedOut.hidden = false;
    seedText.textContent = `Seed ${seed.toString(36)}. Share code: ${share}`;
    status.textContent =
      `Generated ${SANDBOX_MODE_LABELS[mode]}, difficulty ${difficulty}, seed ${seed.toString(36)}.`;
    onSelect(sel);
  };

  const play = (newSeed: boolean) => {
    if (newSeed) seedCounter++;
    const { mode, difficulty } = read();
    announceAndPlay(sandboxSelection(mode, difficulty, seedCounter));
  };

  const genBtn = document.createElement('button');
  genBtn.type = 'button';
  genBtn.className = 'picker-item sandbox-generate';
  genBtn.textContent = 'Generate & play';
  genBtn.addEventListener('click', () => play(false));

  const anotherBtn = document.createElement('button');
  anotherBtn.type = 'button';
  anotherBtn.className = 'picker-item sandbox-another';
  anotherBtn.textContent = 'Another (new seed)';
  anotherBtn.addEventListener('click', () => play(true));

  const btnRow = document.createElement('div');
  btnRow.className = 'sandbox-buttons';
  btnRow.append(genBtn, anotherBtn);

  // --- Enter a seed / share code: paste a seed number or a full share string to
  // replay an exact level. Parsing is pure (selectionFromSeedText); malformed
  // input is announced, never crashes. ---
  const entry = document.createElement('div');
  entry.className = 'sandbox-entry';
  const entryId = 'sandbox-seed-input';
  const entryLabel = document.createElement('label');
  entryLabel.htmlFor = entryId;
  entryLabel.textContent = 'Play a shared seed or code';
  const entryInput = document.createElement('input');
  entryInput.type = 'text';
  entryInput.id = entryId;
  entryInput.className = 'sandbox-seed-input';
  entryInput.placeholder = 'seed number or share code';
  entryInput.setAttribute(
    'aria-describedby',
    'sandbox-seed-help',
  );
  entryLabel.appendChild(entryInput);
  const entryHelp = document.createElement('p');
  entryHelp.id = 'sandbox-seed-help';
  entryHelp.className = 'picker-desc';
  entryHelp.textContent =
    'A bare seed uses the mode and difficulty above; a full share code carries its own.';
  const playSeedBtn = document.createElement('button');
  playSeedBtn.type = 'button';
  playSeedBtn.className = 'picker-item sandbox-play-seed';
  playSeedBtn.textContent = 'Play this seed';

  const playEntered = () => {
    const { mode, difficulty } = read();
    const sel = selectionFromSeedText(entryInput.value, mode, difficulty);
    if (!sel) {
      status.textContent = 'Enter a seed number or a share code first.';
      return;
    }
    announceAndPlay(sel);
  };
  playSeedBtn.addEventListener('click', playEntered);
  entryInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      playEntered();
    }
  });
  entry.append(entryLabel, entryHelp, playSeedBtn);

  section.append(form, btnRow, seedOut, entry, status);
  container.appendChild(section);
}
