/**
 * Audio debug view. Builds the real room IR from the controls and visualizes the
 * exact measurements the automated tests assert on, so a human can confirm by eye
 * and ear. Also plays a clap through the rendered IR.
 */
import { loadHrtf, sphericalToVec, type HrtfSet } from '../engine/hrtf/sofa';
import { assetUrl } from '../engine/baseUrl';
import { buildRoomIr } from '../engine/acoustics/roomIr';
import { initAcoustics, type Tap } from '../engine/acoustics/core';
import { MATERIALS, NUM_BANDS } from '../engine/acoustics/materials';
import { startAudio } from '../engine/audioGraph';
import { HrtfRenderer } from '../engine/hrtf/renderer';
import { ScenePlayer } from './scenePlayer';
import { PROBE_PRESETS, type ProbeName } from './probes';
import { SCENES } from './scenes';
import { TurnControl, headingDescription } from '../game/turnControl';
import {
  stereoEnergy,
  interauralLagSamples,
  brightness,
  firstReflectionSample,
  hasInvalid,
  peak,
  rms,
  bandEnergy,
  waveformPeaks,
} from '../engine/analysis/measure';

const HRTF_URL = assetUrl('assets/hrtf/sadie_h3.hrtf');
const $ = (id: string) => document.getElementById(id)!;
const num = (id: string) => Number(($(id) as HTMLInputElement).value);

let hrtf: HrtfSet;
let lastIr: { left: Float32Array; right: Float32Array; sampleRate: number; length: number } | null = null;
let audioCtx: AudioContext | null = null;

function buildTaps(): Tap[] {
  const az = num('az');
  const el = num('el');
  const dist = num('dist');
  const reflM = num('refl');
  const mat = ($('mat') as HTMLSelectElement).value as keyof typeof MATERIALS;
  const dir = sphericalToVec(az, el) as [number, number, number];

  const taps: Tap[] = [
    { delay: dist / 343, gain: 1 / Math.max(1, dist), dir, order: 0, bandGains: new Array(NUM_BANDS).fill(1) },
  ];
  if (reflM > 0) {
    // A single reflection from the same bearing, attenuated by the material.
    const refl = MATERIALS[mat];
    const bandGains = refl.map((a) => Math.max(0, 1 - a));
    taps.push({ delay: reflM / 343, gain: 0.5 / Math.max(1, reflM), dir, order: 1, bandGains: [...bandGains] });
  }
  return taps;
}

function render() {
  const yaw = (num('yaw') * Math.PI) / 180;
  const taps = buildTaps();
  const ir = buildRoomIr(taps, hrtf, { yaw });
  lastIr = ir;

  ($('readout') as HTMLElement).textContent =
    `IR length ${ir.length} samples (${(ir.length / ir.sampleRate).toFixed(3)}s) · ${taps.length} taps`;

  renderMetrics(ir);
  drawWaveform(ir);
  drawSpectrum(ir);
}

function renderMetrics(ir: { left: Float32Array; right: Float32Array; sampleRate: number }) {
  const e = stereoEnergy(ir.left, ir.right);
  const lag = interauralLagSamples(ir.left, ir.right);
  const br = brightness(ir.left, ir.sampleRate);
  const refl = firstReflectionSample(ir.left, { skip: hrtf.taps });
  const reflMs = refl > 0 ? (refl / ir.sampleRate) * 1000 : -1;
  const invalid = hasInvalid(ir.left) || hasInvalid(ir.right);
  const pk = Math.max(peak(ir.left), peak(ir.right));

  const side = e.balance > 0.03 ? 'RIGHT' : e.balance < -0.03 ? 'LEFT' : 'center';
  const earFirst = lag > 0 ? 'left ear first → source LEFT' : lag < 0 ? 'right ear first → source RIGHT' : 'simultaneous';

  const m = (label: string, val: string, cls = '') =>
    `<span class="metric"><b>${label}:</b> <span class="${cls}">${val}</span></span>`;

  ($('metrics') as HTMLElement).innerHTML = [
    m('L/R balance', `${e.balance.toFixed(3)} (${side})`),
    m('ITD lag', `${lag} smp · ${earFirst}`),
    m('Brightness (hi/lo)', br.toFixed(3)),
    m('RMS', rms(ir.left).toFixed(4)),
    m('Peak', pk.toFixed(3), pk >= 1 ? 'bad' : 'ok'),
    m('First reflection', reflMs >= 0 ? `${reflMs.toFixed(1)} ms` : 'none', reflMs >= 0 ? '' : 'warn'),
    m('Valid (no NaN/Inf)', invalid ? 'FAIL' : 'OK', invalid ? 'bad' : 'ok'),
  ].join('');
}

function fitCanvas(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const w = c.clientWidth || 800;
  c.width = w * devicePixelRatio;
  c.height = c.height * devicePixelRatio;
  const ctx = c.getContext('2d')!;
  ctx.scale(devicePixelRatio, devicePixelRatio);
  return ctx;
}

function drawWaveform(ir: { left: Float32Array; right: Float32Array; sampleRate: number; length: number }) {
  const c = $('wave') as HTMLCanvasElement;
  const ctx = fitCanvas(c);
  const w = c.clientWidth || 800;
  const h = c.height / devicePixelRatio;
  ctx.clearRect(0, 0, w, h);
  const mid = h / 2;

  const drawCh = (buf: Float32Array, color: string) => {
    const peaks = waveformPeaks(buf, w);
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (let x = 0; x < peaks.length; x++) {
      const [mn, mx] = peaks[x];
      ctx.moveTo(x, mid - mx * mid);
      ctx.lineTo(x, mid - mn * mid);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  };
  drawCh(ir.left, '#6ee787');
  drawCh(ir.right, '#ffb86b');

  // Reflection marker.
  const refl = firstReflectionSample(ir.left, { skip: hrtf.taps });
  if (refl > 0) {
    const x = (refl / ir.length) * w;
    ctx.strokeStyle = '#5bd1ff';
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
}

function drawSpectrum(ir: { left: Float32Array; sampleRate: number }) {
  const c = $('spec') as HTMLCanvasElement;
  const ctx = fitCanvas(c);
  const w = c.clientWidth || 800;
  const h = c.height / devicePixelRatio;
  ctx.clearRect(0, 0, w, h);

  // Log-spaced frequency points 40Hz..18kHz.
  const points = 96;
  const freqs: number[] = [];
  for (let i = 0; i < points; i++) {
    const t = i / (points - 1);
    freqs.push(40 * Math.pow(18000 / 40, t));
  }
  const mags = bandEnergy(ir.left, ir.sampleRate, freqs);
  const maxMag = Math.max(...mags, 1e-9);

  ctx.fillStyle = '#5bd1ff';
  for (let i = 0; i < points; i++) {
    const x = (i / points) * w;
    const bh = (mags[i] / maxMag) * (h - 8);
    ctx.fillRect(x, h - bh, w / points - 1, bh);
  }
}

function play() {
  if (!lastIr) return;
  if (!audioCtx) audioCtx = new AudioContext();
  const ctx = audioCtx;
  ctx.resume();

  const convBuf = ctx.createBuffer(2, lastIr.length, lastIr.sampleRate);
  convBuf.getChannelData(0).set(lastIr.left);
  convBuf.getChannelData(1).set(lastIr.right);
  const conv = ctx.createConvolver();
  conv.normalize = false;
  conv.buffer = convBuf;

  const n = Math.ceil(0.01 * ctx.sampleRate);
  const clap = ctx.createBuffer(1, n, ctx.sampleRate);
  const ch = clap.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const env = 1 - i / n;
    ch[i] = (Math.random() * 2 - 1) * env * env;
  }
  const src = ctx.createBufferSource();
  src.buffer = clap;
  src.connect(conv).connect(ctx.destination);
  src.start();
}

async function main() {
  hrtf = await loadHrtf(HRTF_URL);
  for (const id of ['az', 'el', 'dist', 'yaw', 'refl', 'mat']) {
    $(id).addEventListener('input', render);
  }
  $('play').addEventListener('click', play);
  render();
  setupScenes();
}

/** Wire the listenable-scenes panel. Audio starts on first interaction (autoplay). */
function setupScenes() {
  const select = $('scene') as HTMLSelectElement;
  for (const s of SCENES) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    select.appendChild(opt);
  }

  const probeSel = $('scene-probe') as HTMLSelectElement;
  for (const preset of PROBE_PRESETS) {
    const opt = document.createElement('option');
    opt.value = preset.name;
    opt.textContent = preset.label;
    probeSel.appendChild(opt);
  }

  let player: ScenePlayer | null = null;

  const ensure = async (): Promise<ScenePlayer> => {
    if (player) return player;
    await initAcoustics();
    const graph = await startAudio();
    const renderer = await HrtfRenderer.create(graph.ctx, HRTF_URL);
    player = new ScenePlayer(graph, renderer);
    return player;
  };

  const loadCurrent = async () => {
    const scene = SCENES.find((s) => s.id === select.value)!;
    ($('scene-desc') as HTMLElement).textContent = scene.description;
    const p = await ensure();
    p.load(scene);
    ($('scene-clap') as HTMLButtonElement).disabled = !p.hasClap;
    ($('scene-clap-na') as HTMLElement).hidden = p.hasClap;
  };

  select.addEventListener('change', loadCurrent);
  $('scene-clap').addEventListener('click', async () => {
    const p = await ensure();
    await p.setProbe(probeSel.value as ProbeName);
    p.clap();
  });

  // Turn slider for the scenes (drag-anywhere, screen-relative sensitivity).
  new TurnControl($('scene-turn'), {
    onYaw: (yaw) => {
      player?.setYaw(yaw);
      const deg = ((((yaw * 180) / Math.PI) % 360) + 360) % 360;
      ($('scene-heading') as HTMLElement).textContent = headingDescription(deg);
    },
  });

  // Load the first scene on the user's first click anywhere in the panel.
  select.value = SCENES[0].id;
  $('scene-desc').textContent = SCENES[0].description;
  const kickoff = () => {
    loadCurrent();
    document.removeEventListener('pointerdown', kickoff);
  };
  document.addEventListener('pointerdown', kickoff, { once: true });
}

main().catch((e) => {
  ($('readout') as HTMLElement).textContent = 'Error: ' + (e as Error).message;
  console.error(e);
});
