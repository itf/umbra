/**
 * CLICK-FREE MODELED REFLECTIONS — step-discontinuity acceptance.
 *
 * The modeled beacon used to render reflections by swapping a whole-room reflection IR
 * into a ConvolverNode — the same buffer-swap reset that clicked the DIRECT path while
 * turning. The fix renders the strongest N reflections as individual click-free
 * InterpolatingHrtfSources, positioned at each reflection's IMAGE-SOURCE world location
 * (listener + dir * delay*c), so each rotates with the head via the continuously
 * interpolating worklet and never resets a convolution → no click.
 *
 * node-web-audio-api's OfflineAudioContext HANGS on audioWorklet.addModule, so (like
 * tests/interpolatingHrtf.test.ts) we drive the PURE DSP the worklet wraps: the
 * per-reflection image-source positions (computeReflectImages) feeding HrtfDsp, while
 * the head yaws 0→60° at the real UI rate. We assert the worst sample STEP stays in the
 * clean band (~0.02-0.03) and well below an OLD-style hard-swap reflection convolver
 * (which clicks on every bucket/IR change).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sphericalToVec, nearestDir, type HrtfSet } from '../src/engine/hrtf/sofa';
import { precomputeMinPhase, HrtfDsp } from '../src/engine/hrtf/interpolatingDsp';
import { computeReflectImages, assignReflectSlots, type ReflectImage } from '../src/engine/acoustics/modeledSource';
import type { Tap } from '../src/engine/acoustics/core';

const here = dirname(fileURLToPath(import.meta.url));

function loadHrtfFromDisk(path: string): HrtfSet {
  const data = readFileSync(path);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 4 + 4;
  const sampleRate = dv.getFloat32(o, true); o += 4;
  const count = dv.getUint32(o, true); o += 4;
  const taps = dv.getUint32(o, true); o += 4;
  const dirs = new Float32Array(count * 3);
  for (let m = 0; m < count; m++) {
    const az = dv.getFloat32(o, true); o += 4;
    const el = dv.getFloat32(o, true); o += 4;
    const [x, y, z] = sphericalToVec(az, el);
    dirs[m * 3] = x; dirs[m * 3 + 1] = y; dirs[m * 3 + 2] = z;
  }
  const irs = new Float32Array(count * 2 * taps);
  for (let i = 0; i < irs.length; i++) { irs[i] = dv.getFloat32(o, true); o += 4; }
  return { sampleRate, taps, count, dirs, irs };
}

function worstStep(buf: Float32Array, start: number, end: number): number {
  let m = 0;
  for (let i = Math.max(1, start); i < end; i++) {
    const d = Math.abs(buf[i] - buf[i - 1]);
    if (d > m) m = d;
  }
  return m;
}

/** World→head-relative direction (inverse yaw rotation). */
function worldToHead(dx: number, dy: number, dz: number, yaw: number): [number, number, number] {
  const c = Math.cos(-yaw), s = Math.sin(-yaw);
  return [dx * c - dz * s, dy, dx * s + dz * c];
}

describe('modeled reflections — click-free interpolating render (acceptance)', () => {
  const hrtfPath = resolve(here, '../assets/hrtf/sadie_h3.hrtf');
  let set: HrtfSet;
  let SR = 48000;
  const BLOCK = 128;
  const FREQ = 440;
  const C = 343;
  const TURN_RATE = (100 * Math.PI) / 180; // rad/s
  const SECS = 0.6;
  const LISTENER: [number, number, number] = [0, 1.6, 0];

  // A few static reflection taps off WORLD-fixed walls (image sources around the room).
  // dir = unit listener→image-source (world); gain = broadband 1/r; delay = dist/c.
  function mkTap(dir: [number, number, number], dist: number, order = 1): Tap {
    const len = Math.hypot(...dir) || 1;
    const d: [number, number, number] = [dir[0] / len, dir[1] / len, dir[2] / len];
    return { dir: d, delay: dist / C, gain: 1 / Math.max(1, dist), order, bandGains: [] };
  }
  const reflectTaps: Tap[] = [
    mkTap([1, 0, 0.2], 3),    // right wall
    mkTap([-1, 0, 0.1], 4),   // left wall
    mkTap([0.3, 0, 1], 5),    // back wall
    mkTap([0.1, 0, -1], 6),   // front wall
  ];

  beforeAll(() => {
    set = loadHrtfFromDisk(hrtfPath);
    SR = set.sampleRate;
  });

  it('reflections rotate click-free: worst step in clean band, far below hard-swap', () => {
    const mp = precomputeMinPhase(set);
    const images = computeReflectImages(reflectTaps, LISTENER, C, 6);
    const active = images.filter((im) => im.active);
    expect(active.length).toBe(reflectTaps.length); // 4 taps → 4 active slots

    // One HrtfDsp per active reflection (the pooled InterpolatingHrtfSources). Each is
    // driven with the head-relative direction of its WORLD-FIXED image source as the
    // head yaws — i.e. setPosition each block → smooth interpolation.
    const dsps = active.map(() => new HrtfDsp(mp, 4));
    const n = Math.floor(SECS * SR);
    const outL = new Float32Array(n);
    const oL = new Float32Array(BLOCK);
    const oR = new Float32Array(BLOCK);
    const inBlk = new Float32Array(BLOCK);
    let phase = 0;
    const dp = (2 * Math.PI * FREQ) / SR;
    for (let off = 0; off + BLOCK <= n; off += BLOCK) {
      const t = off / SR;
      const yaw = TURN_RATE * t;
      for (let j = 0; j < active.length; j++) {
        const p = active[j].pos;
        const [hx, hy, hz] = worldToHead(p[0] - LISTENER[0], p[1] - LISTENER[1], p[2] - LISTENER[2], yaw);
        dsps[j].setDirection(hx, hy, hz);
      }
      for (let i = 0; i < BLOCK; i++) { inBlk[i] = 0.5 * Math.sin(phase); phase += dp; }
      const accL = new Float32Array(BLOCK);
      for (let j = 0; j < active.length; j++) {
        dsps[j].process(inBlk, oL, oR);
        for (let i = 0; i < BLOCK; i++) accL[i] += active[j].gain * oL[i];
      }
      outL.set(accL, off);
    }
    const start = set.taps + 4 * BLOCK;
    const end = Math.floor(n / BLOCK) * BLOCK;
    const stepNew = worstStep(outL, start, end);

    // --- OLD-style hard-swap reflection convolver: sum the 4 reflections, each rendered
    // by a nearest-IR convolver that HARD-SWAPS its IR on bucket change (the click). ---
    const oldOut = new Float32Array(n);
    const hist = active.map(() => new Float32Array(set.taps));
    const hp = active.map(() => 0);
    const lastIdx = active.map(() => -1);
    const curIr = active.map(() => new Float32Array(set.taps));
    phase = 0;
    for (let i = 0; i < n; i++) {
      if (i % BLOCK === 0) {
        const t = i / SR;
        const yaw = TURN_RATE * t;
        for (let j = 0; j < active.length; j++) {
          const p = active[j].pos;
          const [hx, hy, hz] = worldToHead(p[0] - LISTENER[0], p[1] - LISTENER[1], p[2] - LISTENER[2], yaw);
          const len = Math.hypot(hx, hy, hz) || 1;
          const idx = nearestDir(set, hx / len, hy / len, hz / len);
          if (idx !== lastIdx[j]) {
            lastIdx[j] = idx;
            curIr[j] = set.irs.slice(idx * 2 * set.taps, idx * 2 * set.taps + set.taps);
          }
        }
      }
      const xv = 0.5 * Math.sin(phase); phase += dp;
      let acc = 0;
      for (let j = 0; j < active.length; j++) {
        hist[j][hp[j]] = xv;
        hp[j] = (hp[j] + 1) % set.taps;
        let a = 0; let p = hp[j] - 1; if (p < 0) p += set.taps;
        for (let tk = 0; tk < set.taps; tk++) { a += hist[j][p] * curIr[j][tk]; p--; if (p < 0) p += set.taps; }
        acc += active[j].gain * a;
      }
      oldOut[i] = acc;
    }
    const stepOld = worstStep(oldOut, start, end);

    // eslint-disable-next-line no-console
    console.log(`[reflect-step] NEW=${stepNew.toFixed(4)}  OLD (hard-swap)=${stepOld.toFixed(4)}  old/new=${(stepOld / stepNew).toFixed(1)}x`);

    expect(stepNew).toBeLessThan(0.04);          // clean band (brief: ~0.02-0.03)
    expect(stepNew).toBeLessThan(stepOld * 0.7); // clearly below the swap reference
    let peak = 0; for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(outL[i]));
    expect(peak).toBeGreaterThan(0.001);
  });

  it('computeReflectImages: image at listener + dir*delay*c, gain passthrough, N padding', () => {
    const imgs = computeReflectImages(reflectTaps, LISTENER, C, 6);
    expect(imgs.length).toBe(6);
    // first 4 active, sorted loudest (smallest distance) first
    expect(imgs[0].active).toBe(true);
    expect(imgs[4].active).toBe(false);
    expect(imgs[5].gain).toBe(0);
    // strongest tap is the 3 m one (gain 1/3); its image sits 3 m along its dir
    const dist = Math.hypot(
      imgs[0].pos[0] - LISTENER[0], imgs[0].pos[1] - LISTENER[1], imgs[0].pos[2] - LISTENER[2],
    );
    expect(dist).toBeCloseTo(3, 5);
    expect(imgs[0].gain).toBeCloseTo(1 / 3, 5);
  });

  it('reshuffle of the strong-N set stays click-free with stable slot assignment', () => {
    const mp = precomputeMinPhase(set);

    // More reflections than slots (N=3 slots, 6 taps) so the strong-3 MEMBERSHIP
    // churns as their gains change with yaw — forcing slot reassignment mid-turn.
    const NSLOTS = 3;
    // Six image sources spread around the listener at distinct directions/distances.
    const dirs: Array<[number, number, number]> = [
      [1, 0, 0.2], [-1, 0, 0.1], [0.3, 0, 1], [0.1, 0, -1], [0.7, 0, -0.7], [-0.6, 0, -0.5],
    ];
    const dists = [3, 4, 5, 6, 4.5, 5.5];
    // Per-tap gain that VARIES with yaw so the top-3 set reshuffles during the turn
    // (mimics yaw-dependent occlusion/visibility of reflectors). Phase-shifted sinusoids.
    const baseTaps = (yaw: number): Tap[] =>
      dirs.map((dir, i) => {
        const len = Math.hypot(...dir) || 1;
        const d: [number, number, number] = [dir[0] / len, dir[1] / len, dir[2] / len];
        const wobble = 0.5 + 0.5 * Math.sin(yaw * 3 + (i * Math.PI) / 3); // 0..1
        return { dir: d, delay: dists[i] / C, gain: (1 / dists[i]) * wobble, order: 1, bandGains: [] };
      });

    // Run the full per-frame + throttled-solve loop with a pluggable slot strategy.
    // strategy 'stable' uses assignReflectSlots; 'positional' binds image[i]→slot i
    // (the OLD teleporting behaviour: a slot can jump to an unrelated reflection).
    function render(strategy: 'stable' | 'positional'): number {
      const dsps = Array.from({ length: NSLOTS }, () => new HrtfDsp(mp, 4));
      // held per-slot state (mirrors ModeledSource.reflectImages)
      let held: ReflectImage[] = Array.from({ length: NSLOTS }, () => ({ active: false, pos: [0, 0, 0], gain: 0 } as ReflectImage));
      const slotGain = new Array<number>(NSLOTS).fill(0);     // ramped gain (current)
      const slotTarget = new Array<number>(NSLOTS).fill(0);   // ramp target
      const slotPos: Array<[number, number, number]> = Array.from({ length: NSLOTS }, () => [0, 0, 0] as [number, number, number]);
      const slotActive = new Array<boolean>(NSLOTS).fill(false);

      const n = Math.floor(SECS * SR);
      const out = new Float32Array(n);
      const oL = new Float32Array(BLOCK);
      const oR = new Float32Array(BLOCK);
      const inBlk = new Float32Array(BLOCK);
      let phase = 0;
      const dp = (2 * Math.PI * FREQ) / SR;
      let lastSolveT = -1;
      const SOLVE_DT = 0.07; // 70 ms throttle (matches engine)
      const RAMP_PER_BLOCK = BLOCK / SR / 0.03; // one-pole-ish step toward target

      for (let off = 0; off + BLOCK <= n; off += BLOCK) {
        const t = off / SR;
        const yaw = TURN_RATE * t;

        // --- throttled solve: recompute strong-N + (re)assign slots ---
        if (t - lastSolveT >= SOLVE_DT) {
          lastSolveT = t;
          const images = computeReflectImages(baseTaps(yaw), LISTENER, C, NSLOTS);
          if (strategy === 'stable') {
            const assign = assignReflectSlots(held, images);
            const next: ReflectImage[] = [];
            for (let s = 0; s < NSLOTS; s++) {
              const a = assign[s];
              if (a.active && a.image) {
                slotPos[s] = a.image.pos; slotActive[s] = true;
                slotTarget[s] = a.image.gain; next.push(a.image);
              } else {
                slotActive[s] = false; slotTarget[s] = 0;
                next.push({ ...held[s], active: false, gain: 0 });
              }
            }
            held = next;
          } else {
            // OLD positional: slot i := images[i] (teleports a slot to an unrelated
            // reflection whenever the sort order changes), reposition immediately.
            for (let s = 0; s < NSLOTS; s++) {
              const img = images[s];
              slotActive[s] = img.active;
              slotPos[s] = img.pos;
              slotTarget[s] = img.active ? img.gain : 0;
            }
            held = images;
          }
        }

        // --- per-frame: head-track each active slot + advance gain ramp ---
        for (let s = 0; s < NSLOTS; s++) {
          if (slotActive[s]) {
            const p = slotPos[s];
            const [hx, hy, hz] = worldToHead(p[0] - LISTENER[0], p[1] - LISTENER[1], p[2] - LISTENER[2], yaw);
            dsps[s].setDirection(hx, hy, hz);
          }
          slotGain[s] += (slotTarget[s] - slotGain[s]) * Math.min(1, RAMP_PER_BLOCK);
        }

        for (let i = 0; i < BLOCK; i++) { inBlk[i] = 0.5 * Math.sin(phase); phase += dp; }
        const accL = new Float32Array(BLOCK);
        for (let s = 0; s < NSLOTS; s++) {
          dsps[s].process(inBlk, oL, oR);
          const g = slotGain[s];
          for (let i = 0; i < BLOCK; i++) accL[i] += g * oL[i];
        }
        out.set(accL, off);
      }
      const start = set.taps + 4 * BLOCK;
      const end = Math.floor(n / BLOCK) * BLOCK;
      return worstStep(out, start, end);
    }

    const stepStable = render('stable');
    const stepPositional = render('positional');
    // eslint-disable-next-line no-console
    console.log(`[reshuffle-step] STABLE=${stepStable.toFixed(4)}  POSITIONAL/teleport=${stepPositional.toFixed(4)}  teleport/stable=${(stepPositional / stepStable).toFixed(1)}x`);

    // Through the reshuffle, the stable assignment stays in the clean band; the
    // positional (teleporting) assignment spikes when a slot jumps to an unrelated
    // reflection while still audible.
    expect(stepStable).toBeLessThan(0.04);
    expect(stepStable).toBeLessThan(stepPositional);
  });

  it('assignReflectSlots: continuing reflection keeps its slot; new one fades into a free slot', () => {
    // prev: 2 active slots + 1 free
    const prev: ReflectImage[] = [
      { active: true, pos: [3, 0, 0], gain: 0.3 },
      { active: true, pos: [-4, 0, 0], gain: 0.25 },
      { active: false, pos: [0, 0, 0], gain: 0 },
    ];
    // incoming: the [-4..] reflection moved slightly, the [3..] departed, a NEW one appeared.
    const incoming: ReflectImage[] = [
      { active: true, pos: [-4.1, 0, 0.2], gain: 0.25 }, // continues slot 1 (nearest)
      { active: true, pos: [0, 0, 5], gain: 0.2 },        // new identity
      { active: false, pos: [0, 0, 0], gain: 0 },
    ];
    const assign = assignReflectSlots(prev, incoming);
    // slot 1 keeps the continuing reflection (small move), repositioned (keepPos false)
    expect(assign[1].active).toBe(true);
    expect(assign[1].image!.pos[0]).toBeCloseTo(-4.1, 5);
    // the NEW reflection takes the previously-free slot 2 (fade in)
    expect(assign[2].active).toBe(true);
    expect(assign[2].image!.pos[2]).toBeCloseTo(5, 5);
    // slot 0's reflection departed → inactive, keepPos true (fade out in place, no teleport)
    expect(assign[0].active).toBe(false);
    expect(assign[0].keepPos).toBe(true);
  });
});
