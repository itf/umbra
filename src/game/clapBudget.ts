/**
 * Clap budget — the pure, testable model behind "flash sonar" discipline.
 *
 * The clap/echo probe is free by default (today's behaviour). A level can make it
 * a managed resource via TWO independent constraints, both optional:
 *
 *  - a HARD BUDGET: at most `max` claps for the whole run (0/undefined = unlimited).
 *  - a COOLDOWN: at least `cooldownMs` between consecutive claps (so you can't spam,
 *    even when the budget is generous or unlimited).
 *
 * The model is PURE: it never reads the clock itself. Callers inject the current
 * time (a millisecond number) into `canClap`/`consume`, so tests are deterministic.
 *
 * Back-compat: a config with no `max` and no `cooldownMs` NEVER refuses — exactly
 * today's free clap. `isManaged()` is false then, so the UI shows no counter.
 */

export interface ClapBudgetConfig {
  /** Max claps per level. 0 or undefined ⇒ unlimited. */
  max?: number;
  /** Minimum ms between consecutive claps. 0 or undefined ⇒ no cooldown. */
  cooldownMs?: number;
}

/** Why a clap was refused (for an eyes-free spoken cue). */
export type ClapRefusal = 'exhausted' | 'cooling';

export type CanClapResult =
  | { ok: true }
  | { ok: false; reason: ClapRefusal; /** ms until the cooldown clears (reason==='cooling'). */ waitMs: number };

export class ClapBudget {
  private readonly max: number; // 0 = unlimited
  private readonly cooldownMs: number;
  private used = 0;
  /** Clock value of the last successful clap, or null if none yet. */
  private lastClapMs: number | null = null;

  constructor(cfg: ClapBudgetConfig = {}) {
    // Normalise: negative/NaN/undefined collapse to "no constraint" (0).
    this.max = cfg.max && cfg.max > 0 ? Math.floor(cfg.max) : 0;
    this.cooldownMs = cfg.cooldownMs && cfg.cooldownMs > 0 ? cfg.cooldownMs : 0;
  }

  /** True when at least one constraint applies (so the UI should show/announce it). */
  isManaged(): boolean {
    return this.max > 0 || this.cooldownMs > 0;
  }

  /** True when this level limits the TOTAL number of claps. */
  hasBudget(): boolean {
    return this.max > 0;
  }

  /** Remaining claps, or Infinity when unlimited. */
  remaining(): number {
    return this.max > 0 ? Math.max(0, this.max - this.used) : Infinity;
  }

  /** Can the player clap at `nowMs`? Reports the refusal reason + cooldown wait. */
  canClap(nowMs: number): CanClapResult {
    if (this.max > 0 && this.used >= this.max) {
      return { ok: false, reason: 'exhausted', waitMs: 0 };
    }
    if (this.cooldownMs > 0 && this.lastClapMs != null) {
      const elapsed = nowMs - this.lastClapMs;
      if (elapsed < this.cooldownMs) {
        return { ok: false, reason: 'cooling', waitMs: this.cooldownMs - elapsed };
      }
    }
    return { ok: true };
  }

  /**
   * Attempt to consume one clap at `nowMs`. On success, decrements the budget and
   * arms the cooldown; returns the same result shape as `canClap` so callers can
   * branch once. A refused attempt changes no state.
   */
  consume(nowMs: number): CanClapResult {
    const check = this.canClap(nowMs);
    if (!check.ok) return check;
    this.used += 1;
    this.lastClapMs = nowMs;
    return check;
  }
}
