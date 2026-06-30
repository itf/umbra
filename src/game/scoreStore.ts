/**
 * Per-level SCORE persistence — a thin, testable localStorage wrapper that turns
 * one-and-done levels into replayable score chases. Mirrors trainerStore.ts /
 * dailyStreakStore.ts: a single guarded JSON blob, every read/write wrapped
 * (localStorage can throw in private mode / disabled storage), degrading to an
 * in-memory copy so the session stays consistent. Never throws on corrupt JSON.
 *
 * We persist, PER LEVEL: the best (timeMs/clapsUsed), the total number of
 * completions, and the last result — enough to announce "New best!" / a comparison
 * at the end of a run, and to seed a future leaderboard. The "is this a new best?"
 * rule is the PURE `betterScore` (scoreModel.ts), so the store only persists.
 */
import { betterScore, toBest, type LevelBest, type LevelResult } from './scoreModel';

export const SCORES_KEY = 'ps.scores.v1';

/** Persisted record for one level. */
export interface LevelScore {
  /** Best score so far (lowest time, claps as tiebreak); null until first win. */
  best: LevelBest | null;
  /** Total completions of this level (lifetime). */
  completions: number;
  /** The most recent completion's score (null until the first win). */
  last: LevelBest | null;
}

/** Whole-store shape: a map from level id to its score record. */
export type ScoreMap = Record<string, LevelScore>;

function emptyScore(): LevelScore {
  return { best: null, completions: 0, last: null };
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

/** Coerce an untrusted parsed best into a clean LevelBest, or null if malformed. */
function sanitizeBest(raw: unknown): LevelBest | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isNum(o.timeMs) || !isNum(o.clapsUsed)) return null;
  return { timeMs: Math.max(0, o.timeMs), clapsUsed: Math.max(0, Math.floor(o.clapsUsed)) };
}

/** Defensive coercion of an untrusted parsed level record; never throws. */
function sanitize(raw: unknown): LevelScore {
  const s = emptyScore();
  if (!raw || typeof raw !== 'object') return s;
  const o = raw as Record<string, unknown>;
  s.best = sanitizeBest(o.best);
  s.last = sanitizeBest(o.last);
  if (isNum(o.completions)) s.completions = Math.max(0, Math.floor(o.completions));
  return s;
}

export class ScoreStore {
  private store: Storage | null;
  private mem: string | null = null;

  constructor(store: Storage | null = resolveStorage()) {
    this.store = store;
  }

  /** Read + parse the whole score map; {} on anything malformed/missing. */
  load(): ScoreMap {
    let text: string | null = null;
    try {
      text = this.store?.getItem(SCORES_KEY) ?? null;
    } catch {
      /* fall through to memory */
    }
    if (text == null) text = this.mem;
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== 'object') return {};
      const out: ScoreMap = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = sanitize(v);
      }
      return out;
    } catch {
      return {}; // corrupt JSON → treat as no scores
    }
  }

  /** Read one level's record (empty record if unseen). */
  get(levelId: string): LevelScore {
    return this.load()[levelId] ?? emptyScore();
  }

  /** The persisted best for a level (null until the first completion). */
  best(levelId: string): LevelBest | null {
    return this.get(levelId).best;
  }

  private save(map: ScoreMap) {
    const text = JSON.stringify(map);
    this.mem = text;
    try {
      this.store?.setItem(SCORES_KEY, text);
    } catch {
      /* memory already updated */
    }
  }

  /**
   * Record a level COMPLETION (a win). Bumps the completion count, stores it as the
   * last result, and updates the best when it beats the standing one (pure
   * `betterScore`). Returns `{ isBest, previousBest }` so the caller can announce
   * "New best!" or a comparison. A non-won result is ignored (returns isBest:false).
   */
  record(result: LevelResult): { isBest: boolean; previousBest: LevelBest | null } {
    const map = this.load();
    const rec = map[result.levelId] ?? emptyScore();
    const previousBest = rec.best;
    if (!result.won) {
      return { isBest: false, previousBest };
    }
    const score = toBest(result);
    const isBest = betterScore(previousBest, score);
    rec.completions += 1;
    rec.last = score;
    if (isBest) rec.best = score;
    map[result.levelId] = rec;
    this.save(map);
    return { isBest, previousBest };
  }

  /** Wipe all level scores (used by the settings "reset progress" affordance / tests). */
  clear() {
    this.mem = null;
    try {
      this.store?.removeItem(SCORES_KEY);
    } catch {
      /* ignore */
    }
  }
}
