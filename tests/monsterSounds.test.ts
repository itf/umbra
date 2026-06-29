/**
 * Renders the monster voice offline (via node-web-audio-api) to prove it actually
 * makes sound — a clearly-audible looping growl, and a loud one-shot CATCH roar.
 * Mirrors tests/audioArtifacts.test.ts: if node-web-audio-api can't load, the
 * block is skipped with a clear message so CI stays green.
 */
import { describe, it, expect } from 'vitest';
import { MonsterVoice, resolveMonsterPreset, MONSTER_PRESETS } from '../src/game/monsterSounds';

let OfflineAudioContext: any = null;
let importError = '';
try {
  ({ OfflineAudioContext } = await import('node-web-audio-api'));
} catch (e) {
  importError = e instanceof Error ? e.message : String(e);
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
  return Math.sqrt(s / buf.length);
}

describe('monster preset resolution (pure)', () => {
  it('maps known names and defaults unknown to growl', () => {
    expect(resolveMonsterPreset('hum')).toBe('hum');
    expect(resolveMonsterPreset('growl')).toBe('growl');
    expect(resolveMonsterPreset(undefined)).toBe('growl');
    expect(resolveMonsterPreset('whatever')).toBe('growl');
    expect(MONSTER_PRESETS).toContain('growl');
    expect(MONSTER_PRESETS).toContain('hum');
  });
});

const d = OfflineAudioContext ? describe : describe.skip;
if (!OfflineAudioContext) {
  // eslint-disable-next-line no-console
  console.warn(`[monsterSounds] node-web-audio-api unavailable (${importError}); skipping render tests.`);
}

d('monster voice (offline render)', () => {
  const sr = 44100;

  it('the growl loop is clearly audible', async () => {
    const ctx = new OfflineAudioContext(1, sr * 1.0, sr);
    const voice = new MonsterVoice(ctx, ctx.destination);
    voice.start();
    const buf = await ctx.startRendering();
    const level = rms(buf.getChannelData(0));
    // Not silent, and a substantial drone (well above a noise floor).
    expect(level).toBeGreaterThan(0.05);
  });

  it('the hum preset is audible too', async () => {
    const ctx = new OfflineAudioContext(1, sr * 1.0, sr);
    const voice = new MonsterVoice(ctx, ctx.destination, 'hum');
    voice.start();
    const level = rms((await ctx.startRendering()).getChannelData(0));
    expect(level).toBeGreaterThan(0.05);
  });

  it('the growl is more present (louder) than the hum', async () => {
    // The growl voice is the aggressive one — clearly louder/more present than the
    // calmer hum, so a chasing monster is unmistakable. (Both share the dark body;
    // the growl adds the rasp layer and a higher output level.)
    const level = async (preset: 'growl' | 'hum') => {
      const ctx = new OfflineAudioContext(1, sr * 1.0, sr);
      new MonsterVoice(ctx, ctx.destination, preset).start();
      return rms((await ctx.startRendering()).getChannelData(0));
    };
    expect(await level('growl')).toBeGreaterThan(await level('hum'));
  });

  it('the growl is rough (amplitude flutter), not a smooth tone', async () => {
    // A growl modulates amplitude fast; measure the variation of the short-window
    // envelope. A pure smooth drone would have near-constant envelope.
    const ctx = new OfflineAudioContext(1, sr * 1.0, sr);
    const voice = new MonsterVoice(ctx, ctx.destination);
    voice.start();
    const x = (await ctx.startRendering()).getChannelData(0);
    const win = Math.floor(sr * 0.01); // 10ms windows
    const envs: number[] = [];
    for (let i = sr * 0.2; i + win < x.length; i += win) {
      envs.push(rms(x.subarray(i, i + win)));
    }
    const mean = envs.reduce((a, b) => a + b, 0) / envs.length;
    const variance = envs.reduce((a, b) => a + (b - mean) ** 2, 0) / envs.length;
    const cv = Math.sqrt(variance) / mean; // coefficient of variation
    // A rough growl has meaningful envelope variation; a smooth hum would be ~0.
    expect(cv).toBeGreaterThan(0.08);
  });

  it('the catch roar is a loud transient that decays', async () => {
    const ctx = new OfflineAudioContext(1, sr * 1.2, sr);
    MonsterVoice.roar(ctx, ctx.destination);
    const x = (await ctx.startRendering()).getChannelData(0);
    const early = rms(x.subarray(0, Math.floor(sr * 0.25))); // first 250ms (the lunge)
    const late = rms(x.subarray(Math.floor(sr * 0.95))); // tail after ~950ms
    expect(early).toBeGreaterThan(0.1); // loud
    expect(early).toBeGreaterThan(late * 3); // clearly decays (transient, not a drone)
  });
});
