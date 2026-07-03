/**
 * Movement trajectories + exercise definitions for the perceptual HRTF game.
 *
 * Every exercise moves a probe sound along a short (≤3 s) path around the
 * listener, because a MOVING source reveals HRTF quality far better than a static
 * one: smoothness, dead spots, and front/back or up/down transitions are all
 * motion phenomena. Each exercise targets ONE personalization parameter and, when
 * A/B, is auditioned twice (candidate A then candidate B) with a seamless
 * crossfade so the brain can't adapt between them.
 *
 * Two answer paradigms (see hrtfTuning.ts):
 *   • 'ab'    — "which felt smoother / more outside your head?" (preference)
 *   • 'guess' — "did it end up in front or behind / above or below?" The correct
 *               answer is known, so a wrong guess objectively penalizes that
 *               candidate. Best for front/back + elevation.
 *
 * Pure geometry — no audio, no DOM. `trajectory(t)` maps normalized time t∈[0,1]
 * to a listener-RELATIVE position (engine convention: +x right, +y up, −z front).
 * Unit-tested in tests/hrtfExercises.test.ts.
 */

export type Vec3 = readonly [number, number, number];
export type ExerciseParam = 'itdScale' | 'elevTilt' | 'frontBackTilt' | 'notchHz';
export type AnswerKind = 'ab' | 'guess';
// Re-exported so callers can drive the localization sampler from param metadata.
export type { SampleKind } from './hrtfLocalize';
import type { SampleKind } from './hrtfLocalize';

/**
 * Which sphere region the LOCALIZATION test should sample when tuning each parameter, so
 * the probe is diagnostic for that param (see hrtfLocalize.SampleKind). A param only shows
 * up in certain directions — e.g. testing front/back with a hard-left probe is wasted.
 */
export const PARAM_SAMPLE_KIND: Record<ExerciseParam, SampleKind> = {
  itdScale: 'lateral',        // interaural cues → lateral, near-horizontal
  elevTilt: 'elevation',      // elevation shelf → off the horizontal
  frontBackTilt: 'frontback', // front/back cue → median-plane / cone of confusion
  notchHz: 'elevation',       // pinna-notch elevation cue → off the horizontal
};

export interface Exercise {
  id: string;
  /** Which personalization scalar this exercise tunes. */
  param: ExerciseParam;
  kind: AnswerKind;
  /** Spoken/at-screen prompt describing the motion the listener should attend to. */
  prompt: string;
  /** Labels for the two answer buttons. For 'guess', index 0 is the CORRECT one. */
  choices: readonly [string, string];
  /** Seconds the motion takes (≤3). */
  durationSec: number;
  /** Listener-relative path; t∈[0,1]. Radius ~2 m so it's clearly external. */
  trajectory: (t: number) => Vec3;
}

const R = 2; // orbit radius (m)
const HEAD_Y = 1.6;

/** Horizontal orbit from front, around one side, to back — tests smoothness/dead spots. */
function sideArc(sign: number) {
  // sign +1 = right side, −1 = left. Sweep az from 0 (front) through ±90 to 180 (back).
  return (t: number): Vec3 => {
    const az = sign * Math.PI * t; // 0 → ±π
    const x = Math.sin(az) * R;
    const z = -Math.cos(az) * R; // t=0 front (−z), t=1 back (+z)
    return [x, HEAD_Y, z];
  };
}

/** Front→behind pass at head height (crossing the cone of front/back confusion). */
function frontBackPass(t: number): Vec3 {
  // Move along −z→+z holding a modest +x so it's not perfectly median (which is
  // maximally ambiguous) yet stays externalized as it crosses ear level; the tilt
  // cue should resolve which half (front/back) it's in.
  const z = -R + 2 * R * t; // front to back
  return [0.8, HEAD_Y, z];
}

/** Overhead pass: front-above-head → back-above-head (elevation transition). */
function overheadPass(t: number): Vec3 {
  const z = -R + 2 * R * t;
  return [0, HEAD_Y + 1.2, z]; // clearly above the head throughout
}

/** Vertical rise directly ahead: eye level → overhead. */
function riseAhead(t: number): Vec3 {
  const y = HEAD_Y + t * 1.6;
  return [0, y, -R];
}

/** Straight left→right pass in front (ear-to-ear); tests width / left-right balance. */
function leftRightPass(t: number): Vec3 {
  const x = -R + 2 * R * t; // −R (left) … +R (right)
  return [x, HEAD_Y, -1.2]; // held a bit in front so it's clearly frontal
}

/** Quarter arc on the RIGHT: back-right → right → front-right. A partial orbit that
 *  should have NO dead spot as it comes around the side (the user's own suggestion). */
function backToFrontRightArc(t: number): Vec3 {
  // az from 135° (back-right) sweeping to 45° (front-right).
  const az = (135 - 90 * t) * (Math.PI / 180);
  const x = Math.sin(az) * R; // +x right
  const z = -Math.cos(az) * R;
  return [x, HEAD_Y, z];
}

/** A tilted "rainbow" pass: front-low → overhead → back-low. Combines height + f/b. */
function archOverhead(t: number): Vec3 {
  const z = -R + 2 * R * t; // front → back
  const y = HEAD_Y + Math.sin(t * Math.PI) * 1.5; // rises then falls — an arch
  return [0, y, z];
}

// Every sweep is 3 s — long enough to actually feel the motion (a quick sweep is
// unreadable), short enough to stay under the brain-adaptation window per pass.
const DUR = 3;

export const EXERCISES: readonly Exercise[] = [
  // ---- FRONT / BACK (most important — fix this first) --------------------------
  {
    id: 'frontback-line',
    param: 'frontBackTilt',
    kind: 'guess',
    prompt:
      'A sound moved away from you along one straight line. Did it pass IN FRONT of you, or go BEHIND you?',
    choices: ['It went BEHIND me', 'It stayed IN FRONT'],
    durationSec: DUR,
    trajectory: frontBackPass,
  },
  {
    id: 'frontback-arc',
    param: 'frontBackTilt',
    kind: 'guess',
    prompt:
      'A sound arced along your right side. Did it END UP in FRONT of you, or BEHIND you?',
    choices: ['It ended BEHIND', 'It ended in FRONT'],
    durationSec: DUR,
    trajectory: backToFrontRightArc,
  },
  // ---- WIDTH / LEFT-RIGHT (externalization) -----------------------------------
  {
    id: 'width-orbit',
    param: 'itdScale',
    kind: 'ab',
    prompt:
      'A sound circled from in front, around your right side, to behind you — once per version. Which version felt more OUTSIDE your head, going cleanly around you?',
    choices: ['more outside the head', 'more outside the head'],
    durationSec: DUR,
    trajectory: sideArc(1),
  },
  {
    id: 'width-leftright',
    param: 'itdScale',
    kind: 'ab',
    prompt:
      'A sound passed straight from your LEFT to your RIGHT. Which version stretched fully out to each side, rather than staying close to your head?',
    choices: ['wider / more to the sides', 'wider / more to the sides'],
    durationSec: DUR,
    trajectory: leftRightPass,
  },
  // ---- ELEVATION (up / down) --------------------------------------------------
  {
    id: 'elev-overhead',
    param: 'notchHz',
    kind: 'guess',
    prompt:
      'A sound travelled over the top of your head, front to back. Did it pass ABOVE you, or straight through at EAR LEVEL?',
    choices: ['It passed ABOVE me', 'It felt at EAR LEVEL'],
    durationSec: DUR,
    trajectory: overheadPass,
  },
  {
    id: 'elev-rise',
    param: 'notchHz',
    kind: 'guess',
    prompt:
      'A sound directly ahead rose upward. Did it clearly climb UP, or just get brighter in place?',
    choices: ['It moved UP', 'It stayed in PLACE'],
    durationSec: DUR,
    trajectory: riseAhead,
  },
  {
    id: 'elev-arch',
    param: 'notchHz',
    kind: 'guess',
    prompt:
      'A sound arched like a rainbow from in front, up over you, to behind. Did it clearly go OVERHEAD, or stay low and flat?',
    choices: ['It went OVERHEAD', 'It stayed LOW'],
    durationSec: DUR,
    trajectory: archOverhead,
  },
  // ---- SMOOTHNESS (dead spots) ------------------------------------------------
  {
    id: 'smoothness-orbit',
    param: 'itdScale',
    kind: 'ab',
    prompt:
      'A sound orbited around you. Which version was SMOOTHER — no jumps or dead spots as it crossed the sides?',
    choices: ['smoother, no dead spots', 'smoother, no dead spots'],
    durationSec: DUR,
    trajectory: (t) => sideArc(1)(t < 0.5 ? t * 2 : 2 - t * 2),
  },
];

/** Default staircase config per parameter (coarse first step, halving to fine). */
export const STAIRCASE_CONFIG: Record<ExerciseParam, {
  start: number; step: number; minStep: number; min: number; max: number;
}> = {
  itdScale: { start: 1, step: 0.5, minStep: 0.06, min: 0.5, max: 2.0 },
  elevTilt: { start: 0, step: 9, minStep: 2, min: -18, max: 18 },
  frontBackTilt: { start: 0, step: 9, minStep: 2, min: -18, max: 18 },
  // Pinna-notch centre: sweep the 4–11 kHz range to find where "up" locks for you.
  notchHz: { start: 7500, step: 2000, minStep: 400, min: 4000, max: 11500 },
};
