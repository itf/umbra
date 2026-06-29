# Energy pruning in the image-source solver

`Room::compute_taps` (`acoustics-core/src/geometry.rs`) is a recursive image-source
search: for each candidate image (the source mirrored across a sequence of walls) it
reconstructs and validates the reflection path. The candidate count grows as
`walls^order`, so high reflection order is expensive. **Energy pruning** cuts that
explosion by stopping descent down wall-chains that have become inaudible.

## The pruning rule

Alongside each entry on the candidate-search stack we carry the chain's **accumulated
broadband reflection gain** = the product, over every bounce so far, of that wall's
representative reflection coefficient. When we would push a child chain we compute:

```
child_gain = parent_gain * wall_reflectivity(wall)
```

If `child_gain < ENERGY_THRESHOLD` we **prune the whole subtree**: we neither validate
the child's tap nor push it onto the stack. No descendant can be louder than the child
(each further bounce only multiplies by a coefficient ≤ 1), so dropping the subtree
cannot drop an audible path.

- **`wall_reflectivity(wall)` = max over bands of `(1 - absorption[b])`.** The MAX
  (not the mean) is the conservative choice: a wall that reflects strongly in *any*
  single band counts as fully reflective, so we never cull a chain that is still
  audible in some band. Result clamped to `[0, 1]`.
- **`ENERGY_THRESHOLD = 1e-3` (≈ -60 dB)** of accumulated reflection gain. It gates
  only the *material* reflection product, not the `1/r` distance term — using only the
  absorption product is the conservative floor (distance would prune *more*, so leaving
  it out can only keep *more* paths). Documented and tunable as a `const`.

## Correctness — never drops an audible path; low order unchanged

- The accumulated gain is **monotone non-increasing** with depth, so once a chain is
  below the floor every descendant is too — pruning is sound.
- The floor is well below audibility (-60 dB) and uses the *most reflective* band, so
  at order 1–2 with realistic materials nothing audible is pruned. The existing
  shoebox/box-room tests that assert exact reflection counts (1 direct, 6 first-order)
  **still pass unchanged**.
- Direct path (order 0) and the double-sided-wall logic are untouched — pruning only
  gates how DEEP the reflection search descends.

Tested in `geometry.rs`:
- `energy_pruning_culls_absorptive_high_order_chains` — at order 6, an absorptive box
  (alpha 0.9, reflectivity 0.1/bounce) returns FEWER taps than the same box RIGID,
  whose loud chains survive to full order.
- `energy_pruning_leaves_low_order_unchanged` — rigid box: exactly 1 direct + 6
  first-order taps; a moderately absorptive box (alpha 0.5) still keeps all 6
  first-order reflections (the audibility floor never culls a loud path).

## Before / after cost

Pruning is **conservative by design**: it culls chains only once they fall below the
audibility floor. It therefore prunes a lot in absorbent rooms and *nothing* in a large
low-absorption enclosure whose deep chains stay loud — which is physically honest.

| level         | order | taps before | taps after | total ms after |
|---------------|------:|------------:|-----------:|---------------:|
| open-street   | 3     | 6           | 6          | ~2.9 |
| clap-maze     | 3     | 9           | 9          | ~4.2 |
| **cathedral** | 3     | 57          | **57**     | ~25  |

Cathedral is unchanged: its marble/concrete surfaces have very low absorption, so every
order-3 chain is still audible (reflectivity ≈ 1 in every band → never crosses the
floor). This is correct — those reflections *are* loud. The Rust pruning test proves the
lever works where it should: absorbent geometry. Pruning makes high order *affordable in
general* (absorbent and mixed rooms get cheaper at orders 3+), without ever sacrificing a
real reflection in a live room.

## Beacon order decision

Because cathedral order 3 stays at 57 taps / ~25 ms even with pruning, a *global* order-3
brute force still blows the ~70 ms refresh budget there. The shipped policy is therefore
**"order 3 default with a tap-count safety guard"**:

- `game.ts › refreshBeacon` now solves the modeled beacon at **`maxOrder: 3`**.
- `ModeledSource.refresh` applies **`orderTapCap: 24`**: if the order-3 solve returns more
  than 24 taps it re-solves one order lower, repeating down to order 1. The solve is
  ~0.1 ms, so the fallback is effectively free.

Effect: open-street (6 taps) and clap-maze (9 taps) render at full order 3; cathedral
(order 3 = 57, order 2 = 29, order 1 = 15) auto-drops to **order 1 (15 taps, ~7 ms)**,
staying comfortably under the throttle alongside the clap/monsters/FDN. The guard
self-tunes per level off the quantity that actually drives cost — resulting tap count —
not wall count.

## What's tested

- Rust: the two pruning tests above; all existing `cargo test` (19) green.
- JS: full suite (`npm test`, 290) green — `modeledBeacon`, `reflectorAcoustics`,
  `speedOfSound`, `doubleSidedWalls`, `scenes`, `wasmRoom` unchanged (pruning doesn't
  alter audible results).
- `tests/orderCostBench.test.ts` reports the post-pruning cost table above.
