# Mollweide refinement recipe and camera verification

## Scope and contracts

Application-source changes are limited to `mollweide-refinement.ts`,
`plate-mollweide-frame.ts` and `flat-map-camera.ts`. No controller, renderer,
main/actions, core math 1–3B or source-degeneracy policy changes in this round.

`refineMollweideFaces(..., options)` now accepts:

- `sourcePositions`: immutable model-space unit positions (existing argument).
- `rotateSource(point)`: current pose's rotation **and normalization** for a
  newly created model-space midpoint.
- `reuseRecipe?: boolean`: default enabled; `false` executes the uncached oracle.
- `onRecipe?: ("hit" | "miss") => void`: per-attempt telemetry.

`buildMollweidePlateCpuFrame(..., signal, { reuseRecipe?: boolean })` passes the
current plate matrix to that callback. Its stats add `refinementRecipeHits` and
`refinementRecipeMisses`; `refinementMs` includes validation, misses and search.

A WeakMap holds at most **one successful recipe per immutable polygon index
buffer**. A recipe also checks source-position identity and depth/triangle
budgets. It retains canonical source indices, model-space added midpoint
coordinates and leaf topology; it retains no rotated vertices, projections,
previous age or previous-pose legality. Replacing the source releases old
recipes when their index keys become unreachable. Peak working storage is the
bounded old recipe plus the bounded current candidate/output, not an age cache.

Every hit rotates/normalizes all added model vertices again, projects all
current leaves through the existing strict-halfspace certificate or frozen
oracle, and runs the existing spherical orientation/coverage/omission-budget
validation per original face. Shared source edges retain one midpoint and the
full conforming neighbour patch. A new seed outside the patch, changed source
identity/budgets or failed leaf validation executes the original refinement
search. Only a successful, non-aborted refinement replaces the recipe.
Numerical-source and numerical-leaf policies are unchanged.

This is a geometry-splitting recipe cache, **not** full CPU-geometry reuse, a
persistent GPU renderer, or evidence of a hardware FPS ceiling.

## Camera corrections

`FlatMapCamera.getSnapshot()` applies public `camera.viewMatrix` to scene-world
`(depth, east, north)` points before orthographic viewport conversion. The
Mollweide four ellipse extrema use `MOLLWEIDE_DEPTH`; Rectangle's full-domain
corners use zero scene depth and Cesium's native SCENE2D axis permutation. No
scene coordinates are passed to an ECEF-only transform.

API Rectangle zoom scales its public off-center frustum directly, avoiding
native `zoomIn`'s independent 2D clamp. Mollweide pan restores the pre-pan width
after Cesium `moveRight`/`moveUp` adjust the frustum using distance to the ECEF
origin. Mollweide→Rectangle morph restores the saved globe **pose as well as
frustum** first; a real-browser hang was reproduced without that pose restore,
and the final API/UI transition succeeds with it.

The API is unchanged: `camera.zoom({factor})`,
`camera.pan({deltaX,deltaY})`, `camera.reset({})`, and pure
`getState().projection.camera`. Globe zoom/pan still return 501. Camera actions
do not change committed/requested age or persisted project data.

## Verification

Commands: `npx vitest run` (**502 passed, 5 skipped**), `npx tsc --noEmit`
(exit 0), and `npx vite build --outDir /tmp/timemachineweb-test/rectangle-mvp-dist`
(exit 0). No dependency installation or root-dist build.

- Real Cesium Camera/matrix tests cover both modes at aspect 0.75, 1.6 and 3:
  Home max ratio 0.65, maximum zoom-out 0.20, pan translation without resizing.
- Recipe tests compare cached/uncached spherical coverage, current projected
  winding, original-face mapping and conforming edges across small changes,
  rapid spans, reversal, seam and near-pole poses. They exercise hits, new-seed
  misses, source-identity misses, failure and mid-validation abort retention.
- Original byte-hash baselines remain **unchanged** and explicitly run the
  uncached oracle. The full-model 120 noninteger-age sweep uses recipe replay,
  retains every original non-numerical source face and has zero refined-leaf
  omissions. Source position/index buffers remain byte-immutable.
- Final production API checks succeed at 0, 100, 180, 100.6 and 25.63 Ma.
- Production UI Projection select, Home and Jump to present share the working
  handlers; the settled UI result is ready at age 0. Globe unsupported checks
  and Mollweide↔Rectangle transitions were also exercised.

At production viewport 1024×439, **both modes** returned:

| Operation | Domain bounds (canvas CSS px) | Max viewport ratio |
|---|---|---:|
| Home | left 226.65, top 76.825, 570.7×285.35 | 0.65 |
| zoom factor 3 | left 416.8833, top 171.9417, 190.2333×95.1167 | 0.216667 |
| pan (+80, −30) | left 496.8833, top 141.9417, same size | 0.216667 |
| reset | same as Home | 0.65 |
| maximum zoom-out | 175.6×87.8 | 0.20 |

Screenshots match the visible full-domain boundaries after adding the canvas
screen offset; Home/reset and zoom/pan retain their expected ellipse/rectangle
sizes. Bounds are not inferred from currently visible plate data.

## Performance: not yet sustained 10 Hz

Final production bundle tested: `index-MTknhNTq.js`, served by the existing 4183
server from `/tmp/timemachineweb-test/rectangle-mvp-dist`. Root dist/4173 and
existing server processes were not changed/restarted. The unresponsive test
**page** was closed after preserving its evidence; no listening service was killed.

Two real-browser streams used a nominal 50ms interval for at least three
seconds, then explicitly sent and awaited the exact final target:

| Stream | Actual input duration | Inputs | Confirmations during input | Confirm Hz | p95 confirm gap | p95 input→confirm latency | Final settle |
|---|---:|---:|---:|---:|---:|---:|---:|
| 100→130 | 3030.5ms | 59 | 25 | **8.25** | 135.5ms | 221.7ms | 192.3ms |
| 0→30 | 3034.0ms | 58 | 24 | **7.91** | 154.8ms | 240.1ms | 210.0ms |

Main-thread load made p95 actual input gaps 73.9/75.8ms despite the 50ms timer.
There were 33/33 expected 409 supersedes, no non-busy failures, and both final
target calls succeeded with ready state and exact committed target.

Separate sequential stage probes (not a stream throughput claim), collected
before the final opt-out-only allocation guard; the enabled-recipe path is unchanged:

| Age | CPU prepare | Refinement (inside prepare) | stage incl. hidden warm-up | confirm/other | Complete API action |
|---|---:|---:|---:|---:|---:|
| 100.02 | 67.3ms | 12.9ms | 28.1ms | 2.0ms | 97.4ms |
| 100.03 | 68.0ms | 12.9ms | 27.0ms | 2.0ms | 97.0ms |
| 0.02 | 72.9ms | 15.5ms | 31.7ms | 2.3ms | 106.9ms |
| 0.03 | 72.2ms | 14.1ms | 29.6ms | 1.8ms | 103.6ms |

These probes had 69–70/84 recipe hits and 0–1 misses; larger stream jumps still
have misses and search. The 0.02/0.03 samples need another approximately
7/4ms merely to reach 100ms individually; stream p95 gaps need about 30/51ms
removed to reach a 100ms gap (final-stream p95 needs ~36/55ms). Geometry assembly is already about 2–3ms and was
not re-optimized.

### Next smallest reviewable change (requires parent authorization)

First measure/reuse each **current-pose** leaf's `measureSphericalArea` result
within `projectLeaf` and the existing coverage validators, rather than computing
it again in validation. This does not reuse a previous-pose certificate or drop
any checks, and stays within the refiner. It targets the remaining 13–16ms
verification cost, but no speedup is claimed without measurement.

Renderer scheduling is not yet justified as a redundant full-frame wait:
`stageRectangleFrame` awaits `warmUpRectangleFrame`, whose `postRender` check
verifies `ready` and public instance attributes; after commit the controller
awaits a distinct visible render. The measured **post-stage** remainder is only
~2ms in these probes. Removing the warm-up blindly would discard real compile/
resource validation, not simply a duplicate delay. Any renderer change requires
a separate approved, instrumented proposal; none was made here.

## Evidence for parent acceptance

All following artifacts are outside the repository under
`/tmp/timemachineweb-test/`:

- `recipe-full-final.log`, `recipe-tsc-final.log`, `recipe-build.log`
- `recipe-stream50-final.json` and `recipe-stream50.js` (final-bundle raw inputs/results/confirmations)
- `recipe-stream50.json` (previous-bundle repetition)
- `recipe-stage.json` and `recipe-stage.js` (separate stage probes)
- `recipe-camera.json`, `recipe-camera-home-zoom.json`, `recipe-camera-pan.json`
- `recipe-rectangle-{home,zoom3,pan,reset,max}.json`
- `recipe-moll-max.json`, `recipe-screen-domain.json`, `recipe-mode-cycle.json`
- `recipe-final-api.json` (final-bundle five ages and both-mode camera sequence)
- `recipe-ages-final.json`, `recipe-globe-unsupported.json`
- `recipe-frontend-rectangle.json`, `recipe-frontend-moll-settled.json`
- `recipe-{home,zoom3,pan,reset}.png`, `recipe-rectangle-{home,zoom3,pan,reset}.png`
- `recipe-final-home100.png`, `recipe-moll-max-pan.png`

Parent acceptance and a sustained 10Hz claim remain outstanding.
