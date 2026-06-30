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
/** First-launch onboarding gate (the "blind reference" trial runs once). */
export const TRAINER_ONBOARDING_KEY = 'ps.trainer.onboarding.v1';

/** A timestamped threshold sample (for the progress sparkline / trend). */
export interface ThresholdEntry {
  /** Epoch ms when the session was recorded. */
  ts: number;
  /** Difficulty threshold in [0,1] (lower = better). */
  threshold: number;
}

/** Persisted record for one exercise type (or the 'all'/mixed pseudo-type). */
export interface ExerciseProgress {
  /** One threshold sample per completed session, oldest first. */
  thresholdHistory: number[];
  /**
   * Timestamped threshold samples, oldest first — the source for the progress
   * sparkline. Back-compat: older blobs only had `thresholdHistory` (plain
   * numbers, no timestamps); those are tolerated and surfaced with ts=0.
   */
  thresholdLog: ThresholdEntry[];
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
  return { thresholdHistory: [], thresholdLog: [], trials: 0, correct: 0, sessions: 0, best: null, last: null };
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
  // Timestamped log: keep only well-formed {ts, threshold} entries. If absent
  // (old blob), synthesize from the plain history with ts=0 so the sparkline /
  // trend still has the shape — old entries simply lack a real timestamp.
  if (Array.isArray(o.thresholdLog)) {
    p.thresholdLog = o.thresholdLog
      .filter((e): e is { ts: unknown; threshold: unknown } => !!e && typeof e === 'object')
      .filter((e) => isNum(e.ts) && isNum(e.threshold))
      .map((e) => ({ ts: e.ts as number, threshold: e.threshold as number }));
  } else {
    p.thresholdLog = p.thresholdHistory.map((threshold) => ({ ts: 0, threshold }));
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
  recordSession(type: string, session: { threshold: number; trials: number; correct: number }, now: number = Date.now()): ExerciseProgress {
    const map = this.load();
    const p = map[type] ?? emptyProgress();
    const t = session.threshold;
    p.thresholdHistory.push(t);
    p.thresholdLog.push({ ts: now, threshold: t });
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
  updateLastSession(type: string, session: { threshold: number; trials: number; correct: number }, now: number = Date.now()): ExerciseProgress {
    const map = this.load();
    const p = map[type];
    if (!p || p.sessions === 0 || p.thresholdHistory.length === 0) {
      return this.recordSession(type, session, now);
    }
    // Roll back the previous checkpoint's contribution, then re-apply the latest.
    const prevT = p.thresholdHistory[p.thresholdHistory.length - 1];
    const prevTrials = p.lastTrials ?? 0;
    const prevCorrect = p.lastCorrect ?? 0;
    p.trials = Math.max(0, p.trials - prevTrials) + Math.max(0, Math.floor(session.trials));
    p.correct = Math.max(0, p.correct - prevCorrect) + Math.max(0, Math.floor(session.correct));
    p.thresholdHistory[p.thresholdHistory.length - 1] = session.threshold;
    // Mirror the in-place edit into the timestamped log (re-stamp the latest).
    if (p.thresholdLog.length > 0) {
      p.thresholdLog[p.thresholdLog.length - 1] = { ts: now, threshold: session.threshold };
    } else {
      p.thresholdLog.push({ ts: now, threshold: session.threshold });
    }
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

  /**
   * Has the one-time "blind reference" onboarding been shown? Stored as a tiny
   * separate flag so it survives a progress `clear()` (onboarding is a one-shot
   * orientation, not part of the score history). Guarded; false on any error.
   */
  hasSeenOnboarding(): boolean {
    try {
      return this.store?.getItem(TRAINER_ONBOARDING_KEY) === '1';
    } catch {
      return this.onboardingMem;
    }
  }

  /** Mark the onboarding as seen so it never repeats. */
  markOnboardingSeen() {
    this.onboardingMem = true;
    try {
      this.store?.setItem(TRAINER_ONBOARDING_KEY, '1');
    } catch {
      /* memory flag already set */
    }
  }

  private onboardingMem = false;
}

// --- Pure progress-trend helpers (sparkline data + accessible summary) --------

/** A point ready for the sparkline canvas: x in [0,1] (time), y in [0,1] (threshold). */
export interface SparkPoint {
  x: number;
  y: number;
}

/**
 * PURE: turn a threshold log into normalized sparkline points. X is spread evenly
 * across the samples (index-based — robust to ts=0 back-compat entries and to many
 * sessions in one day), Y is the RAW threshold in [0,1] (already a 0..1 difficulty,
 * so no rescaling needed — a flat line means a flat skill, a falling line means
 * improvement since lower = better). Empty in → empty out. A single sample → one
 * centred point. The canvas drawer flips Y (lower threshold = higher on screen).
 */
export function sparklinePoints(log: ThresholdEntry[]): SparkPoint[] {
  if (log.length === 0) return [];
  if (log.length === 1) return [{ x: 0.5, y: clamp01(log[0].threshold) }];
  const n = log.length;
  return log.map((e, i) => ({ x: i / (n - 1), y: clamp01(e.threshold) }));
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/**
 * PURE: an accessible, spoken-friendly one-line trend summary for an exercise
 * (canvas alone isn't screen-reader accessible). Renders the direction of change
 * and the best score as a percent of full difficulty (lower = better):
 *
 *   "Room size: improving — best 22% of full difficulty over 4 sessions."
 *
 * Direction compares the latest sample to the average of the EARLIER ones:
 * improving (lower), regressing (higher), or steady. Empty for no history so the
 * caller can hide the row for a brand-new exercise.
 */
export function trendSummary(label: string, p: ExerciseProgress | null | undefined): string {
  if (!p || p.thresholdLog.length === 0 || p.best == null) return '';
  const log = p.thresholdLog;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const sessions = log.length === 1 ? '1 session' : `${log.length} sessions`;
  let dir = 'steady';
  if (log.length >= 2) {
    const latest = log[log.length - 1].threshold;
    const earlier = log.slice(0, -1);
    const avgEarlier = earlier.reduce((a, b) => a + b.threshold, 0) / earlier.length;
    const delta = latest - avgEarlier;
    if (delta < -0.03) dir = 'improving';
    else if (delta > 0.03) dir = 'slipping';
  }
  return `${label}: ${dir} — best ${pct(p.best)} of full difficulty over ${sessions}.`;
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
