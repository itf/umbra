/**
 * DAILY STREAK persistence — a thin, testable localStorage wrapper for the daily
 * challenge's streak state. Mirrors trainerStore.ts: a single guarded JSON blob,
 * every read/write wrapped (localStorage can throw in private mode / disabled
 * storage), degrading to an in-memory copy so the session stays consistent.
 *
 * The STREAK TRANSITION itself is pure (see daily.ts `applyDailyCompletion`); this
 * store only persists the resulting state and answers "is today done?". Recording
 * a completion is idempotent for the day (the pure rule handles same-day repeats).
 */
import { applyDailyCompletion, isDateStr, type DateStr, type StreakTransition } from './daily';

export const DAILY_STREAK_KEY = 'ps.daily.streak.v1';

/** Persisted streak state. */
export interface DailyStreakState {
  currentStreak: number;
  longestStreak: number;
  /** The last date a challenge was completed (YYYY-MM-DD), or null. */
  lastCompletedDate: DateStr | null;
  /** Total days completed (lifetime), for a "you've trained N days" readout. */
  totalDays: number;
}

export function emptyStreak(): DailyStreakState {
  return { currentStreak: 0, longestStreak: 0, lastCompletedDate: null, totalDays: 0 };
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;

function resolveStorage(): Storage | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage;
  } catch {
    /* access itself can throw in some sandboxes */
  }
  return null;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Defensive coercion of an untrusted parsed blob; never throws. */
function sanitize(raw: unknown): DailyStreakState {
  const s = emptyStreak();
  if (!raw || typeof raw !== 'object') return s;
  const o = raw as Record<string, unknown>;
  if (isNum(o.currentStreak)) s.currentStreak = Math.max(0, Math.floor(o.currentStreak));
  if (isNum(o.longestStreak)) s.longestStreak = Math.max(0, Math.floor(o.longestStreak));
  if (isNum(o.totalDays)) s.totalDays = Math.max(0, Math.floor(o.totalDays));
  if (isDateStr(o.lastCompletedDate)) s.lastCompletedDate = o.lastCompletedDate;
  // longest can never be below current.
  s.longestStreak = Math.max(s.longestStreak, s.currentStreak);
  return s;
}

export class DailyStreakStore {
  private store: Storage | null;
  private mem: string | null = null;

  constructor(store: Storage | null = resolveStorage()) {
    this.store = store;
  }

  /** Read the persisted streak state; empty on anything missing/malformed. */
  load(): DailyStreakState {
    let text: string | null = null;
    try {
      text = this.store?.getItem(DAILY_STREAK_KEY) ?? null;
    } catch {
      /* fall through to memory */
    }
    if (text == null) text = this.mem;
    if (!text) return emptyStreak();
    try {
      return sanitize(JSON.parse(text) as unknown);
    } catch {
      return emptyStreak(); // corrupt JSON → no streak
    }
  }

  private save(state: DailyStreakState) {
    const text = JSON.stringify(state);
    this.mem = text;
    try {
      this.store?.setItem(DAILY_STREAK_KEY, text);
    } catch {
      /* memory already updated */
    }
  }

  /** True when today's challenge has already been completed (streak is safe). */
  isCompletedOn(date: DateStr): boolean {
    return this.load().lastCompletedDate === date;
  }

  /**
   * Record a completion of `today`'s daily challenge and persist the new streak.
   * Idempotent for the day (a same-day repeat returns the unchanged state with
   * `transition.changed === false`). Returns both the new state and the pure
   * transition so the UI can announce the result.
   */
  complete(today: DateStr): { state: DailyStreakState; transition: StreakTransition } {
    const prev = this.load();
    const transition = applyDailyCompletion(prev, today);
    const next: DailyStreakState = {
      currentStreak: transition.currentStreak,
      longestStreak: transition.longestStreak,
      lastCompletedDate: today,
      totalDays: transition.changed ? prev.totalDays + 1 : prev.totalDays,
    };
    this.save(next);
    return { state: next, transition };
  }

  /** Wipe all streak state (reset affordance / tests). */
  clear() {
    this.mem = null;
    try {
      this.store?.removeItem(DAILY_STREAK_KEY);
    } catch {
      /* ignore */
    }
  }
}
