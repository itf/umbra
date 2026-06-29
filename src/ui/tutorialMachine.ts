/**
 * Tutorial sequencer — the PURE, testable controller for the 3-lesson guided
 * first-run (STEPPING → TURNING → CLAPPING). It owns NO audio and NO DOM: it
 * tracks which lesson we're on, whether the lesson's gate has been satisfied
 * (e.g. the player took enough practice steps / turned far enough / clapped),
 * and advance/skip/complete. The spoken instructions + practice harness wiring
 * live in tutorial.ts (ear/screen-reader-verified).
 *
 * Completion persistence (localStorage) lives in onboardingStore.ts.
 */

export type Lesson = 'stepping' | 'turning' | 'clapping';

/** Ordered lessons. `complete()` runs off the end of this. */
export const LESSONS: Lesson[] = ['stepping', 'turning', 'clapping'];

/** How many qualifying actions satisfy each lesson's practice gate. */
export const LESSON_GOAL: Record<Lesson, number> = {
  stepping: 4, // a few alternating steps
  turning: 1, // turn toward the tone once
  clapping: 1, // one clap
};

export interface TutorialSnapshot {
  /** Current lesson, or null once the whole tutorial is finished. */
  lesson: Lesson | null;
  /** Progress within the current lesson (qualifying actions counted). */
  progress: number;
  /** Whether the current lesson's gate is satisfied (player may advance). */
  gateMet: boolean;
  /** Index of the current lesson (0-based), or LESSONS.length when finished. */
  index: number;
  done: boolean;
}

export class TutorialMachine {
  private index = 0;
  private progress = 0;
  private finished = false;

  get lesson(): Lesson | null {
    return this.finished ? null : LESSONS[this.index] ?? null;
  }

  snapshot(): TutorialSnapshot {
    const lesson = this.lesson;
    return {
      lesson,
      progress: this.progress,
      gateMet: this.gateMet(),
      index: this.finished ? LESSONS.length : this.index,
      done: this.finished,
    };
  }

  /** Goal count for the current lesson (0 when finished). */
  private goal(): number {
    const l = this.lesson;
    return l ? LESSON_GOAL[l] : 0;
  }

  /** Has the player done enough to advance from the current lesson? */
  gateMet(): boolean {
    if (this.finished) return true;
    return this.progress >= this.goal();
  }

  /**
   * Record one qualifying practice action for the current lesson (a good step, a
   * completed turn, a clap). Caps at the goal. Returns the new progress.
   */
  recordAction(n = 1): number {
    if (this.finished) return this.progress;
    this.progress = Math.min(this.goal(), this.progress + Math.max(0, n));
    return this.progress;
  }

  /**
   * Advance to the next lesson. Only proceeds when the gate is met (use `skip` to
   * force). Returns the new lesson (or null when it completes the tutorial).
   */
  next(): Lesson | null {
    if (this.finished) return null;
    if (!this.gateMet()) return this.lesson;
    return this.advance();
  }

  /** Skip the current lesson regardless of its gate. */
  skip(): Lesson | null {
    if (this.finished) return null;
    return this.advance();
  }

  private advance(): Lesson | null {
    this.index += 1;
    this.progress = 0;
    if (this.index >= LESSONS.length) {
      this.finished = true;
      this.index = LESSONS.length;
    }
    return this.lesson;
  }

  /** Skip the ENTIRE remaining tutorial (the "skip tutorial" button). */
  skipAll() {
    this.finished = true;
    this.index = LESSONS.length;
    this.progress = 0;
  }

  get done(): boolean {
    return this.finished;
  }

  /** Restart from the first lesson (for replay). */
  reset() {
    this.index = 0;
    this.progress = 0;
    this.finished = false;
  }
}
