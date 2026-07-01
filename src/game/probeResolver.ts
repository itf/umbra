/**
 * Resolves the player's persisted PROBE CHOICE into what to hand `ClapRoom.clap()`:
 * a synth preset NAME (fired directly) or a decoded AudioBuffer (a CC recording).
 *
 * Recordings decode asynchronously, so this holds a tiny cache: `probe()` returns the
 * decoded buffer once ready, and the synth `'clap'` fallback until then (or if the
 * choice isn't a recording). It reads the choice live via `getChoice`, so a mid-run
 * Settings change takes effect on the next clap. Kept out of main.ts so setupClap stays
 * about the clap flow, not buffer bookkeeping.
 */
import { resolveChoice, RECORDING_PREFIX } from './probeCatalog';
import { loadClicksManifest } from './clicksManifest';

/** Decodes a url to a (cached) AudioBuffer, or null on failure. Matches loadCustomLoop. */
export type DecodeUrl = (url: string) => Promise<AudioBuffer | null>;

export class ProbeResolver {
  private buffer: AudioBuffer | null = null;
  private bufferFor: string | null = null;

  constructor(private getChoice: () => string, private decode: DecodeUrl) {
    this.warm(); // kick off decoding the initial choice
  }

  /** Ensure the current choice's recording is decoding/decoded (no-op for synth). */
  private warm(): void {
    const choice = this.getChoice();
    void loadClicksManifest().then((manifest) => {
      const resolved = resolveChoice(choice, manifest);
      if (!('url' in resolved)) { this.buffer = null; this.bufferFor = choice; return; }
      if (this.bufferFor === choice && this.buffer) return; // already decoded
      void this.decode(resolved.url)
        .then((buf) => { this.buffer = buf; this.bufferFor = choice; })
        .catch(() => { this.buffer = null; this.bufferFor = choice; });
    });
  }

  /** What to pass to ClapRoom.clap(): the decoded recording buffer, or a synth name. */
  probe(): { probe: string | AudioBuffer } {
    const choice = this.getChoice();
    if (choice.startsWith(RECORDING_PREFIX)) {
      if (this.bufferFor !== choice) this.warm(); // choice changed at runtime → re-decode
      return { probe: this.buffer ?? 'clap' };     // buffer if ready, else fall back
    }
    return { probe: choice };
  }
}
