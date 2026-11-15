# Mollweide CPU reuse — bounded optimization evidence

## Scope

Only `plate-mollweide-frame.ts`, the performance portions of `mollweide-refinement.ts`, and root regression tests changed in this pass. No controller, renderer, camera, action handler, oracle, area measurement, numerical-degenerate policy, omission allowance, or refinement budget changes.

- Each split caches its three midpoint candidates, including unsuccessful certification. Successful certification retains both full child evaluations and installs them in the new leaves' WeakMap. Reuse requires the same leaf, source face, oriented edge and exact canonical shared midpoint object. Conforming neighbours are independently evaluated.
- Immutable snapshot-local ring unit directions remove repeated longitude/latitude trigonometry. Each ring vertex is rotated once per frame, while every edge still goes through `projectSegment`.
- Exact finite longitude/latitude memoization is local to one polygon/refinement preparation. Runtime and reference maps are separate; ±180 and signed zero remain distinct. No rounded keys, age-keyed growth, topology template, LUT or approximate projection.

## Verification

- `npx tsc --noEmit`: passed.
- `npx vitest run`: **487 passed, 5 skipped**, 40 files passed / 1 skipped.
- Real-model output SHA-256 baselines were recorded with the original split/outline loops, then replayed against the optimized loops: identical positions, indices, source-triangle mapping and outlines at **0, 100, 180, 100.6 Ma**. Baselines are inline snapshots in the root frame test.
- Reversed-edge conforming fixture: same complete output hash, correct per-neighbour source IDs, source buffers unchanged; atan2 calls **76 → 72**, reflecting reuse of both installed child evaluations rather than their repeated area/projection evaluation.
- Seam/hole fixture checks every projected edge segment, both seam sides, repeated exact closure removal, A→B→A pose changes, and output poisoning without source/cache contamination. Separate memo tests cover lifetime, runtime/reference isolation, ±180, signed zero and non-finite rejection.

## Measured timings

Single-run Node/Vitest warm-model stage samples, milliseconds; timings are noisy, not hardware limits. `triangleMs` **already includes refinementMs**.

| Age | refinement before → after | triangles before → after | outlines before → after |
| --- | --- | --- | --- |
| 100 | 207.34 → 165.13 | 247.73 → 199.95 | 12.33 → 8.86 |
| 180 | 25.12 → 18.53 | 49.39 → 41.53 | 8.31 → 6.77 |
| 100.6 | 43.70 → 29.17 | 73.31 → 57.89 | 9.82 → 8.51 |

Raw logs: `/tmp/timemachineweb-moll-baseline-golden.log`, `/tmp/timemachineweb-moll-memo.log`.

## Production browser

Built only to `/tmp/timemachineweb-test/rectangle-mvp-dist`; the existing port 4183 process served it without restart. Root dist / port 4173 were not changed. Isolated browser session `moll-cpu-reuse`; before bundle `index-DRSlvafx.js`, after bundle `index-BWTR7Bkb.js`. For the second before replay, a session-local HTML network route selected the retained old bundle; the route was removed and the session returned to the new build afterward.

Production `time.set` requests every 50 ms for approximately 3 seconds; counters observe actual changes to `projection.committedTimeMa`, **not rAF frequency**:

| Input range | before | after |
| --- | --- | --- |
| 100 → approximately 130 Ma | 15 commits / 3.0095 s = **4.98 Hz** | 16 / 3.0173 s = **5.30 Hz** |
| 100 + successive 0.01 Ma steps | 14 / 3.0085 s = **4.65 Hz** | 16 / 3.0105 s = **5.31 Hz** |

These are **not clean all-age passes**: both narrow-range runs encountered the same pre-existing depth-budget failure at source `GPlates-3ab6fd71-fa4f-477a-88cd-ae32204274b1#0#74` (100.01 Ma; the superseding 100.03 request also received the failure). Wider-range runs hit other polar/sliver budget cases. The separate source-842 issue remains unfixed; this pass deliberately does not change the frozen mathematical policy. Different scheduler-selected wide-range ages are not an output-equivalence test.

Agent smoke: successful fixed ages 0/100/180/100.6, zoom/pan/Home; real frontend controls: Rectangle→Mollweide dropdown and Jump to 100 Ma, ending ready at Mollweide/100. Raw artifacts under `/tmp/timemachineweb-test/moll-cpu-reuse-{browser-before,browser-after,browser-before-clean,browser-after-clean,agent-smoke,frontend-smoke}.json` (the historical `clean` filename denotes narrower input, not error-free execution).

**10 committed frames/s is still not achieved.** These are CPU reuse improvements, not a persistent GPU renderer, complete all-age correctness acceptance, or a hardware FPS ceiling. Parent must independently replay final acceptance.
