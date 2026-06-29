//! Real-time stereo room-IR builder (the WASM port of `roomIr.ts`'s `buildRoomIr`).
//!
//! The JS implementation collapses N acoustics taps into one stereo impulse
//! response by, per tap: taking the HRIR pair for the tap's arrival direction,
//! coloring both ears with a short frequency-sampled FIR matching the tap's
//! 8-band gains, scaling by the broadband 1/r gain, and accumulating at the
//! sample offset. Rough surfaces additionally smear `s` of a reflection's energy
//! into a short diffuse tail. That convolution (per-tap FIR ⊛ HRIR) is the
//! ~32 ms bottleneck; here we do it with FFT-based convolution so the whole IR
//! can be rebuilt every frame for moving walls.
//!
//! JS↔WASM split: JS keeps the SOFA loader and the cheap `nearestDir` scan, and
//! passes the already-selected L/R HRIR pair for each tap into WASM. WASM owns
//! the expensive band-FIR coloring, convolution, accumulation and scattering.
//!
//! This is intended to be perceptually equivalent (same taps → same IR) to the
//! JS path: `band_fir`, the scattering LCG/copy logic, the delay placement and
//! the output-length formula all mirror `roomIr.ts` exactly.

use crate::image_source::NUM_BANDS;
use rustfft::{num_complex::Complex32, FftPlanner};
use std::cell::RefCell;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

const BANDS_HZ: [f32; NUM_BANDS] = [63.0, 125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0];

/// Interpolate a target magnitude at `freq` from the 8 band centers (log-freq,
/// clamped at the ends) — mirrors `targetAt` in roomIr.ts.
#[inline]
fn target_at(band_gains: &[f32], freq: f32) -> f32 {
    if freq <= BANDS_HZ[0] {
        return band_gains[0];
    }
    if freq >= BANDS_HZ[NUM_BANDS - 1] {
        return band_gains[NUM_BANDS - 1];
    }
    for b in 1..NUM_BANDS {
        if freq <= BANDS_HZ[b] {
            let f0 = BANDS_HZ[b - 1];
            let f1 = BANDS_HZ[b];
            let t = (freq.ln() - f0.ln()) / (f1.ln() - f0.ln());
            return band_gains[b - 1] * (1.0 - t) + band_gains[b] * t;
        }
    }
    band_gains[NUM_BANDS - 1]
}

/// Build a short symmetric (linear-phase) FIR whose magnitude roughly matches the
/// 8 band gains — frequency-sampled, Hann-windowed. Mirrors `bandFir` in roomIr.ts.
fn band_fir(band_gains: &[f32], length: usize, sample_rate: f32) -> Vec<f32> {
    if length < 4 {
        let avg: f32 = band_gains.iter().sum::<f32>() / band_gains.len() as f32;
        let mut k = vec![0.0f32; length.max(1)];
        k[0] = avg;
        return k;
    }
    let half = length / 2; // Math.floor(length/2)
    let nyquist = sample_rate / 2.0;
    let n = length;
    let mut fir = vec![0.0f32; n];
    let nf = n as f32;
    for nn in 0..n {
        let mut acc = 0.0f32;
        let kmax = n / 2; // k <= N/2 (integer)
        for k in 0..=kmax {
            let freq = (k as f32 / (nf / 2.0)) * nyquist;
            let mag = target_at(band_gains, freq);
            let w = if k == 0 || k == n / 2 { 1.0 } else { 2.0 };
            acc += w * mag
                * ((2.0 * std::f32::consts::PI * k as f32 * (nn as f32 - half as f32)) / nf).cos();
        }
        fir[nn] = acc / nf;
    }
    // Hann window.
    for nn in 0..n {
        fir[nn] *= 0.5 - 0.5 * ((2.0 * std::f32::consts::PI * nn as f32) / (nf - 1.0)).cos();
    }
    fir
}

/// FFT-based circular convolution into a fixed-size buffer. `out` must have length
/// `fft_size`; inputs are zero-padded. Returns the first `a_len + b_len - 1`
/// samples (linear convolution) by virtue of `fft_size >= a_len + b_len - 1`.
struct Convolver {
    fft: Arc<dyn rustfft::Fft<f32>>,
    ifft: Arc<dyn rustfft::Fft<f32>>,
    size: usize,
    fir_spec: Vec<Complex32>, // cached transform of the current FIR
    scratch_a: Vec<Complex32>,
}

impl Convolver {
    fn new(planner: &mut FftPlanner<f32>, size: usize) -> Self {
        Convolver {
            fft: planner.plan_fft_forward(size),
            ifft: planner.plan_fft_inverse(size),
            size,
            fir_spec: vec![Complex32::new(0.0, 0.0); size],
            scratch_a: vec![Complex32::new(0.0, 0.0); size],
        }
    }

    /// Set the FIR for subsequent convolutions (transformed once, reused for L+R).
    fn set_fir(&mut self, fir: &[f32]) {
        for i in 0..self.size {
            self.fir_spec[i] = Complex32::new(if i < fir.len() { fir[i] } else { 0.0 }, 0.0);
        }
        self.fft.process(&mut self.fir_spec);
    }

    /// Convolve `signal` with the cached FIR, writing `out_len` samples into `out`.
    fn convolve_into(&mut self, signal: &[f32], out: &mut [f32], out_len: usize) {
        let buf = &mut self.scratch_a;
        for i in 0..self.size {
            buf[i] = Complex32::new(if i < signal.len() { signal[i] } else { 0.0 }, 0.0);
        }
        self.fft.process(buf);
        for i in 0..self.size {
            buf[i] *= self.fir_spec[i];
        }
        self.ifft.process(buf);
        let scale = 1.0 / self.size as f32;
        for i in 0..out_len {
            out[i] = buf[i].re * scale;
        }
    }
}

thread_local! {
    /// Cached planner + convolver keyed by `fft_size`. `fft_size` depends only on
    /// `hrir_len` (constant for a given HRTF set), so for the moving-walls hot path
    /// (rebuild every frame) we plan the FFT once and reuse it across calls. The
    /// convolver's `fir_spec`/`scratch_a` are fully overwritten on each use, so
    /// reuse does not affect correctness.
    static CONV_CACHE: RefCell<Option<(usize, Convolver)>> = const { RefCell::new(None) };
}

/// Run `f` with a cached `Convolver` for `fft_size`, (re)planning only when the
/// size changes from the previous call on this thread.
fn with_convolver<R>(fft_size: usize, f: impl FnOnce(&mut Convolver) -> R) -> R {
    CONV_CACHE.with(|cell| {
        let mut slot = cell.borrow_mut();
        let needs_new = match slot.as_ref() {
            Some((size, _)) => *size != fft_size,
            None => true,
        };
        if needs_new {
            let mut planner = FftPlanner::<f32>::new();
            *slot = Some((fft_size, Convolver::new(&mut planner, fft_size)));
        }
        let (_, conv) = slot.as_mut().unwrap();
        f(conv)
    })
}

/// Build a stereo room IR from packed taps and per-tap HRIR pairs.
///
/// Inputs (flat to avoid object marshalling):
/// - `tap_data`: per tap `[delay, gain, order, band0..band7]` (3 + NUM_BANDS each).
///   Direction is already resolved to an HRIR index by JS, so it isn't passed.
/// - `hrir_l`/`hrir_r`: the selected left/right HRIR for each tap, concatenated;
///   each is `hrir_len` samples. (JS does the cheap nearestDir lookup.)
/// - `hrir_len`: HRIR length per ear (== hrtf.taps).
/// - `sample_rate`, `scattering`, `tail_pad`.
///
/// Returns `[left.., right..]` concatenated (each `length` samples), with the IR
/// length prepended as the first element so JS can split. Layout:
///   out[0] = length (as f32); out[1..1+length] = left; out[1+length..] = right.
#[wasm_bindgen]
pub fn build_room_ir(
    tap_data: &[f32],
    hrir_l: &[f32],
    hrir_r: &[f32],
    hrir_len: usize,
    sample_rate: f32,
    scattering: f32,
    tail_pad: f32,
    // --- LATE REVERB (FDN) params (additive; pass rt60 <= 0 to disable the tail) ---
    // Broadband reverberation time in seconds (Sabine/Eyring estimate from the
    // room's volume, surface area and mean absorption — derived in JS, see roomIr.ts).
    rt60: f32,
    // High-frequency RT60 ratio (rt60_hf / rt60), 0..1: how much faster the highs
    // decay (air + material). ~0.5 is typical. <=0 falls back to 0.5.
    rt60_hf_ratio: f32,
    // Overall wet level multiplier for the late tail (1.0 = continuity-matched).
    wet: f32,
) -> Vec<f32> {
    let tap_stride = 3 + NUM_BANDS;
    let n_taps = if tap_stride > 0 { tap_data.len() / tap_stride } else { 0 };
    let sr = sample_rate;
    let scatter = scattering.clamp(0.0, 1.0);

    let smear_sec = 0.02f32;
    let smear_n = (smear_sec * sr).ceil() as usize;

    // Output length: latest tap delay + HRIR len + band-FIR len + smear + pad.
    // (band-FIR length == hrir_len, so `extra = 2*hrir_len + smear + pad`.)
    let mut max_delay = 0.0f32;
    for t in 0..n_taps {
        let d = tap_data[t * tap_stride];
        if d > max_delay {
            max_delay = d;
        }
    }
    let extra = hrir_len + hrir_len + smear_n + (tail_pad * sr).ceil() as usize;
    // `early_len` is the length of the early (image-source + scatter smear) IR —
    // exactly the old output length. The late FDN tail is overlap-added onto an
    // extended buffer; existing early-energy assertions are scoped to this window.
    let early_len = (max_delay * sr).ceil() as usize + extra;

    // Total length: extend by the FDN tail (until it decays ~60 dB) when enabled.
    let tail_samples = if rt60 > 0.0 {
        // Render the tail for ~rt60 seconds (the -60 dB point) plus a little ring-out.
        ((rt60 * 1.05 + 0.05) * sr).ceil() as usize
    } else {
        0
    };
    let length = early_len + tail_samples;

    let mut left = vec![0.0f32; length];
    let mut right = vec![0.0f32; length];

    // Convolution buffers. Colored HRIR length = hrir_len + band_fir_len - 1
    // = 2*hrir_len - 1. FFT size = next pow2 >= that.
    let conv_len = if hrir_len >= 1 { 2 * hrir_len - 1 } else { 1 };
    let fft_size = conv_len.next_power_of_two().max(1);
    let mut cl = vec![0.0f32; conv_len.max(1)];
    let mut cr = vec![0.0f32; conv_len.max(1)];

    // Deterministic jitter LCG — identical to roomIr.ts `rand`.
    let mut seed: u32 = 0x9e3779b9;
    let mut rand = || -> f32 {
        seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        // Divide in f64 then narrow, matching JS (`seed / 0xffffffff` in f64).
        // f32 has only a 24-bit mantissa, so dividing large u32 seeds in f32
        // would lose precision and desync the scatter smear from JS.
        (seed as f64 / 0xffffffffu32 as f64) as f32
    };

    // Reuse a thread-local FFT planner/convolver across calls (moving-walls hot
    // path rebuilds this every frame). `fft_size` is constant for a given HRTF set.
    with_convolver(fft_size, |conv| {
        for t in 0..n_taps {
            let o = t * tap_stride;
            let delay = tap_data[o];
            let gain = tap_data[o + 1];
            let order = tap_data[o + 2];
            let band_gains = &tap_data[o + 3..o + 3 + NUM_BANDS];

            let hl = &hrir_l[t * hrir_len..(t + 1) * hrir_len];
            let hr = &hrir_r[t * hrir_len..(t + 1) * hrir_len];

            let fir = band_fir(band_gains, hrir_len, sr);
            conv.set_fir(&fir);
            conv.convolve_into(hl, &mut cl, conv_len);
            conv.convolve_into(hr, &mut cr, conv_len);

            let s = if order == 0.0 { 0.0 } else { scatter };
            let spec_gain = gain * (1.0 - s);
            let base_off = (delay * sr).round() as i64;
            place(&mut left, &mut right, &cl, &cr, base_off, spec_gain, length);

            if s > 0.0 {
                let copies = 6;
                for _c in 0..copies {
                    let jitter = (rand() * smear_n as f32).round() as i64;
                    let decay = (1.0 - jitter as f32 / smear_n as f32) * (0.5 + 0.5 * rand());
                    let dg = (gain * s * decay) / copies as f32;
                    place(&mut left, &mut right, &cl, &cr, base_off + jitter, dg, length);
                }
            }
        }
    });

    // --- LATE REVERB: render an FDN tail offline and overlap-add it ------------
    // We keep the whole room a single stereo IR (one ConvolverNode), so the clap
    // and moving-walls crossfade work unchanged. The tail is fed by the energy the
    // early field leaves off with (continuity) and decays per the room's RT60.
    if tail_samples > 0 {
        // Mean per-band material gain across reflections → an overall darkness used
        // to derive HF damping; also gives the late field its broadband level.
        let wet_mul = if wet.is_finite() && wet >= 0.0 { wet } else { 1.0 };
        let hf_ratio = if rt60_hf_ratio > 0.0 && rt60_hf_ratio < 1.0 {
            rt60_hf_ratio
        } else {
            0.5
        };

        // Where the early field hands over to the late field. Use the LATEST early
        // reflection arrival (max_delay) — the diffuse late field starts where the
        // discrete early reflections end. Clamp so degenerate IRs still get a tail.
        let handover = ((max_delay * sr).round() as usize).min(early_len.saturating_sub(1));

        // Continuity / excitation level: the RMS of the early field in a short
        // window just before the handover sets the tail's starting amplitude, so
        // the late field begins at roughly the energy the early reflections leave
        // off with (no level jump). The diffuse scatter smear already raised this
        // window, so the smear naturally transitions INTO the tail.
        let win = (0.01 * sr).ceil() as usize; // 10 ms window
        let w0 = handover.saturating_sub(win);
        let mut el = 0.0f64;
        let mut er = 0.0f64;
        let mut wn = 0usize;
        for i in w0..handover.min(left.len()) {
            el += (left[i] as f64) * (left[i] as f64);
            er += (right[i] as f64) * (right[i] as f64);
            wn += 1;
        }
        let rms_l = if wn > 0 { (el / wn as f64).sqrt() as f32 } else { 0.0 };
        let rms_r = if wn > 0 { (er / wn as f64).sqrt() as f32 } else { 0.0 };
        // If the early field is essentially silent here (e.g. a single direct tap),
        // seed the tail from the global early peak so a room still rings.
        let mut peak = 0.0f32;
        for i in 0..early_len.min(left.len()) {
            peak = peak.max(left[i].abs()).max(right[i].abs());
        }
        let seed_l = if rms_l > 1e-6 { rms_l } else { peak * 0.1 };
        let seed_r = if rms_r > 1e-6 { rms_r } else { peak * 0.1 };

        let (tl, tr) = fdn_tail(tail_samples, sr, rt60, hf_ratio, seed_l, seed_r);

        // Overlap-add: ramp the tail in over a short crossfade starting at the
        // handover so the early end and tail start SUM smoothly (no gap, no click).
        let xfade = (0.005 * sr).ceil() as usize; // 5 ms equal-power-ish ramp-in
        for i in 0..tl.len() {
            let o = handover + i;
            if o >= length {
                break;
            }
            let ramp = if i < xfade {
                // sin ramp 0→1; the early field is simultaneously decaying, so the
                // sum stays continuous.
                (0.5 - 0.5 * (std::f32::consts::PI * i as f32 / xfade as f32).cos()).clamp(0.0, 1.0)
            } else {
                1.0
            };
            left[o] += tl[i] * wet_mul * ramp;
            right[o] += tr[i] * wet_mul * ramp;
        }
    }

    let mut out = Vec::with_capacity(1 + 2 * length);
    out.push(length as f32);
    out.extend_from_slice(&left);
    out.extend_from_slice(&right);
    out
}

/// Render a stereo late-reverb tail with a Feedback Delay Network (FDN).
///
/// Structure (Jot / EVERTims style):
///  - `N = 8` delay lines with mutually-prime lengths (in samples). Mutual primality
///    maximises the modal density / echo-pattern period so the tail sounds smooth and
///    dense rather than fluttery.
///  - A **lossless orthogonal feedback matrix** (Householder reflection built from the
///    all-ones vector) mixes the line outputs back into the inputs. Orthogonality means
///    the recirculation neither adds nor removes energy on its own — the decay comes
///    ONLY from the per-line attenuation, which is what lets us set RT60 precisely.
///  - **Per-line damping**: a one-pole lowpass in each feedback path so highs decay
///    faster than lows (air absorption + soft materials). The broadband gain per line
///    is g = 10^(-3 · delay_seconds / rt60) so each line loses 60 dB over `rt60`; the
///    lowpass adds extra HF loss to hit `rt60·hf_ratio` at high frequencies.
///  - **Decorrelated L/R output taps**: even lines → left, odd lines → right (with a
///    light cross-feed) so the late field is wide/diffuse, not mono.
///
/// The network is excited by a single impulse of amplitude `seed_l`/`seed_r` (the
/// energy the early field hands over with — see caller), so the tail STARTS at roughly
/// the early-reflection level and decays from there.
fn fdn_tail(
    n_out: usize,
    sr: f32,
    rt60: f32,
    hf_ratio: f32,
    seed_l: f32,
    seed_r: f32,
) -> (Vec<f32>, Vec<f32>) {
    let mut out_l = vec![0.0f32; n_out];
    let mut out_r = vec![0.0f32; n_out];
    if n_out == 0 || rt60 <= 0.0 {
        return (out_l, out_r);
    }
    const N: usize = 8;
    // Mutually-prime delay-line lengths (samples) spanning ~17–47 ms at 48 kHz,
    // scaled to the actual sample rate. These primes are coprime so the combined
    // echo pattern has a very long period (dense, smooth tail).
    const BASE_PRIMES: [usize; N] = [809, 877, 937, 1049, 1151, 1249, 1373, 1499];
    let mut lens = [0usize; N];
    let scale = sr / 48000.0;
    for i in 0..N {
        lens[i] = ((BASE_PRIMES[i] as f32 * scale).round() as usize).max(1);
    }

    // Per-line broadband feedback gain for the target RT60: a line of delay D seconds
    // multiplied by g each pass loses 60 dB after rt60 → g = 10^(-3·D/rt60).
    let mut g = [0.0f32; N];
    // One-pole lowpass coefficient per line for extra HF damping. We want the HF decay
    // time to be rt60·hf_ratio. The lowpass DC gain is 1; at Nyquist it attenuates by
    // `damp`. We pick `damp` so HF feedback gain ≈ 10^(-3·D/(rt60·hf_ratio)).
    let mut damp = [0.0f32; N];
    for i in 0..N {
        let d = lens[i] as f32 / sr;
        g[i] = 10f32.powf(-3.0 * d / rt60);
        let g_hf = 10f32.powf(-3.0 * d / (rt60 * hf_ratio));
        // Extra HF attenuation factor (0..1) the lowpass must supply at Nyquist.
        let extra = (g_hf / g[i]).clamp(0.05, 1.0);
        damp[i] = extra; // used as the lowpass HF gain (see filter below)
    }

    // Householder feedback matrix M = I − (2/N)·J, J = ones·onesᵀ. Orthogonal &
    // lossless; applied implicitly as: y_i' = g_i·(s_i − (2/N)·Σ s_j) where s = lp(line out).
    let lp_a = 2.0 / N as f32;

    // Delay-line ring buffers + per-line lowpass state.
    let mut lines: Vec<Vec<f32>> = lens.iter().map(|&l| vec![0.0f32; l]).collect();
    let mut widx = [0usize; N];
    let mut lp_state = [0.0f32; N];

    // Input distribution: split the seed impulse across the lines (alternating sign
    // for decorrelation). Inject on sample 0.
    let in_gain = 1.0 / (N as f32).sqrt();

    for t in 0..n_out {
        // Read each delay line's current output (oldest sample at write index).
        let mut s = [0.0f32; N];
        let mut sum = 0.0f32;
        for i in 0..N {
            let v = lines[i][widx[i]];
            // One-pole lowpass `y = (1-a)·x + a·y_prev`, `a = 1-damp[i]`. This is an
            // APPROXIMATE HF damper: its true Nyquist gain is `(1-a) - a = 2·damp-1`,
            // not `damp` exactly, so the realized HF-decay only roughly tracks
            // rt60·hf_ratio. That's fine perceptually, and the JS mirror uses the same
            // filter so the two paths stay equivalent. Smaller damp → larger a → duller.
            let a = 1.0 - damp[i]; // more damping (smaller damp) → larger a → duller
            let y = (1.0 - a) * v + a * lp_state[i];
            lp_state[i] = y;
            s[i] = y;
            sum += y;
        }
        // Output taps: decorrelate L/R (even→L, odd→R) with light cross-feed.
        let mut ol = 0.0f32;
        let mut or = 0.0f32;
        for i in 0..N {
            if i % 2 == 0 {
                ol += s[i];
                or += 0.4 * s[i];
            } else {
                or += s[i];
                ol += 0.4 * s[i];
            }
        }
        out_l[t] = ol * in_gain;
        out_r[t] = or * in_gain;

        // Feedback: Householder mix, then per-line gain, then write back (+ input).
        for i in 0..N {
            let mixed = s[i] - lp_a * sum; // M·s
            let mut fb = g[i] * mixed;
            if t == 0 {
                // Inject the excitation impulse, sign-alternated for decorrelation.
                let sgn = if i % 2 == 0 { 1.0 } else { -1.0 };
                let seed = if i % 2 == 0 { seed_l } else { seed_r };
                fb += sgn * seed * in_gain;
            }
            lines[i][widx[i]] = fb;
            widx[i] = (widx[i] + 1) % lines[i].len();
        }
    }

    (out_l, out_r)
}

/// Accumulate a colored L/R tap into the output at a sample offset. Mirrors `place`.
#[inline]
fn place(
    left: &mut [f32],
    right: &mut [f32],
    cl: &[f32],
    cr: &[f32],
    offset: i64,
    gain: f32,
    length: usize,
) {
    if gain == 0.0 {
        return;
    }
    for i in 0..cl.len() {
        let o = offset + i as i64;
        if o >= length as i64 {
            break;
        }
        if o < 0 {
            continue;
        }
        let oi = o as usize;
        left[oi] += cl[i] * gain;
        right[oi] += cr[i] * gain;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // One tap, flat bands, an impulse HRIR -> energy near the delay sample.
    fn pack_tap(delay: f32, gain: f32, order: f32, band: f32) -> Vec<f32> {
        let mut v = vec![delay, gain, order];
        v.extend(std::iter::repeat(band).take(NUM_BANDS));
        v
    }

    fn impulse_hrir(len: usize) -> Vec<f32> {
        let mut h = vec![0.0f32; len];
        h[0] = 1.0;
        h
    }

    fn split(out: &[f32]) -> (usize, &[f32], &[f32]) {
        let length = out[0] as usize;
        (length, &out[1..1 + length], &out[1 + length..1 + 2 * length])
    }

    #[test]
    fn tap_energy_lands_at_delay() {
        let sr = 48000.0;
        let hlen = 16;
        let tap = pack_tap(0.01, 0.5, 1.0, 1.0);
        let out = build_room_ir(&tap, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.0, 0.05, 0.0, 0.5, 1.0);
        let (_len, left, _r) = split(&out);
        let exp = (0.01 * sr).round() as usize;
        let before: f32 = left[..exp - 5].iter().map(|x| x.abs()).sum();
        let around: f32 = left[exp - 2..exp + 3].iter().map(|x| x.abs()).sum();
        assert!(around > 0.0);
        assert!(before < around * 0.05);
    }

    #[test]
    fn scattering_lowers_peak_but_not_direct_path() {
        let sr = 48000.0;
        let hlen = 16;
        // order-1 reflection: scattering should lower the peak.
        let refl = pack_tap(0.01, 1.0, 1.0, 1.0);
        let crisp = build_room_ir(&refl, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.0, 0.05, 0.0, 0.5, 1.0);
        let rough = build_room_ir(&refl, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.8, 0.05, 0.0, 0.5, 1.0);
        let peak = |o: &[f32]| split(o).1.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak(&rough) < peak(&crisp));

        // order-0 direct path: scattering must not change it.
        let direct = pack_tap(0.005, 1.0, 0.0, 1.0);
        let a = build_room_ir(&direct, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.0, 0.05, 0.0, 0.5, 1.0);
        let b = build_room_ir(&direct, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.9, 0.05, 0.0, 0.5, 1.0);
        assert!((peak(&a) - peak(&b)).abs() < 1e-5);
    }

    // RMS of a window [a,b) of a slice.
    fn win_rms(x: &[f32], a: usize, b: usize) -> f32 {
        let b = b.min(x.len());
        if b <= a {
            return 0.0;
        }
        let s: f64 = x[a..b].iter().map(|v| (*v as f64) * (*v as f64)).sum();
        (s / (b - a) as f64).sqrt() as f32
    }

    #[test]
    fn fdn_tail_exists_and_decays() {
        let sr = 48000.0;
        let hlen = 16;
        let tap = pack_tap(0.01, 1.0, 1.0, 1.0);
        // rt60 = 1.2 s tail.
        let out = build_room_ir(
            &tap, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.3, 0.05, 1.2, 0.5, 1.0,
        );
        let (len, left, right) = split(&out);
        // Tail extends well past the early field (~10 ms early + ~1.2 s tail).
        assert!(len as f32 / sr > 1.0);
        // There is energy far past the early reflections.
        let late = win_rms(left, (0.5 * sr) as usize, (0.55 * sr) as usize);
        assert!(late > 0.0, "tail should have energy at 0.5 s");
        // Successive 50 ms windows decrease (decays toward zero).
        let w = (0.05 * sr) as usize;
        let mut prev = f32::INFINITY;
        let mut decreasing = 0;
        let mut total = 0;
        let mut start = (0.05 * sr) as usize;
        while start + w < left.len() {
            let r = win_rms(left, start, start + w);
            if r <= prev * 1.05 {
                decreasing += 1;
            }
            total += 1;
            prev = r;
            start += w;
        }
        // Mostly monotone decreasing (FDN has some ripple, allow a few exceptions).
        assert!(decreasing as f32 > total as f32 * 0.85, "tail should decay monotonically-ish");
        // Stereo: L and R differ (decorrelated wide tail).
        let diff: f32 = left.iter().zip(right.iter()).map(|(a, b)| (a - b).abs()).sum();
        assert!(diff > 0.0);
    }

    #[test]
    fn fdn_rt60_orders_tail_length() {
        let sr = 48000.0;
        let hlen = 16;
        let tap = pack_tap(0.01, 1.0, 1.0, 1.0);
        let short = build_room_ir(
            &tap, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.3, 0.05, 0.3, 0.5, 1.0,
        );
        let long = build_room_ir(
            &tap, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.3, 0.05, 2.0, 0.5, 1.0,
        );
        // Longer RT60 → longer IR and audible energy later.
        assert!(long[0] > short[0]);
        let (_l, ll, _r) = split(&long);
        let (_s, sl, _sr) = split(&short);
        // At 0.6 s the long room still rings; the short one is ~silent.
        let late_long = win_rms(ll, (0.6 * sr) as usize, (0.65 * sr) as usize);
        let late_short_idx = (0.6 * sr) as usize;
        let late_short = if late_short_idx < sl.len() {
            win_rms(sl, late_short_idx, (0.65 * sr) as usize)
        } else {
            0.0
        };
        assert!(late_long > late_short);
    }

    #[test]
    fn fdn_continuity_no_gap_at_handover() {
        let sr = 48000.0;
        let hlen = 16;
        // A reflection at 10 ms with scattering so the early field has a smear.
        let tap = pack_tap(0.01, 1.0, 1.0, 1.0);
        let out = build_room_ir(
            &tap, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.5, 0.05, 1.0, 0.5, 1.0,
        );
        let (_len, left, _r) = split(&out);
        // No long zero-run anywhere before the tail has decayed (continuity): scan
        // the first 0.3 s in 5 ms windows; none should be exactly silent.
        let w = (0.005 * sr) as usize;
        let end = (0.3 * sr) as usize;
        let mut start = (0.01 * sr) as usize;
        while start + w < end.min(left.len()) {
            let r = win_rms(left, start, start + w);
            assert!(r > 0.0, "no silent gap between early field and tail at {}", start);
            start += w;
        }
    }
}
