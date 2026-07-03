/**
 * Headphone-compensation calibration — the OPTIONAL, advanced "Calibrate headphones"
 * flow. Our HRTF is measured in-ear, which double-filters through the pinna on over-ear
 * headphones and smears up/down + front/back cues. A gentle static master-bus EQ (the
 * average-inverse of the ARI HpIR set) partly undoes that; this flow lets the user (a)
 * declare their headphone TYPE and (b) pick, by ear, HOW MUCH of the correction helps.
 *
 * Two steps, both eyes-free (spoken + keyboard-operable, mirroring calibration.ts):
 *   1. TYPE — IEM / clip-on / over-ear. Seeds a weak starting strength (see
 *      defaultCompStrengthFor); IEM needs no comp, so it saves 0 and finishes.
 *   2. A/B CHOOSER — plays the SAME up/down + front/back probe at two candidate
 *      strengths and asks "which located more clearly?", refining toward the user's
 *      sweet spot (same "you choose" paradigm as the HRTF tuning game, hrtfTuning.ts).
 *
 * The audio graph + DOM are integration/ear-verified; the strength candidates + verdict
 * folding are simple enough to live inline. Persistence + live application are the host's
 * job (deps.save / deps.onDone). The comp filter itself is applied on the master bus in
 * main.ts (buildBiquadChain), OUTSIDE the HRTF/Steam path.
 *
 * Attribution (CC BY-SA 3.0): the compensation asset is derived from the ARI HpIR
 * database — Acoustics Research Institute, Austrian Academy of Sciences (Vienna). It is
 * credited on the Credits screen; the info copy below names it too.
 */
import { HrtfRenderer } from '../engine/hrtf/renderer';
import { InterpolatingHrtfRenderer } from '../engine/hrtf/interpolatingRenderer';
import { loadOverEarComp, buildBiquadChain, type EqChain } from './loudnessEqAudio';
import { defaultCompStrengthFor, type HeadphoneType } from './settingsStore';
import { mountDirectionPicker, type DirectionPicker } from './hrtfDirectionPicker';
import { calDebugEnabled } from './calDebug';
import { makeTestDirections, angularError, dirToPosition, decideWinner, type Direction, type Attempt } from './hrtfLocalize';

export interface HeadphoneCalibrationDeps {
  ctx: AudioContext;
  /** Where the probe plays out (usually the master bus). */
  dest: AudioNode;
  /** URL of the measured base HRTF set to render the probe through. */
  hrtfUrl: string;
  say: (msg: string) => void;
  alert: (msg: string) => void;
  /** Persist the finished type + chosen comp strength. */
  save: (type: HeadphoneType, strength: number) => void;
  /** The stored type/strength to start from (so re-running refines rather than resets). */
  startType?: HeadphoneType | null;
  startStrength?: number;
  onDone: () => void;
}

/** Human-readable label for each form factor (spoken + shown). */
const TYPE_LABELS: Record<HeadphoneType, string> = {
  iem: 'In-ear (tips that seal the canal, e.g. earbuds / IEMs)',
  clip: 'Clip-on / open earbuds (sit at the ear, don’t seal)',
  overear: 'Over-ear / on-ear headphones (cups over the ears)',
};

/** The elevation + front/back probe path: rise up-and-over, then swing front↔behind. A
 *  one-shot ~4 s trajectory that exercises exactly the cues the comp is meant to help. */
function probePath(t: number): [number, number, number] {
  if (t < 0.5) {
    // Up and over: arc from front-low to overhead-behind.
    const u = t * 2; // 0..1
    const el = Math.sin(u * Math.PI) * 1.6; // rise then fall a touch
    const z = -2 + u * 3; // front (−2) → behind (+1)
    return [0.3, 1.6 + el, z];
  }
  // Front ↔ behind at head height.
  const u = (t - 0.5) * 2; // 0..1
  const tri = u < 0.5 ? u * 2 : 2 - u * 2; // 0→1→0
  return [0.3, 1.6, -2 + tri * 4];
}

export function mountHeadphoneCalibration(
  root: HTMLElement,
  deps: HeadphoneCalibrationDeps,
): () => void {
  const { ctx, dest } = deps;
  let disposed = false;
  let type: HeadphoneType | null = deps.startType ?? null;

  root.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = 'Calibrate headphones';
  const p = document.createElement('p');
  p.id = 'hp-cal-instruction';
  const controls = document.createElement('div');
  controls.className = 'cal-controls';
  root.append(h, p, controls);

  // ---- audio: one shared renderer whose comp filter is swapped between passes. -------
  const noise = makeProbeNoise(ctx);
  let noiseStarted = false;
  const startNoise = () => { if (!noiseStarted) { noise.start(); noiseStarted = true; } };
  let renderer: InterpolatingHrtfRenderer | null = null;
  let src: ReturnType<InterpolatingHrtfRenderer['createSource']> | null = null;
  let dry: GainNode | null = null; // the renderer's output tap (pre-comp)
  let gate: GainNode | null = null; // sounds only during a pass
  let comp: EqChain | null = null; // the currently-applied comp filter (or null)
  let compBiquads: Awaited<ReturnType<typeof loadOverEarComp>> = null;
  let rafHandle = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];

  function bigButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = primary ? 'primary' : 'secondary';
    b.addEventListener('click', onClick);
    return b;
  }

  function clearTimers() {
    cancelAnimationFrame(rafHandle);
    for (const id of timers) clearTimeout(id);
    timers = [];
  }

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => { const id = setTimeout(resolve, ms); timers.push(id); });
  }

  async function ensureRenderer() {
    if (renderer) return;
    const set = (await HrtfRenderer.create(ctx, deps.hrtfUrl)).set;
    renderer = await InterpolatingHrtfRenderer.fromSetAsync(ctx, set, {});
    renderer.setListener({ x: 0, y: 1.6, z: 0, yaw: 0 });
    src = renderer.createSource();
    dry = ctx.createGain();
    gate = ctx.createGain();
    gate.gain.value = 0;
    noise.connect(src.input);
    src.output.connect(dry);
    // dry → gate → dest, with an optional comp filter spliced between dry and gate.
    dry.connect(gate);
    gate.connect(dest);
  }

  /** Rewire the comp filter for a given strength (0 ⇒ dry). Instant while gated silent. */
  function setCompStrength(strength: number) {
    if (!dry || !gate) return;
    try { dry.disconnect(); } catch { /* noop */ }
    if (comp) { comp.dispose(); comp = null; }
    const built = strength > 0 ? buildBiquadChain(ctx, compBiquads, strength) : null;
    if (built) {
      comp = built;
      dry.connect(comp.input);
      comp.output.connect(gate);
    } else {
      dry.connect(gate);
    }
  }

  function setGate(on: boolean) {
    if (!gate) return;
    gate.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.02);
  }

  /** Play ONE pass of the probe at the current comp strength. Resolves when done. */
  function playPass(): Promise<void> {
    setGate(true);
    cancelAnimationFrame(rafHandle);
    const durMs = 4000;
    const t0 = now();
    return new Promise((resolve) => {
      const step = () => {
        if (disposed) return resolve();
        const t = Math.min(1, (now() - t0) / durMs);
        const [x, y, z] = probePath(t);
        src?.setPosition(x, y, z);
        if (t >= 1) {
          setGate(false);
          const id = setTimeout(resolve, 120);
          timers.push(id);
          return;
        }
        rafHandle = requestAnimationFrame(step);
      };
      rafHandle = requestAnimationFrame(step);
    });
  }

  // ---- step 1: headphone type ------------------------------------------------------
  /**
   * ADVANCED entry — this flow now ONLY fine-tunes the comp STRENGTH by ear. The basic
   * over-ear-vs-in-ear question (in the calibration onboarding + Settings) has already
   * set a sensible default; here the user refines the scalar. A "switch headphones type"
   * affordance stays available so they can change it and re-tune.
   */
  function showIntro() {
    controls.innerHTML = '';
    h.textContent = 'Fine-tune headphone compensation';
    // Default the type: whatever's stored, else over-ear (in-ear needs no comp, so the
    // fine-tune is only meaningful for over-ear / clip). If they're on in-ear they can
    // switch type and it'll turn comp off.
    if (!type || type === 'iem') type = deps.startType && deps.startType !== 'iem' ? deps.startType : 'overear';
    p.textContent =
      'This fine-tunes how strongly we compensate for your headphones, by ear. You’ll hear a ' +
      'sound travel overhead and front-to-back at two settings; pick whichever locates more ' +
      'clearly, a few times. (Compensation data: ARI HpIR database, Acoustics Research ' +
      `Institute, Vienna.) Currently set for: ${TYPE_LABELS[type]}.`;
    deps.say('Fine-tune your headphone compensation by ear.');
    const begin = bigButton('Begin fine-tuning', () => void startChooser(), true);
    const switchType = bigButton('Change headphone type', showTypeChoice);
    const skip = bigButton('Skip', () => { teardown(); deps.say('Fine-tuning skipped.'); deps.onDone(); });
    controls.append(begin, switchType, skip);
    (controls.querySelector('button') as HTMLElement).focus();
  }

  /** Optional type switcher — reachable from the intro. In-ear turns comp off and exits;
   *  over-ear / clip set the type and return to the intro to fine-tune. */
  function showTypeChoice() {
    controls.innerHTML = '';
    p.textContent = 'What are you wearing?';
    deps.say('What headphones are you wearing?');
    (['iem', 'clip', 'overear'] as HeadphoneType[]).forEach((t, i) => {
      const b = bigButton(TYPE_LABELS[t], () => onType(t), i === 2);
      controls.append(b);
    });
    const back = bigButton('Back', showIntro);
    controls.append(back);
    (controls.querySelector('button') as HTMLElement).focus();
  }

  function onType(t: HeadphoneType) {
    type = t;
    if (t === 'iem') {
      // In-ear needs no compensation — save a zero strength and finish.
      teardown();
      deps.save('iem', 0);
      deps.say('In-ear selected. No headphone compensation needed.');
      deps.alert('Headphone compensation turned off for in-ear.');
      deps.onDone();
      return;
    }
    showIntro();
  }

  // ---- step 2: A/B strength chooser -------------------------------------------------
  // Coarse→fine around the type's seed: audition two candidates, keep the winner as the
  // new centre, halve the spread, repeat a few rounds. "Both same / can't tell" keeps the
  // gentler (lower) candidate — the safe choice.
  let center = 0;
  let spread = 0;
  let round = 0;
  const ROUNDS = 3;

  async function startChooser() {
    controls.innerHTML = '';
    p.textContent = 'Preparing…';
    compBiquads = await loadOverEarComp();
    if (disposed) return;
    if (!compBiquads) {
      // No asset (offline / missing) — save the type's default seed and finish gracefully.
      const seed = defaultCompStrengthFor(type!);
      teardown();
      deps.save(type!, seed);
      deps.alert('Compensation data unavailable; applied a gentle default for your headphones.');
      deps.onDone();
      return;
    }
    await ensureRenderer();
    startNoise();
    center = deps.startStrength && deps.startStrength > 0
      ? deps.startStrength
      : defaultCompStrengthFor(type!);
    spread = 0.35;
    round = 0;
    void nextRound();
  }

  async function nextRound() {
    if (disposed) return;
    if (round >= ROUNDS) return finishChooser();
    const lo = clamp01(center - spread / 2);
    const hi = clamp01(center + spread / 2);

    controls.innerHTML = '';
    p.textContent = 'VERSION 1 — listen for where the sound goes…';
    setCompStrength(lo);
    await playPass();
    if (disposed) return;

    await wait(300);
    p.textContent = 'VERSION 2 — listen again…';
    setCompStrength(hi);
    await playPass();
    if (disposed) return;

    setCompStrength(0); // silent between passes anyway; keep the graph tidy
    p.textContent =
      'Which time did the sound travel more clearly overhead and front-to-back — version 1 or version 2?';
    deps.say('Which was clearer — version one or version two?');
    const first = bigButton('Version 1 was clearer', () => pick(lo, hi, lo), true);
    const second = bigButton('Version 2 was clearer', () => pick(lo, hi, hi));
    const same = bigButton('About the same / can’t tell', () => pick(lo, hi, lo)); // keep gentler
    const replay = bigButton('▶ Play both again', () => { void replayRound(lo, hi); });
    controls.append(first, second, same, replay);
    first.focus();
  }

  async function replayRound(lo: number, hi: number) {
    controls.innerHTML = '';
    p.textContent = 'VERSION 1…';
    setCompStrength(lo);
    await playPass();
    if (disposed) return;
    await wait(300);
    p.textContent = 'VERSION 2…';
    setCompStrength(hi);
    await playPass();
    if (disposed) return;
    setCompStrength(0);
    // Re-show the same choice buttons.
    p.textContent =
      'Which time did the sound travel more clearly overhead and front-to-back — version 1 or version 2?';
    const first = bigButton('Version 1 was clearer', () => pick(lo, hi, lo), true);
    const second = bigButton('Version 2 was clearer', () => pick(lo, hi, hi));
    const same = bigButton('About the same / can’t tell', () => pick(lo, hi, lo));
    const replay = bigButton('▶ Play both again', () => { void replayRound(lo, hi); });
    controls.innerHTML = '';
    controls.append(first, second, same, replay);
    first.focus();
  }

  function pick(_lo: number, _hi: number, winner: number) {
    center = winner;
    spread /= 2; // narrow the search around the winner
    round++;
    void nextRound();
  }

  function finishChooser() {
    const strength = clamp01(center);
    teardown();
    deps.save(type!, strength);
    const pct = Math.round(strength * 100);
    deps.say(`Saved. Headphone compensation set to ${pct} percent.`);
    deps.alert(`Headphone calibration complete — compensation ${pct}% for ${TYPE_LABELS[type!]}.`);
    deps.onDone();
  }

  function teardown() {
    clearTimers();
    if (src) { try { noise.disconnect(src.input); } catch { /* noop */ } }
    try { src?.disconnect(); } catch { /* noop */ }
    if (comp) { comp.dispose(); comp = null; }
    try { dry?.disconnect(); } catch { /* noop */ }
    try { gate?.disconnect(); } catch { /* noop */ }
    src = null; dry = null; gate = null; renderer = null;
  }

  function dispose() {
    disposed = true;
    teardown();
    try { noise.stop(); } catch { /* already stopped */ }
  }

  // Advanced flow starts at the fine-tune intro (basic already set the type + a default
  // strength); the type switcher remains reachable from there.
  showIntro();
  return dispose;
}

// ============================================================================
// OBJECTIVE headphone-comp A/B — decide comp ON vs OFF by POINTING ERROR
// (not preference). Over-ear only: our comp is the average-inverse of an over-ear
// HpIR set, so it's meaningless for IEM/clip (they skip). Reuses the same seeded
// "point to the sound" harness the HRTF base-head A/B uses (identical directions per
// pass, seed 9000+attempt, so OFF and ON are judged on the SAME targets). CRITICAL:
// ties resolve to OFF — comp defaults off (DEFAULT_OVEREAR_COMP_STRENGTH=0), so we
// only turn it on when it measurably helps.
// ============================================================================

export interface HeadphoneCompAbDeps {
  ctx: AudioContext;
  dest: AudioNode;
  hrtfUrl: string;
  say: (msg: string) => void;
  alert: (msg: string) => void;
  /** The user's declared form factor — this step is only meaningful for 'overear'. */
  headphoneType: HeadphoneType | null;
  /** Persist the chosen comp strength (0 = OFF, or the active over-ear default). */
  save: (strength: number) => void;
  onDone: () => void;
}

/** The active comp strength put up against OFF — the type-appropriate over-ear default
 *  (0.5), the same value the preference A/B centres on. */
const COMP_AB_ACTIVE_STRENGTH = defaultCompStrengthFor('overear');
/** Attempts per candidate (OFF/ON). Small but enough for a mean; 5 dirs each = 10 probes. */
const COMP_AB_ATTEMPTS_PER_SIDE = 5;
/** Mean-error tie band: if OFF and ON are within ~5° mean pointing error, call it a tie
 *  and keep OFF. (decideWinner takes radians; keep it aligned with its default bias.) */
const COMP_AB_TIE_RAD = (5 * Math.PI) / 180;

/**
 * Mount the objective comp A/B. If the type isn't over-ear (or unknown), it does NOT run
 * the test: it persists OFF and finishes, since comp is over-ear-specific. Otherwise it
 * interleaves OFF/ON passes on identical seeded directions, scores pointing error, and
 * keeps whichever localizes better (OFF on a tie).
 */
export function mountHeadphoneCompLocalizeAb(
  root: HTMLElement,
  deps: HeadphoneCompAbDeps,
): () => void {
  const { ctx, dest } = deps;
  let disposed = false;

  root.innerHTML = '';
  const h = document.createElement('h1');
  h.textContent = 'Do your headphones need compensation?';
  const p = document.createElement('p');
  const controls = document.createElement('div');
  controls.className = 'cal-controls';
  root.append(h, p, controls);

  function bigButton(label: string, onClick: () => void, primary = false): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = primary ? 'primary' : 'secondary';
    b.addEventListener('click', onClick);
    return b;
  }

  // Non-over-ear (or unknown): comp is over-ear-specific — persist OFF and leave.
  if (deps.headphoneType !== 'overear') {
    p.textContent = 'Headphone compensation only applies to over-ear headphones — skipping.';
    deps.say('Compensation only applies to over-ear headphones. Skipping.');
    deps.save(0);
    const id = setTimeout(() => { if (!disposed) deps.onDone(); }, 400);
    return () => { disposed = true; clearTimeout(id); };
  }

  const noise = makeProbeNoise(ctx);
  let noiseStarted = false;
  const startNoise = () => { if (!noiseStarted) { noise.start(); noiseStarted = true; } };
  let renderer: InterpolatingHrtfRenderer | null = null;
  let src: ReturnType<InterpolatingHrtfRenderer['createSource']> | null = null;
  let dry: GainNode | null = null;
  let gate: GainNode | null = null;
  let comp: EqChain | null = null;
  let compBiquads: Awaited<ReturnType<typeof loadOverEarComp>> = null;
  let picker: DirectionPicker | null = null;
  let rafHandle = 0;
  let timers: ReturnType<typeof setTimeout>[] = [];

  // A/B state: 'a' = OFF (incumbent), 'b' = ON. Identical seeded directions per attempt.
  const attempts: Attempt[] = [];
  let which: 'a' | 'b' = 'a';
  let target: Direction | null = null;
  let attemptCount = 0;

  function clearTimers() { cancelAnimationFrame(rafHandle); for (const id of timers) clearTimeout(id); timers = []; }

  async function ensureRenderer() {
    if (renderer) return;
    const set = (await HrtfRenderer.create(ctx, deps.hrtfUrl)).set;
    renderer = await InterpolatingHrtfRenderer.fromSetAsync(ctx, set, {});
    renderer.setListener({ x: 0, y: 1.6, z: 0, yaw: 0 });
    src = renderer.createSource();
    dry = ctx.createGain();
    gate = ctx.createGain();
    gate.gain.value = 0;
    noise.connect(src.input);
    src.output.connect(dry);
    dry.connect(gate);
    gate.connect(dest);
  }

  function setCompStrength(strength: number) {
    if (!dry || !gate) return;
    try { dry.disconnect(); } catch { /* noop */ }
    if (comp) { comp.dispose(); comp = null; }
    const built = strength > 0 ? buildBiquadChain(ctx, compBiquads, strength) : null;
    if (built) { comp = built; dry.connect(comp.input); comp.output.connect(gate); }
    else { dry.connect(gate); }
  }

  function setGate(on: boolean) { gate?.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.02); }

  /** Play the current `target` as a short WIGGLING probe (small motion helps front/back),
   *  at the current comp strength. Resolves when the ~2.2 s probe finishes. */
  function playProbe(): Promise<void> {
    if (!target) return Promise.resolve();
    setGate(true);
    cancelAnimationFrame(rafHandle);
    const durMs = 2200;
    const [bx, by, bz] = dirToPosition(target, 1, 1.6);
    const t0 = now();
    return new Promise((resolve) => {
      const step = () => {
        if (disposed) return resolve();
        const t = Math.min(1, (now() - t0) / durMs);
        // ~2° circular wiggle (matches hrtfTuning's WIGGLE), keeps the centre fixed.
        const a = t * Math.PI * 2 * 3; // 3 cycles
        const w = (2 * Math.PI) / 180;
        src?.setPosition(bx + Math.sin(a) * w, by + Math.cos(a) * w, bz);
        if (t >= 1) { setGate(false); const id = setTimeout(resolve, 120); timers.push(id); return; }
        rafHandle = requestAnimationFrame(step);
      };
      rafHandle = requestAnimationFrame(step);
    });
  }

  /** Pick the next candidate side (the one with fewer attempts), set the seeded target,
   *  apply its comp strength, play, then enable the picker. */
  async function nextProbe() {
    if (disposed) return;
    const verdict = decideWinner(attempts, COMP_AB_ATTEMPTS_PER_SIDE, COMP_AB_TIE_RAD);
    if (verdict) return finish(verdict);
    const na = attempts.filter((x) => x.which === 'a').length;
    const nb = attempts.filter((x) => x.which === 'b').length;
    which = na <= nb ? 'a' : 'b';
    // Same seeded direction for the matching OFF/ON pair, so the two are judged fairly.
    const pairIdx = which === 'a' ? na : nb;
    target = makeTestDirections(1, 9000 + pairIdx)[0];
    attemptCount++;
    setCompStrength(which === 'a' ? 0 : COMP_AB_ACTIVE_STRENGTH);
    controls.innerHTML = '';
    p.textContent = 'Listen — where does the sound come from?';
    picker?.reset();
    picker?.setEnabled(false);
    await playProbe();
    if (disposed) return;
    mountPicker();
    picker?.setEnabled(true);
  }

  function mountPicker() {
    controls.innerHTML = '';
    const replay = bigButton('▶ Play again', () => { void playProbe(); });
    replay.classList.add('secondary');
    picker = mountDirectionPicker(controls, {
      onCommit: onCommit,
      say: deps.say,
      extraAction: replay,
    });
    picker.setEnabled(true);
  }

  function onCommit(guess: Direction) {
    if (!target) return;
    picker?.setEnabled(false);
    const err = angularError(target, guess);
    attempts.push({ which, error: err });
    const done = attempts.length;
    const total = COMP_AB_ATTEMPTS_PER_SIDE * 2;
    p.textContent = `Round ${Math.min(done + 1, total)} of about ${total}…`;
    const id = setTimeout(() => void nextProbe(), 700);
    timers.push(id);
  }

  function finish(verdict: 'a' | 'b') {
    const strength = verdict === 'b' ? COMP_AB_ACTIVE_STRENGTH : 0;
    const meanOf = (w: 'a' | 'b') => {
      const es = attempts.filter((x) => x.which === w).map((x) => x.error);
      return es.length ? es.reduce((s, c) => s + c, 0) / es.length : NaN;
    };
    if (calDebugEnabled()) {
      const degOff = Math.round((meanOf('a') * 180) / Math.PI);
      const degOn = Math.round((meanOf('b') * 180) / Math.PI);
      console.log(`[hp-comp-ab] OFF ${degOff}° vs ON ${degOn}° → ${verdict === 'b' ? 'ON' : 'OFF'} (tie→OFF)`);
    }
    teardown();
    deps.save(strength);
    if (strength > 0) {
      deps.say('Compensation helped — turning it on.');
      deps.alert('Headphone compensation ON — it improved your localization.');
    } else {
      deps.say('No improvement — leaving compensation off.');
      deps.alert('Headphone compensation left OFF — it did not improve localization.');
    }
    deps.onDone();
  }

  function teardown() {
    clearTimers();
    picker?.dispose(); picker = null;
    if (src) { try { noise.disconnect(src.input); } catch { /* noop */ } }
    try { src?.disconnect(); } catch { /* noop */ }
    if (comp) { comp.dispose(); comp = null; }
    try { dry?.disconnect(); } catch { /* noop */ }
    try { gate?.disconnect(); } catch { /* noop */ }
    src = null; dry = null; gate = null; renderer = null;
  }

  function dispose() {
    disposed = true;
    teardown();
    try { noise.stop(); } catch { /* already stopped */ }
  }

  async function begin() {
    controls.innerHTML = '';
    p.textContent = 'Preparing…';
    compBiquads = await loadOverEarComp();
    if (disposed) return;
    if (!compBiquads) {
      // No comp asset (offline/missing) — can't test it; leave comp OFF.
      teardown();
      deps.save(0);
      deps.alert('Compensation data unavailable; leaving it off.');
      deps.onDone();
      return;
    }
    await ensureRenderer();
    if (disposed) return;
    startNoise();
    attempts.length = 0;
    attemptCount = 0;
    await nextProbe();
  }

  function showIntro() {
    controls.innerHTML = '';
    p.textContent =
      'We’ll play a sound around you a few times, twice each way — with and without headphone ' +
      'compensation. Point to where each one comes from. We keep whichever setting you locate ' +
      'more accurately, and leave compensation OFF if they’re about the same.';
    deps.say('We’ll check whether headphone compensation helps you locate sounds.');
    const start = bigButton('Begin', () => void begin(), true);
    const skip = bigButton('Skip (leave compensation off)', () => { teardown(); deps.save(0); deps.onDone(); });
    controls.append(start, skip);
    start.focus();
  }

  showIntro();
  return dispose;
}

/** performance.now() with a plain fallback (jsdom/tests). */
function now(): number {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : 0;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** A short looping pink-ish noise buffer — broadband so the pinna/comp bands are
 *  excited (the same reason hrtfTuning uses pink noise for its probe). */
function makeProbeNoise(ctx: AudioContext): AudioBufferSourceNode {
  const seconds = 2;
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < n; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.0990460;
    b1 = 0.96300 * b1 + white * 0.2965164;
    b2 = 0.57000 * b2 + white * 1.0526913;
    d[i] = (b0 + b1 + b2 + white * 0.1848) * 0.15;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  return src;
}
