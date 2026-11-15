# Mollweide CPU-gap render failure repair

## Scope and behavior

Only application change: `src/projection/projection-controller.ts`. No renderer, Worker, math, precision, backend, build configuration or global-role changes.

The old frame may throw during asynchronous CPU preparation. CesiumWidget stops its default render loop before raising `renderError`. Previously the controller listened only during GPU warm-up/confirmation: a late CPU result could stage successfully and wait forever for a postRender that `requestRender()` alone cannot deliver. A new time request only queued behind this active request.

CPU preparation now occupies the controller's existing cancellable waiter slot. Its renderError listener is installed before invoking preparation. It rejects with the original render error before aborting CPU work, so cancellation cannot replace a 500 with AbortError/busy. The existing failure path clears staged/prepared/successor/pending work and settles tickets; late CPU resolution cannot resume the rejected await or stage a frame. Mode/source/destroy cancellation removes this listener through the same waiter mechanism. Generation and swap-owner checks remain unchanged.

Loop recovery occurs on explicit time input (including the active/queued path), after CPU generation validation before staging, and on confirmation entry. There is no automatic request retry, timeout-based success, or completion without real rendering. A renderError is still a failed transaction, not a successful one rescued by restarting its loop.

## Automated verification

- `npx vitest run`: **528 passed, 5 skipped**, 43 passing files / 1 skipped.
- `npx tsc --noEmit`: passed.
- `git diff --check`: passed.
- Fake Widget stops its loop before error callbacks and refuses postRender while stopped. Regressions cover CPU-gap failure/late CPU, ready successor plus latest queued failure, explicit queued retry recovery, silent CPU/staging stops, and mode/source/destroy listener cleanup.

## Production browser evidence

Command: `node scripts/mollweide-render-gap-browser.mjs` (isolated session `moll-gap-fix`, candidate port 4184).

Evidence: `/tmp/timemachineweb-test/moll-gap-fix-browser.json`.

Uses actual WebGL2 `gl.drawElements`: restores the original method immediately before throwing once. It captures the actual CesiumWidget through a browser-only prototype wrapper; Viewer delegates `useDefaultRenderLoop` to this widget. No production debug viewer/API. GPU stage timestamps are scene primitive-add observations, not an exported controller hook.

### CPU-gap run (performance.now milliseconds)

- 108Ma Worker ticket 3 started 2290.7; GPU error requested 2295.8 (~5.1ms later for nominal 4ms timer).
- Actual draw threw 2309.3; renderError 2309.5 observed **loop=false**.
- Existing cancellation terminated active Worker at 2309.6. Consequently this failed CPU ticket has **no ready packet**, not a fabricated ready timestamp.
- 108 and queued 110 both settled **500 at 2310.5**, before any target GPU stage. Committed frame remained 100Ma.
- Explicit retry100 sent 2533.4 with loop=false. Existing worker cancellation semantics initialize a fresh Worker on this retry; no new worker algorithm/lifecycle was added.
- Retry Worker ready 2815.5, GPU stage 2819.8, ticket success 2856.8 with **loop=true**, committed/requested 100Ma.

### GPU-current / CPU-successor-ready / latest-queued run

For deterministic phase placement only, the diagnostic temporarily suppresses postRender notifications while the real Widget keeps rendering, then restores the original raiseEvent before the fault. It never emits a synthetic postRender.

- Current 108 Worker ready 2993.0; GPU stage 2999.0.
- Successor109 Worker started 2999.4, ready 3099.7. Latest110 sent 2999.9.
- Actual GL throw 3107.6; renderError 3107.8 with **loop=false**.
- 108, 109, 110 **all settled 500 at 3108.6**; no failed successor GPU stage/promotion; committed100 unchanged.
- Immediate retry100 sent 3108.8; ready3213.1, stage3217.4, success3254.7 with **loop=true**. Idle Worker reused in this case.

Basics 13 / 25.63 / 100.6 / 180 all succeeded with exact committed ages.

### Continuous input performance

`BROWSER_SESSION=moll-gap-fix node scripts/mollweide-worker-browser-smoke.mjs http://127.0.0.1:4184 /tmp/timemachineweb-test/moll-gap-fix-performance.json`

Two original 60-ticket, 3-second, 50ms input streams, waiting for their original final tickets without resending:

| Ages | Confirmed | Wall-clock Hz | Steady Hz | p95 gap |
|---|---:|---:|---:|---:|
|100→130|40|12.57|13.00|101.4ms|
|0→30|39|12.39|12.75|112.3ms|

This is observed confirmed-frame throughput, not persistent GPU rendering or a hardware FPS ceiling.

## Delivery / remaining acceptance

Candidate and formal temporary builds both contain application asset `index-CXrl6any.js`. Formal build updated only `/tmp/timemachineweb-test/rectangle-mvp-dist` for the existing 4183 server; no port process restarted and root dist / 4173 untouched. Parent's existing hung browser was not accessed. Parent independently reruns its original failure scenario before final sign-off. Error-panel DOM is not evidence of loop status and may remain after recovery.
