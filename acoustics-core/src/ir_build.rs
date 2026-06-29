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
    let length = (max_delay * sr).ceil() as usize + extra;

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

    let mut out = Vec::with_capacity(1 + 2 * length);
    out.push(length as f32);
    out.extend_from_slice(&left);
    out.extend_from_slice(&right);
    out
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
        let out = build_room_ir(&tap, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.0, 0.05);
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
        let crisp = build_room_ir(&refl, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.0, 0.05);
        let rough = build_room_ir(&refl, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.8, 0.05);
        let peak = |o: &[f32]| split(o).1.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(peak(&rough) < peak(&crisp));

        // order-0 direct path: scattering must not change it.
        let direct = pack_tap(0.005, 1.0, 0.0, 1.0);
        let a = build_room_ir(&direct, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.0, 0.05);
        let b = build_room_ir(&direct, &impulse_hrir(hlen), &impulse_hrir(hlen), hlen, sr, 0.9, 0.05);
        assert!((peak(&a) - peak(&b)).abs() < 1e-5);
    }
}
