/**
 * Unified PROBE CATALOG — the single list of probe ("echo") sounds the user can
 * choose from, shared by the game Settings chooser and the trainer picker.
 *
 * An option is either:
 *   - a SYNTH preset (a pure generator name from debug/probes.ts: clap/click/hiss/
 *     snap/stomp/mouthclick), or
 *   - a RECORDING (one of the CC-licensed tongue-click .ogg files in
 *     public/audio/clicks/manifest.json), identified by `url`.
 *
 * A choice is persisted as a short string id:
 *   - synth  → the ProbeName ('clap', 'mouthclick', …)
 *   - record → 'rec:<id>' (e.g. 'rec:dental'), resolved to its url via the manifest.
 *
 * `resolveChoice` turns a stored id into a concrete probe: a synth name (played by
 * ClapRoom/ScenePlayer directly) or `{ url }` (the caller decodes + caches the .ogg,
 * since decode is async). Pure w.r.t. the passed-in manifest, so it's unit-testable.
 */
import { PROBE_PRESETS, DEFAULT_PROBE, isProbeName, type ProbeName } from '../debug/probes';
import { assetUrl } from '../engine/baseUrl';

/**
 * One recording entry from public/audio/clicks/manifest.json. The canonical shape,
 * shared by the probe catalog, the /clicks help page, and the credits screen. Only
 * `id`/`file`/`label` are needed to USE a recording as a probe; the attribution fields
 * (author/license/…) are required for the CC-BY-SA credit lines the UI shows.
 */
export interface ClickManifestEntry {
  id: string;
  file: string; // e.g. "/audio/clicks/dental.ogg"
  label: string;
  ipa?: string;
  author?: string;
  license?: string;
  licenseUrl?: string;
  sourceUrl?: string;
}

/** One selectable probe option for a chooser UI. */
export interface ProbeOption {
  /** Persisted id: a ProbeName, or 'rec:<manifestId>'. */
  id: string;
  label: string;
  hint: string;
  kind: 'synth' | 'recording';
}

/** Prefix marking a persisted choice that refers to a manifest RECORDING. */
export const RECORDING_PREFIX = 'rec:';

/** The default probe choice id (the legacy noise-burst clap). */
export const DEFAULT_PROBE_CHOICE: string = DEFAULT_PROBE;

/**
 * Build the full ordered option list: every synth preset, then every recording from
 * the manifest (labelled "<label> (recording)"). A malformed/empty manifest just
 * yields the synth presets.
 */
export function probeOptions(manifest: ClickManifestEntry[] = []): ProbeOption[] {
  const synth: ProbeOption[] = PROBE_PRESETS.map((p) => ({
    id: p.name,
    label: p.label,
    hint: p.hint,
    kind: 'synth' as const,
  }));
  const recordings: ProbeOption[] = manifest
    .filter((m) => m && typeof m.id === 'string' && typeof m.file === 'string')
    .map((m) => ({
      id: `${RECORDING_PREFIX}${m.id}`,
      label: `${m.label} (recording)`,
      hint: m.license
        ? `Real tongue-click recording — ${m.license}${m.author ? `, ${m.author}` : ''}`
        : 'Real tongue-click recording',
      kind: 'recording' as const,
    }));
  return [...synth, ...recordings];
}

/** A resolved probe: a synth preset name, or a recording url to decode. */
export type ResolvedProbe = { synth: ProbeName } | { url: string };

/**
 * Resolve a stored choice id to a concrete probe against the manifest. Unknown ids,
 * or a 'rec:<id>' whose recording is missing, fall back to the default synth probe.
 */
export function resolveChoice(
  choice: string | null | undefined,
  manifest: ClickManifestEntry[] = [],
): ResolvedProbe {
  if (typeof choice === 'string' && choice.startsWith(RECORDING_PREFIX)) {
    const id = choice.slice(RECORDING_PREFIX.length);
    const entry = manifest.find((m) => m.id === id);
    if (entry?.file) return { url: assetUrl(entry.file) };
    return { synth: DEFAULT_PROBE }; // recording vanished → safe fallback
  }
  return { synth: isProbeName(choice) ? choice : DEFAULT_PROBE };
}
