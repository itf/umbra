/**
 * Reaction-event model (PURE — no Web Audio, fully unit-tested).
 *
 * A level can define timed EVENTS, each ACTIVE for a short window (~2-3 s). The
 * player's job is to PRESS the react key while an event is active. This file holds:
 *   - the event data + `activeEvents(t)` / `isAnyActive(t)` timing queries, and
 *   - a SIGNAL-DETECTION scorer that turns a stream of presses + event-ends into
 *     {hits, misses, falseAlarms}.
 *
 * The audio side (occlusion dip / door leak + the event's own transient sound) is
 * wired in game.ts, which drives this model from its tick loop. Keeping the timing
 * + scoring pure makes the whole mechanic deterministically testable headless.
 *
 * SCORING RULES (user-confirmed):
 *  - A press while ANY event is ACTIVE ⇒ a HIT for that event. At most ONE hit per
 *    event (a second press during the same event is ignored, NOT a false alarm).
 *  - A press while NO event is active ⇒ a FALSE ALARM.
 *  - An event that ENDS with no press during its window ⇒ a MISS.
 */

/**
 * The kind of reaction event. See the spec / game.ts for the audio treatment:
 *  - `crossing`: a body walks fully between you and the source — a deep duck + heavy
 *    muffle + a moving pass-by swoosh. The most obvious cue.
 *  - `door`: a door opens so the source LEAKS louder + brighter, with a click/creak.
 *  - `occlusion`: something briefly passes PARTLY in front of the source — a shorter,
 *    shallower dip in level + high frequencies that restores quickly. Subtler than a
 *    full crossing; the `depth` field tunes how deep the dip goes.
 */
export type ReactionEventType = 'crossing' | 'door' | 'occlusion';

/**
 * One timed event. `start`/`end` are seconds from level start (end EXCLUSIVE). The
 * event is ACTIVE for t in [start, end). `sourceId` names the ambient source it
 * modulates (the fountain it occludes / the AC it leaks). `id` is unique per level.
 */
export interface ReactionEvent {
  id: string;
  type: ReactionEventType;
  /** The AmbientSource.id this event occludes ('crossing') or leaks ('door'). */
  sourceId: string;
  /** Active window start (seconds from level start). */
  start: number;
  /** Active window end (seconds, EXCLUSIVE). */
  end: number;
  /**
   * OCCLUSION-only: how deep the partial-occlusion dip goes, 0..1. 0 ⇒ barely any
   * dip (very hard), 1 ⇒ nearly a full crossing (easy). Absent ⇒ DEFAULT_OCCLUSION_DEPTH.
   * Ignored for 'crossing'/'door'. See game.ts `occlusionModulation`.
   */
  depth?: number;
}

/** Default partial-occlusion depth when an 'occlusion' event omits `depth`. */
export const DEFAULT_OCCLUSION_DEPTH = 0.6;

/**
 * Map a partial-occlusion `depth` (0..1) to the audio modulation the game applies
 * while the event is active: a multiplicative gain `factor` on the source's steady
 * level and a low-pass `cutoffHz`. Deeper ⇒ quieter + more muffled. PURE so it can
 * be unit-tested independently of Web Audio.
 *
 * At depth 0 the dip is negligible (factor≈0.95, cutoff≈16 kHz — the hardest to
 * hear); at depth 1 it approaches a full crossing (factor≈0.4, cutoff≈900 Hz). The
 * default (0.6) is a clearly-audible-but-brief partial dip.
 */
export function occlusionModulation(depth = DEFAULT_OCCLUSION_DEPTH): { factor: number; cutoffHz: number } {
  const d = Math.min(1, Math.max(0, depth));
  // Gain: 0.95 (no dip) down to 0.40 (deep). Linear in depth.
  const factor = 0.95 - 0.55 * d;
  // Cutoff: 16 kHz (bright) down to 900 Hz (muffled). Log-ish via exponent feel.
  const cutoffHz = 16000 * Math.pow(900 / 16000, d);
  return { factor, cutoffHz };
}

/** Events whose active window contains `t` (start <= t < end). Pure. */
export function activeEvents(events: readonly ReactionEvent[], t: number): ReactionEvent[] {
  return events.filter((e) => t >= e.start && t < e.end);
}

/** Whether ANY event is active at `t`. Pure. */
export function isAnyActive(events: readonly ReactionEvent[], t: number): boolean {
  return events.some((e) => t >= e.start && t < e.end);
}

/** Running signal-detection tally. */
export interface ReactionScore {
  hits: number;
  misses: number;
  falseAlarms: number;
}

/**
 * Signal-detection scorer for the reaction mechanic. Feed it the event list once,
 * then drive it monotonically with `press(t)` (a react input) and `advance(t)` (the
 * current clock, so it can finalize events that have ended). It tracks, per event,
 * whether it has been HIT, and counts a MISS the moment an un-hit event's window
 * passes. Presses outside every active window are FALSE ALARMs.
 *
 * `advance` must be called with non-decreasing `t` (the game tick does this); it is
 * idempotent for the same/earlier t. `press` also advances the clock to `t`.
 */
export class ReactionScorer {
  private readonly events: ReactionEvent[];
  /** Event ids already credited a hit (≤ 1 hit each). */
  private readonly hit = new Set<string>();
  /** Event ids already finalized as a miss (window passed, no hit). */
  private readonly missed = new Set<string>();
  private falseAlarms = 0;
  /** High-water clock so misses fire exactly once as time advances. */
  private clock = 0;

  constructor(events: readonly ReactionEvent[]) {
    // Copy + sort by end so finalization is a simple forward sweep.
    this.events = [...events].sort((a, b) => a.end - b.end);
  }

  /**
   * Advance the clock to `t` (non-decreasing), finalizing any event whose window has
   * fully passed (t >= end) without a hit as a MISS. Safe to call every frame.
   */
  advance(t: number): void {
    if (t < this.clock) return;
    this.clock = t;
    for (const e of this.events) {
      if (t >= e.end && !this.hit.has(e.id) && !this.missed.has(e.id)) {
        this.missed.add(e.id);
      }
    }
  }

  /**
   * Record a react press at time `t`. Advances the clock first. If an event is active
   * and not yet hit, credits a HIT (the FIRST active, by earliest end). A press with
   * no creditable active event is a FALSE ALARM — UNLESS it lands on an already-hit
   * active event, which is simply ignored (no double-count, no false alarm).
   * Returns the outcome for the caller's spoken cue.
   */
  press(t: number): 'hit' | 'false-alarm' | 'ignored' {
    this.advance(t);
    const active = activeEvents(this.events, t).sort((a, b) => a.end - b.end);
    if (active.length === 0) {
      this.falseAlarms++;
      return 'false-alarm';
    }
    // Credit the first active event not yet hit.
    const target = active.find((e) => !this.hit.has(e.id));
    if (target) {
      this.hit.add(target.id);
      return 'hit';
    }
    // All active events already hit ⇒ ignore (not a false alarm).
    return 'ignored';
  }

  /** The current tally. `misses` reflects only events finalized by `advance`. */
  score(): ReactionScore {
    return { hits: this.hit.size, misses: this.missed.size, falseAlarms: this.falseAlarms };
  }

  /** Total events in the level (the denominator for "reacted to K of N"). */
  total(): number {
    return this.events.length;
  }
}
