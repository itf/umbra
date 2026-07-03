/**
 * Tests the calibration RESULTS-screen content logic (pure): the "what was tuned" summary
 * and the early-vs-recent accuracy line the completion screen composes its copy from.
 *
 * The completion CONTRACT (finishing shows the results screen + auto-saves last-best, and
 * NEVER auto-calls onDone — onDone fires only from the explicit "Continue to volume setup"
 * button) lives in locFinish/renderResults in hrtfTuning.ts; it's a DOM/audio flow with no
 * headless harness (worklets hang under the test runner), so it's guaranteed structurally
 * (there is exactly ONE deps.onDone() call, on the Continue button) rather than driven here.
 */
import { describe, it, expect } from 'vitest';
import { tunedSummary, accuracyLine } from '../src/ui/hrtfTuning';
import { NEUTRAL_PERSONALIZATION } from '../src/engine/hrtf/personalize';

describe('tunedSummary (results: what was tuned)', () => {
  it('lists the factors that moved from neutral', () => {
    const s = tunedSummary({ ...NEUTRAL_PERSONALIZATION, frontBackTilt: 8, notchDepth: 12, upDownBias: 0.4 });
    expect(s).toMatch(/front\/back/);
    expect(s).toMatch(/up\/down \(ear shape\)/);
    expect(s).toMatch(/up\/down bias/);
  });
  it('flags real-ear shape when a PCA weight is nonzero', () => {
    expect(tunedSummary({ ...NEUTRAL_PERSONALIZATION, pcaWeights: [0, 0, 1.2] })).toMatch(/real-ear shape/);
  });
  it('flags width + forward/back bias', () => {
    const s = tunedSummary({ ...NEUTRAL_PERSONALIZATION, itdScale: 1.3, frontBackBias: -0.5 });
    expect(s).toMatch(/width/);
    expect(s).toMatch(/forward\/back bias/);
  });
  it('says "kept default" when nothing moved', () => {
    expect(tunedSummary({ ...NEUTRAL_PERSONALIZATION })).toMatch(/kept your sound close to the default/);
  });
});

describe('accuracyLine (results: aim improvement)', () => {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  it('reports improvement early→recent when aim tightened', () => {
    const hist = [rad(40), rad(38), rad(42), rad(12), rad(10), rad(11)];
    expect(accuracyLine(hist)).toMatch(/improved from about 40° to about 11° off/);
  });
  it('reports steady when it did not improve', () => {
    const hist = [rad(15), rad(14), rad(16), rad(15), rad(14), rad(15)];
    expect(accuracyLine(hist)).toMatch(/held steady at about 15° off/);
  });
  it('falls back to recent mean with little history', () => {
    expect(accuracyLine([rad(20), rad(22)])).toMatch(/recent aim was about 21° off/);
  });
  it('is empty with no history', () => {
    expect(accuracyLine([])).toBe('');
  });
});
