# Mollweide longest-edge correction

## Changes and limits

Only `mollweide-refinement.ts`, local CPU optimization in `plate-mollweide-frame.ts`, and three root tests changed in this pass. Controller, camera, renderer, frozen mathematics 1–3B, dependencies and whole-source numerical classification are unchanged.

- Recursively bisect the longest great-circle edge at its canonical normalized midpoint. Before splitting a shared edge, first split any incident neighbour's longer edge. This avoids forcing short-edge cuts into already narrow neighbours. Children can require further refinement; no latitude-aligned locations or search for two immediately valid children remains.
- Simply removing the old selection heuristic was insufficient: the 0 Ma shared polar patch exhausted 16,384 triangles (4218 alone had 4,246 leaves). Longest-edge *propagation* fixes this without increasing depth 40 or the triangle budget.
- A 25.63 Ma seam regression exposed a different amplification: source 169's tiny clipped hemisphere piece was below 3B's fixed planar area floor. Runtime retention now uses **all** frozen 3A pieces, robust positive XY determinants, and spherical coverage; 3/4-vertex pieces must triangulate completely. No projected reversal or unsupported spherical clip is accepted or omitted. The frozen standalone `projectTriangle` verdict remains unchanged.
- The optional post-subdivision omission certificate requires frozen spherical `degenerate / no spherical area`, finite `u = abs(area) + roundingBound <= 1e-14 sr`, original-source orientation, and cumulative per-source `sum(u) + summation rounding <= min(1e-14, max(0,abs(sourceArea)-sourceRounding)*1e-7)`. All leaves enter coverage; retained signed area is additionally checked against `coverage.roundingBound + cap`. This is not the whole-source policy.
- A 179-entry half-degree theta table is only a Newton initial guess for frame vertices at |latitude| <= 89°. Every vertex is corrected anew; near poles/invalid inputs retain the existing solver. Dense 35,601-point comparison against the frozen reference measured maximum error **4.05335e-7 m** (<1e-6 m). The fast-face edge-distance predicate is squared algebraically, preserving its 1e-5 m threshold.

## Correctness evidence

- **491 passed, 5 skipped**; `npx tsc --noEmit` passed.
- Source 842 reproduces exactly the independently certified three leaves `(b,m,a), (m,n,a), (n,c,a)` with **maxDepth 2**, every leaf accepted by original `projectTriangle`, zero omission, and source cap approximately **9.50941623e-15 sr**. Its isolated old refiner already passed; the historical full-frame 842 failure is not claimed as an isolated reproduction. The old full-model 100.01 Ma source-74 depth failure was reproduced before replacement.
- Full actual PALEOMAP frames passed at **25.63, 0, 100, 180, 100.6, 0.6, 10.2, 20.4, 30, 100.01, 110.2, 120.4, 130 Ma**, plus **120 noninteger frames**: `0.13 + 0.5*i` and `100.13 + 0.5*i`, i=0..59. Every frame had **zero subdivided-leaf omissions**. Only the existing whole-source 889 was omitted; 842 never entered that list.
- Negative controls reject deleting a visible 842 leaf (~2.377e-8 sr), marking it omitted, reversed spherical orientation even with an individually valid oracle result, two ~5.78e-15-sr omission bounds accumulated beyond a source cap, unsupported fake omission and nonfinite bounds. Coverage, aliased/reversed shared-edge segments, immutable sources/mappings, abort and resource budgets remain tested.
- Buffer goldens were deliberately updated: topology changes with longest-edge propagation; frame forward coordinates can differ by submicrometres with the corrected theta seed. They are not old-topology equivalence claims.

## Performance, not a GPU-renderer claim

Representative warm Node stage samples (noisy): 100 Ma refinement **168.5 → 32.8 ms** after propagation; frame vertex work about **31–35 → 23–30 ms** after theta seeding. Low-age refinement remains ~40–50 ms, outlines ~8–10 ms, geometry ~12–14 ms. `triangleMs` includes refinement.

Existing port **4183** served only `/tmp/timemachineweb-test/rectangle-mvp-dist`; no process restart, root dist or port 4173 change. Final bundle: **index-DscJ2vGl.js**. Isolated browser: **moll-longest-impl**. Actual `time.set` input streams, nominal 50-ms request intervals:

| Stream | Actual input | Commits during input | Rate | Median / p95 / max gap | Median / max commit latency |
| --- | --- | --- | --- | --- | --- |
| 100→130 | 3036.0 ms | 18 | **5.93 Hz** | 150.2 / 181.7 / 186.3 ms | 216.0 / 281.3 ms |
| 0→30 | 3049.2 ms | 13 | **4.26 Hz** | 183.5 / 186.7 / 194.9 ms | 247.5 / 336.0 ms |

The pre-task cache-only historical run was 5.30 Hz at 100→approximately130 with depth failures at other requested ages. With propagation but before theta seeding, the corrected endpoint benchmark measured 5.62 Hz (100→130) and 4.25 Hz (0→30). These runs are not deterministic same-age GPU comparisons.

Final benchmark explicitly **sends and awaits 130 / 30** after timed input; compares final committed age with **lastSent**, not an unsent ideal target. Both ended ready at the exact lastSent, with no non-busy errors. Final settle times: 281.4 / 225.6 ms. First-commit latencies: 370.6 / 715.7 ms. Superseded requests remain expected 409/busy results.

**10 effective commits/s is not reached.** Before theta optimization a browser CPU profile attributed substantial self time to frame assembly (~1793 ms), runtime theta solves (~1121 ms), frozen clip normalization (~346 ms), and additional Cesium bounding/geometry work across the two streams. This is measured remaining CPU/rebuild work, not a hardware ceiling; no persistent GPU renderer, hidden outlines, reduced precision or GPU upload-byte claim is made.

GUI smoke used the actual projection dropdown Rectangle→Mollweide, Jump to 100 Ma and Home; screenshot shows the complete 100 Ma ellipse with outlines. Parent must independently perform final Agent/API/GUI acceptance.

Artifacts under `/tmp/timemachineweb-test/`: `moll-longest-full-tests.log`, `moll-longest-tsc.log`, `moll-longest-build.log`, `moll-longest-perf.js`, `moll-longest-perf-release.json`, `moll-longest.cpuprofile`, `moll-longest-profile-summary.log`, `moll-longest-gui100.png`, `moll-longest-gui100.json`.

## Follow-up: allocation-only preparation (latest build)

Changed only `plate-mollweide-frame.ts`, new `mollweide-assembly-performance.test.ts`, and this document. No oracle, refinement algorithm/topology, norm arithmetic, Renderer, camera, Controller, Agent/API, UI, dependency or backend changes.

- Frame-local typed index/source buffers and geometrically growing **exception-only** typed position storage replace number-array pushes/conversions. Only used views reach Geometry; positions have exact used storage. Index width and original face IDs are preserved.
- Reuse one mutable projection scratch object per polygon. Cache exact normalized duplicate-vertex identities (including signed zero) per immutable snapshot; recompute every unique vertex each pose and copy identical results within that frame. This costs one Uint32 per source vertex and additional cold-only key construction, not cross-age geometry caching.
- Reuse the face mask for refinement replacement instead of per-triangle Map lookup. `triangleMs` still **includes** `refinementMs`; never sum them.
- **All 13 prior binary output hashes unchanged**, including outlines/mappings; all 120 noninteger frames still pass with zero refined-leaf omissions. New forced 65,537-vertex seam fixture exercises append growth, Uint32 indices, original-face mapping, poisoned-output isolation. Full suite **493 passed / 5 skipped**, targeted tests and `tsc --noEmit` pass. Baseline/goldens were not changed.

Latest served bundle: **index-DN6JNWDk.js**, same existing 4183 server and external build directory. Independent browser session `moll-assembly-impl`; actual UI Rectangle→Mollweide, Jump to 100 and Home verified with a visible complete ellipse/outlines; end-of-stream 30 Ma screenshot also visible. Final unprofiled runs, after Home:

| Stream | Actual input / requests | Commits / rate | Stream median / p95 / max gap | Stream median / p95 latency | Awaited final / settle |
| --- | --- | --- | --- | --- | --- |
| 100→130 | 3014.3 ms / 48 | 22 / **7.30 Hz** | 127.4 / 140.6 / 144.4 ms | 181.9 / 214.0 ms | 130 ready / 171.5 ms |
| 0→30 | 3019.8 ms / 46 | 16 / **5.30 Hz** | 163.0 / 170.9 / 170.9 ms | 225.4 / 275.0 ms | 30 ready / 223.1 ms |

Both explicitly sent and awaited the final target, with no non-busy errors. First-commit delays were 285.7 / 570.0 ms, reported separately rather than hidden from effective Hz. Earlier allocation-step runs ranged 6.87–7.59 / 5.23–5.63 Hz; these noisy samples are not a guaranteed speedup or acceptance. **10 Hz remains unmet; parent acceptance remains pending.**

Remaining measured costs: isolated warm Node samples at 100.6 Ma: vertex 22.1, triangle **39.5 including refinement 27.3**, outline 8.8, geometry 3.3 ms (74.3 ms total); 0.6 Ma: 23.4, **57.6 including 46.0**, 9.0, 3.7 ms (94.4 ms total). Earlier geometry assembly was ~12–14 ms. The latest 7.10-s browser CPU profile (including setup/settle) has exclusive self totals: frame file 1521 ms (including seeded forward 670 ms), refinement 1126 ms, frozen clip/segment file 1014 ms, runtime forward helper 295 ms, Cesium 1625 ms. Do not add these source-file self totals to inclusive stage timings.

Next bounded option is previous-success split-DAG/leaf recipe reuse **with an explicit local refiner interface**, not caching a prior pose's validity: rebuild midpoint coordinates, projections, winding, coverage and budgets each pose; route new exceptions and conforming neighbours through the same refiner. This could avoid repeated failed-intermediate-leaf work, but has not been implemented or claimed fast enough. Larger alternative, requiring parent/user authorization, is persistent native geometry/buffer updates (or a GPU-projection layout) to avoid repeated Cesium encoding/rebuild. Current median gaps require roughly **27 / 63 ms** further savings to reach 100-ms spacing; no hardware ceiling is inferred.

Latest evidence under `/tmp/timemachineweb-test/`: `moll-assembly-{before,after,object-target,exact-target,flags-target,append-target}.log`, `moll-assembly-full-tests.log`, `moll-assembly-final-{tsc,build,perftest}.log`, `moll-assembly-final-node.json`, `moll-assembly-final-{perf,summary}.json`, `moll-assembly.cpuprofile`, `moll-assembly-final-profile-mapped.json`, `moll-assembly-final-gui.{png,json}`, `moll-assembly-final-stream30.{png,json}`. Intermediate step logs contain unchanged-hash checks; latest script is still `moll-longest-perf.js`. Parent must perform independent final Agent/API/GUI acceptance.
