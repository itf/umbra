#!/usr/bin/env bash
# Rebuild & re-vendor the three-steam-audio fork (SOFA custom-HRTF + head-tracked
# Ambisonic reflections) into vendor/three-steam-audio.
#
# papasangre depends on `three-steam-audio` via "file:vendor/three-steam-audio" — a
# committed, prebuilt copy of the fork's publishable package. The published npm
# package (0.1.0-beta.1) has NEITHER SOFA nor head-tracked reflections; only the fork
# does, and the fork's dist/ is gitignored (a build artifact), so we vendor the built
# dist here so `npm install` from a fresh clone needs no external path or build.
#
# The 6 MB phonon_bindings.wasm is LAZY-loaded (only on ?engine=steam) and excluded
# from the PWA precache (vite globIgnores) — vendoring it does not bloat the default
# ?engine=ours bundle.
#
# WASM rebuilds need emsdk (/home/ivan/emsdk) + the fork's Justfile; the JS dist is a
# pure `tsdown` build. Usually only the JS needs rebuilding when fork *.ts changes; the
# committed phonon_bindings.{js,wasm} only change when the C bindings change.
set -euo pipefail

FORK="${FORK_DIR:-/home/ivan/pproject/three-steam-audio}"
PKG="$FORK/packages/three-steam-audio"
DST="$(cd "$(dirname "$0")/.." && pwd)/vendor/three-steam-audio"

echo "Rebuilding fork JS dist (tsdown) in $PKG ..."
( cd "$PKG" && pnpm build )

echo "Vendoring built dist -> $DST"
rm -rf "$DST/dist"
mkdir -p "$DST"
cp -r "$PKG/dist" "$DST/dist"
cp "$PKG/THIRDPARTY.md" "$DST/THIRDPARTY.md" 2>/dev/null || true
[ -f "$FORK/LICENSE" ] && cp "$FORK/LICENSE" "$DST/LICENSE" || true

echo "Verifying head-tracked + SOFA support in vendored dist ..."
grep -rl headTracked "$DST/dist" >/dev/null || { echo "FAIL: headTracked missing from JS dist"; exit 1; }
for s in _sa_hrtf_create_sofa _sa_ambisonics_binaural_effect_create _sa_ambisonics_binaural_effect_apply; do
  grep -q "$s" "$DST/dist/bindings/phonon_bindings.js" || { echo "FAIL: WASM export $s missing"; exit 1; }
done
echo "OK: vendored dist contains SOFA + head-tracked reflections."
echo "NOTE: vendor/three-steam-audio/package.json is hand-maintained (do not overwrite)."
