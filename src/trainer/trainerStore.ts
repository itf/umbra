/**
 * Trainer progress persistence — a thin, testable localStorage wrapper that turns
 * isolated drills into visible long-term progress. Mirrors `onboardingStore.ts`'s
 * style: a single JSON blob per app key, every read/write guarded (localStorage
 * can throw in private mode / disabled storage), degrading to an in-memory map so
 * the session is still consistent.
 *
 * We persist, PER EXERCISE TYPE: the staircase threshold history (one sample per
 * completed session), trial counts, best/last threshold and sessions completed.
 * A returning user is greeted with their best + last so the trainer feels like a
 * coach that remembers them ("Your best on direction: 8 degrees. Last: 12.").
 *
 * The summarize step is a PURE function (`summarizeProgress`) so the spoken
 * greeting is unit-testable without DOM or storage.
 */

export const TRAINER_PROGRESS_KEY = 'ps.trainer.progress.v1';

/** Persisted record for one exercise type (or the 'all'/mixed pseudo-type). */
export interface ExerciseProgress {
  /** One threshold sample per completed session, oldest first. */
  thresholdHistory: number[];
  /** Total trials answered across all sessions of this type. */
  trials: number;
  /** Total correct answers across all sessions (for an accuracy readout). */
  correct: number;
  /** Sessions completed (a session = one recorded threshold sample). */
  sessions: number;
  /** Lowest (best) threshold ever recorded; null until the first session. */
  best: number | null;
  /** Most recent session's threshold; null until the first session. */
  last: number | null;
  /** Trials in the most recent session (for in-place checkpoint updates). */
  lastTrials?: number;
  /** Correct answers in the most recent session (for in-place updates). */
  lastCorrect?: number;
}

/** Whole-store shape: a map from exercise type to its progress. */
export type ProgressMap = Record<string, ExerciseProgress>;

function emptyProgress(): ExerciseProgress {
  return { thresholdHistory: [], trials: 0, correct: 0, sessions: 0, best: null, last: null };
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

/**
 * Coerce an untrusted parsed object into a clean ExerciseProgress, dropping any
 * malformed fields. Defensive: a corrupt localStorage blob must never crash the
 * trainer — worst case we treat it as no progress.
 */
function sanitize(raw: unknown): ExerciseProgress {
  const p = emptyProgress();
  if (!raw || typeof raw !== 'object') return p;
  const o = raw as Record<string, unknown>;
  if (Array.isArray(o.thresholdHistory)) {
    p.thresholdHistory = o.thresholdHistory.filter(isNum);
  }
  if (isNum(o.trials)) p.trials = Math.max(0, Math.floor(o.trials));
  if (isNum(o.correct)) p.correct = Math.max(0, Math.floor(o.correct));
  if (isNum(o.sessions)) p.sessions = Math.max(0, Math.floor(o.sessions));
  if (isNum(o.best)) p.best = o.best;
  if (isNum(o.last)) p.last = o.last;
  if (isNum(o.lastTrials)) p.lastTrials = Math.max(0, Math.floor(o.lastTrials));
  if (isNum(o.lastCorrect)) p.lastCorrect = Math.max(0, Math.floor(o.lastCorrect));
  return p;
}

export class TrainerStore {
  private store: Storage | null;
  private mem: string | null = null;

  constructor(store: Storage | null = resolveStorage()) {
    this.store = store;
  }

  /** Read + parse the whole progress map; {} on anything malformed/missing. */
  load(): ProgressMap {
    let text: string | null = null;
    try {
      text = this.store?.getItem(TRAINER_PROGRESS_KEY) ?? null;
    } catch {
      /* fall through to memory */
    }
    if (text == null) text = this.mem;
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object') return {};
      const out: ProgressMap = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = sanitize(v);
      }
      return out;
    } catch {
      return {}; // corrupt JSON → treat as no progress
    }
  }

  /** Read one exercise type's progress (empty record if unseen). */
  get(type: string): ExerciseProgress {
    return this.load()[type] ?? emptyProgress();
  }

  /** Persist the whole map (writes memory first so the session stays consistent). */
  private save(map: ProgressMap) {
    const text = JSON.stringify(map);
    this.mem = text;
    try {
      this.store?.setItem(TRAINER_PROGRESS_KEY, text);
    } catch {
      /* memory already updated */
    }
  }

  /**
   * Record one completed SESSION for an exercise type: append the threshold
   * sample, fold in the session's trial/correct counts, and update best/last.
   * Returns the updated record.
   */
  recordSession(type: string, session: { threshold: number; trials: number; correct: number }): ExerciseProgress {
    const map = this.load();
    const p = map[type] ?? emptyProgress();
    const t = session.threshold;
    p.thresholdHistory.push(t);
    p.trials += Math.max(0, Math.floor(session.trials));
    p.correct += Math.max(0, Math.floor(session.correct));
    p.sessions += 1;
    p.last = t;
    p.lastTrials = Math.max(0, Math.floor(session.trials));
    p.lastCorrect = Math.max(0, Math.floor(session.correct));
    p.best = p.best == null ? t : Math.min(p.best, t);
    map[type] = p;
    this.save(map);
    return p;
  }

  /**
   * Update the MOST RECENT session of a type in place (instead of appending a new
   * one). Used to checkpoint a single live sitting repeatedly without inflating the
   * session count: call `recordSession` once at the start of a sitting, then
   * `updateLastSession` on each later checkpoint/flush. No-op if no session exists.
   */
  updateLastSession(type: string, session: { threshold: number; trials: number; correct: number }): ExerciseProgress {
    const map = this.load();
    const p = map[type];
    if (!p || p.sessions === 0 || p.thresholdHistory.length === 0) {
      return this.recordSession(type, session);
    }
    // Roll back the previous checkpoint's contribution, then re-apply the latest.
    const prevT = p.thresholdHistory[p.thresholdHistory.length - 1];
    const prevTrials = p.lastTrials ?? 0;
    const prevCorrect = p.lastCorrect ?? 0;
    p.trials = Math.max(0, p.trials - prevTrials) + Math.max(0, Math.floor(session.trials));
    p.correct = Math.max(0, p.correct - prevCorrect) + Math.max(0, Math.floor(session.correct));
    p.thresholdHistory[p.thresholdHistory.length - 1] = session.threshold;
    p.last = session.threshold;
    p.lastTrials = Math.max(0, Math.floor(session.trials));
    p.lastCorrect = Math.max(0, Math.floor(session.correct));
    // Recompute best from history (the rolled-back sample may have been the best).
    p.best = p.thresholdHistory.reduce((m, x) => (m == null ? x : Math.min(m, x)), null as number | null);
    void prevT;
    map[type] = p;
    this.save(map);
    return p;
  }

  /** Wipe all trainer progress (used by a "reset progress" affordance / tests). */
  clear() {
    this.mem = null;
    try {
      this.store?.removeItem(TRAINER_PROGRESS_KEY);
    } catch {
      /* ignore */
    }
  }
}

/**
 * PURE: turn a stored ExerciseProgress + a human label for the exercise into a
 * concise spoken greeting. Thresholds are difficulty in [0,1]; we render them as
 * a percent of full difficulty (lower = better, matching the staircase's mastery
 * readout). Returns '' when there is no history, so the caller can skip greeting
 * a brand-new user.
 *
 *   "Your best on direction: 18% of full difficulty. Last session: 24%. 3 sessions."
 */
export function summarizeProgress(label: string, p: ExerciseProgress | null | undefined): string {
  if (!p || p.sessions === 0 || p.best == null || p.last == null) return '';
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const sessions = p.sessions === 1 ? '1 session' : `${p.sessions} sessions`;
  return `Your best on ${label}: ${pct(p.best)} of full difficulty. Last session: ${pct(p.last)}. ${sessions} so far.`;
}
