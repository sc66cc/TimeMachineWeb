# Mollweide model-worker pipeline

## Scope and contracts

The existing `buildMollweidePlateCpuFrame` remains the production algorithm. Projection equations, tolerances, refinement topology, validity, camera parameters, point/raster rendering and Agent actions are unchanged. Rectangle and Globe retain their existing synchronous/single-active dispatch paths. This is CPU/GPU scheduling, not a persistent GPU renderer or a hardware frame-rate ceiling.

- One lazily created resident Worker per renderer/model; source snapshots are structured-cloned once, **never transferred from retained main-thread buffers**. Worker snapshot/index objects remain stable for recipe caches. An idle worker survives ordinary mode switches.
- Each frame sends only age, quaternion entries and a monotonically increasing ticket. Worker lifetime/transport identity is its source epoch. Active cancellation terminates the worker; explicit retry lazily recreates it. Source invalidation and renderer/controller destruction release idle workers too.
- The Worker uses named public `@cesium/engine` CPU exports already installed by Cesium. A worker-local exact `Cesium` table precedes static-literal dynamic imports of the shared algorithm and packet module. This accommodates the existing global-externalizing Cesium plugin without Vite changes, eval, importScripts or runtime-generated import URLs. No page global is added.
- Frame positions/indices and compact outline coordinates/offsets transfer ownership without an additional main-thread typed-array copy. Main reconstructs Cesium descriptors and binds picks to the **original retained feature** by source-snapshot index. Features are not returned from the worker.
- Moll keeps one GPU-active/confirmation request, one CPU-active/ready successor, and one latest pending metadata request. Later inputs overwrite only pending (busy/409); promoted CPU work is not starved. There is no historical work queue. The renderer's consumed CPU slot is independent of its warming GPU slot. At most old committed plus new staged GPU resources exist.
- Every ticket resolves only after its own actual render. Requested age remains the latest time input; committed age advances only after confirmation. Prepared handles are identity-checked and single use.
- Mode/capability/source/destroy/render-error cancellation settles active, promoted and pending promises; worker error/abort removes listeners, clears the liveness timer, terminates the transport and rejects. Old messages cannot replace newer work. The 60-second lost-worker timeout is a liveness bound, not a performance deadline. Existing flat-swap rollback retains the last confirmed view and explicit retry restores Cesium's render loop.
- CPU cooperative yields use native `MessageChannel` in both window and worker realms, avoiding the worker's nested-setTimeout minimum-delay penalty. There is no numerical shortcut.

## Verification

Commands:

```sh
npx tsc --noEmit
npm test -- --reporter=dot
npx vite build --outDir /tmp/timemachineweb-test/moll-worker-candidate-dist
node scripts/mollweide-worker-browser-smoke.mjs http://localhost:4184
```

The last command uses only the already installed `agent-browser` CLI, isolated session `moll-worker-impl`, and a candidate preview started separately on a checked-free port. It saves raw worker/request events and summaries to `/tmp/timemachineweb-test/moll-worker-browser-results.json` by default. It does not start/stop services or publish a bundle.

- Typecheck passed; **520 passed / 5 skipped** (503 pre-existing passing tests plus 17 new tests).
- New tests execute the production client, packet adapter and controller queue, covering initialization once, frame-message shape, actual structured-clone transfer detachment, retained-source ownership, original feature rebinding, concurrent-job rejection, timeout, clone/protocol/transport errors, abort/destroy, listener cleanup, old-ticket isolation, retry, CPU/GPU overlap, bounded pending replacement, mode/source/capability/renderError cancellation, worker failure, and renderer handle single consumption while another frame warms.
- Real browser Worker successfully prepared PALEOMAP: 471 features, 503 polygons, 316 rotation sequences. The 29-action smoke covers all three modes, zoom/pan/home, time, layer capability guards and invalid actions. Exactly one worker initialization spans ordinary mode changes. Native UI select changes Rectangle → Globe → Mollweide and the home button also passed. No uncaught browser errors observed; screenshot shows the populated Mollweide plane, not an empty model.
- The existing real-model 120-noninteger-age test still reports zero refinement omissions. Existing fixed-age, mathematical and accounting tests remain passing.

## Real-stream measurements

Candidate Chromium/browser CLI run, PALEOMAP Home, 60 unique requests at 50 ms planned intervals over 3 seconds, increments of 0.5 Ma. Initialization/warm-up occurs before measurement. Each run awaits **the original final input's promise** (130 / 30); no duplicate terminal age is sent or counted. Superseded pending inputs return busy, not success. Counts below are successful render-confirmed `time.set` results, never rAF counts.

| Metric | 100 → 130 Ma | 0 → 30 Ma |
| --- | ---: | ---: |
| Actual duration incl. final drain | 3131.4 ms | 3143.2 ms |
| Confirmed unique frames | 40 | 38 |
| Confirmed / actual duration | 12.77 Hz | 12.09 Hz |
| Steady first-to-last confirmation | 13.23 Hz | 12.50 Hz |
| p95 confirmation gap | 99.1 ms | 101.2 ms |
| p95 accepted-request latency | 180.3 ms | 178.2 ms |
| Mean worker CPU prepare | 70.19 ms | 73.26 ms |
| Mean worker packet packing | 0.69 ms | 0.91 ms |
| Mean worker idle between jobs | 6.97 ms | 9.30 ms |
| Mean return transfer/dispatch | 0.96 ms | 1.13 ms |
| Mean CPU-successor/GPU-predecessor overlap | 33.47 ms | 37.76 ms |
| Main-thread long tasks during stream | 0 | 0 |

Worker prepare/pack/idle are durations measured within the worker. Transfer/dispatch uses `worker.performance.timeOrigin + worker.performance.now()` against the receiving main thread's corresponding epoch timestamp, **not raw cross-realm performance.now subtraction**. Transfer includes dispatch/scheduling and is not claimed to isolate hardware copy time. Overlap is the main-clock interval from sending the promoted next CPU job until the preceding confirmed Agent result, derived from raw ticket/age events; unit tests independently pin that CPU b starts while GPU a remains unresolved.

After candidate Worker/API/UI smoke passed, the formal `/tmp/timemachineweb-test/rectangle-mvp-dist` bundle was built without restarting the existing preview. A separate repeat against port 4183 also passed the 29 Agent actions and three UI switches: 100 → 130 confirmed 40 frames / 3167.7 ms = **12.63 Hz** (steady 13.06; p95 gap 100.4 ms; p95 latency 179.4 ms); 0 → 30 confirmed 39 / 3192.4 ms = **12.22 Hz** (steady 12.60; p95 gap 101.1 ms; p95 latency 174.8 ms). Both had zero main-thread long tasks and exact terminal-age confirmation. Raw formal evidence is `/tmp/timemachineweb-test/moll-worker-formal-browser-results.json`.

Both streams exceeded the requested 10 confirmed frames/second in these measurements. Remaining CPU preparation (~70–73 ms) and browser/GPU scheduling still limit throughput; this is not a guarantee for every machine/model. Parent independent acceptance remains required, especially physical timeline needle dragging and actual MacBook trackpad zoom in both directions with/without Ctrl.
