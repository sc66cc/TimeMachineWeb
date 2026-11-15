// @vitest-environment jsdom

import { PrimitiveCollection, type Viewer } from "cesium";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GpuPointRenderer, type LoadedPointDataset } from "@timemachine/point-runtime";

const gpu = vi.hoisted(() => ({
  failAt: "" as "" | "buffer" | "vertex-array" | "shader" | "texture",
  failDestroyKinds: new Set<string>(),
  renderStateDestroyCount: 0,
  renderStateDestroyAttempts: 0,
  resources: [] as { kind: string; destroyCount: number; destroyAttempts: number; destroy(): void }[],
}));

vi.mock("cesium", async importOriginal => {
  const actual = await importOriginal<typeof import("cesium")>();
  const allocate = (kind: string) => {
    if (gpu.failAt === kind) throw new Error(`Controlled ${kind} allocation failure.`);
    const resource = {
      kind, destroyCount: 0, destroyAttempts: 0,
      destroy() {
        this.destroyAttempts += 1;
        if (gpu.failDestroyKinds.has(kind)) throw new Error(`Controlled ${kind} destroy failure.`);
        this.destroyCount += 1;
      },
    };
    gpu.resources.push(resource);
    return resource;
  };
  return {
    ...actual,
    // No WebGL context in jsdom. Keep the real primitive, collection, ready
    // promise and update path; control only native GPU allocation/release.
    Buffer: { createVertexBuffer: () => allocate("buffer") },
    VertexArray: class {
      private readonly resource = allocate("vertex-array");
      private readonly buffer: { destroy(): void };
      constructor(options: { attributes: { vertexBuffer: { destroy(): void } }[] }) {
        this.buffer = options.attributes[0]!.vertexBuffer;
      }
      destroy() { this.resource.destroy(); this.buffer.destroy(); }
    },
    ShaderProgram: { fromCache: () => allocate("shader") },
    RenderState: {
      fromCache: () => ({}),
      removeFromCache: () => {
        gpu.renderStateDestroyAttempts += 1;
        if (gpu.failDestroyKinds.has("render-state")) throw new Error("Controlled render-state destroy failure.");
        gpu.renderStateDestroyCount += 1;
      },
    },
    Texture: class {
      private readonly resource = allocate("texture");
      copyFrom() {}
      destroy() { this.resource.destroy(); }
    },
  };
});

interface Candidate {
  update(frame: { context: unknown; passes: { render: boolean }; commandList: unknown[] }): void;
  isDestroyed(): boolean;
  destroy(): void;
}

const collections: PrimitiveCollection[] = [];
function harness(destroyPrimitives = true) {
  const primitives = new PrimitiveCollection({ destroyPrimitives });
  collections.push(primitives);
  const viewer = { scene: { primitives, requestRender: () => undefined, isDestroyed: () => false } } as unknown as Viewer;
  return { viewer, primitives };
}

function dataset(): LoadedPointDataset {
  return {
    datasetId: "synthetic-gpu-lifecycle",
    header: {
      magic: "WGP1", version: 1, headerBytes: 32, recordStrideBytes: 20,
      pointCount: 1, sourcePointCount: 1, maxPlateId: 0, maxTimeDeciMa: 1_000,
    },
    buffer: new ArrayBuffer(52),
    timings: { cacheHit: false, fetchMs: 0, decodeMs: 0, totalMs: 0 },
  };
}

function render(candidate: Candidate): unknown[] {
  const commandList: unknown[] = [];
  candidate.update({ context: {}, passes: { render: true }, commandList });
  return commandList;
}

function observe(promise: Promise<GpuPointRenderer>) {
  const result: { status: "pending" | "resolved" | "rejected"; error?: unknown; renderer?: GpuPointRenderer } = { status: "pending" };
  void promise.then(renderer => { result.status = "resolved"; result.renderer = renderer; },
    error => { result.status = "rejected"; result.error = error; });
  return result;
}

// Drain promise reactions only: cancellation must settle without a render,
// timer, polling loop or GPU-ready callback.
async function drainReactions() { for (let index = 0; index < 6; index += 1) await Promise.resolve(); }

beforeEach(() => {
  gpu.failAt = "";
  gpu.failDestroyKinds.clear();
  gpu.renderStateDestroyCount = 0;
  gpu.renderStateDestroyAttempts = 0;
  gpu.resources.length = 0;
});
afterEach(() => {
  gpu.failDestroyKinds.clear();
  for (const collection of collections.splice(0)) if (!collection.isDestroyed()) collection.destroy();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("GpuPointRenderer creation ownership", () => {
  it("restarts a stopped public loop so a hidden retry can actually initialize", async () => {
    const { viewer, primitives } = harness(); viewer.useDefaultRenderLoop = false;
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { show: false }));
    // A stopped CesiumWidget cannot drive primitive.update for hidden creation.
    const commands = viewer.useDefaultRenderLoop ? render(primitives.get(0) as Candidate) : [];
    await drainReactions();
    expect(result.status).toBe("resolved");
    expect(commands).toHaveLength(0);
    expect(result.renderer?.matchesFrameState(0, false)).toBe(true);
    result.renderer?.destroy();
  });

  it.each(["pre-abort", "destroyed-scene"] as const)("does not resume or allocate for %s", async condition => {
    const { viewer, primitives } = harness(); viewer.useDefaultRenderLoop = false;
    const abort = new AbortController(); const request = vi.spyOn(viewer.scene, "requestRender");
    if (condition === "pre-abort") abort.abort();
    else vi.spyOn(viewer.scene, "isDestroyed").mockReturnValue(true);
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { signal: abort.signal }));
    await drainReactions();
    expect(result).toMatchObject({ status: "rejected", error: { name: "AbortError" } });
    expect(viewer.useDefaultRenderLoop).toBe(false);
    expect(primitives.length).toBe(0); expect(request).not.toHaveBeenCalled();
  });

  it("does not resume a candidate invalidated synchronously during native add", async () => {
    const { viewer, primitives } = harness(); viewer.useDefaultRenderLoop = false;
    primitives.primitiveAdded.addEventListener(() => { vi.spyOn(viewer.scene, "isDestroyed").mockReturnValue(true); });
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map()));
    await drainReactions();
    expect(result).toMatchObject({ status: "rejected", error: { name: "AbortError" } });
    expect(viewer.useDefaultRenderLoop).toBe(false);
    expect(primitives.length).toBe(0);
  });

  it.each(["abort", "destroyed-scene"] as const)("rechecks %s after resuming before requesting or handing off a frame", async condition => {
    const { viewer, primitives } = harness(); const abort = new AbortController();
    const request = vi.spyOn(viewer.scene, "requestRender");
    let loop = false; let requestsAtResume = -1;
    Object.defineProperty(viewer, "useDefaultRenderLoop", { configurable: true,
      get: () => loop,
      set: (value: boolean) => {
        loop = value; requestsAtResume = request.mock.calls.length;
        if (condition === "abort") abort.abort();
        else vi.spyOn(viewer.scene, "isDestroyed").mockReturnValue(true);
      },
    });
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { signal: abort.signal }));
    await drainReactions();
    expect(result).toMatchObject({ status: "rejected", error: { name: "AbortError" } });
    expect(requestsAtResume).toBeGreaterThanOrEqual(0);
    expect(request).toHaveBeenCalledTimes(requestsAtResume);
    expect(primitives.length).toBe(0);
    expect(primitives.primitiveRemoved.numberOfListeners).toBe(0);
  });

  it("bounds missing GPU initialization at 30 seconds and releases its candidate and listeners", async () => {
    vi.useFakeTimers();
    const { viewer, primitives } = harness(); const abort = new AbortController();
    const removeAbort = vi.spyOn(abort.signal, "removeEventListener");
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { signal: abort.signal, show: false }));
    await vi.advanceTimersByTimeAsync(29_999); expect(result.status).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ status: "rejected", error: { message: expect.stringContaining("30 seconds") } });
    expect(primitives.length).toBe(0); expect(primitives.primitiveRemoved.numberOfListeners).toBe(0);
    expect(removeAbort).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["success", "cancel", "failure"] as const)("removes the initialization deadline after %s", async outcome => {
    vi.useFakeTimers();
    const { viewer, primitives } = harness(); const abort = new AbortController();
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { signal: abort.signal }));
    if (outcome === "cancel") abort.abort();
    else {
      if (outcome === "failure") gpu.failAt = "buffer";
      render(primitives.get(0) as Candidate);
    }
    await drainReactions();
    expect(result.status).toBe(outcome === "success" ? "resolved" : "rejected");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(result.status).toBe(outcome === "success" ? "resolved" : "rejected");
    result.renderer?.destroy();
  });

  it("rejects a pre-aborted request without adding a primitive", async () => {
    const { viewer, primitives } = harness();
    const abort = new AbortController();
    abort.abort(new Error("Caller details must not replace the standard AbortError."));
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { signal: abort.signal }));
    await drainReactions();
    expect(result.status).toBe("rejected");
    expect(result.error).toBeInstanceOf(DOMException);
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(primitives.length).toBe(0);
    expect(gpu.resources).toHaveLength(0);
  });

  it("aborts before GPU ready without requiring another frame, and ignores late updates", async () => {
    const { viewer, primitives } = harness();
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { signal: abort.signal }));
    const candidate = primitives.get(0) as Candidate;
    abort.abort();
    await drainReactions();
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(primitives.length).toBe(0);
    expect(candidate.isDestroyed()).toBe(true);
    expect(render(candidate)).toHaveLength(0);
    expect(gpu.resources).toHaveLength(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each(["removeAll", "destroy"] as const)("settles waiting creation when the external collection calls %s", async operation => {
    const { viewer, primitives } = harness();
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { signal: abort.signal }));
    const candidate = primitives.get(0) as Candidate;
    primitives[operation]();
    await drainReactions();
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(candidate.isDestroyed()).toBe(true);
    expect(render(candidate)).toHaveLength(0);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it.each(["removeAll", "destroy"] as const)("also cancels creation when a non-owning collection calls %s", async operation => {
    const { viewer, primitives } = harness(false);
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map()));
    const candidate = primitives.get(0) as Candidate;
    primitives[operation]();
    await drainReactions();
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(candidate.isDestroyed()).toBe(true);
    expect(primitives.primitiveRemoved.numberOfListeners).toBe(0);
  });

  it.each(["abort", "external-remove", "external-remove-without-destroy"] as const)("does not hand off a renderer when ready is immediately followed by %s", async operation => {
    const { viewer, primitives } = harness(operation !== "external-remove-without-destroy");
    const abort = new AbortController();
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { signal: abort.signal }));
    const candidate = primitives.get(0) as Candidate;
    expect(render(candidate)).toHaveLength(1);
    if (operation === "abort") abort.abort();
    else primitives.removeAll();
    await drainReactions();
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(primitives.length).toBe(0);
    expect(render(candidate)).toHaveLength(0);
    expect(gpu.resources.map(resource => resource.destroyCount)).toEqual([1, 1, 1, 1]);
  });

  it("keeps the four-argument creation API and destroys allocated resources only once", async () => {
    const { viewer, primitives } = harness();
    const creation = GpuPointRenderer.create(viewer, dataset(), 10, new Map());
    expect(render(primitives.get(0) as Candidate)).toHaveLength(1);
    const renderer = await creation;
    expect(renderer.buildStats).toMatchObject({ pointCount: 1, sourceBytes: 52, gpuVertexBytes: 20, quaternionTextureBytes: 16, drawCalls: 1 });
    expect(primitives.length).toBe(1);
    renderer.destroy();
    renderer.destroy();
    expect(primitives.length).toBe(0);
    expect(gpu.resources.map(resource => resource.destroyCount)).toEqual([1, 1, 1, 1]);
  });

  it("initializes a hidden candidate without drawing before or after ready until explicitly shown", async () => {
    const { viewer, primitives } = harness();
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 10, new Map(), { show: false }));
    const candidate = primitives.get(0) as Candidate;
    expect(render(candidate)).toHaveLength(0);
    await drainReactions();
    expect(result.status).toBe("resolved");
    expect(result.renderer?.buildStats.pointCount).toBe(1);
    expect(render(candidate)).toHaveLength(0);
    result.renderer!.setShow(true);
    expect(render(candidate)).toHaveLength(1);
    result.renderer!.setShow(false);
    expect(render(candidate)).toHaveLength(0);
    result.renderer!.destroy();
  });

  it("verifies native visibility, age, and the rotation upload before acknowledging a visible frame", async () => {
    const { viewer, primitives } = harness();
    const creation = GpuPointRenderer.create(viewer, dataset(), 10, new Map(), { show: false });
    const candidate = primitives.get(0) as Candidate;
    render(candidate);
    const renderer = await creation;
    expect(renderer.matchesFrameState(10, false)).toBe(true);
    expect(renderer.matchesFrameState(10, true)).toBe(false);
    expect(renderer.matchesFrameState(20, false)).toBe(false);
    renderer.setTime(20, new Map()); renderer.setShow(true);
    expect(renderer.matchesFrameState(20, true)).toBe(false);
    expect(render(candidate)).toHaveLength(1);
    expect(renderer.matchesFrameState(20, true)).toBe(true);
    expect(renderer.matchesFrameState(10, true)).toBe(false);
    renderer.setShow(false);
    expect(renderer.matchesFrameState(20, true)).toBe(false);
    expect(renderer.matchesFrameState(20, false)).toBe(true);
  });

  it.each(["removed", "destroyed", "scene-destroyed"] as const)("does not acknowledge an initialized renderer that is %s", async reason => {
    const { viewer, primitives } = harness(false);
    const creation = GpuPointRenderer.create(viewer, dataset(), 10, new Map());
    const candidate = primitives.get(0) as Candidate;
    render(candidate); const renderer = await creation;
    expect(renderer.matchesFrameState(10, true)).toBe(true);
    if (reason === "removed") primitives.removeAll();
    if (reason === "destroyed") renderer.destroy();
    if (reason === "scene-destroyed") vi.spyOn(viewer.scene, "isDestroyed").mockReturnValue(true);
    expect(renderer.matchesFrameState(10, true)).toBe(false);
    renderer.destroy();
  });

  it("releases other resources after vertex-array cleanup fails, and retries only failed handles", async () => {
    const { viewer, primitives } = harness();
    const creation = GpuPointRenderer.create(viewer, dataset(), 0, new Map());
    const candidate = primitives.get(0) as Candidate;
    render(candidate);
    const renderer = await creation;
    gpu.failDestroyKinds.add("vertex-array");
    let failure: unknown;
    try { renderer.destroy(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(1);
    expect(primitives.length).toBe(0);
    expect(candidate.isDestroyed()).toBe(true);
    expect(render(candidate)).toHaveLength(0);
    expect(gpu.resources.map(resource => resource.destroyCount)).toEqual([0, 0, 1, 1]);
    expect(gpu.renderStateDestroyCount).toBe(1);
    expect(() => renderer.destroy()).toThrow(AggregateError);
    expect(gpu.resources.map(resource => resource.destroyAttempts)).toEqual([0, 2, 1, 1]);
    gpu.failDestroyKinds.clear();
    expect(() => renderer.destroy()).not.toThrow();
    expect(() => renderer.destroy()).not.toThrow();
    expect(gpu.resources.map(resource => resource.destroyCount)).toEqual([1, 1, 1, 1]);
    expect(gpu.resources.map(resource => resource.destroyAttempts)).toEqual([1, 3, 1, 1]);
    expect(gpu.renderStateDestroyAttempts).toBe(1);
  });

  it("reports every cleanup failure and preserves both failed handles for retry", async () => {
    const { viewer, primitives } = harness();
    const creation = GpuPointRenderer.create(viewer, dataset(), 0, new Map());
    render(primitives.get(0) as Candidate);
    const renderer = await creation;
    gpu.failDestroyKinds.add("shader");
    gpu.failDestroyKinds.add("render-state");
    let failure: unknown;
    try { renderer.destroy(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map((error: Error) => error.message)).toEqual([
      "Controlled shader destroy failure.", "Controlled render-state destroy failure.",
    ]);
    expect(gpu.resources.map(resource => resource.destroyCount)).toEqual([1, 1, 0, 1]);
    expect(gpu.renderStateDestroyCount).toBe(0);
    gpu.failDestroyKinds.clear();
    renderer.destroy();
    renderer.destroy();
    expect(gpu.resources.map(resource => resource.destroyCount)).toEqual([1, 1, 1, 1]);
    expect(gpu.renderStateDestroyCount).toBe(1);
    expect(gpu.renderStateDestroyAttempts).toBe(2);
  });

  it.each(["return", "throw", "reject"] as const)("reports cancellation cleanup failure once even when the reporter chooses to %s", async behavior => {
    const { viewer, primitives } = harness();
    const abort = new AbortController();
    const reports: unknown[] = [];
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), {
      signal: abort.signal,
      onCleanupError(error: unknown) {
        reports.push(error);
        if (behavior === "throw") throw new Error("Reporter failed.");
        if (behavior === "reject") return Promise.reject(new Error("Async reporter failed."));
      },
    }));
    const candidate = primitives.get(0) as Candidate;
    render(candidate);
    gpu.failDestroyKinds.add("vertex-array");
    abort.abort();
    await drainReactions();
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(reports).toHaveLength(1);
    expect(reports[0]).toBeInstanceOf(AggregateError);
    expect(gpu.resources.map(resource => resource.destroyCount)).toEqual([0, 0, 1, 1]);
    expect(gpu.renderStateDestroyCount).toBe(1);
    expect(primitives.length).toBe(0);
    expect(primitives.primitiveRemoved.numberOfListeners).toBe(0);
    gpu.failDestroyKinds.clear();
    candidate.destroy();
    expect(gpu.resources.map(resource => resource.destroyCount)).toEqual([1, 1, 1, 1]);
  });

  it("does not report a cleanup error for normal cancellation", async () => {
    const { viewer } = harness();
    const abort = new AbortController();
    const reports: unknown[] = [];
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), {
      signal: abort.signal, onCleanupError: (error: unknown) => { reports.push(error); },
    }));
    abort.abort();
    await drainReactions();
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(reports).toHaveLength(0);
  });

  it.each(["cancel", "initialization"] as const)("hands failed %s cleanup to a retryable release owner", async trigger => {
    const { viewer, primitives } = harness(); const abort = new AbortController();
    const pending: Array<{ destroy(): void }> = []; const reports: unknown[] = [];
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), {
      signal: abort.signal, onCleanupError: error => { reports.push(error); },
      onCleanupPending: resource => { pending.push(resource); },
    }));
    gpu.failDestroyKinds.add("vertex-array");
    if (trigger === "initialization") gpu.failAt = "texture";
    render(primitives.get(0) as Candidate);
    if (trigger === "cancel") abort.abort();
    await drainReactions();
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject(trigger === "cancel" ? { name: "AbortError" } : { message: "Controlled texture allocation failure." });
    expect(pending).toHaveLength(1);
    expect(reports).toHaveLength(1);
    expect(primitives.length).toBe(0);
    expect(() => pending[0]!.destroy()).toThrow(AggregateError);
    gpu.failDestroyKinds.clear();
    pending[0]!.destroy(); pending[0]!.destroy();
    expect(gpu.resources.every(resource => resource.destroyCount === 1)).toBe(true);
    expect(primitives.primitiveRemoved.numberOfListeners).toBe(0);
  });

  it.each(["throw", "reject"] as const)("does not let a pending-owner callback %s mask cancellation", async behavior => {
    const { viewer, primitives } = harness(); const abort = new AbortController();
    const pending: Array<{ destroy(): void }> = [];
    const reports: unknown[] = [];
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), {
      signal: abort.signal, onCleanupError: error => { reports.push(error); },
      onCleanupPending(resource) {
        pending.push(resource);
        if (behavior === "throw") throw new Error("Pending owner observer failed");
        return Promise.reject(new Error("Pending owner observer failed"));
      },
    }));
    render(primitives.get(0) as Candidate); gpu.failDestroyKinds.add("vertex-array");
    abort.abort(); await drainReactions();
    expect(result.error).toMatchObject({ name: "AbortError" });
    expect(pending).toHaveLength(1);
    expect(reports.some(error => error instanceof AggregateError)).toBe(true);
    gpu.failDestroyKinds.clear(); pending[0]!.destroy();
    expect(gpu.resources.every(resource => resource.destroyCount === 1)).toBe(true);
  });

  it.each(["success", "failure"] as const)("does not let subscription removal mask creation %s or skip the other release", async outcome => {
    const { viewer, primitives } = harness(); const abort = new AbortController();
    const reports: unknown[] = [];
    const remove = abort.signal.removeEventListener.bind(abort.signal);
    vi.spyOn(abort.signal, "removeEventListener").mockImplementation((...args) => {
      remove(...args); throw new Error("Abort listener removal failed");
    });
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), {
      signal: abort.signal, onCleanupError: error => { reports.push(error); },
    }));
    if (outcome === "failure") gpu.failAt = "buffer";
    render(primitives.get(0) as Candidate); await drainReactions();
    expect(primitives.primitiveRemoved.numberOfListeners).toBe(0);
    expect(result.status).toBe(outcome === "success" ? "resolved" : "rejected");
    if (outcome === "failure") expect(result.error).toMatchObject({ message: "Controlled buffer allocation failure." });
    expect(reports).toHaveLength(1);
    result.renderer?.destroy();
  });

  it("allows renderer cleanup after the external collection was already destroyed", async () => {
    const { viewer, primitives } = harness();
    const creation = GpuPointRenderer.create(viewer, dataset(), 0, new Map());
    render(primitives.get(0) as Candidate);
    const renderer = await creation;
    primitives.destroy();
    expect(() => renderer.destroy()).not.toThrow();
    expect(() => renderer.destroy()).not.toThrow();
    expect(gpu.resources.map(resource => resource.destroyCount)).toEqual([1, 1, 1, 1]);
  });

  it("removes its creation listener after success so a later abort does not destroy the renderer", async () => {
    const { viewer, primitives } = harness();
    const abort = new AbortController();
    const addListener = vi.spyOn(abort.signal, "addEventListener");
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");
    const creation = GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { signal: abort.signal });
    render(primitives.get(0) as Candidate);
    const renderer = await creation;
    expect(addListener).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(removeListener).toHaveBeenCalledWith("abort", addListener.mock.calls[0]![1]);
    abort.abort();
    expect(primitives.length).toBe(1);
    expect(primitives.primitiveRemoved.numberOfListeners).toBe(0);
    expect(gpu.resources.every(resource => resource.destroyCount === 0)).toBe(true);
    renderer.destroy();
  });

  it.each(["buffer", "vertex-array", "shader", "texture"] as const)("preserves %s creation failure and retires its partial resources", async failAt => {
    const { viewer, primitives } = harness();
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");
    const result = observe(GpuPointRenderer.create(viewer, dataset(), 0, new Map(), { signal: abort.signal }));
    gpu.failAt = failAt;
    render(primitives.get(0) as Candidate);
    await drainReactions();
    expect(result.status).toBe("rejected");
    expect(result.error).toMatchObject({ message: `Controlled ${failAt} allocation failure.` });
    expect(primitives.length).toBe(0);
    expect(gpu.resources.every(resource => resource.destroyCount === 1)).toBe(true);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
