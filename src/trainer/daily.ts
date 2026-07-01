/**
 * DAILY CHALLENGE — the seed-of-the-day retention layer.
 *
 * One deterministic challenge per calendar day: the same date always yields the
 * same exercise type + difficulty, so every player worldwide drills the identical
 * problem and can compare a shareable score string. Completing today's challenge
 * extends a localStorage streak (Duolingo-style), the single best retention lever
 * for a skill-training app (see docs/product/research-audio-games.md, row #2).
 *
 * This is a PURE PRODUCT LAYER over the existing seed-deterministic generators —
 * no acoustics-engine change. Everything here is a PURE function of an injected
 * date STRING (YYYY-MM-DD): the codebase forbids `Date.now()`/`new Date()` in
 * pure/testable modules (they throw in workflow/test contexts), so the UI layer
 * (trainer.ts) reads the real date and passes the string in. That keeps the
 * date→challenge mapping, the streak transition, and the score-string format all
 * unit-testable without a clock.
 *
 * Streak persistence (DailyStreakStore) mirrors trainerStore.ts: a single guarded
 * JSON blob, degrading to an in-memory fallback when localStorage is unavailable.
 */
import { makeRandomQuestion, ALL_TYPES, type ExerciseType, type Question } from './exercises';

// --- Daily seed + challenge config -------------------------------------------

/** A YYYY-MM-DD calendar date string. */
export type DateStr = string;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a well-formed YYYY-MM-DD string (cheap shape check, not calendar-valid). */
export function isDateStr(s: unknown): s is DateStr {
  return typeof s === 'string' && DATE_RE.test(s);
}

/**
 * PURE: map a calendar date string to a stable 32-bit seed. An FNV-1a hash over
 * the date characters — deterministic, well-distributed, and independent of any
 * clock. The same date always returns the same seed; adjacent dates diverge.
 */
export function dailySeed(date: DateStr): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < date.length; i++) {
    h ^= date.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV prime
  }
  return h >>> 0;
}

/** The fully-resolved challenge for a given day. */
export interface DailyChallenge {
  /** The date this challenge is for. */
  date: DateStr;
  /** The deterministic seed driving the question + difficulty. */
  seed: number;
  /** Which exercise the day picked. */
  type: ExerciseType;
  /** Difficulty in [0,1], fixed for the day (not adaptive — it's a fair daily). */
  difficulty: number;
  /** The built, deterministic question (reuses the trainer generators). */
  question: Question;
}

/**
 * Difficulty bands the daily rotates through, so a streak isn't all-easy or
 * all-expert. The day's seed picks a band, keeping every day a fixed, fair test.
 */
const DAILY_DIFFICULTIES = [0.2, 0.35, 0.5, 0.65, 0.8];

/**
 * PURE: build today's challenge from a date string. Deterministic — the same date
 * always yields the same type, difficulty and question. The type is drawn from the
 * full exercise roster; the difficulty from a fixed band set; both keyed off the
 * day's seed so they're stable but vary day to day.
 */
export function challengeForDate(date: DateStr): DailyChallenge {
  const seed = dailySeed(date);
  // Pick a difficulty band deterministically from a second decorrelated hash so it
  // doesn't lock-step with the type choice inside makeRandomQuestion.
  const diffIdx = (dailySeed(`${date}#d`) >>> 0) % DAILY_DIFFICULTIES.length;
  const difficulty = DAILY_DIFFICULTIES[diffIdx];
  const question = makeRandomQuestion(seed, { difficulty, types: ALL_TYPES });
  return { date, seed, type: question.type, difficulty, question };
}

/** Human label for an exercise type, for spoken/written challenge announcements. */
export const TYPE_LABELS: Record<ExerciseType, string> = {
  larger: 'room size',
  wider: 'room width',
  longer: 'room length',
  carpet: 'carpet vs hard',
  brick: 'brick vs concrete',
  direction: 'sound direction',
  reflector: 'echo direction',
  distance: 'distance to wall',
  gap: 'find the gap',
  material: 'identify the material',
  metal: 'which wall is metal',
  orientation: 'panel orientation',
  estimate: 'distance estimation',
  detect: 'panel present or absent',
  calibrate: 'click calibration',
};

// --- Streak transition (pure) ------------------------------------------------

/**
 * PURE: shift a YYYY-MM-DD date by `days` (usually +/-1), via UTC so it's free of
 * timezone/DST drift and of any ambient clock. Used only to ask "is `today` the
 * day right after `lastDate`?" for the consecutive-day check.
 */
export function shiftDate(date: DateStr, days: number): DateStr {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  const dt = new Date(t); // operates on a fixed epoch ms — no ambient clock read
  const yyyy = dt.getUTCFullYear().toString().padStart(4, '0');
  const mm = (dt.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = dt.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** The outcome of applying a completion to a prior streak state. */
export interface StreakTransition {
  currentStreak: number;
  longestStreak: number;
  /** True when this completion changed the streak (i.e. wasn't a same-day repeat). */
  changed: boolean;
  /** True when this completion is a new personal best for the longest streak. */
  isBest: boolean;
}

/**
 * PURE streak rule. Given the last completed date, the prior streak lengths and
 * today's date, compute the new streak. Rules:
 *
 *   - First-ever completion (no lastDate): streak = 1.
 *   - Same day as lastDate: IDEMPOTENT — no change (grinding the daily twice
 *     doesn't double-count). `changed` = false.
 *   - today is the day right after lastDate: increment (consecutive).
 *   - any gap (a day missed) OR a backwards/weird date: reset to 1.
 *
 * `longestStreak` only ever grows. `isBest` is true when the new current streak
 * matches the (possibly just-extended) longest — i.e. this is a record day.
 */
export function applyDailyCompletion(
  prev: { lastCompletedDate: DateStr | null; currentStreak: number; longestStreak: number },
  today: DateStr,
): StreakTransition {
  const prior = Math.max(0, prev.currentStreak | 0);
  const longestPrior = Math.max(0, prev.longestStreak | 0, prior);

  if (prev.lastCompletedDate === today) {
    // Same-day repeat — idempotent.
    return { currentStreak: prior, longestStreak: longestPrior, changed: false, isBest: false };
  }

  let next: number;
  if (!prev.lastCompletedDate || !isDateStr(prev.lastCompletedDate)) {
    next = 1; // first-ever (or corrupt prior date) → start fresh
  } else if (shiftDate(prev.lastCompletedDate, 1) === today) {
    next = prior + 1; // consecutive day → extend
  } else {
    next = 1; // a day (or more) missed, or a non-consecutive/backwards date → reset
  }

  const longest = Math.max(longestPrior, next);
  // A record day: the new streak matches the (possibly just-extended) longest AND
  // it strictly beat the prior best (so day 1 of a fresh streak isn't "your best").
  const isBest = next > 1 && next === longest && next > longestPrior;
  return { currentStreak: next, longestStreak: longest, changed: true, isBest };
}

// --- Spoken status + shareable score string (pure) ---------------------------

const dayWord = (n: number) => (n === 1 ? '1-day' : `${n}-day`);

/**
 * PURE: the spoken status when the player OPENS the daily challenge. Announces the
 * skill being tested and the current streak, plus whether today is already done.
 *
 *   "Daily challenge: sound direction. Day 4 streak."
 *   "Daily challenge: sound direction. Day 4 streak. Already completed today —
 *    replay for fun; your streak is safe."
 */
export function dailyOpenAnnouncement(opts: {
  challenge: DailyChallenge;
  currentStreak: number;
  doneToday: boolean;
}): string {
  const label = TYPE_LABELS[opts.challenge.type];
  const streak =
    opts.currentStreak > 0 ? ` Day ${opts.currentStreak} streak.` : ' No streak yet — complete it to start one.';
  const done = opts.doneToday
    ? ' Already completed today — replay for fun; your streak is safe.'
    : '';
  return `Daily challenge: ${label}.${streak}${done}`;
}

/**
 * PURE: the spoken status when the player COMPLETES the daily challenge. Reflects
 * whether they got it right and the new streak, calling out a personal best.
 *
 *   "Correct! 5-day streak — your best."
 *   "Not quite. 1-day streak."
 *   "Correct! Daily already done today — streak stays at 5 days."  (idempotent)
 */
export function dailyResultAnnouncement(opts: {
  correct: boolean;
  transition: StreakTransition;
  /** True when the player had already completed today before this attempt. */
  alreadyDoneToday: boolean;
}): string {
  const verdict = opts.correct ? 'Correct!' : 'Not quite.';
  const n = opts.transition.currentStreak;
  if (opts.alreadyDoneToday || !opts.transition.changed) {
    return `${verdict} Daily already done today — streak stays at ${dayWord(n)} streak.`;
  }
  const best = opts.transition.isBest && n > 1 ? ' — your best' : '';
  return `${verdict} ${dayWord(n)} streak${best}.`;
}

/**
 * PURE: a shareable, copy-pasteable one-line score string for today's result.
 *
 *   "papasangre daily 2026-06-29 — sound direction, correct, 5-day streak"
 *
 * `detail` is an optional extra metric (e.g. the direction error in degrees) the
 * caller can fold in; omitted when empty.
 */
export function shareScoreString(opts: {
  date: DateStr;
  challenge: DailyChallenge;
  correct: boolean;
  currentStreak: number;
  detail?: string;
}): string {
  const label = TYPE_LABELS[opts.challenge.type];
  const verdict = opts.correct ? 'correct' : 'missed';
  const detail = opts.detail ? `, ${opts.detail}` : '';
  return `papasangre daily ${opts.date} — ${label}, ${verdict}${detail}, ${dayWord(opts.currentStreak)} streak`;
}
