/**
 * AudioContext bootstrap + master bus. iOS Safari requires the context to be
 * created/resumed inside a user gesture, so this is only called from the Begin
 * button handler.
 */
export interface AudioGraph {
  ctx: AudioContext;
  master: GainNode;
}

let graph: AudioGraph | null = null;

export async function startAudio(): Promise<AudioGraph> {
  if (graph) {
    await graph.ctx.resume();
    return graph;
  }
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  const master = ctx.createGain();
  master.gain.value = 0.9;
  master.connect(ctx.destination);
  graph = { ctx, master };
  return graph;
}

export function getGraph(): AudioGraph | null {
  return graph;
}
