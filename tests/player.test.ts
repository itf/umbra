import { describe, it, expect } from 'vitest';
import { Player, DEFAULT_STEP_CONFIG } from '../src/game/player';

const cfg = DEFAULT_STEP_CONFIG;
const start = () => new Player({ x: 0, z: 0, yaw: 0 }, cfg);

// A legal cadence: above the rush limit, below the slow limit.
const GOOD = cfg.rushIntervalMs + 200;

describe('step alternation', () => {
  it('first expected foot is left', () => {
    expect(start().nextFoot).toBe('L');
  });

  it('alternating L,R,L advances forward each time', () => {
    const p = start();
    let t = 1000;
    const r1 = p.step('L', t);
    t += GOOD;
    const r2 = p.step('R', t);
    t += GOOD;
    const r3 = p.step('L', t);
    expect(r1.outcome.kind).toBe('step');
    expect(r2.outcome.kind).toBe('step');
    expect(r3.outcome.kind).toBe('step');
    // yaw=0 → forward is -z, so z decreases each step.
    expect(p.state.z).toBeLessThan(0);
    expect(Math.abs(p.state.x)).toBeLessThan(1e-6); // straight ahead
  });

  it('same foot twice in a row stumbles', () => {
    const p = start();
    p.step('L', 1000);
    const r = p.step('L', 1000 + GOOD); // expected R, got L
    expect(r.outcome).toMatchObject({ kind: 'stumble', reason: 'wrong-foot' });
  });

  it('after a wrong-foot stumble, recovery restarts on the left foot', () => {
    const p = start();
    p.step('L', 1000);
    p.step('L', 1000 + GOOD); // stumble, freezes + resets to L
    expect(p.nextFoot).toBe('L');
  });
});

describe('rush penalty', () => {
  it('stepping faster than the rush limit trips you', () => {
    const p = start();
    p.step('L', 1000);
    const r = p.step('R', 1000 + cfg.rushIntervalMs - 1); // too soon
    expect(r.outcome).toMatchObject({ kind: 'stumble', reason: 'too-fast' });
  });

  it('a stumble freezes stepping for the configured time', () => {
    const p = start();
    p.step('L', 1000);
    p.step('R', 1000 + cfg.rushIntervalMs - 1); // stumble at t≈1000
    // Immediately retrying within the freeze window is rejected as frozen.
    const r = p.step('L', 1000 + 10);
    expect(r.outcome).toMatchObject({ kind: 'stumble', reason: 'frozen' });
  });
});

describe('stride scales with cadence', () => {
  it('brisk legal cadence gives a longer stride than a slow one', () => {
    const fast = start();
    const slow = start();
    fast.step('L', 0);
    const fastStep = fast.step('R', cfg.rushIntervalMs + 1); // near the fast limit
    slow.step('L', 0);
    const slowStep = slow.step('R', cfg.slowIntervalMs + 100); // very slow
    const fastStride = fastStep.outcome.kind === 'step' ? fastStep.outcome.stride : 0;
    const slowStride = slowStep.outcome.kind === 'step' ? slowStep.outcome.stride : 0;
    expect(fastStride).toBeGreaterThan(slowStride);
    expect(fastStride).toBeCloseTo(cfg.maxStride, 1);
    expect(slowStride).toBeCloseTo(cfg.minStride, 1);
  });
});

describe('settling (feet together after a stop)', () => {
  it('after a long idle, the next step may be EITHER foot without stumbling', () => {
    const p = start();
    p.step('L', 1000); // now expects R
    // Stand still past the settle threshold, then step LEFT again — allowed.
    const r = p.step('L', 1000 + cfg.settleIntervalMs + 50);
    expect(r.outcome.kind).toBe('step');
    if (r.outcome.kind === 'step') expect(r.outcome.settled).toBe(true);
  });

  it('a continuous (non-idle) walk does NOT settle, so alternation still binds', () => {
    const p = start();
    p.step('L', 1000); // expects R
    const r = p.step('L', 1000 + GOOD); // not idle long enough → wrong foot
    expect(r.outcome).toMatchObject({ kind: 'stumble', reason: 'wrong-foot' });
  });

  it('after settling on the left, alternation resumes (next expects right)', () => {
    const p = start();
    p.step('L', 1000);
    p.step('L', 1000 + cfg.settleIntervalMs + 50); // settled, stepped left
    expect(p.nextFoot).toBe('R');
  });
});

describe('heading affects direction', () => {
  it('turning 90° right then stepping moves +x (to the right)', () => {
    const p = start();
    p.setYaw(Math.PI / 2); // face right
    p.step('L', 1000);
    expect(p.state.x).toBeGreaterThan(0.1);
    expect(Math.abs(p.state.z)).toBeLessThan(1e-6);
  });
});

describe('goal distance', () => {
  it('walking toward a goal decreases distance', () => {
    const p = start();
    const goal: [number, number] = [0, -5]; // 5m ahead
    const before = p.distanceTo(goal[0], goal[1]);
    let t = 0;
    for (const foot of ['L', 'R', 'L', 'R'] as const) {
      p.step(foot, t);
      t += GOOD;
    }
    expect(p.distanceTo(goal[0], goal[1])).toBeLessThan(before);
  });
});
