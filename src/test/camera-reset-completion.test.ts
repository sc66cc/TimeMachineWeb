import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "cesium";
import { CameraResetCompletion } from "../projection/camera-reset-completion";

function harness() {
  const frames = new Set<() => void>();
  const errors = new Set<(_scene: unknown, error: unknown) => void>();
  let callbacks!: { complete: () => void; cancel: () => void };
  const camera = { cancelFlight: vi.fn(() => callbacks?.cancel()),
    positionWC: { x: 1, y: 2, z: 3 }, directionWC: { x: 0, y: 0, z: -1 }, upWC: { x: 0, y: 1, z: 0 },
    frustum: { width: 20, aspectRatio: 1.5 },
  };
  const viewer = {
    camera, useDefaultRenderLoop: true,
    scene: {
      isDestroyed: () => false, requestRender: vi.fn(),
      postRender: { addEventListener: (fn: () => void) => { frames.add(fn); return () => frames.delete(fn); } },
      renderError: { addEventListener: (fn: (_scene: unknown, error: unknown) => void) => { errors.add(fn); return () => errors.delete(fn); } },
    },
  };
  const completion = new CameraResetCompletion(viewer as unknown as Viewer);
  const start = vi.fn((next: typeof callbacks) => { callbacks = next; });
  return { completion, start, viewer, camera, complete: () => callbacks.complete(), cancelNative: () => callbacks.cancel(),
    frame: () => [...frames].forEach(fn => fn()), error: () => [...errors].forEach(fn => fn(viewer.scene, new Error("synthetic render failure"))),
    listeners: () => frames.size + errors.size, callbacks: () => callbacks };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("camera reset completion", () => {
  it("waits for native flight completion and a subsequent rendered frame", async () => {
    const h = harness(); let done = false;
    const p = h.completion.run(h.start).then(() => { done = true; });
    h.frame(); await Promise.resolve(); expect(done).toBe(false);
    h.complete(); await Promise.resolve(); expect(done).toBe(false);
    h.frame(); await p;
    expect(done).toBe(true); expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("acknowledges native cancellation without reporting completed", async () => {
    const h = harness(); const p = h.completion.run(h.start);
    const rejected = expect(p).rejects.toMatchObject({ reason: "cancelled" });
    h.cancelNative(); await rejected; h.frame();
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("actually stops an aborted flight and ignores its late callback", async () => {
    const h = harness(); const signal = new AbortController();
    const p = h.completion.run(h.start, { signal: signal.signal });
    const old = h.callbacks(); const rejected = expect(p).rejects.toMatchObject({ reason: "cancelled" });
    signal.abort(); await rejected;
    expect(h.camera.cancelFlight).toHaveBeenCalledTimes(1);
    old.complete(); h.frame(); expect(h.listeners()).toBe(0);
  });

  it("does not let a pre-cancelled or old signal stop the new owner", async () => {
    const h = harness(); const oldSignal = new AbortController();
    const first = h.completion.run(h.start, { signal: oldSignal.signal });
    const firstRejected = expect(first).rejects.toMatchObject({ reason: "superseded" });
    const old = h.callbacks();
    const second = h.completion.run(h.start); await firstRejected;
    const alreadyAborted = new AbortController(); alreadyAborted.abort();
    await expect(h.completion.run(h.start, { signal: alreadyAborted.signal })).rejects.toMatchObject({ reason: "cancelled" });
    oldSignal.abort(); old.cancel(); old.complete();
    expect(h.camera.cancelFlight).toHaveBeenCalledTimes(1);
    h.complete(); h.frame(); await second;
  });

  it("rejects a completion whose target pose is not finite instead of matching NaN", async () => {
    const h = harness();
    const p = h.completion.run(h.start);
    const rejected = expect(p).rejects.toThrow(/non-finite camera pose/);
    h.camera.positionWC.x = Number.NaN;
    h.complete();
    await rejected;
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a frame that renders a non-finite pose after a healthy target", async () => {
    const h = harness();
    const p = h.completion.run(h.start);
    const rejected = expect(p).rejects.toThrow(/not finite after the reset frame/);
    h.complete();
    h.camera.directionWC.y = Number.NaN;
    h.frame();
    await rejected;
    expect(h.listeners()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports a synchronous flat reset but still waits for its real frame", async () => {
    const h = harness(); let done = false;
    const p = h.completion.run(({ complete }) => complete()).then(() => { done = true; });
    await Promise.resolve(); expect(done).toBe(false);
    h.frame(); await p; expect(done).toBe(true);
  });

  it.each(["position", "frustum"])("does not confirm a reset overwritten through native %s before its frame", async field => {
    const h = harness(); const p = h.completion.run(({ complete }) => complete());
    const rejected = expect(p).rejects.toMatchObject({ reason: "superseded" });
    if (field === "position") h.camera.positionWC.x += 5;
    else h.camera.frustum.width *= 2;
    h.frame(); await rejected;
    expect(h.camera.cancelFlight).not.toHaveBeenCalled();
    expect(h.listeners()).toBe(0);
  });

  it("fails on render errors and releases the real flight before allowing retry", async () => {
    const h = harness(); const p = h.completion.run(h.start);
    const rejected = expect(p).rejects.toThrow("synthetic render failure");
    h.error(); await rejected;
    expect(h.camera.cancelFlight).toHaveBeenCalledTimes(1); expect(h.listeners()).toBe(0);
    h.viewer.useDefaultRenderLoop = false;
    const retry = h.completion.run(h.start);
    expect(h.viewer.useDefaultRenderLoop).toBe(true);
    h.complete(); h.frame(); await retry;
  });

  it("bounds a stopped render loop and cancels its native flight", async () => {
    const h = harness(); const p = h.completion.run(h.start);
    const rejected = expect(p).rejects.toThrow(/30 seconds/);
    await vi.advanceTimersByTimeAsync(30_000); await rejected;
    expect(h.camera.cancelFlight).toHaveBeenCalledTimes(1);
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("releases listeners on startup failure and destruction, and never restarts a disposed owner", async () => {
    const h = harness(); await expect(h.completion.run(() => { throw new Error("synthetic start failure"); })).rejects.toThrow("start failure");
    expect(h.listeners()).toBe(0);
    const p = h.completion.run(h.start); const rejected = expect(p).rejects.toMatchObject({ reason: "cancelled" });
    h.completion.destroy(); await rejected;
    await expect(h.completion.run(h.start)).rejects.toThrow(/destroyed/);
    expect(h.start).toHaveBeenCalledTimes(1); expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
