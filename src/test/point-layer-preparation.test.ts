import { afterEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "cesium";
import type { GpuPointRenderer, LoadedPointDataset } from "@timemachine/point-runtime";
import { preparePointLayer, disposePointLayer } from "../layers/point-layer-preparation";
import { OperationInterruptedError } from "../agent-actions/operation";

const runtime = vi.hoisted(() => ({ load: vi.fn(), create: vi.fn() }));
vi.mock("@timemachine/point-runtime", () => ({
  loadPointDataset: runtime.load,
  GpuPointRenderer: { create: runtime.create },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const dataset = { datasetId: "sample", header: { pointCount: 3 }, buffer: new ArrayBuffer(60), timings: { cacheHit: false } } as LoadedPointDataset;
const frame = (timeMa: number) => ({ timeMa, rotationMap: new Map([[1, { w: 1, x: timeMa / 1000, y: 0, z: 0 }]]) });
function setup() {
  const renderer = { setTime: vi.fn(), destroy: vi.fn() };
  const abort = new AbortController();
  runtime.load.mockResolvedValue(dataset);
  runtime.create.mockResolvedValue(renderer);
  const readCommittedFrame = vi.fn(() => frame(100));
  return { renderer, abort, options: {
    viewer: {} as Viewer, entry: { id: "sample", pointCount: 3 },
    resolveUrl: vi.fn(async () => "/sample.wgp"), readCommittedFrame,
    onUploading: vi.fn(), onCleanupError: vi.fn(), signal: abort.signal,
  } };
}
afterEach(() => { vi.resetAllMocks(); });

describe("point layer preparation used by the application", () => {
  it("does no work when the load was cancelled before URL resolution", async () => {
    const { abort, options } = setup(); abort.abort();
    await expect(preparePointLayer(options)).rejects.toMatchObject({ reason: "cancelled" });
    expect(options.resolveUrl).not.toHaveBeenCalled();
    expect(runtime.load).not.toHaveBeenCalled();
    expect(runtime.create).not.toHaveBeenCalled();
  });

  it("settles a cancelled URL wait immediately and never starts its late Worker", async () => {
    const { abort, options } = setup(); const url = deferred<string>();
    options.resolveUrl.mockReturnValue(url.promise);
    const result = preparePointLayer(options);
    const rejected = expect(result).rejects.toMatchObject({ reason: "cancelled" });
    abort.abort(); await rejected;
    url.resolve("/late.wgp"); await Promise.resolve(); await Promise.resolve();
    expect(runtime.load).not.toHaveBeenCalled();
  });

  it("does not create a GPU renderer from a late decoded or cached result", async () => {
    const { abort, options } = setup(); const loaded = deferred<LoadedPointDataset>();
    runtime.load.mockReturnValue(loaded.promise);
    const result = preparePointLayer(options);
    const rejected = expect(result).rejects.toMatchObject({ reason: "cancelled" });
    await vi.waitFor(() => expect(runtime.load).toHaveBeenCalledOnce());
    abort.abort(); await rejected;
    loaded.resolve(dataset); await Promise.resolve(); await Promise.resolve();
    expect(runtime.create).not.toHaveBeenCalled();
    expect(options.onUploading).not.toHaveBeenCalled();
  });

  it("destroys a late GPU candidate after supersession without returning it", async () => {
    const { abort, options, renderer } = setup(); const gpu = deferred<typeof renderer>();
    runtime.create.mockReturnValue(gpu.promise);
    const result = preparePointLayer(options);
    const rejected = expect(result).rejects.toMatchObject({ reason: "superseded" });
    await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce());
    abort.abort(new OperationInterruptedError("superseded")); await rejected;
    gpu.resolve(renderer); await Promise.resolve(); await Promise.resolve();
    expect(renderer.destroy).toHaveBeenCalledOnce();
    expect(renderer.setTime).not.toHaveBeenCalled();
  });

  it("uses one committed age/map pair and refreshes that pair after GPU preparation", async () => {
    const { options, renderer, abort } = setup(); const gpu = deferred<typeof renderer>();
    const first = frame(100), latest = frame(200);
    options.readCommittedFrame.mockReturnValue(first);
    runtime.create.mockReturnValue(gpu.promise);
    const result = preparePointLayer(options);
    await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce());
    expect(runtime.create).toHaveBeenCalledWith(options.viewer, dataset, first.timeMa, first.rotationMap, { signal: abort.signal, show: false, onCleanupError: options.onCleanupError });
    options.readCommittedFrame.mockReturnValue(latest);
    gpu.resolve(renderer);
    await expect(result).resolves.toEqual({ dataset, renderer });
    expect(renderer.setTime).toHaveBeenCalledExactlyOnceWith(latest.timeMa, latest.rotationMap);
    expect(renderer.destroy).not.toHaveBeenCalled();
  });

  it("rejects wrong point counts before creating GPU resources", async () => {
    const { options } = setup(); options.entry.pointCount = 4;
    await expect(preparePointLayer(options)).rejects.toThrow("3");
    expect(runtime.create).not.toHaveBeenCalled();
  });

  it("releases an uninstalled renderer if final frame reconciliation fails", async () => {
    const { options, renderer } = setup(); renderer.setTime.mockImplementation(() => { throw new Error("frame failed"); });
    await expect(preparePointLayer(options)).rejects.toThrow("frame failed");
    expect(renderer.destroy).toHaveBeenCalledOnce();
  });

  it("hands a late cancelled GPU candidate to the caller so failed release stays retryable", async () => {
    const { abort, options, renderer } = setup(); const gpu = deferred<typeof renderer>();
    runtime.create.mockReturnValue(gpu.promise);
    renderer.destroy.mockImplementationOnce(() => { throw new Error("retry release"); });
    const retained: { renderer?: { destroy(): void } } = {};
    const result = preparePointLayer({ ...options, releaseRenderer(value: GpuPointRenderer) {
      retained.renderer = value;
      disposePointLayer(retained, options.onCleanupError);
    } });
    const rejected = expect(result).rejects.toMatchObject({ reason: "cancelled" });
    await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce());
    abort.abort(); await rejected;
    gpu.resolve(renderer); await Promise.resolve(); await Promise.resolve();
    expect(retained.renderer).toBe(renderer);
    expect(renderer.destroy).toHaveBeenCalledOnce();
    expect(disposePointLayer(retained, options.onCleanupError)).toBe(true);
    expect(retained.renderer).toBeUndefined();
    expect(renderer.destroy).toHaveBeenCalledTimes(2);
  });

  it("retains the renderer after installation-time reconciliation and release both fail", async () => {
    const { options, renderer } = setup(); const failure = new Error("setTime failed");
    renderer.setTime.mockImplementation(() => { throw failure; });
    renderer.destroy.mockImplementationOnce(() => { throw new Error("retry release"); });
    const retained: { renderer?: { destroy(): void } } = {};
    await expect(preparePointLayer({ ...options, releaseRenderer(value: GpuPointRenderer) {
      retained.renderer = value;
      disposePointLayer(retained, options.onCleanupError);
    } })).rejects.toBe(failure);
    expect(retained.renderer).toBe(renderer);
    expect(renderer.destroy).toHaveBeenCalledOnce();
    expect(disposePointLayer(retained)).toBe(true);
    expect(retained.renderer).toBeUndefined();
  });

  it.each(["late", "reconciliation"] as const)("does not let a throwing release callback mask %s failure or leak a rejection", async stage => {
    const { options, renderer, abort } = setup(); const gpu = deferred<typeof renderer>();
    const primary = new Error("setTime failed");
    const cleanup = new Error("release callback failed");
    const observed: unknown[] = [];
    const retained: GpuPointRenderer[] = [];
    if (stage === "late") runtime.create.mockReturnValue(gpu.promise);
    else renderer.setTime.mockImplementation(() => { throw primary; });
    const result = preparePointLayer({ ...options,
      releaseRenderer(value: GpuPointRenderer) { retained.push(value); throw cleanup; },
      onCleanupError(error: unknown) { observed.push(error); throw new Error("diagnostic observer failed"); },
    });
    const rejected = stage === "late"
      ? expect(result).rejects.toMatchObject({ reason: "cancelled" }) : expect(result).rejects.toBe(primary);
    if (stage === "late") {
      await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce());
      abort.abort(); await rejected;
      gpu.resolve(renderer);
    } else await rejected;
    await Promise.resolve(); await Promise.resolve();
    expect(retained).toEqual([renderer]);
    expect(observed).toEqual([cleanup]);
    expect(renderer.destroy).not.toHaveBeenCalled();
  });

  it("consumes an accidental async release rejection without replacing the original failure", async () => {
    const { options, renderer } = setup(); const primary = new Error("setTime failed");
    const cleanup = new Error("async release failed");
    renderer.setTime.mockImplementation(() => { throw primary; });
    const retained: GpuPointRenderer[] = [];
    await expect(preparePointLayer({ ...options, releaseRenderer: async (value: GpuPointRenderer) => {
      retained.push(value); throw cleanup;
    } })).rejects.toBe(primary);
    await Promise.resolve(); await Promise.resolve();
    expect(retained).toEqual([renderer]);
    expect(options.onCleanupError).toHaveBeenCalledExactlyOnceWith(cleanup);
    expect(renderer.destroy).not.toHaveBeenCalled();
  });

  it("keeps GPU cleanup diagnostics observable after its cancelled wait has settled", async () => {
    const { options, renderer, abort } = setup(); const gpu = deferred<typeof renderer>();
    runtime.create.mockReturnValue(gpu.promise);
    const result = preparePointLayer(options);
    const rejected = expect(result).rejects.toMatchObject({ reason: "cancelled" });
    await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce());
    const gpuOptions = runtime.create.mock.calls[0]![4];
    abort.abort(); await rejected;
    expect(gpuOptions.onCleanupError).toBe(options.onCleanupError);
    const cleanupFailure = new Error("GPU cleanup failed");
    gpuOptions.onCleanupError(cleanupFailure);
    gpu.reject(new DOMException("Cancelled", "AbortError"));
    await Promise.resolve(); await Promise.resolve();
    expect(options.onCleanupError).toHaveBeenCalledExactlyOnceWith(cleanupFailure);
  });

  it("forwards a failed pre-renderer GPU release handle even after preparation cancellation", async () => {
    const { options, abort, renderer } = setup(); const gpu = deferred<typeof renderer>();
    runtime.create.mockReturnValue(gpu.promise);
    const pending: Array<{ destroy(): void }> = [];
    const result = preparePointLayer({ ...options, onCleanupPending: (resource: { destroy(): void }) => { pending.push(resource); } });
    const rejected = expect(result).rejects.toMatchObject({ reason: "cancelled" });
    await vi.waitFor(() => expect(runtime.create).toHaveBeenCalledOnce());
    const gpuOptions = runtime.create.mock.calls[0]![4];
    abort.abort(); await rejected;
    let released = false;
    const handle = { destroy() { released = true; } };
    expect(gpuOptions.onCleanupPending).toBeTypeOf("function");
    gpuOptions.onCleanupPending(handle);
    gpu.reject(new DOMException("Cancelled", "AbortError"));
    await Promise.resolve(); await Promise.resolve();
    expect(pending).toEqual([handle]);
    expect(released).toBe(false);
    pending[0]!.destroy(); expect(released).toBe(true);
  });

  it("removes cancellation listeners after successful preparation", async () => {
    const { options, abort } = setup();
    const add = vi.spyOn(abort.signal, "addEventListener");
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    await preparePointLayer(options);
    expect(add.mock.calls.length).toBeGreaterThan(0);
    for (const [name, listener] of add.mock.calls) expect(remove).toHaveBeenCalledWith(name, listener);
  });

  it("releases the picker even if renderer destruction fails", () => {
    const renderer = { destroy: vi.fn(() => { throw new Error("GPU cleanup failed"); }) };
    const picker = { destroy: vi.fn() }, report = vi.fn();
    expect(disposePointLayer({ renderer, picker }, report)).toBe(false);
    expect(picker.destroy).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
  });

  it("retains only failed resource handles so an explicit unload can retry them", () => {
    const renderer = { destroy: vi.fn().mockImplementationOnce(() => { throw new Error("temporary GPU release failure"); }) };
    const picker = { destroy: vi.fn() };
    const resources: { renderer?: typeof renderer; picker?: typeof picker } = { renderer, picker };
    expect(disposePointLayer(resources)).toBe(false);
    expect(resources.renderer).toBe(renderer);
    expect(resources.picker).toBeUndefined();
    expect(disposePointLayer(resources)).toBe(true);
    expect(renderer.destroy).toHaveBeenCalledTimes(2);
    expect(picker.destroy).toHaveBeenCalledOnce();
    expect(resources.renderer).toBeUndefined();
  });
});
