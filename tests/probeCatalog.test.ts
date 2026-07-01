import { describe, it, expect } from 'vitest';
import {
  probeOptions, resolveChoice, RECORDING_PREFIX, DEFAULT_PROBE_CHOICE,
  type ClickManifestEntry,
} from '../src/game/probeCatalog';

const MANIFEST: ClickManifestEntry[] = [
  { id: 'dental', file: '/audio/clicks/dental.ogg', label: 'Dental click', license: 'CC BY-SA 3.0', author: 'X' },
  { id: 'percussive-alveolar', file: '/audio/clicks/percussive-alveolar.ogg', label: 'Percussive alveolar click', license: 'CC0 1.0' },
];

describe('probeOptions', () => {
  it('lists the synth presets even with an empty manifest', () => {
    const opts = probeOptions([]);
    const ids = opts.map((o) => o.id);
    expect(ids).toContain('clap');
    expect(ids).toContain('mouthclick');
    expect(opts.every((o) => o.kind === 'synth')).toBe(true);
  });
  it('appends a recording option per manifest entry, after the synth presets', () => {
    const opts = probeOptions(MANIFEST);
    const recs = opts.filter((o) => o.kind === 'recording');
    expect(recs.map((o) => o.id)).toEqual(['rec:dental', 'rec:percussive-alveolar']);
    // Recordings come after synth presets.
    const firstRec = opts.findIndex((o) => o.kind === 'recording');
    expect(opts.slice(0, firstRec).every((o) => o.kind === 'synth')).toBe(true);
    // License is surfaced in the hint (attribution visibility).
    expect(recs[0].hint).toMatch(/CC BY-SA 3\.0/);
  });
  it('ignores malformed manifest rows', () => {
    const opts = probeOptions([{ id: 'ok', file: '/a.ogg', label: 'OK' }, { } as ClickManifestEntry]);
    expect(opts.filter((o) => o.kind === 'recording')).toHaveLength(1);
  });
});

describe('resolveChoice', () => {
  it('resolves a synth name to that synth', () => {
    expect(resolveChoice('mouthclick', MANIFEST)).toEqual({ synth: 'mouthclick' });
  });
  it('resolves a recording id to its url', () => {
    expect(resolveChoice(`${RECORDING_PREFIX}dental`, MANIFEST)).toEqual({ url: '/audio/clicks/dental.ogg' });
  });
  it('falls back to the default synth for an unknown name', () => {
    expect(resolveChoice('bogus', MANIFEST)).toEqual({ synth: DEFAULT_PROBE_CHOICE });
  });
  it('falls back to the default synth when a recording id is missing from the manifest', () => {
    expect(resolveChoice('rec:ghost', MANIFEST)).toEqual({ synth: DEFAULT_PROBE_CHOICE });
  });
  it('falls back for null/undefined', () => {
    expect(resolveChoice(null, MANIFEST)).toEqual({ synth: DEFAULT_PROBE_CHOICE });
    expect(resolveChoice(undefined, MANIFEST)).toEqual({ synth: DEFAULT_PROBE_CHOICE });
  });
});
