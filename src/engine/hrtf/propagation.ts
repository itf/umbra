/**
 * Pure propagation-delay / Doppler physics, separated from Web Audio so it can be
 * unit-tested deterministically (vitest has no AudioContext).
 *
 * The renderer feeds these numbers into a per-source `DelayNode`: the delay time
 * is `distance / speedOfSound`. When a source moves, that delay changes smoothly
 * and the DelayNode resamples its buffer — which IS Doppler, for free and
 * physically correct (no separately-computed detune). See
 * docs/engine/doppler-and-propagation-delay.md.
 */

import { DEFAULT_SPEED_OF_SOUND } from '../acoustics/core';

/**
 * Largest delay (seconds) a source DelayNode is sized for. 2 s ≈ 686 m at 343 m/s.
 * Sources farther than `maxDelaySec × c` will have their arrival delay CLAMPED to
 * this cap (they still play, just without honest extra lag). Plenty for any game
 * scene; raising it only costs a little memory per source.
 */
export const DEFAULT_MAX_DELAY_SEC = 2;

/** Propagation delay in seconds for a straight path of `dist` metres at speed `c`. */
export function propagationDelaySec(
  dist: number,
  speedOfSound: number = DEFAULT_SPEED_OF_SOUND,
): number {
  if (!(speedOfSound > 0)) return 0;
  return Math.max(0, dist) / speedOfSound;
}

/** Clamp a propagation delay to the DelayNode's allocated maximum. */
export function clampDelaySec(delaySec: number, maxDelaySec: number): number {
  return Math.min(Math.max(0, delaySec), maxDelaySec);
}

/**
 * Predicted Doppler frequency ratio (observed / emitted) for a source approaching
 * (or receding from) the listener at radial speed `vRadial` (m/s, positive =
 * CLOSING the gap / approaching), with a stationary listener.
 *
 * Standard Doppler for a moving source, stationary observer:
 *   f_obs / f_src = c / (c − v_src_toward_observer)
 *
 * This is what the delay-line modulation reproduces automatically; we expose it
 * only as a prediction the tests assert the delay math against (the rate of change
 * of delay equals −v_radial / c, and the resampling ratio is 1/(1 + d(delay)/dt)).
 */
export function dopplerRatio(
  vRadial: number,
  speedOfSound: number = DEFAULT_SPEED_OF_SOUND,
): number {
  const denom = speedOfSound - vRadial;
  if (!(denom > 0)) return Infinity; // source at/over the speed of sound: shock
  return speedOfSound / denom;
}

/**
 * The instantaneous resampling ratio (observed/emitted frequency) a variable
 * delay line produces, given the delay's rate of change `dDelayDt` (seconds per
 * second). A shrinking delay (source approaching ⇒ dDelay/dt < 0) raises pitch.
 *
 *   ratio = 1 / (1 + dDelay/dt)
 *
 * With dDelay/dt = −v_radial / c this reduces exactly to `dopplerRatio`, which is
 * the proof that the delay line gives correct Doppler.
 */
export function delayResampleRatio(dDelayDt: number): number {
  const denom = 1 + dDelayDt;
  if (!(denom > 0)) return Infinity;
  return 1 / denom;
}
