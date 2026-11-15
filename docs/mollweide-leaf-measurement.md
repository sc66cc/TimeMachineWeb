# Mollweide current-pose leaf measurement reuse

## Change boundary

Only `packages/cesium-runtime/src/mollweide-refinement.ts` and root tests/documentation changed in this pass. Existing unrelated working-tree changes were preserved. No renderer/controller/camera/main/oracle changes, threshold or budget changes, topology changes, omitted normal faces, or GPU code changes.

`refineMollweideFaces` creates one weak, tuple-identity measurement cache per invocation. It stores the complete existing `measureSphericalArea` result (`area`, `roundingBound`), without changing that measurement's arithmetic. Immutable canonical vertex objects remain unchanged. Original face coordinate tuples are reused within the call, including depth-zero evaluations; recipes still reconstruct and validate measurements for every pose. Evaluation, source winding, numerical certificates, clipped-piece coverage, full coverage and omission validation share that measurement. Value-only paths read its existing signed area. Orientation/oracle/coverage/budget checks and summation order/rounding formulas are unchanged.

The cache is not attached to recipes, indices, ages or global state. Weak keys do not retain discarded leaf tuples. The original-face tuple map is bounded by touched source faces and released with the invocation. A failed recipe and its fallback are within the same invocation/current pose, never another pose.

## Verification

- `npx vitest run`: **503 passed, 5 skipped**, 42 files passed / 1 skipped.
- `npx tsc --noEmit`: passed.
- `npx vite build --outDir /tmp/timemachineweb-test/rectangle-mvp-dist`: passed. Existing 4183 preview reused without restart; root `dist` untouched.
- New injected measurement-count test: original plus two leaves require exactly **3** complete measurements across repeated coverage/certificate/retained-area checks; complete cached results and coverage/budget outputs equal uncached results exactly. New tuples and fresh cache instances force new measurements.
- Existing complete output hashes and variable-pose/120-age tests pass, including source 842 zero omission, 412 and 889 policy regressions. Existing negative controls remain; cached validation additionally replays over-budget omission, infinite/false certificates and reversed orientation failures, and exactly matches the valid omitted-leaf budget result.

Raw logs: `/tmp/timemachineweb-test/moll-measure-{full,tsc,build}.log`.

## Production stream measurement

Target: production **Mollweide local PALEOMAP plate model**, `http://127.0.0.1:4183/`, isolated browser session `moll-assembly-impl`, bundle `index-BnKhqMqw.js`. Same existing `/tmp/timemachineweb-test/moll-longest-perf.js` flow: two roughly three-second `time.set` streams, nominal 50 ms scheduling. Main-thread load delayed delivery: each stream actually sent 48 requests, not a claimed exact 60. Commit observations sample changes to `projection.committedTimeMa` every 10 ms, not rAF. Gap/latency statistics below exclude final settlement outside the input window; latency starts at the matching actual send.

| Stream | Actual input window | Actual commits | actualCommitHz | p95 commit gap | p50 / p95 latency | Final target |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 100 → 130 Ma | 3055.2 ms | 24 | **7.855 Hz** | 134.1 ms | 171.9 / 205.8 ms | 130, matched |
| 0 → 30 Ma | 3049.3 ms | 23 | **7.543 Hz** | 135.9 ms | 170.1 / 204.3 ms | 30, matched |

Only expected superseded-request `409 busy` responses occurred (22 / 23); no non-busy errors. Raw result: `/tmp/timemachineweb-test/moll-measure-perf.json`.

**10 Hz is not achieved.** Compared with the supplied previous 8.25 / 7.91 Hz measurements, the new samples do not establish an overall stream speedup. These are noisy single runs, not hardware limits or evidence of a persistent GPU renderer.

Separate current-build wall-time instrumentation (temporary browser wrappers, restored afterward), `/tmp/timemachineweb-test/moll-measure-stage.json`:

| Warm age | CPU prepare | refinement (included in triangles) | vertices | triangles | outlines | geometry | stage | total confirmed action |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 100.01 | 93.5 | 11.2 | 29.5 | 45.8 | 14.1 | 2.2 | 41.9 | 137.9 |
| 100.02 | 82.8 | 11.8 | 28.6 | 39.1 | 11.3 | 2.6 | 38.6 | 127.9 |
| 100.03 | 80.6 | 10.9 | 28.2 | 37.2 | 11.6 | 2.5 | 36.7 | 119.4 |
| 0.01 | 91.8 | 14.7 | 29.3 | 46.3 | 11.7 | 3.0 | 32.0 | 126.3 |
| 0.02 | 83.3 | 13.4 | 30.6 | 36.9 | 11.4 | 2.9 | 30.8 | 116.1 |
| 0.03 | 71.7 | 16.7 | 24.9 | 32.1 | 10.7 | 2.5 | 39.2 | 113.1 |

All times ms. Total-minus-prepare-minus-stage is 2.0–6.5 ms, a residual including confirmation/other overhead, **not** a separately instrumented confirmation duration. The non-warm 100 / 0 samples took 149.8 / 277.6 ms preparation and 38.2 / 88.4 ms staging. No optimization beyond the approved measurement reuse was attempted.
