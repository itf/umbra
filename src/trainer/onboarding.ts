/**
 * PURE first-launch "blind reference" onboarding for the Echolocation Trainer.
 *
 * Goal: prove the skill exists in minute one. On the FIRST ever launch we force a
 * single, maximally-easy size discrimination — two extreme room sizes, "Which is
 * LARGER?" — then reveal "You just used echolocation." After that it never repeats
 * (gated by a persisted flag in TrainerStore).
 *
 * This module is the PURE part: the gating decision and the onboarding question
 * builder. trainer.ts owns the flag read/write + playback. No DOM, no audio.
 */
import { makeQuestion, type Question } from './exercises';

/**
 * Should the blind-reference onboarding run? Only on first launch (the persisted
 * flag is false) AND not in daily-challenge mode (daily is its own flow we mustn't
 * hijack). Pure so the first-launch-only rule is unit-testable.
 */
export function shouldRunOnboarding(opts: { hasSeen: boolean; daily: boolean }): boolean {
  return !opts.hasSeen && !opts.daily;
}

/**
 * The onboarding question: the existing `larger` exercise at difficulty 0 (max
 * contrast — clearly small vs clearly large), built from a fixed seed so the
 * reference trial is the same crisp, easy pair for everyone. Reuses the real
 * generator so playback goes through the identical path as a normal question.
 */
export function onboardingQuestion(): Question {
  return makeQuestion('larger', 0xb11d, { difficulty: 0 });
}

/** The post-answer reveal that names the skill (spoken + shown). */
export const ONBOARDING_REVEAL =
  'You just used echolocation — you heard the room size from the echo. ' +
  'Now your real practice begins.';
