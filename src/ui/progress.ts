/**
 * "Best Times / Progress" screen — the thin, accessible DOM around the PURE
 * `buildProgressSummary` model. Reachable from the picker via a "Your progress"
 * link. It is screen-reader-first: a labeled summary, levels grouped by mode under
 * real headings, "—" / "Not yet cleared" for unplayed levels, the daily streak
 * shown prominently, and a "back to levels" control. On open it announces a
 * concise spoken overview through the same `say()` live-region path the rest of
 * the app uses (so it also rides TTS when enabled).
 *
 * READ-ONLY: it only renders what the stores already persist.
 */
import {
  buildProgressSummary,
  announceProgress,
  streakPhrase,
  type LevelInfo,
  type StreakInfo,
  type TrainerInfo,
} from '../game/progressSummary';
import { formatDuration, type LevelBest } from '../game/scoreModel';

export interface ProgressScreenOptions {
  /** Builtin levels (name + category) — the universe of clearable levels. */
  levels: LevelInfo[];
  /** Read-only best lookup keyed by level name (the score store's key). */
  bestOf: (name: string) => LevelBest | null;
  /** The daily-challenge streak state. */
  streak: StreakInfo;
  /** Optional trainer-best rows. */
  trainer?: TrainerInfo[];
  /** Polite live-region announcer (the app's say()). */
  say: (msg: string) => void;
  /** Return to the level picker. */
  onBack: () => void;
}

/**
 * Render the progress screen into `container` and announce its overview. Returns
 * the structured summary (for tests/debug).
 */
export function renderProgressScreen(container: HTMLElement, opts: ProgressScreenOptions) {
  const summary = buildProgressSummary(opts.levels, opts.bestOf, opts.streak, opts.trainer ?? []);
  container.replaceChildren();

  const h1 = document.createElement('h1');
  h1.textContent = 'Best Times & Progress';
  container.appendChild(h1);

  // Headline + streak: announced and visible, prominent.
  const headline = document.createElement('p');
  headline.className = 'progress-headline';
  headline.textContent = `${summary.totalCleared} of ${summary.totalLevels} levels cleared.`;
  container.appendChild(headline);

  const streakEl = document.createElement('p');
  streakEl.className = 'progress-streak';
  streakEl.textContent = streakPhrase(summary.streak);
  container.appendChild(streakEl);

  if (summary.fastest) {
    const fast = document.createElement('p');
    fast.className = 'progress-fastest';
    fast.textContent = `Fastest cleared: ${summary.fastest.name}, ${formatDuration(summary.fastest.best.timeMs)}.`;
    container.appendChild(fast);
  }

  // Per-mode groups, each a section with a heading + a list of level rows.
  for (const g of summary.groups) {
    const section = document.createElement('section');
    section.className = 'picker-group progress-group';
    const h2 = document.createElement('h2');
    h2.id = `progress-h-${g.category}`;
    h2.textContent = `${g.heading} — ${g.cleared} of ${g.total} cleared`;
    section.appendChild(h2);

    const list = document.createElement('ul');
    list.className = 'picker-list progress-list';
    list.setAttribute('role', 'list');
    list.setAttribute('aria-labelledby', h2.id);

    for (const row of g.rows) {
      const li = document.createElement('li');
      li.className = 'progress-row';
      li.setAttribute('aria-label', `${row.name}. ${row.bestText}.`);

      const title = document.createElement('span');
      title.className = 'picker-title';
      title.textContent = row.name;

      const best = document.createElement('span');
      best.className = row.cleared ? 'picker-best' : 'progress-uncleared';
      best.textContent = row.cleared ? row.bestText : '— not yet cleared';

      li.append(title, best);
      list.appendChild(li);
    }
    section.appendChild(list);
    container.appendChild(section);
  }

  // Optional trainer bests.
  const trainerRows = summary.trainer.filter((t) => t.best != null);
  if (trainerRows.length > 0) {
    const section = document.createElement('section');
    section.className = 'picker-group progress-group';
    const h2 = document.createElement('h2');
    h2.textContent = 'Echolocation trainer — your bests';
    section.appendChild(h2);
    const list = document.createElement('ul');
    list.className = 'picker-list progress-list';
    list.setAttribute('role', 'list');
    for (const t of trainerRows) {
      const li = document.createElement('li');
      li.className = 'progress-row';
      const pct = `${Math.round((t.best as number) * 100)}% of full difficulty`;
      const text = `${t.label}: best ${pct} (${t.sessions} ${t.sessions === 1 ? 'session' : 'sessions'})`;
      li.setAttribute('aria-label', text);
      const title = document.createElement('span');
      title.className = 'picker-title';
      title.textContent = t.label;
      const val = document.createElement('span');
      val.className = 'picker-best';
      val.textContent = `Best: ${pct}`;
      li.append(title, val);
      list.appendChild(li);
    }
    section.appendChild(list);
    container.appendChild(section);
  }

  // Back control.
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'secondary progress-back';
  back.textContent = 'Back to levels';
  back.addEventListener('click', opts.onBack);
  container.appendChild(back);

  // Land focus on the heading so an eyes-free user starts at the top, then
  // announce the spoken overview through the live region (rides TTS if enabled).
  h1.setAttribute('tabindex', '-1');
  h1.focus();
  opts.say(announceProgress(summary));

  return summary;
}
