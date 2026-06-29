import { describe, it, expect } from 'vitest';
import {
  makeMonster,
  updateMonster,
  caught,
  decayedLoudness,
  DEFAULT_NOISE_THRESHOLD,
  DEFAULT_CATCH_RADIUS,
} from '../src/game/monster';
import { makeNoiseEvent, type NoiseEvent, NOISE_DECAY_MS } from '../src/game/noiseEvents';

const stepNoise = (x: number, z: number, tMs: number, mat = 'concrete'): NoiseEvent =>
  makeNoiseEvent('step', x, z, mat, tMs);

describe('monster AI core (pure)', () => {
  it('moves toward the last-noise location', () => {
    let m = makeMonster(0, 0, 1); // 1 m/s
    const n = stepNoise(10, 0, 0);
    m = updateMonster(m, n, 100, 100); // 0.1 s → up to 0.1 m
    expect(m.x).toBeGreaterThan(0);
    expect(m.x).toBeLessThanOrEqual(0.1 + 1e-9);
    expect(m.z).toBeCloseTo(0);
    expect(m.phase).toBe('investigate');
    expect(m.target).toEqual({ x: 10, z: 0 });
  });

  it('never moves more than speed*dt in one step', () => {
    let m = makeMonster(0, 0, 2); // 2 m/s
    const n = stepNoise(100, 0, 0);
    const dt = 250; // 0.25 s → max 0.5 m
    const before = { x: m.x, z: m.z };
    m = updateMonster(m, n, 0, dt);
    const moved = Math.hypot(m.x - before.x, m.z - before.z);
    expect(moved).toBeLessThanOrEqual(2 * (dt / 1000) + 1e-9);
    expect(moved).toBeCloseTo(0.5, 6);
  });

  it('retargets when a newer (still-loud) noise arrives', () => {
    let m = makeMonster(0, 0, 100); // fast, to reach quickly
    m = updateMonster(m, stepNoise(5, 0, 0), 10, 10);
    expect(m.target).toEqual({ x: 5, z: 0 });
    // A newer noise elsewhere, fresh → retarget.
    m = updateMonster(m, stepNoise(-5, 0, 20), 25, 10);
    expect(m.target).toEqual({ x: -5, z: 0 });
    expect(m.targetTMs).toBe(20);
  });

  it('does NOT retarget to a faded/stale noise below threshold (evasion)', () => {
    let m = makeMonster(0, 0, 1);
    // First a loud fresh noise it commits to.
    m = updateMonster(m, stepNoise(5, 0, 0), 0, 10);
    expect(m.target).toEqual({ x: 5, z: 0 });
    // A NEWER but quiet noise that has decayed below threshold by `now`.
    const quiet: NoiseEvent = { x: -50, z: 0, loudness: 0.3, kind: 'step', tMs: 100 };
    // Choose now far enough out that decayedLoudness < threshold.
    const now = 100 + NOISE_DECAY_MS * 5; // exp(-5) ≈ 0.0067 → 0.3*0.0067 ≈ 0.002
    expect(decayedLoudness(quiet, now)).toBeLessThan(DEFAULT_NOISE_THRESHOLD);
    m = updateMonster(m, quiet, now, 10);
    // Target unchanged — the stale noise did not attract.
    expect(m.target).toEqual({ x: 5, z: 0 });
  });

  it('reaches and idles at the target', () => {
    let m = makeMonster(0, 0, 100);
    const n = stepNoise(1, 0, 0);
    m = updateMonster(m, n, 10, 100); // fast enough to arrive
    expect(m.x).toBeCloseTo(1);
    expect(m.z).toBeCloseTo(0);
    expect(m.phase).toBe('idle');
    // Stays put with no fresh noise.
    const stale = m;
    m = updateMonster(m, n, 200, 100); // same (not newer) noise
    expect(m.x).toBeCloseTo(stale.x);
    expect(m.z).toBeCloseTo(stale.z);
    expect(m.phase).toBe('idle');
  });

  it('idles in place with no noise', () => {
    let m = makeMonster(3, 4, 1);
    m = updateMonster(m, null, 0, 100);
    expect(m.x).toBe(3);
    expect(m.z).toBe(4);
    expect(m.phase).toBe('idle');
  });
});

describe('catch test (real proximity)', () => {
  it('caught within radius of the PLAYER position', () => {
    const m = makeMonster(0, 0, 1);
    expect(caught(m, 0.5, 0, DEFAULT_CATCH_RADIUS)).toBe(true);
  });
  it('not caught when far', () => {
    const m = makeMonster(0, 0, 1);
    expect(caught(m, 5, 5, DEFAULT_CATCH_RADIUS)).toBe(false);
  });
});

describe('silent player evades (headline behavior)', () => {
  it('monster ends at the stale loud-noise spot, not on the player', () => {
    // Player at origin makes ONE loud noise, then walks away making no fresh
    // attractive noise. The monster homes on the loud spot and lingers there;
    // distance to the (now distant) player grows.
    let m = makeMonster(20, 0, 2); // 2 m/s, starts 20 m away on +x
    const loud = makeNoiseEvent('stumble', 0, 0, 'concrete', 0); // loudness 1.0 at origin

    let playerX = 0;
    const noiseForFrame = (frame: number): NoiseEvent | null => {
      // Frame 0: the loud noise. Afterwards: the SAME last noise persists in the
      // tracker (player makes no new noise while sneaking) — it's not newer, so it
      // never re-attracts, and it decays. We pass `loud` every frame to mirror the
      // tracker returning the last (unchanging) noise.
      return frame === 0 ? loud : loud;
    };

    let now = 0;
    const dt = 200; // 0.2 s frames
    for (let frame = 0; frame < 100; frame++) {
      now = frame * dt;
      m = updateMonster(m, noiseForFrame(frame), now, dt);
      // Player tiptoes away in -x making no new noise.
      playerX -= 0.1;
    }

    // Monster homed on the loud spot (origin) and idles there.
    expect(Math.hypot(m.x - 0, m.z - 0)).toBeLessThan(0.3);
    expect(m.phase).toBe('idle');
    // Player is far from both the spot and the monster — evaded.
    const distToPlayer = Math.hypot(m.x - playerX, m.z - 0);
    expect(distToPlayer).toBeGreaterThan(5);
    expect(caught(m, playerX, 0)).toBe(false);
  });

  it('a fresh-but-quiet noise every frame never attracts (decay/threshold lever)', () => {
    // Unlike the test above (where evasion is via the not-newer guard), here the
    // player emits a NEWER noise each frame while tiptoeing on soft floor — so the
    // newer-check would let it through; only the decay/threshold lever stops the
    // chase. Each frame's noise is quiet enough that decayedLoudness < threshold,
    // so the monster must never retarget onto the moving player.
    let m = makeMonster(20, 0, 2); // 2 m/s, starts 20 m away on +x
    let now = 0;
    const dt = 200;
    let playerX = 0;
    let everTargeted = false;
    for (let frame = 0; frame < 100; frame++) {
      now = frame * dt;
      // A foam step at the player's CURRENT position, stamped NOW (always newer).
      const quiet = makeNoiseEvent('step', playerX, 0, 'acoustic_foam', now);
      // Sanity: this fresh noise is below the attract threshold even un-decayed.
      expect(decayedLoudness(quiet, now)).toBeLessThan(DEFAULT_NOISE_THRESHOLD);
      m = updateMonster(m, quiet, now, dt);
      if (m.target !== null) everTargeted = true;
      playerX -= 0.1; // tiptoe away in -x
    }
    // The quiet noises never became a target, so the monster never homed on the
    // player; it stayed put (no initial target) and the player escaped.
    expect(everTargeted).toBe(false);
    expect(Math.hypot(m.x - 20, m.z - 0)).toBeLessThan(0.3); // still near its spawn
    expect(caught(m, playerX, 0)).toBe(false);
  });
});

describe('decayedLoudness mirrors the noise decay', () => {
  it('matches loudness * exp(-dt/tau)', () => {
    const n = makeNoiseEvent('stumble', 0, 0, 'concrete', 0);
    expect(decayedLoudness(n, NOISE_DECAY_MS)).toBeCloseTo(n.loudness * Math.exp(-1), 6);
    expect(decayedLoudness(n, 0)).toBeCloseTo(n.loudness, 6);
  });
});
