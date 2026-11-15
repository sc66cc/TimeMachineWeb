import { Event, type Viewer } from "cesium";
import type { GpuPointRenderer } from "@timemachine/point-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperationInterruptedError } from "../agent-actions/operation";
import { waitForPointLayerFrame } from "../layers/point-layer-frame";

function observe(promise: Promise<void>) {
  const state: { status: "pending" | "resolved" | "rejected"; error?: unknown } = { status: "pending" };
  void promise.then(() => { state.status = "resolved"; }, error => { state.status = "rejected"; state.error = error; });
  return state;
}
async function drain() { for (let index = 0; index < 5; index++) await Promise.resolve(); }
function harness() {
  const postRender = new Event();
  const renderError = new Event();
  const state = { current: true, destroyed: false, timeMa: 100, show: true, belongs: true };
  const scene = { postRender, renderError, isDestroyed: () => state.destroyed, requestRender: vi.fn() };
  const viewer = { scene, useDefaultRenderLoop: true };
  const renderer = { matchesFrameState: (timeMa: number, show: boolean) => state.belongs && state.timeMa === timeMa && state.show === show };
  const signal = new AbortController();
  const options = { signal: signal.signal, isCurrent: () => state.current, timeMa: 100, show: true };
  return {
    viewer, renderer, state, options, signal, scene,
    start: () => waitForPointLayerFrame(viewer as unknown as Viewer, renderer as unknown as GpuPointRenderer, options),
    startEmpty: () => waitForPointLayerFrame(viewer as unknown as Viewer, undefined, options),
    frame: () => postRender.raiseEvent(scene),
    error: (error: unknown) => renderError.raiseEvent(scene, error),
    listeners: () => postRender.numberOfListeners + renderError.numberOfListeners,
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("point layer frame acknowledgement", () => {
  it("requires a postRender after installation, then releases all waiting resources", async () => {
    const h = harness(); const removeAbort = vi.spyOn(h.signal.signal, "removeEventListener");
    const promise = h.start(); const result = observe(promise);
    await drain(); expect(result.status).toBe("pending");
    h.frame(); await promise;
    expect(result.status).toBe("resolved");
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("confirms restoration to no point renderer only after a new real frame", async () => {
    const h = harness();
    const promise = h.startEmpty(); const result = observe(promise);
    await drain(); expect(result.status).toBe("pending");
    h.frame(); await promise;
    expect(result.status).toBe("resolved");
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not accept a failed empty restoration frame or a newly installed owner", async () => {
    const h = harness(); const failure = new Error("Empty restoration draw failed");
    const failed = observe(h.startEmpty());
    h.error(failure); h.frame(); await drain();
    expect(failed).toMatchObject({ status: "rejected", error: failure });
    const replaced = observe(h.startEmpty());
    h.state.current = false; h.frame(); await drain();
    expect(replaced).toMatchObject({ status: "rejected", error: { reason: "superseded" } });
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("never accepts the postRender Cesium emits after a same-stack renderError", async () => {
    const h = harness(); const failure = new Error("Synthetic native POINTS draw failure");
    const promise = h.start(); const result = observe(promise);
    h.viewer.useDefaultRenderLoop = false;
    h.error(failure); h.frame();
    await drain();
    expect(result).toMatchObject({ status: "rejected", error: failure });
    expect(h.viewer.useDefaultRenderLoop).toBe(false);
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
    // Caller recovery runs after the failing native stack, and owns a NEW wait.
    const recovery = h.start(); const recovered = observe(recovery);
    expect(h.viewer.useDefaultRenderLoop).toBe(true);
    await drain(); expect(recovered.status).toBe("pending");
    h.frame(); await recovery;
  });

  it("keeps a second recovery render error as failure without automatic retries", async () => {
    const h = harness(); h.viewer.useDefaultRenderLoop = false;
    const promise = h.start(); const result = observe(promise);
    const failure = new Error("Synthetic recovery failure");
    h.viewer.useDefaultRenderLoop = false; h.error(failure); h.frame();
    await drain();
    expect(result).toMatchObject({ status: "rejected", error: failure });
    expect(h.viewer.useDefaultRenderLoop).toBe(false);
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not resolve before the native frame stack can report its final failure", async () => {
    const h = harness(); const failure = new Error("Failure in a later frame listener");
    const result = observe(h.start());
    h.frame(); h.error(failure); await drain();
    expect(result).toMatchObject({ status: "rejected", error: failure });
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("never restarts the loop when ownership validation synchronously cancels the wait", async () => {
    const h = harness(); h.viewer.useDefaultRenderLoop = false;
    let reads = 0;
    h.options.isCurrent = () => {
      if (++reads === 2) h.signal.abort();
      return true;
    };
    const result = observe(h.start()); await drain();
    expect(result).toMatchObject({ status: "rejected", error: { reason: "cancelled" } });
    expect(h.viewer.useDefaultRenderLoop).toBe(false);
    expect(h.scene.requestRender).not.toHaveBeenCalled();
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["time", "visibility", "collection"] as const)("rejects a %s change before confirmation", async field => {
    const h = harness(); const promise = h.start(); const result = observe(promise);
    if (field === "time") h.state.timeMa = 200;
    if (field === "visibility") h.state.show = false;
    if (field === "collection") h.state.belongs = false;
    h.frame(); await drain();
    expect(result.status).toBe("rejected");
    expect(result.error).toBeInstanceOf(OperationInterruptedError);
    expect(result.error).toMatchObject({ reason: "superseded" });
    expect(h.listeners()).toBe(0);
  });

  it("acknowledges an explicitly hidden target only after its hidden frame", async () => {
    const h = harness(); h.state.show = false; h.options.show = false;
    const promise = h.start(); const result = observe(promise);
    await drain(); expect(result.status).toBe("pending");
    h.frame(); await promise;
    expect(result.status).toBe("resolved");
  });

  it.each(["pre-abort", "stale-owner", "destroyed-scene"] as const)("does not start native work for %s", async reason => {
    const h = harness(); h.viewer.useDefaultRenderLoop = false;
    if (reason === "pre-abort") h.signal.abort();
    if (reason === "stale-owner") h.state.current = false;
    if (reason === "destroyed-scene") h.state.destroyed = true;
    const result = observe(h.start()); await drain();
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ reason: reason === "stale-owner" ? "superseded" : "cancelled" });
    expect(h.viewer.useDefaultRenderLoop).toBe(false);
    expect(h.scene.requestRender).not.toHaveBeenCalled();
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("releases an aborted wait immediately and never lets its old signal stop a successor", async () => {
    const h = harness(); const first = observe(h.start());
    h.signal.abort(new OperationInterruptedError("superseded")); await drain();
    expect(first).toMatchObject({ status: "rejected", error: { reason: "superseded" } });
    const next = new AbortController(); h.options.signal = next.signal;
    const second = h.start(); const result = observe(second);
    h.signal.abort(); await drain(); expect(result.status).toBe("pending");
    h.frame(); await second;
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["owner", "scene"] as const)("rejects when the %s becomes invalid before postRender", async reason => {
    const h = harness(); const result = observe(h.start());
    if (reason === "owner") h.state.current = false;
    else h.state.destroyed = true;
    h.frame(); await drain();
    expect(result).toMatchObject({ status: "rejected", error: { reason: reason === "owner" ? "superseded" : "cancelled" } });
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a missing frame at 30 seconds and removes listeners", async () => {
    const h = harness(); const result = observe(h.start());
    await vi.advanceTimersByTimeAsync(29_999); expect(result.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ message: expect.stringContaining("30 seconds") });
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up if requesting the frame throws synchronously", async () => {
    const h = harness(); const failure = new Error("requestRender failed");
    h.scene.requestRender.mockImplementation(() => { throw failure; });
    const result = observe(h.start()); await drain();
    expect(result).toMatchObject({ status: "rejected", error: failure });
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("removes an earlier listener if a later native subscription fails", async () => {
    const h = harness(); const failure = new Error("Native error listener registration failed");
    vi.spyOn(h.scene.renderError, "addEventListener").mockImplementation(() => { throw failure; });
    const result = observe(h.start()); await drain();
    expect(result).toMatchObject({ status: "rejected", error: failure });
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("attempts all listener releases and reports cleanup failure instead of success", async () => {
    const h = harness(); const failure = new Error("Native listener removal failed");
    const add = h.scene.postRender.addEventListener.bind(h.scene.postRender);
    vi.spyOn(h.scene.postRender, "addEventListener").mockImplementation(listener => {
      const remove = add(listener);
      return () => { remove(); throw failure; };
    });
    const result = observe(h.start()); h.frame(); await drain();
    expect(result.status).toBe("rejected");
    expect(result.error).toBeInstanceOf(AggregateError);
    expect((result.error as AggregateError).errors).toContain(failure);
    expect(h.listeners()).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
});
