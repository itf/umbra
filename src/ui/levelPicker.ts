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

/** One selectable row in the picker. */
export interface PickerItem {
  /** `builtin:<id>` or `saved:<name>` — a stable selection key. */
  key: string;
  source: 'builtin' | 'saved';
  /** The id (builtin) or saved name used to load the level. */
  ref: string;
  label: string;
  description: string;
}

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
  }));
  for (const name of savedNames) {
    items.push({
      key: `saved:${name}`,
      source: 'saved',
      ref: name,
      label: name,
      description: 'Your saved level (from the editor).',
    });
  }
  return items;
}

/** What a picker selection asks the host page to load. */
export interface PickerSelection {
  source: 'builtin' | 'saved';
  ref: string;
  label: string;
}

export interface RenderOptions {
  builtins: BuiltinInfo[];
  savedNames: string[];
  onSelect: (sel: PickerSelection) => void;
}

/**
 * Render the picker into `container`. Returns the model used (for tests/debug).
 * Each item is a focusable button; selecting it calls `onSelect`. Headings group
 * the two sources. Empty sources are simply omitted.
 */
export function renderLevelPicker(container: HTMLElement, opts: RenderOptions): PickerItem[] {
  const model = buildPickerModel(opts.builtins, opts.savedNames);
  container.replaceChildren();

  const groups: Array<{ source: 'builtin' | 'saved'; heading: string }> = [
    { source: 'builtin', heading: 'Demo levels' },
    { source: 'saved', heading: 'Your saved levels' },
  ];

  for (const g of groups) {
    const rows = model.filter((m) => m.source === g.source);
    if (rows.length === 0) continue;

    const section = document.createElement('section');
    section.className = 'picker-group';
    const h = document.createElement('h2');
    h.textContent = g.heading;
    h.id = `picker-h-${g.source}`;
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
      btn.setAttribute('aria-label', `${item.label}. ${item.description}`);

      const title = document.createElement('span');
      title.className = 'picker-title';
      title.textContent = item.label;
      const desc = document.createElement('span');
      desc.className = 'picker-desc';
      desc.textContent = item.description;
      btn.append(title, desc);

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
