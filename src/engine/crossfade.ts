/**
 * Crossfade between two parallel audio chains (e.g. two convolvers carrying
 * different room IRs / HRIR pairs) WITHOUT overshooting full-scale mid-swap.
 *
 * The subtlety: which crossfade shape is safe depends on signal correlation.
 *  - DECORRELATED signals add as power → equal-power (sin/cos) keeps level flat,
 *    but for CORRELATED signals it overshoots by up to √2 (≈ +3 dB).
 *  - CORRELATED signals add as amplitude → a LINEAR pair (gains sum to exactly 1)
 *    keeps level flat, but slightly dips power for decorrelated ones.
 *
 * Our spatializers swap between IRs for ADJACENT listener orientations of a
 * CONTINUOUS source (beacon tone, monster growl). Across a small head turn those two
 * convolved outputs are highly correlated, so the dangerous case is amplitude
 * addition → we use a LINEAR crossfade whose gains sum to 1 at every instant. That
 * removes the mid-turn overshoot that was clipping ("farting") on fast spins. We
 * schedule it as an exact curve (`setValueCurveAtTime`), not an asymptotic
 * `setTargetAtTime` (whose two exponentials never sum to 1).
 */
export function linearCrossfade(
  gainIn: AudioParam,
  gainOut: AudioParam,
  t: number,
  dur: number,
  steps = 32,
): void {
  const inCurve = new Float32Array(steps);
  const outCurve = new Float32Array(steps);
  for (let i = 0; i < steps; i++) {
    const x = i / (steps - 1); // 0 → 1, linear
    inCurve[i] = x; // 0 → 1
    outCurve[i] = 1 - x; // 1 → 0  (inCurve + outCurve === 1 at every step)
  }
  gainIn.cancelScheduledValues(t);
  gainOut.cancelScheduledValues(t);
  gainIn.setValueCurveAtTime(inCurve, t, dur);
  gainOut.setValueCurveAtTime(outCurve, t, dur);
}
