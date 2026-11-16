// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { Cartesian3, Matrix4, OrthographicFrustum, OrthographicOffCenterFrustum, PerspectiveFrustum, PolylineCollection, PrimitiveCollection } from "cesium";
import { PlateRenderer } from "@timemachine/cesium-runtime";
import { AGENT_ACTIONS, AGENT_DECLARATIONS } from "../agent-actions/actions";
import { agentActions, installAgentActions } from "../agent-actions/registry";
import { OperationInterruptedError } from "../agent-actions/operation";

import {
  ProjectionController,
  type ProjectionHost,
  type ProjectionSnapshot,
  type TimeLayerPreparation,
} from "../projection/projection-controller";

/** Flushes every queued microtask and one macrotask turn. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeScene {
  mode: string;
  morphTo2D: ReturnType<typeof vi.fn>;
  morphTo3D: ReturnType<typeof vi.fn>;
  requestRender: ReturnType<typeof vi.fn>;
  postRender: { addEventListener: (fn: () => void) => () => void };
  renderError: {
    addEventListener: (fn: (scene: unknown, error: unknown) => void) => () => void;
  };
  isDestroyed: () => boolean;
  listenerCount: () => number;
  lifecycleListenerCount: () => number;
  firePostRender: () => void;
  fireRenderError: (error: unknown) => void;
}

function createFakeScene(): FakeScene {
  const listeners = new Set<() => void>();
  const errorListeners = new Set<(scene: unknown, error: unknown) => void>();
  // The controller installs exactly one lifecycle renderError listener in its
  // constructor. listenerCount() keeps its original meaning (in-flight
  // transaction listeners) so the existing leak assertions stay honest.
  let lifecycleListener: ((scene: unknown, error: unknown) => void) | undefined;
  const scene: FakeScene = {
    mode: "SCENE3D",
    morphTo2D: vi.fn(() => {
      scene.mode = "SCENE2D";
    }),
    morphTo3D: vi.fn(() => {
      scene.mode = "SCENE3D";
    }),
    requestRender: vi.fn(),
    postRender: {
      addEventListener: (fn: () => void) => {
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    },
    renderError: {
      addEventListener: (fn: (scene: unknown, error: unknown) => void) => {
        lifecycleListener ??= fn;
        errorListeners.add(fn);
        return () => {
          errorListeners.delete(fn);
        };
      },
    },
    isDestroyed: () => false,
    listenerCount: () =>
      listeners.size + errorListeners.size - (lifecycleListener && errorListeners.has(lifecycleListener) ? 1 : 0),
    lifecycleListenerCount: () =>
      lifecycleListener && errorListeners.has(lifecycleListener) ? 1 : 0,
    firePostRender: () => {
      for (const fn of [...listeners]) {
        fn();
      }
    },
    fireRenderError: (error: unknown) => {
      for (const fn of [...errorListeners]) {
        fn(scene, error);
      }
    },
  };
  return scene;
}

const COUNTS = {
  activeFeatureCount: 7,
  activePlateCount: 3,
  disconnectedFeatureCount: 1,
};

const HANDLE = {
  generation: 1,
  timeMa: 0,
  timeState: COUNTS,
  stats: {} as never,
};

interface Harness {
  controller: ProjectionController;
  host: ProjectionHost;
  scene: FakeScene;
  renderer: {
    prepareRectangleFrame: ReturnType<typeof vi.fn>;
    stageRectangleFrame: ReturnType<typeof vi.fn>;
    commitRectangleFrame: ReturnType<typeof vi.fn>;
    restoreGlobeFrame: ReturnType<typeof vi.fn>;
    cancelRectangleStaging: ReturnType<typeof vi.fn>;
    cancelRectanglePreparation: ReturnType<typeof vi.fn>;
    beginFlatSwap: ReturnType<typeof vi.fn>;
    confirmFlatSwap: ReturnType<typeof vi.fn>;
    rollbackFlatSwap: ReturnType<typeof vi.fn>;
  };
  setAge: (age: number) => void;
  setVisible: (ids: number[]) => void;
  /** The controller's UI sink, kept as the mock so a refresh can be inspected. */
  stateSink: ReturnType<typeof vi.fn>;
  snapshot: () => ProjectionSnapshot;
}

function createHarness(flat = false): Harness {
  const scene = createFakeScene();
  const renderer = {
    prepareRectangleFrame: vi.fn(async () => ({ ...HANDLE })),
    stageRectangleFrame: vi.fn(async () => ({
      generation: 1,
      timeMa: 0,
      hasContent: true,
    })),
    commitRectangleFrame: vi.fn(),
    restoreGlobeFrame: vi.fn(),
    cancelRectangleStaging: vi.fn(),
    cancelRectanglePreparation: vi.fn(),
    setFlatPickFilter: vi.fn(),
    beginFlatSwap: vi.fn(),
    confirmFlatSwap: vi.fn(),
    rollbackFlatSwap: vi.fn(),
  };
  let currentAge = 100;
  const visible = new Set<number>();
  const onStateChange = vi.fn();
  const host: ProjectionHost = {
    viewer: {
      scene,
      camera: { setView: vi.fn() },
    } as unknown as ProjectionHost["viewer"],
    plateRenderer: renderer as unknown as ProjectionHost["plateRenderer"],
    rotationModel: {} as ProjectionHost["rotationModel"],
    incompatibleLayerIds: [1, 2, 3],
    getCurrentTimeMa: () => currentAge,
    isLayerVisible: (id) => visible.has(id),
    describeLayer: (id) => `layer ${id}`,
    onCommittedTimeChange: vi.fn(),
    onStateChange,
    setGlobeInertiaEnabled: vi.fn(),
    captureGlobeCamera: vi.fn(),
    restoreGlobeCamera: vi.fn(),
    applyGlobeFrame: vi.fn(() => COUNTS),
    globeHome: vi.fn(),
  };
  host.viewer.useDefaultRenderLoop = true;
  const emitPostRender = scene.firePostRender;
  scene.firePostRender = () => {
    if (host.viewer.useDefaultRenderLoop) emitPostRender();
  };
  const emitRenderError = scene.fireRenderError;
  scene.fireRenderError = error => {
    // CesiumWidget's listener runs first and stops the actual render loop.
    host.viewer.useDefaultRenderLoop = false;
    emitRenderError(error);
  };
  if (flat) {
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    vi.stubGlobal("ImageBitmap", class {});
    vi.stubGlobal("OffscreenCanvas", class {});
    const canvas = document.createElement("canvas");
    Object.defineProperties(canvas, { clientWidth: { value: 1000 }, clientHeight: { value: 600 } });
    const camera = {
      frustum: new PerspectiveFrustum() as PerspectiveFrustum | OrthographicFrustum | OrthographicOffCenterFrustum,
      positionWC: new Cartesian3(50000000, 0, 0), directionWC: new Cartesian3(-1, 0, 0), upWC: new Cartesian3(0, 0, 1),
      maximumZoomFactor: 1,
      cancelFlight: vi.fn(),
      setView: vi.fn(),
      moveRight: vi.fn((amount: number) => { camera.positionWC.y += amount; }),
      moveUp: vi.fn((amount: number) => { camera.positionWC.z += amount; }),
      getPickRay: () => ({ origin: new Cartesian3(100000000, 0, 0), direction: new Cartesian3(-1, 0, 0) }),
      zoomIn: vi.fn((distance: number) => {
        const f = camera.frustum as OrthographicOffCenterFrustum;
        const ratio = (f.right! - f.left! - distance) / (f.right! - f.left!);
        f.left! *= ratio; f.right! *= ratio; f.top! *= ratio; f.bottom! *= ratio;
      }),
      get viewMatrix(): Matrix4 {
        return Matrix4.computeView(camera.positionWC, camera.directionWC, camera.upWC,
          Cartesian3.cross(camera.directionWC,camera.upWC,new Cartesian3()), new Matrix4());
      },
    };
    Object.assign(host.viewer, { camera, isDestroyed: () => false });
    Object.assign(scene, { canvas, screenSpaceCameraController: {}, primitives: { add: (p: unknown) => p, remove: vi.fn() } });
    scene.morphTo2D.mockImplementation(() => {
      scene.mode = "SCENE2D";
      camera.frustum = new OrthographicOffCenterFrustum({ left: -50000000, right: 50000000, top: 30000000, bottom: -30000000 });
    });
    scene.morphTo3D.mockImplementation(() => { scene.mode = "SCENE3D"; camera.frustum = new PerspectiveFrustum(); });
  }
  const controller = new ProjectionController(host);
  controller.initialize(currentAge, COUNTS);
  return {
    controller,
    host,
    scene,
    renderer,
    stateSink: onStateChange,
    setAge: (age) => {
      currentAge = age;
    },
    setVisible: (ids) => {
      visible.clear();
      for (const id of ids) {
        visible.add(id);
      }
    },
    snapshot: () => controller.getSnapshot(),
  };
}

/** Runs a mode switch to completion by flushing and firing one real render. */
async function completeSwitch(
  harness: Harness,
  promise: Promise<unknown>,
): Promise<void> {
  await flush();
  harness.scene.firePostRender();
  await promise;
}

function captureTimeLayers(h: Harness) {
  const captured: {
    context: Parameters<NonNullable<ProjectionHost["captureTimeLayers"]>>[0];
    ready: ReturnType<typeof deferred<void>>;
    rendered: boolean;
    layers: TimeLayerPreparation & {
      activate: ReturnType<typeof vi.fn>;
      accept: ReturnType<typeof vi.fn>;
      rollback: ReturnType<typeof vi.fn>;
      retire: ReturnType<typeof vi.fn>;
    };
  }[] = [];
  h.host.captureTimeLayers = vi.fn(context => {
    const ready = deferred<void>();
    const entry = {
      context, ready, rendered: false,
      layers: {
        ready: ready.promise,
        activate: vi.fn(),
        canConfirm: () => entry.rendered,
        accept: vi.fn(), rollback: vi.fn(), retire: vi.fn(),
      },
    };
    captured.push(entry);
    return entry.layers;
  });
  return captured;
}

describe("ProjectionController shared time-layer owner", () => {
  it("keeps the old Globe until layers prepare and confirms all participants on a later real render", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    let completed = false;
    const operation = h.controller.setTime(10).then(() => { completed = true; });
    expect(captured).toHaveLength(1);
    const target = captured[0]!;
    expect(target.context).toMatchObject({ ageMa: 10, mode: "globe" });
    expect(h.host.applyGlobeFrame).not.toHaveBeenCalled();
    h.scene.firePostRender();
    await flush();
    expect(completed).toBe(false);
    target.ready.resolve();
    await flush();
    expect(h.host.applyGlobeFrame).toHaveBeenCalledExactlyOnceWith(10);
    expect(target.layers.activate).toHaveBeenCalledOnce();
    expect(target.layers.accept).not.toHaveBeenCalled();
    h.scene.firePostRender();
    await flush();
    expect(completed).toBe(false);
    expect(h.snapshot().committedTimeMa).toBe(100);
    target.rendered = true;
    h.scene.firePostRender();
    await operation;
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 10, status: "ready" });
    expect(target.layers.accept).toHaveBeenCalledOnce();
    expect(target.layers.retire).toHaveBeenCalledOnce();
    expect(target.layers.rollback).not.toHaveBeenCalled();
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("captures only active requests and ignores old callbacks within the same generation", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    const first = h.controller.setTime(10);
    const overwritten = h.controller.setTime(20).catch(error => error);
    const latest = h.controller.setTime(30);
    expect(await overwritten).toMatchObject({ reason: "superseded" });
    expect(captured).toHaveLength(1);
    const a = captured[0]!;
    a.ready.resolve(); a.rendered = true;
    await flush(); h.scene.firePostRender(); await first;
    expect(captured).toHaveLength(2);
    const b = captured[1]!;
    expect(b.context.ageMa).toBe(30);
    expect(b.context.generation).toBe(a.context.generation);
    expect(b.context.owner).not.toBe(a.context.owner);
    a.context.onFailure(new Error("late old source error"));
    expect(b.context.signal.aborted).toBe(false);
    b.ready.resolve(); b.rendered = true;
    await flush(); h.scene.firePostRender(); await latest;
    expect(h.snapshot().committedTimeMa).toBe(30);
    expect(a.layers.rollback).not.toHaveBeenCalled();
    expect(b.layers.rollback).not.toHaveBeenCalled();
  });

  it.each(["ready-rejection", "failure-after-ready"] as const)("settles %s after restoring any activated participants", async boundary => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    const active = h.controller.setTime(10).catch(error => error);
    const pending = h.controller.setTime(20).catch(error => error);
    expect(captured).toHaveLength(1);
    const target = captured[0]!;
    const failure = new Error("target imagery failed");
    if (boundary === "ready-rejection") target.ready.reject(failure);
    else { target.ready.resolve(); await flush(); target.context.onFailure(failure); }
    if (boundary === "failure-after-ready") { await flush(); h.scene.firePostRender(); }
    expect(await active).toBe(failure);
    expect(await pending).toBe(failure);
    expect(target.context.signal.aborted).toBe(true);
    expect(target.layers.rollback).toHaveBeenCalledOnce();
    expect(target.layers.accept).not.toHaveBeenCalled();
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 100, status: "error" });
    if (boundary === "failure-after-ready") expect(h.host.applyGlobeFrame).toHaveBeenLastCalledWith(100);
    h.scene.firePostRender(); await flush();
    expect(h.snapshot().committedTimeMa).toBe(100);
    expect(h.scene.listenerCount()).toBe(0);
  });

  it.each(["rectangle", "mollweide"] as const)("prepares %s plates in parallel and retains them until the shared frame confirms", async mode => {
    const h = createHarness(true);
    await completeSwitch(h, h.controller.select(mode));
    h.renderer.prepareRectangleFrame.mockClear();
    h.renderer.commitRectangleFrame.mockClear();
    h.renderer.confirmFlatSwap.mockClear();
    const captured = captureTimeLayers(h);
    const operation = h.controller.setTime(10);
    expect(captured).toHaveLength(1);
    expect(h.renderer.prepareRectangleFrame).toHaveBeenCalledExactlyOnceWith(10, h.host.rotationModel, mode);
    await flush();
    expect(h.renderer.commitRectangleFrame).not.toHaveBeenCalled();
    const target = captured[0]!;
    target.ready.resolve(); await flush();
    expect(h.renderer.commitRectangleFrame).toHaveBeenCalledOnce();
    expect(target.layers.activate).toHaveBeenCalledOnce();
    h.scene.firePostRender(); await flush();
    expect(h.renderer.confirmFlatSwap).not.toHaveBeenCalled();
    target.rendered = true;
    h.scene.firePostRender(); await operation;
    expect(h.renderer.confirmFlatSwap).toHaveBeenCalledOnce();
    expect(target.layers.accept).toHaveBeenCalledOnce();
  });

  it.each(["source", "destroy", "mode", "capability"] as const)("aborts the captured owner before %s cleanup and ignores its late callbacks", async boundary => {
    const h = createHarness(true);
    if (boundary === "capability") await completeSwitch(h, h.controller.select("rectangle"));
    const captured = captureTimeLayers(h);
    const active = h.controller.setTime(10).catch(error => error);
    const pending = h.controller.setTime(20).catch(error => error);
    expect(captured).toHaveLength(1);
    const target = captured[0]!;
    target.layers.rollback.mockImplementation(() => { expect(target.context.signal.aborted).toBe(true); });
    target.ready.resolve(); await flush();
    if (boundary === "source") h.controller.invalidateSource();
    if (boundary === "destroy") h.controller.destroy();
    if (boundary === "mode") await completeSwitch(h, h.controller.select("rectangle"));
    if (boundary === "capability") { h.setVisible([2]); h.controller.refreshCapabilities(); }
    expect(await active).toBeInstanceOf(Error);
    expect(await pending).toBeInstanceOf(Error);
    expect(target.context.signal.aborted).toBe(true);
    expect(target.layers.rollback).toHaveBeenCalledOnce();
    const committed = h.snapshot().committedTimeMa;
    target.context.onFailure(new Error("late superseded error"));
    target.rendered = true; h.scene.firePostRender(); await flush();
    expect(h.snapshot().committedTimeMa).toBe(committed);
    expect(target.layers.accept).not.toHaveBeenCalled();
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("diagnoses retirement failure without rolling back an accepted frame", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    h.host.onTimeLayerCleanupError = vi.fn();
    const operation = h.controller.setTime(10);
    expect(captured).toHaveLength(1);
    const target = captured[0]!;
    const failure = new Error("old imagery removal failed");
    target.layers.retire.mockImplementation(() => { throw failure; });
    target.ready.resolve(); target.rendered = true;
    await flush(); h.scene.firePostRender(); await operation;
    expect(h.host.onTimeLayerCleanupError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 10, status: "ready" });
    target.context.onFailure(new Error("late accepted failure"));
    expect(target.layers.rollback).not.toHaveBeenCalled();
    expect(h.host.applyGlobeFrame).toHaveBeenCalledExactlyOnceWith(10);
  });

  it.each(["globe", "rectangle", "mollweide"] as const)("keeps a %s frame accepted even when its commit notification invalidates the source", async mode => {
    const h = createHarness(true);
    if (mode !== "globe") await completeSwitch(h, h.controller.select(mode));
    h.renderer.rollbackFlatSwap.mockClear();
    const captured = captureTimeLayers(h);
    h.host.onCommittedTimeChange = () => h.controller.invalidateSource();
    const operation = h.controller.setTime(10);
    const result = operation.catch(error => error);
    expect(captured).toHaveLength(1);
    const target = captured[0]!;
    target.ready.resolve(); target.rendered = true;
    await flush(); h.scene.firePostRender();
    expect(await result).toBeUndefined();
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 10, status: "error" });
    expect(target.layers.rollback).not.toHaveBeenCalled();
    expect(h.renderer.rollbackFlatSwap).not.toHaveBeenCalled();
  });

  it("does not commit after accept synchronously invalidates its owner", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    const result = h.controller.setTime(10).catch(error => error);
    const target = captured[0]!;
    target.layers.accept.mockImplementation(() => h.controller.invalidateSource());
    target.ready.resolve(); target.rendered = true;
    await flush(); h.scene.firePostRender();
    expect(await result).toBeInstanceOf(Error);
    expect(h.snapshot().committedTimeMa).toBe(100);
    expect(target.layers.retire).not.toHaveBeenCalled();
    expect(target.layers.rollback).toHaveBeenCalledOnce();
  });

  it("does not let an old failure cancel a replacement created by its abort listener", async () => {
    const h = createHarness(true);
    const captured = captureTimeLayers(h);
    const old = h.controller.setTime(10).catch(error => error);
    const target = captured[0]!;
    let replacement: Promise<unknown> | undefined;
    target.context.signal.addEventListener("abort", () => { replacement = h.controller.select("rectangle"); });
    target.ready.resolve(); await flush();
    target.context.onFailure(new Error("old imagery failed"));
    await flush();
    expect(replacement).toBeDefined();
    expect(h.snapshot()).toMatchObject({ requestedId: "rectangle", status: "preparing" });
    h.scene.firePostRender(); await replacement;
    expect(await old).toBeInstanceOf(Error);
    expect(h.snapshot()).toMatchObject({ committedId: "rectangle", status: "ready" });
    expect(target.layers.rollback).toHaveBeenCalledOnce();
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("lets a newer mode started by an abort listener supersede the mode that triggered that abort", async () => {
    const h = createHarness(true);
    const captured = captureTimeLayers(h);
    const old = h.controller.setTime(10).catch(error => error);
    const target = captured[0]!;
    let newer: Promise<unknown> | undefined;
    target.context.signal.addEventListener("abort", () => { newer = h.controller.select("mollweide").catch(error => error); });
    target.ready.resolve(); await flush();
    const superseded = h.controller.select("rectangle").catch(error => error);
    await flush();
    expect(h.snapshot()).toMatchObject({ requestedId: "mollweide", status: "preparing" });
    h.scene.firePostRender();
    expect(await newer).toMatchObject({ projectionId: "mollweide" });
    expect(await superseded).toMatchObject({ reason: "superseded" });
    expect(await old).toBeInstanceOf(Error);
    expect(target.layers.rollback).toHaveBeenCalledOnce();
    expect(h.snapshot()).toMatchObject({ committedId: "mollweide", status: "ready" });
  });

  it("does not roll back a newer mode started during an old layer rollback", async () => {
    const h = createHarness(true);
    const captured = captureTimeLayers(h);
    const old = h.controller.setTime(10).catch(error => error);
    const target = captured[0]!;
    let newer: Promise<unknown> | undefined;
    target.layers.rollback.mockImplementationOnce(() => { newer = h.controller.select("mollweide").catch(error => error); });
    target.ready.resolve(); await flush();
    const superseded = h.controller.select("rectangle").catch(error => error);
    await flush();
    expect(h.snapshot()).toMatchObject({ requestedId: "mollweide", status: "preparing" });
    h.scene.firePostRender();
    expect(await newer).toMatchObject({ projectionId: "mollweide" });
    expect(await superseded).toMatchObject({ reason: "superseded" });
    expect(await old).toBeInstanceOf(Error);
    expect(h.snapshot().committedId).toBe("mollweide");
  });

  it("does not overwrite a Globe recovery started by capability cancellation", async () => {
    const h = createHarness(true);
    await completeSwitch(h, h.controller.select("rectangle"));
    const captured = captureTimeLayers(h);
    const old = h.controller.setTime(10).catch(error => error);
    const target = captured[0]!;
    let recovery: Promise<unknown> | undefined;
    target.context.signal.addEventListener("abort", () => { recovery = h.controller.select("globe").catch(error => error); });
    target.ready.resolve(); await flush();
    h.setVisible([2]); h.controller.refreshCapabilities();
    await flush();
    expect(h.snapshot()).toMatchObject({ requestedId: "globe", status: "preparing" });
    h.scene.firePostRender();
    expect(await recovery).toMatchObject({ projectionId: "globe" });
    expect(await old).toBeInstanceOf(Error);
    expect(target.layers.rollback).toHaveBeenCalledOnce();
    expect(h.snapshot()).toMatchObject({ committedId: "globe", status: "ready" });
  });

  it("closes an accepted flat swap before a native retirement error can leave it rollbackable", async () => {
    const h = createHarness(true);
    await completeSwitch(h, h.controller.select("rectangle"));
    h.renderer.rollbackFlatSwap.mockClear();
    h.renderer.confirmFlatSwap.mockImplementationOnce(() => { throw new Error("native old frame cleanup failed"); });
    h.host.onTimeLayerCleanupError = vi.fn();
    const captured = captureTimeLayers(h);
    const result = h.controller.setTime(10);
    const target = captured[0]!;
    target.ready.resolve(); target.rendered = true;
    await flush(); h.scene.firePostRender(); await result;
    h.controller.invalidateSource();
    expect(h.renderer.rollbackFlatSwap).not.toHaveBeenCalled();
    expect(h.snapshot().committedTimeMa).toBe(10);
    expect(h.host.onTimeLayerCleanupError).toHaveBeenCalledWith(expect.objectContaining({ message: "native old frame cleanup failed" }));
  });

  it("settles native render failure while a layer is still preparing and rejects late preparation", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    const operation = h.controller.setTime(10).catch(error => error);
    expect(captured).toHaveLength(1);
    h.scene.fireRenderError(new Error("old view failed during imagery preparation"));
    expect(await operation).toMatchObject({ message: "old view failed during imagery preparation" });
    expect(captured[0]!.layers.rollback).toHaveBeenCalledOnce();
    captured[0]!.ready.resolve(); await flush();
    expect(captured[0]!.layers.activate).not.toHaveBeenCalled();
    expect(h.host.applyGlobeFrame).not.toHaveBeenCalled();
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("does not lose plate restoration when the layer rollback throws", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    const operation = h.controller.setTime(10).catch(error => error);
    expect(captured).toHaveLength(1);
    const target = captured[0]!;
    target.layers.rollback.mockImplementation(() => { throw new Error("layer restoration failed"); });
    target.ready.resolve(); await flush();
    target.context.onFailure(new Error("new tile failed"));
    expect(await operation).toMatchObject({ message: "layer restoration failed" });
    expect(h.host.applyGlobeFrame).toHaveBeenLastCalledWith(100);
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 100, status: "error", lastError: { message: "layer restoration failed" } });
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("aborts and restores a ticket returned after synchronous capture invalidation", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    const capture = h.host.captureTimeLayers!;
    h.host.captureTimeLayers = context => {
      const layers = capture(context);
      h.controller.invalidateSource();
      return layers;
    };
    const operation = h.controller.setTime(10).catch(error => error);
    expect(await operation).toMatchObject({ reason: "superseded" });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.context.signal.aborted).toBe(true);
    expect(captured[0]!.layers.rollback).toHaveBeenCalledOnce();
    expect(h.snapshot().status).toBe("error");
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("reports failed restoration of a ticket returned after capture invalidation", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    h.host.onTimeLayerCleanupError = vi.fn();
    const capture = h.host.captureTimeLayers!;
    const failure = new Error("late captured layer cleanup failed");
    h.host.captureTimeLayers = context => {
      const layers = capture(context);
      layers.rollback = () => { throw failure; };
      h.controller.invalidateSource();
      return layers;
    };
    expect(await h.controller.setTime(10).catch(error => error)).toBeInstanceOf(Error);
    expect(captured[0]!.layers.activate).not.toHaveBeenCalled();
    expect(h.host.onTimeLayerCleanupError).toHaveBeenCalledExactlyOnceWith(failure);
  });

  it("preserves Moll CPU promotion while capturing layers only when that successor becomes active", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const captured = captureTimeLayers(h);
    const warm = deferred<never>();
    h.renderer.stageRectangleFrame.mockImplementationOnce(() => warm.promise);
    h.renderer.prepareRectangleFrame.mockClear();
    const a = h.controller.setTime(10);
    await flush();
    const promoted = h.controller.setTime(20);
    await flush();
    const overwritten = h.controller.setTime(30).catch(error => error);
    const latest = h.controller.setTime(40);
    expect(await overwritten).toMatchObject({ reason: "superseded" });
    expect(h.renderer.prepareRectangleFrame.mock.calls.map(call => call[0])).toEqual([10, 20]);
    expect(captured.map(item => item.context.ageMa)).toEqual([10]);
    warm.resolve(undefined as never);
    for (const [index, operation] of [a, promoted, latest].entries()) {
      const target = captured[index]!;
      expect(target).toBeDefined();
      target.ready.resolve(); target.rendered = true;
      await flush(); h.scene.firePostRender(); await operation;
    }
    expect(captured.map(item => item.context.ageMa)).toEqual([10, 20, 40]);
    expect(h.renderer.prepareRectangleFrame.mock.calls.map(call => call[0])).toEqual([10, 20, 40]);
    expect(h.snapshot().committedTimeMa).toBe(40);
  });

  it("continues the pending owner when removing an accepted owner's observer throws", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    h.host.onTimeLayerCleanupError = vi.fn();
    const add = h.scene.renderError.addEventListener;
    let firstObserver = true;
    h.scene.renderError.addEventListener = listener => {
      const remove = add(listener);
      const throws = firstObserver; firstObserver = false;
      return () => { remove(); if (throws) throw new Error("native observer removal failed"); };
    };
    const active = h.controller.setTime(10);
    const pending = h.controller.setTime(20);
    const a = captured[0]!;
    a.ready.resolve(); a.rendered = true;
    await flush(); h.scene.firePostRender(); await active;
    await flush();
    expect(captured).toHaveLength(2);
    const b = captured[1]!;
    b.ready.resolve(); b.rendered = true;
    await flush(); h.scene.firePostRender(); await pending;
    expect(h.host.onTimeLayerCleanupError).toHaveBeenCalledWith(expect.objectContaining({ message: "native observer removal failed" }));
    expect(a.layers.rollback).not.toHaveBeenCalled();
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 20, status: "ready" });
    expect(h.scene.listenerCount()).toBe(0);
  });
});

describe("ProjectionController external time cancellation", () => {
  it("rejects a pre-aborted time without changing the queue or capturing layers", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    const abort = new AbortController(); abort.abort();
    const result = h.controller.setTime(10, { signal: abort.signal }).catch(error => error);
    expect(captured).toHaveLength(0);
    expect(h.snapshot()).toMatchObject({ requestedTimeMa: 100, committedTimeMa: 100, status: "ready" });
    expect(await result).toMatchObject({ reason: "cancelled" });
    expect(h.host.applyGlobeFrame).not.toHaveBeenCalled();
  });

  it("cancels only a pending request and releases its signal without interrupting the active frame", async () => {
    const h = createHarness();
    const active = h.controller.setTime(10);
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    let settled = false;
    const pending = h.controller.setTime(20, { signal: abort.signal }).catch(error => { settled = true; return error; });
    abort.abort(); await flush();
    expect(settled).toBe(true);
    expect(await pending).toMatchObject({ reason: "cancelled" });
    expect(h.snapshot()).toMatchObject({ requestedTimeMa: 10, committedTimeMa: 100, status: "preparing" });
    expect(h.host.applyGlobeFrame).toHaveBeenCalledExactlyOnceWith(10);
    h.scene.firePostRender(); await active;
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 10, status: "ready" });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("restores an active Globe frame before cancelling and then advances the valid pending request", async () => {
    const h = createHarness();
    const abort = new AbortController();
    let settled = false;
    const active = h.controller.setTime(10, { signal: abort.signal }).catch(error => { settled = true; return error; });
    const pending = h.controller.setTime(20);
    abort.abort(); await flush();
    expect(h.host.applyGlobeFrame).toHaveBeenLastCalledWith(100);
    expect(settled).toBe(false);
    expect(h.snapshot().committedTimeMa).toBe(100);
    h.scene.firePostRender();
    expect(await active).toMatchObject({ reason: "cancelled" });
    expect(h.host.applyGlobeFrame).toHaveBeenLastCalledWith(20);
    h.scene.firePostRender(); await pending;
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 20, status: "ready" });
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("cancels unready layers immediately and never activates their late readiness", async () => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    const abort = new AbortController();
    let settled = false;
    const active = h.controller.setTime(10, { signal: abort.signal }).catch(error => { settled = true; return error; });
    abort.abort(); await flush();
    expect(settled).toBe(true);
    expect(await active).toMatchObject({ reason: "cancelled" });
    expect(captured[0]!.context.signal.aborted).toBe(true);
    expect(captured[0]!.layers.rollback).toHaveBeenCalledOnce();
    captured[0]!.ready.resolve(); await flush();
    expect(captured[0]!.layers.activate).not.toHaveBeenCalled();
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 100, requestedTimeMa: 100, status: "ready" });
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("cancels a promoted Moll CPU ticket without cancelling the active GPU frame", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const warm = deferred<never>();
    h.renderer.stageRectangleFrame.mockImplementationOnce(() => warm.promise);
    h.renderer.prepareRectangleFrame.mockClear();
    const active = h.controller.setTime(10);
    await flush();
    const abort = new AbortController();
    let settled = false;
    const promoted = h.controller.setTime(20, { signal: abort.signal }).catch(error => { settled = true; return error; });
    const latest = h.controller.setTime(30);
    h.renderer.cancelRectanglePreparation.mockClear();
    h.renderer.cancelRectangleStaging.mockClear();
    abort.abort(); await flush();
    expect(settled).toBe(true);
    expect(await promoted).toMatchObject({ reason: "cancelled" });
    expect(h.renderer.cancelRectanglePreparation).toHaveBeenCalledOnce();
    expect(h.renderer.cancelRectangleStaging).not.toHaveBeenCalled();
    expect(h.renderer.prepareRectangleFrame.mock.calls.map(call => call[0])).toEqual([10, 20, 30]);
    warm.resolve(undefined as never);
    await flush(); h.scene.firePostRender(); await active;
    await flush(); h.scene.firePostRender(); await latest;
    expect(h.snapshot().committedTimeMa).toBe(30);
  });

  it("preserves an already promoted CPU successor when cancelling the active Moll GPU preparation", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const warm = deferred<never>();
    h.renderer.stageRectangleFrame.mockImplementationOnce(() => warm.promise);
    const abort = new AbortController();
    let settled = false;
    const active = h.controller.setTime(10, { signal: abort.signal }).catch(error => { settled = true; return error; });
    await flush();
    const promoted = h.controller.setTime(20);
    await flush();
    h.renderer.cancelRectanglePreparation.mockClear();
    abort.abort(); await flush();
    expect(settled).toBe(true);
    expect(await active).toMatchObject({ reason: "cancelled" });
    expect(h.renderer.cancelRectanglePreparation).not.toHaveBeenCalled();
    await flush(); h.scene.firePostRender(); await promoted;
    warm.resolve(undefined as never); await flush();
    expect(h.snapshot().committedTimeMa).toBe(20);
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("removes settled signal listeners and ignores an old signal after a new owner starts", async () => {
    const h = createHarness();
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, "addEventListener");
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const first = h.controller.setTime(10, { signal: abort.signal });
    expect(add).toHaveBeenCalledOnce();
    h.scene.firePostRender(); await first;
    expect(remove).toHaveBeenCalledOnce();
    const next = h.controller.setTime(20);
    const listeners = h.scene.listenerCount();
    abort.abort();
    expect(h.scene.listenerCount()).toBe(listeners);
    h.scene.firePostRender(); await next;
    expect(h.snapshot().committedTimeMa).toBe(20);
  });

  it("reports a failed recovery render instead of claiming cancellation succeeded", async () => {
    const h = createHarness();
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const active = h.controller.setTime(10, { signal: abort.signal }).catch(error => error);
    const pending = h.controller.setTime(20).catch(error => error);
    abort.abort(); await flush();
    h.scene.fireRenderError(new Error("restored frame failed to render"));
    expect(await active).toMatchObject({ message: "restored frame failed to render" });
    expect(await pending).toMatchObject({ message: "restored frame failed to render" });
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 100, status: "error" });
    expect(remove).toHaveBeenCalledOnce();
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("does not replace a newer selection's waiter when cancellation recovery publishes state", async () => {
    const h = createHarness();
    const abort = new AbortController();
    let replacement: Promise<unknown> | undefined;
    let replacementSettled = false;
    h.stateSink.mockImplementation(snapshot => {
      if (abort.signal.aborted && snapshot.status === "preparing" && !replacement) {
        // Set a guard before the nested select publishes its own preparing state.
        replacement = Promise.resolve();
        replacement = h.controller.select("globe").catch(error => { replacementSettled = true; return error; });
      }
    });
    const active = h.controller.setTime(10, { signal: abort.signal }).catch(error => error);
    abort.abort(); await flush();
    expect(replacement).toBeDefined();
    h.controller.destroy(); await flush();
    expect(replacementSettled).toBe(true);
    expect(await replacement).toMatchObject({ reason: "superseded" });
    expect(await active).toBeInstanceOf(Error);
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("does not undo an accepted time when its commit notification aborts the caller", async () => {
    const h = createHarness();
    const abort = new AbortController();
    h.host.onCommittedTimeChange = () => abort.abort();
    const active = h.controller.setTime(10, { signal: abort.signal });
    h.scene.firePostRender(); await active;
    expect(h.host.applyGlobeFrame).toHaveBeenCalledExactlyOnceWith(10);
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 10, status: "ready" });
  });

  it("releases an overwritten pending listener before an old signal can reach the replacement", async () => {
    const h = createHarness();
    const active = h.controller.setTime(10);
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const overwritten = h.controller.setTime(20, { signal: abort.signal }).catch(error => error);
    const pending = h.controller.setTime(30);
    expect(await overwritten).toMatchObject({ reason: "superseded" });
    expect(remove).toHaveBeenCalledOnce();
    abort.abort(); h.scene.firePostRender(); await active;
    h.scene.firePostRender(); await pending;
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 30, status: "ready" });
  });
});

describe("ProjectionController mode selection preserves the committed age", () => {
  it.each(["pending", "failed"] as const)("reprojects the committed age after a %s requested time, then retries through the shared owner", async boundary => {
    const h = createHarness();
    const captured = captureTimeLayers(h);
    let plates = 100;
    let points = 100;
    let atlas = 100;
    h.host.applyGlobeFrame = vi.fn(age => { plates = age; return COUNTS; });
    h.setAge(200);
    const requested = h.controller.setTime(200).catch(error => error);
    const first = captured[0]!;
    first.layers.activate.mockImplementation(() => { points = atlas = 200; });
    first.layers.rollback.mockImplementation(() => { points = atlas = 100; });
    if (boundary === "failed") {
      first.ready.resolve(); await flush();
      first.context.onFailure(new Error("Atlas target failed"));
      await flush(); h.scene.firePostRender();
      expect(await requested).toMatchObject({ message: "Atlas target failed" });
    }
    const select = h.controller.select("globe");
    await flush(); h.scene.firePostRender(); await select;
    expect(await requested).toBeInstanceOf(Error);
    expect({ plates, points, atlas }).toEqual({ plates: 100, points: 100, atlas: 100 });
    expect(h.snapshot()).toMatchObject({ committedId: "globe", committedTimeMa: 100, requestedTimeMa: 200 });
    if (boundary === "pending") {
      expect(await requested).toMatchObject({ reason: "superseded" });
      first.ready.resolve(); await flush();
      expect(first.layers.activate).not.toHaveBeenCalled();
    }
    const retry = h.controller.setTime(200);
    const second = captured[1]!;
    second.layers.activate.mockImplementation(() => { points = atlas = 200; });
    second.ready.resolve(); second.rendered = true;
    await flush();
    expect(h.snapshot().committedTimeMa).toBe(100);
    h.scene.firePostRender(); await retry;
    expect({ plates, points, atlas }).toEqual({ plates: 200, points: 200, atlas: 200 });
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 200, requestedTimeMa: 200, status: "ready" });
  });
});

describe("ProjectionController failed-frame recovery", () => {
  it("restarts Widget and waits for the restored frame before rejecting active and pending times", async () => {
    const h = createHarness();
    let settled = false;
    let pendingSettled = false;
    const active = h.controller.setTime(10).catch(error => { settled = true; return error; });
    const pending = h.controller.setTime(20).catch(error => { pendingSettled = true; return error; });
    const failure = new Error("native point draw failed");
    h.scene.fireRenderError(failure); await flush();
    expect(settled).toBe(false);
    expect(pendingSettled).toBe(false);
    expect(h.host.viewer.useDefaultRenderLoop).toBe(true);
    expect(h.host.applyGlobeFrame).toHaveBeenLastCalledWith(100);
    expect(h.snapshot().committedTimeMa).toBe(100);
    h.scene.firePostRender();
    expect(await active).toBe(failure);
    expect(await pending).toBe(failure);
    expect(h.snapshot()).toMatchObject({ status: "error", committedTimeMa: 100 });
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("ends a second render failure without restarting another recovery attempt", async () => {
    const h = createHarness();
    let settled = false;
    const active = h.controller.setTime(10).catch(error => { settled = true; return error; });
    h.scene.fireRenderError(new Error("target draw failed")); await flush();
    expect(settled).toBe(false);
    const recoveryFailure = new Error("restored draw failed");
    h.scene.fireRenderError(recoveryFailure); await flush();
    expect(await active).toBe(recoveryFailure);
    expect(h.host.viewer.useDefaultRenderLoop).toBe(false);
    expect(h.scene.listenerCount()).toBe(0);
    expect(h.snapshot()).toMatchObject({ status: "error", committedTimeMa: 100, lastError: { message: recoveryFailure.message } });
  });

  it("bounds a recovery that never renders instead of leaving the failed request pending forever", async () => {
    vi.useFakeTimers();
    try {
      const h = createHarness();
      let settled = false;
      const active = h.controller.setTime(10).catch(error => { settled = true; return error; });
      h.scene.fireRenderError(new Error("target draw failed"));
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await active).toMatchObject({ message: "The restored frame did not render within 30000ms." });
      expect(h.scene.listenerCount()).toBe(0);
      expect(h.snapshot().status).toBe("error");
    } finally { vi.useRealTimers(); }
  });

  it("does not overwrite a newer selection's waiter while publishing failed-frame recovery", async () => {
    const h = createHarness();
    let replacement: Promise<unknown> | undefined;
    let replacementSettled = false;
    h.stateSink.mockImplementation(snapshot => {
      if (snapshot.status === "preparing" && snapshot.lastError?.message === "target draw failed" && !replacement) {
        replacement = Promise.resolve();
        replacement = h.controller.select("globe").catch(error => { replacementSettled = true; return error; });
      }
    });
    const active = h.controller.setTime(10).catch(error => error);
    h.scene.fireRenderError(new Error("target draw failed")); await flush();
    expect(replacement).toBeDefined();
    h.controller.destroy(); await flush();
    expect(replacementSettled).toBe(true);
    expect(await replacement).toMatchObject({ reason: "superseded" });
    expect(await active).toBeInstanceOf(Error);
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("reports mode-superseded time as superseded in v2 while retaining the v1 busy shape", async () => {
    const h = createHarness();
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.timeSet], async (params, context) => {
      await h.controller.setTime(params.ageMa as number, { signal: context?.signal });
      return { data: { committedAgeMa: h.snapshot().committedTimeMa } };
    });
    const v1 = agentActions.execute(AGENT_ACTIONS.timeSet, { ageMa: 10 });
    await completeSwitch(h, h.controller.select("globe"));
    expect(await v1).toMatchObject({ ok: false, error: { kind: "busy" } });
    const target = {} as Window;
    installAgentActions(target);
    const v2 = target.timeMachineAgent!.v2;
    const accepted = await v2.execute(AGENT_ACTIONS.timeSet, { ageMa: 20 }, { completion: "accepted" });
    expect(accepted).toMatchObject({ status: "accepted" });
    await completeSwitch(h, h.controller.select("globe"));
    expect(await v2.jobs.wait(accepted.jobId!)).toMatchObject({ ok: false, status: "superseded", error: { code: "SUPERSEDED" } });
    expect(h.snapshot().committedTimeMa).toBe(100);
  });
});

describe("ProjectionController request cancellation", () => {
  it("rejects a pre-aborted selection without changing the view or cancelling other work", async () => {
    const h = createHarness(true);
    const abort = new AbortController();
    abort.abort();
    const before = h.snapshot();
    const result = h.controller.select("rectangle", { signal: abort.signal }).catch(error => error);
    try {
      expect(h.renderer.prepareRectangleFrame).not.toHaveBeenCalled();
      expect(h.renderer.cancelRectanglePreparation).not.toHaveBeenCalled();
      expect(h.snapshot()).toEqual(before);
      expect(await result).toMatchObject({ reason: "cancelled" });
      expect(h.scene.listenerCount()).toBe(0);
    } finally { h.controller.destroy(); await result; }
  });

  it("cancels preparation, removes listeners, and never stages a late CPU result", async () => {
    const h = createHarness(true);
    const cpu = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(cpu.promise);
    const abort = new AbortController();
    const removeAbort = vi.spyOn(abort.signal, "removeEventListener");
    const result = h.controller.select("rectangle", { signal: abort.signal }).catch(error => error);
    const cancellations = h.renderer.cancelRectanglePreparation.mock.calls.length;
    try {
      abort.abort();
      expect(h.renderer.cancelRectanglePreparation).toHaveBeenCalledTimes(cancellations + 1);
      expect(await result).toBeInstanceOf(OperationInterruptedError);
      expect(await result).toMatchObject({ reason: "cancelled" });
      expect(h.snapshot()).toMatchObject({ committedId: "globe", requestedId: "globe", committedTimeMa: 100, status: "ready" });
      expect(h.host.setGlobeInertiaEnabled).toHaveBeenLastCalledWith(true);
      expect(h.scene.listenerCount()).toBe(0);
      expect(removeAbort).toHaveBeenCalledTimes(1);
      cpu.resolve(HANDLE);
      await flush();
      expect(h.renderer.stageRectangleFrame).not.toHaveBeenCalled();
      expect(h.renderer.commitRectangleFrame).not.toHaveBeenCalled();
    } finally { h.controller.destroy(); await result; }
  });

  it.each([
    ["globe", "rectangle"], ["rectangle", "globe"],
    ["rectangle", "mollweide"], ["mollweide", "rectangle"],
  ] as const)("restores the confirmed %s frame and camera when cancelling the %s render wait", async (previous, target) => {
    const h = createHarness(true);
    if (previous !== "globe") await completeSwitch(h, h.controller.select(previous));
    const before = h.snapshot();
    h.renderer.rollbackFlatSwap.mockClear();
    const abort = new AbortController();
    const removeAbort = vi.spyOn(abort.signal, "removeEventListener");
    let settled = false;
    const result = h.controller.select(target, { signal: abort.signal }).catch(error => error).then(value => { settled = true; return value; });
    try {
      await flush();
      expect(h.controller.sceneMode).toBe(target);
      abort.abort();
      expect(h.controller.sceneMode).toBe(previous);
      expect(h.renderer.rollbackFlatSwap).toHaveBeenCalledTimes(1);
      await flush();
      expect(settled).toBe(false); // rollback is not confirmed by a fixed delay
      h.scene.firePostRender();
      expect(await result).toMatchObject({ reason: "cancelled" });
      expect(h.snapshot()).toMatchObject({ committedId: previous, requestedId: previous, committedTimeMa: before.committedTimeMa, revision: before.revision, camera: before.camera, status: "ready" });
      expect(h.scene.listenerCount()).toBe(0);
      expect(removeAbort).toHaveBeenCalledTimes(1);
      abort.abort();
      expect(h.renderer.rollbackFlatSwap).toHaveBeenCalledTimes(1);
    } finally { h.controller.destroy(); await result; }
  });

  it("does not let an older signal cancel a newer selection or clear its listeners", async () => {
    const h = createHarness(true);
    const oldAbort = new AbortController();
    const old = h.controller.select("rectangle", { signal: oldAbort.signal }).catch(error => error);
    await flush();
    const next = h.controller.select("mollweide");
    try {
      await flush();
      const before = h.snapshot();
      const cancellations = h.renderer.cancelRectanglePreparation.mock.calls.length;
      const listenerCount = h.scene.listenerCount();
      oldAbort.abort();
      expect(await old).toMatchObject({ reason: "superseded" });
      expect(h.snapshot()).toEqual(before);
      expect(h.scene.listenerCount()).toBe(listenerCount);
      expect(h.renderer.cancelRectanglePreparation).toHaveBeenCalledTimes(cancellations);
      h.scene.firePostRender();
      expect(await next).toMatchObject({ projectionId: "mollweide" });
    } finally { h.controller.destroy(); await old; await next.catch(() => undefined); }
  });

  it("classifies source invalidation as superseded and never installs its late preparation", async () => {
    const h = createHarness(true);
    const cpu = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(cpu.promise);
    const abort = new AbortController();
    const removeAbort = vi.spyOn(abort.signal, "removeEventListener");
    const result = h.controller.select("mollweide", { signal: abort.signal }).catch(error => error);
    try {
      h.controller.invalidateSource();
      expect(await result).toMatchObject({ reason: "superseded" });
      expect(removeAbort).toHaveBeenCalledTimes(1);
      const before = h.snapshot();
      abort.abort();
      cpu.resolve(HANDLE);
      await flush();
      expect(h.snapshot()).toEqual(before);
      expect(h.renderer.stageRectangleFrame).not.toHaveBeenCalled();
      expect(h.scene.listenerCount()).toBe(0);
    } finally { h.controller.destroy(); await result; }
  });

  it("cancels GPU warm-up without waiting for a late staging result", async () => {
    const h = createHarness(true);
    const warm = deferred<never>();
    h.renderer.stageRectangleFrame.mockReturnValueOnce(warm.promise);
    const abort = new AbortController();
    const result = h.controller.select("rectangle", { signal: abort.signal }).catch(error => error);
    try {
      await flush();
      abort.abort();
      expect(await result).toMatchObject({ reason: "cancelled" });
      expect(h.snapshot()).toMatchObject({ committedId: "globe", status: "ready" });
      expect(h.host.setGlobeInertiaEnabled).toHaveBeenLastCalledWith(true);
      warm.resolve(undefined as never);
      await flush();
      expect(h.renderer.commitRectangleFrame).not.toHaveBeenCalled();
      expect(h.scene.listenerCount()).toBe(0);
    } finally { h.controller.destroy(); await result; }
  });

  it("keeps a genuine preparation failure and removes its signal listener once", async () => {
    const h = createHarness(true);
    h.renderer.prepareRectangleFrame.mockRejectedValueOnce(new Error("Synthetic preparation failure"));
    const abort = new AbortController();
    const removeAbort = vi.spyOn(abort.signal, "removeEventListener");
    await expect(h.controller.select("rectangle", { signal: abort.signal })).rejects.toThrow("Synthetic preparation failure");
    expect(h.snapshot()).toMatchObject({ committedId: "globe", status: "error", lastError: { code: 500 } });
    expect(removeAbort).toHaveBeenCalledTimes(1);
    const before = h.snapshot();
    abort.abort();
    expect(h.snapshot()).toEqual(before);
    expect(h.scene.listenerCount()).toBe(0);
    h.controller.destroy();
  });

  it("reports a rollback render error instead of claiming cancellation completed", async () => {
    const h = createHarness(true);
    const abort = new AbortController();
    const result = h.controller.select("rectangle", { signal: abort.signal }).catch(error => error);
    try {
      await flush();
      abort.abort();
      h.scene.fireRenderError(new Error("Synthetic rollback render failure"));
      expect(await result).toMatchObject({ message: "Synthetic rollback render failure" });
      expect(await result).not.toBeInstanceOf(OperationInterruptedError);
      expect(h.snapshot()).toMatchObject({ committedId: "globe", status: "error", lastError: { code: 500 } });
      expect(h.scene.listenerCount()).toBe(0);
    } finally { h.controller.destroy(); await result; }
  });

  it("lets a new selection take over a cancelled request's recovery without stale cleanup", async () => {
    const h = createHarness(true);
    const abort = new AbortController();
    const old = h.controller.select("rectangle", { signal: abort.signal }).catch(error => error);
    await flush();
    abort.abort();
    const next = h.controller.select("mollweide");
    try {
      await flush();
      expect(await old).toMatchObject({ reason: "cancelled" });
      expect(h.snapshot()).toMatchObject({ requestedId: "mollweide", status: "preparing" });
      h.scene.firePostRender();
      expect(await next).toMatchObject({ projectionId: "mollweide" });
      expect(h.snapshot()).toMatchObject({ committedId: "mollweide", status: "ready" });
      expect(h.scene.listenerCount()).toBe(0);
    } finally { h.controller.destroy(); await old; await next.catch(() => undefined); }
  });

  it("handles a synchronous state observer cancellation before preparation starts", async () => {
    const h = createHarness(true);
    const abort = new AbortController();
    h.stateSink.mockImplementationOnce(() => abort.abort());
    try {
      await expect(h.controller.select("rectangle", { signal: abort.signal })).rejects.toMatchObject({ reason: "cancelled" });
      await flush();
      expect(h.renderer.prepareRectangleFrame).not.toHaveBeenCalled();
      expect(h.scene.listenerCount()).toBe(0);
      expect(h.snapshot()).toMatchObject({ committedId: "globe", status: "ready" });
    } finally { h.controller.destroy(); }
  });

  it("returns a synchronous rollback failure instead of a false cancelled result", async () => {
    const h = createHarness(true);
    const abort = new AbortController();
    const result = h.controller.select("rectangle", { signal: abort.signal }).catch(error => error);
    try {
      await flush();
      h.renderer.rollbackFlatSwap.mockImplementationOnce(() => { throw new Error("Synthetic rollback failure"); });
      abort.abort();
      expect(await result).toMatchObject({ message: "Synthetic rollback failure" });
      expect(await result).not.toBeInstanceOf(OperationInterruptedError);
      expect(h.snapshot()).toMatchObject({ status: "error", lastError: { code: 500 } });
      expect(h.scene.listenerCount()).toBe(0);
    } finally { h.controller.destroy(); await result; }
  });

  it("finishes an already-confirmed frame when its commit observer requests cancellation", async () => {
    const h = createHarness(true);
    const abort = new AbortController();
    h.host.onCommittedTimeChange = () => abort.abort();
    const result = h.controller.select("rectangle", { signal: abort.signal }).catch(error => error);
    try {
      await flush();
      h.scene.firePostRender();
      expect(await result).toMatchObject({ projectionId: "rectangle", revision: 1 });
      expect(h.snapshot()).toMatchObject({ requestedId: "rectangle", committedId: "rectangle", status: "ready" });
      expect(h.controller.sceneMode).toBe("rectangle");
      expect(h.renderer.rollbackFlatSwap).not.toHaveBeenCalled();
      expect(h.scene.listenerCount()).toBe(0);
    } finally { h.controller.destroy(); await result; }
  });
});

describe("ProjectionController Moll worker pipeline", () => {
  it("fails CPU-gap tickets immediately when Widget stops, never stages late CPU and retries", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    h.renderer.stageRectangleFrame.mockClear();
    const cpu = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockImplementationOnce(() => cpu.promise);
    const a = h.controller.setTime(108).catch(e => e);
    const b = h.controller.setTime(110).catch(e => e);
    h.scene.fireRenderError(new Error("CPU gap draw failure"));
    expect(await a).toMatchObject({ message: "CPU gap draw failure" });
    expect(await b).toMatchObject({ message: "CPU gap draw failure" });
    expect(h.snapshot()).toMatchObject({ status: "error", lastError: { code: 500 }, committedTimeMa: 100 });
    expect(h.scene.listenerCount()).toBe(0);
    cpu.resolve({ ...HANDLE, timeMa: 108 });
    await flush();
    expect(h.renderer.stageRectangleFrame).not.toHaveBeenCalled();
    expect(h.host.viewer.useDefaultRenderLoop).toBe(false);
    await completeSwitch(h, h.controller.setTime(100));
    expect(h.host.viewer.useDefaultRenderLoop).toBe(true);
    expect(h.snapshot()).toMatchObject({ status: "ready", committedTimeMa: 100 });
  });

  it("settles GPU current, CPU-ready successor and latest queued on failure without promotion", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const a = h.controller.setTime(108).catch(e => e);
    await flush();
    const b = h.controller.setTime(109).catch(e => e);
    await flush();
    const c = h.controller.setTime(110).catch(e => e);
    const stages = h.renderer.stageRectangleFrame.mock.calls.length;
    h.scene.fireRenderError(new Error("GPU failed with ready successor"));
    for (const result of await Promise.all([a, b, c])) expect(result).toMatchObject({ message: "GPU failed with ready successor" });
    await flush();
    expect(h.renderer.stageRectangleFrame).toHaveBeenCalledTimes(stages);
    expect(h.snapshot()).toMatchObject({ status: "error", committedTimeMa: 100, lastError: { code: 500 } });
    await completeSwitch(h, h.controller.setTime(100));
    expect(h.snapshot().status).toBe("ready");
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("resumes stopped active confirmation on explicit queued retry without resending", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const a = h.controller.setTime(108);
    await flush();
    h.host.viewer.useDefaultRenderLoop = false;
    h.scene.firePostRender(); // stopped Widget must not deliver this frame
    expect(h.snapshot().committedTimeMa).toBe(100);
    const retry = h.controller.setTime(100);
    expect(h.host.viewer.useDefaultRenderLoop).toBe(true);
    h.scene.firePostRender();
    await a;
    await completeSwitch(h, retry);
    expect(h.snapshot()).toMatchObject({ status: "ready", committedTimeMa: 100 });
  });

  it("resumes after a silent CPU-gap stop before stage and confirmation", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const cpu = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockImplementationOnce(() => cpu.promise);
    const a = h.controller.setTime(108);
    h.host.viewer.useDefaultRenderLoop = false;
    cpu.resolve(HANDLE);
    await flush();
    expect(h.host.viewer.useDefaultRenderLoop).toBe(true);
    h.scene.firePostRender();
    await a;
  });

  it("resumes a silently stopped loop when entering confirmation after warm-up", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const warm = deferred<never>();
    h.renderer.stageRectangleFrame.mockImplementationOnce(() => warm.promise);
    const a = h.controller.setTime(108);
    await flush();
    h.host.viewer.useDefaultRenderLoop = false;
    warm.resolve(undefined as never);
    await flush();
    expect(h.host.viewer.useDefaultRenderLoop).toBe(true);
    h.scene.firePostRender();
    await a;
    expect(h.scene.listenerCount()).toBe(0);
  });

  it.each(["mode", "destroy", "source"])("removes CPU error listener on %s and ignores late errors/results", async boundary => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const cpu = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockImplementationOnce(() => cpu.promise);
    const old = h.controller.setTime(108).catch(e => e);
    if (boundary === "mode") await completeSwitch(h, h.controller.select("globe"));
    else if (boundary === "destroy") h.controller.destroy();
    else h.controller.invalidateSource();
    expect(await old).toMatchObject({ reason: "superseded" });
    expect(h.scene.listenerCount()).toBe(0);
    const before = h.snapshot();
    const stages = h.renderer.stageRectangleFrame.mock.calls.length;
    h.scene.fireRenderError(new Error("late old error"));
    cpu.resolve(HANDLE);
    await flush();
    if (boundary === "mode") {
      // The old request still cannot install anything, but a scene error raised
      // with no owning transaction is now an honest lifecycle error.
      expect(h.snapshot()).toMatchObject({
        committedId: before.committedId,
        committedTimeMa: before.committedTimeMa,
        requestedTimeMa: before.requestedTimeMa,
        revision: before.revision,
        status: "error",
      });
      expect(h.snapshot().lastError?.message).toBe("late old error");
    } else {
      expect(h.snapshot()).toEqual(before);
    }
    expect(h.renderer.stageRectangleFrame).toHaveBeenCalledTimes(stages);
  });

  it("overlaps CPU b with GPU a, preserves promoted b and bounds pending to the latest", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const warmA = deferred<never>();
    h.renderer.stageRectangleFrame.mockImplementationOnce(() => warmA.promise);
    h.renderer.prepareRectangleFrame.mockClear();
    const a = h.controller.setTime(101);
    await flush();
    const b = h.controller.setTime(102);
    await flush();
    const c = h.controller.setTime(103);
    const superseded = expect(c).rejects.toMatchObject({ reason: "superseded" });
    const latest = h.controller.setTime(104);
    await superseded;
    // b is already CPU-active/ready even though a has not finished warming.
    expect(h.renderer.prepareRectangleFrame.mock.calls.map(call => call[0])).toEqual([101,102]);
    expect(h.snapshot().requestedTimeMa).toBe(104);
    expect(h.snapshot().committedTimeMa).not.toBe(101);
    warmA.resolve(undefined as never);
    await flush(); h.scene.firePostRender(); await a;
    await flush(); h.scene.firePostRender(); await b;
    await flush(); h.scene.firePostRender(); await latest;
    expect(h.renderer.prepareRectangleFrame.mock.calls.map(call => call[0])).toEqual([101,102,104]);
    expect(vi.mocked(h.host.onCommittedTimeChange).mock.calls.slice(-3).map(call => call[0])).toEqual([101,102,104]);
    expect(h.snapshot().committedTimeMa).toBe(104);
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("keeps a confirmed frame after prefetched worker failure, settles pending and supports retry", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const a = h.controller.setTime(101);
    await flush();
    h.renderer.prepareRectangleFrame.mockRejectedValueOnce(new Error("worker failed"));
    const b = h.controller.setTime(102), rejectedB = expect(b).rejects.toThrow("worker failed");
    const c = h.controller.setTime(103), rejectedC = expect(c).rejects.toThrow("worker failed");
    await flush(); h.scene.firePostRender(); await a;
    await Promise.all([rejectedB, rejectedC]);
    expect(h.snapshot().committedTimeMa).toBe(101);
    expect(h.snapshot().requestedTimeMa).toBe(103);
    expect(h.snapshot().status).toBe("error");
    expect(h.renderer.cancelRectanglePreparation).toHaveBeenCalled();
    const retry = h.controller.setTime(104);
    await flush(); h.scene.firePostRender(); await retry;
    expect(h.snapshot().committedTimeMa).toBe(104);
    expect(h.snapshot().status).toBe("ready");
    expect(h.scene.listenerCount()).toBe(0);
  });

  it.each(["destroy", "mode", "source", "capability", "renderError"])("settles GPU/CPU/pending tickets on %s and ignores late CPU", async reason => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const cpu = deferred<typeof HANDLE>();
    const a = h.controller.setTime(101);
    const aRejected = expect(a).rejects.toThrow();
    await flush();
    h.renderer.prepareRectangleFrame.mockImplementationOnce(() => cpu.promise);
    const b = h.controller.setTime(102), bRejected = expect(b).rejects.toThrow();
    const c = h.controller.setTime(103), cRejected = expect(c).rejects.toThrow();
    if (reason === "destroy") h.controller.destroy();
    else if (reason === "source") h.controller.invalidateSource();
    else if (reason === "capability") { h.setVisible([2]); h.controller.refreshCapabilities(); }
    else if (reason === "renderError") h.scene.fireRenderError(new Error("lost frame"));
    else await completeSwitch(h, h.controller.select("globe"));
    await Promise.all([aRejected,bRejected,cRejected]);
    cpu.resolve({ ...HANDLE, timeMa:102 });
    await flush();
    expect(h.snapshot().committedTimeMa).not.toBe(102);
    expect(h.renderer.stageRectangleFrame.mock.calls.some(call => call[0].timeMa === 102)).toBe(false);
    expect(h.scene.listenerCount()).toBe(0);
  });

  it.each(["rollbackFlatSwap", "cancelRectanglePreparation", "cancelRectangleStaging", "cameraRestore"] as const)(
    "invalidates capability tickets before %s throws and cannot commit a late frame",
    async failurePoint => {
      const h = createHarness(true);
      await completeSwitch(h, h.controller.select("mollweide"));
      vi.mocked(h.host.onCommittedTimeChange).mockClear();
      const cpu = deferred<typeof HANDLE>();
      const results: unknown[] = [];
      const observe = (index: number, promise: Promise<void>) => promise.then(
        () => { results[index] = "completed"; },
        error => { results[index] = error; },
      );
      const active = observe(0, h.controller.setTime(101));
      await flush(); // Replacement is installed, awaiting its own postRender.
      h.renderer.prepareRectangleFrame.mockImplementationOnce(() => cpu.promise);
      const successor = observe(1, h.controller.setTime(102));
      const pending = observe(2, h.controller.setTime(103));
      const stages = h.renderer.stageRectangleFrame.mock.calls.length;
      const failure = new Error(`Synthetic ${failurePoint} failure`);
      if (failurePoint === "cameraRestore") {
        vi.mocked(h.host.viewer.camera.setView).mockImplementationOnce(() => { throw failure; });
      } else {
        h.renderer[failurePoint].mockImplementationOnce(() => { throw failure; });
      }
      h.setVisible([2]);
      try {
        expect(() => h.controller.refreshCapabilities()).toThrow(failure);
        h.scene.firePostRender();
        cpu.resolve({ ...HANDLE, timeMa: 102 });
        await flush();
        expect(results).toEqual([
          expect.objectContaining({ reason: "superseded" }),
          expect.objectContaining({ reason: "superseded" }),
          expect.objectContaining({ reason: "superseded" }),
        ]);
        expect(h.snapshot()).toMatchObject({
          status: "error", committedTimeMa: 100, requestedTimeMa: 100,
          lastError: { kind: "internal", message: failure.message },
        });
        expect(h.host.onCommittedTimeChange).not.toHaveBeenCalled();
        expect(h.renderer.stageRectangleFrame).toHaveBeenCalledTimes(stages);
        expect(h.scene.listenerCount()).toBe(0);
        await Promise.all([active, successor, pending]);
        h.setVisible([]);
        await completeSwitch(h, h.controller.setTime(150));
        expect(h.snapshot()).toMatchObject({ status: "ready", committedTimeMa: 150 });
      } finally {
        h.controller.destroy();
        cpu.resolve(HANDLE);
        await Promise.all([active, successor, pending]);
      }
    },
  );
});

describe("ProjectionController", () => {
  it.each(["renderError", "success"] as const)("retains real Rectangle resources until replacement confirmation: %s", async outcome => {
    const h = createHarness(true);
    const primitives = new PrimitiveCollection();
    Object.assign(h.host.viewer.scene, { primitives, pick: () => undefined });
    const renderer = await PlateRenderer.create(h.host.viewer, []);
    Object.assign(h.host, { plateRenderer: renderer });
    const frames = new Map<number, PolylineCollection>();
    vi.spyOn(renderer, "prepareRectangleFrame").mockImplementation(async age => ({ ...HANDLE, timeMa: age }));
    // No WebGL in jsdom: supply a warmed frame, but exercise the real renderer's
    // commit/retain/rollback/destruction on Cesium-owned native collections.
    vi.spyOn(renderer, "stageRectangleFrame").mockImplementation(async (handle, generation) => {
      const outlines = primitives.add(new PolylineCollection());
      frames.set(handle.timeMa, outlines);
      Object.assign(renderer, { rectangleStaging: {
        generation, timeMa: handle.timeMa, fill: undefined, outlines, instances: [], renderedOutlines: [],
      } });
      return { generation, timeMa: handle.timeMa, hasContent: true };
    });
    try {
      await completeSwitch(h, h.controller.select("rectangle"));
      h.controller.zoom(2);
      const before = h.snapshot();
      const oldFrame = frames.get(100)!;
      vi.mocked(h.host.onCommittedTimeChange).mockClear();
      const replacement = h.controller.setTime(180).then(() => undefined, error => error);
      await flush();
      const candidate = frames.get(180)!;
      expect(candidate.show).toBe(true);
      expect(oldFrame.isDestroyed()).toBe(false);
      expect(primitives.contains(oldFrame)).toBe(true);
      expect(oldFrame.show).toBe(false);
      expect(h.snapshot().committedTimeMa).toBe(100);
      if (outcome === "renderError") {
        h.scene.fireRenderError(new Error("Rectangle replacement draw failed"));
        await flush();
        expect(candidate.isDestroyed()).toBe(true);
        expect(oldFrame.isDestroyed()).toBe(false);
        expect(oldFrame.show).toBe(true);
        expect(h.snapshot()).toMatchObject({ status: "preparing", committedId: "rectangle", committedTimeMa: 100, camera: before.camera });
        expect(h.host.viewer.useDefaultRenderLoop).toBe(true);
        h.scene.firePostRender();
        expect(await replacement).toMatchObject({ message: "Rectangle replacement draw failed" });
        expect(h.snapshot().status).toBe("error");
        expect(h.snapshot().committedTimeMa).toBe(100);
        expect(h.host.onCommittedTimeChange).not.toHaveBeenCalled();
        await completeSwitch(h, h.controller.setTime(160));
        expect(h.snapshot()).toMatchObject({ status: "ready", committedTimeMa: 160 });
      } else {
        h.scene.firePostRender();
        expect(await replacement).toBeUndefined();
        expect(candidate.isDestroyed()).toBe(false);
        expect(h.snapshot()).toMatchObject({ status: "ready", committedTimeMa: 180 });
      }
      expect(oldFrame.isDestroyed()).toBe(true);
      expect(primitives.contains(oldFrame)).toBe(false);
      expect(h.scene.listenerCount()).toBe(0);
    } finally {
      h.controller.destroy();
      renderer.destroy();
      primitives.destroy();
    }
  });

  it("retires the old Moll frame when a superseding Globe fast path accepts a newer age", async () => {
    const h = createHarness(true);
    await completeSwitch(h, h.controller.select("mollweide"));
    h.renderer.confirmFlatSwap.mockClear();
    const old = h.controller.select("globe").catch(e => e);
    await flush();
    expect(h.controller.sceneMode).toBe("globe");
    const token = h.renderer.beginFlatSwap.mock.lastCall![0];
    await completeSwitch(h, h.controller.setTime(180));
    expect(await old).toMatchObject({ reason: "superseded" });
    expect(h.renderer.confirmFlatSwap).toHaveBeenCalledExactlyOnceWith(token);
    h.renderer.prepareRectangleFrame.mockRejectedValueOnce(new Error("prepare fails"));
    await expect(h.controller.select("rectangle")).rejects.toThrow("prepare fails");
    expect(h.renderer.rollbackFlatSwap).not.toHaveBeenCalled();
    expect(h.controller.sceneMode).toBe("globe");
    expect(h.snapshot()).toMatchObject({ committedId: "globe", committedTimeMa: 180 });
    h.controller.destroy();
  });

  it("transfers pending flat swap ownership and rolls back genuine render failures", async () => {
    const h = createHarness(true);
    const old = h.controller.select("mollweide").catch(e => e);
    await flush();
    const token = h.renderer.beginFlatSwap.mock.lastCall![0];
    const newer = h.controller.setTime(180).catch(e => e);
    await flush();
    expect(await old).toMatchObject({ reason: "superseded" });
    expect(h.renderer.beginFlatSwap).toHaveBeenCalledTimes(1);
    h.host.viewer.useDefaultRenderLoop = false;
    h.scene.fireRenderError(new Error("render fails"));
    await flush(); h.scene.firePostRender();
    expect(await newer).toBeInstanceOf(Error);
    expect(h.renderer.rollbackFlatSwap).toHaveBeenCalledExactlyOnceWith(token);
    expect(h.controller.sceneMode).toBe("globe");
    expect(h.host.viewer.useDefaultRenderLoop).toBe(true);
    h.controller.destroy();
  });

  it.each(["rectangle", "mollweide"] as const)("a confirmed %s frame rolls back its failed replacement and resumes rendering", async mode => {
    const h = createHarness(true);
    await completeSwitch(h, h.controller.select(mode));
    h.controller.zoom(2);
    const before = h.snapshot();
    const failed = h.controller.setTime(180).catch(e => e);
    await flush();
    expect(h.renderer.beginFlatSwap).toHaveBeenCalled();
    const token = h.renderer.beginFlatSwap.mock.lastCall![0];
    h.host.viewer.useDefaultRenderLoop = false;
    h.scene.fireRenderError(new Error("replacement render failure"));
    await flush(); h.scene.firePostRender();
    expect(await failed).toBeInstanceOf(Error);
    expect(h.renderer.rollbackFlatSwap).toHaveBeenCalledExactlyOnceWith(token);
    expect(h.snapshot()).toMatchObject({ committedId: mode, committedTimeMa: 100, camera: before.camera });
    expect(h.host.viewer.useDefaultRenderLoop).toBe(true);
    h.controller.destroy();
  });

  it("a superseding flat success confirms the inherited resource token once", async () => {
    const h = createHarness(true);
    await completeSwitch(h, h.controller.select("rectangle"));
    const old = h.controller.select("mollweide").catch(e => e);
    await flush();
    const token = h.renderer.beginFlatSwap.mock.lastCall![0];
    const newer = h.controller.setTime(180);
    await flush();
    expect(await old).toMatchObject({ reason: "superseded" });
    h.scene.firePostRender();
    await newer;
    expect(h.renderer.confirmFlatSwap).toHaveBeenCalledExactlyOnceWith(token);
    expect(h.renderer.rollbackFlatSwap).not.toHaveBeenCalled();
    expect(h.snapshot()).toMatchObject({ committedId: "mollweide", committedTimeMa: 180 });
    h.controller.destroy();
    expect(h.renderer.rollbackFlatSwap).not.toHaveBeenCalled();
  });

  for (const mode of ["rectangle", "mollweide"] as const) {
    it(`${mode}: shared camera actions clamp, pan and read without time/mode mutations`, async () => {
      const h = createHarness(true);
      await completeSwitch(h, h.controller.select(mode));
      const before = h.snapshot();
      const zoom = h.controller.zoom(100);
      expect(zoom.factor).toBeLessThan(100);
      expect(zoom.width).toBeGreaterThan(before.camera!.width!);
      expect(h.controller.zoom(1).factor).toBe(1);
      const bounds = h.snapshot().camera!.worldBounds!;
      h.controller.pan(20, -10);
      expect(h.snapshot().camera!.worldBounds!.left - bounds.left).toBeCloseTo(20);
      expect(h.snapshot().camera!.worldBounds!.top - bounds.top).toBeCloseTo(-10);
      expect(h.host.viewer.camera.moveRight).toHaveBeenCalledWith(expect.any(Number));
      expect(h.host.viewer.camera.moveUp).toHaveBeenCalledWith(expect.any(Number));
      expect(h.snapshot()).toMatchObject({ committedId: mode, committedTimeMa: before.committedTimeMa, revision: before.revision });
      expect(h.snapshot().camera!.worldRatio!.width).toBeLessThanOrEqual(0.201);
      for (let i = 0; i < 5; i++) h.controller.zoom(0.01);
      expect(h.controller.zoom(0.01)).toMatchObject({ factor: 1, width: 1000 });
      for (const factor of [0, -1, NaN, Infinity, 0.001, 101, "2"]) expect(() => h.controller.zoom(factor)).toThrow();
      for (const delta of [NaN, Infinity, 100001, "2"]) expect(() => h.controller.pan(delta, 0)).toThrow();
      h.controller.destroy();
    });
  }

  it("Moll pointer dragging and wheel/ctrl-wheel use the API's business methods exactly once", async () => {
    const h = createHarness(true);
    await completeSwitch(h, h.controller.select("mollweide"));
    const canvas = h.host.viewer.scene.canvas;
    canvas.setPointerCapture = vi.fn();
    const pointer = (type: string, x: number, y: number) => {
      const e = new Event(type, { cancelable: true });
      Object.assign(e, { clientX: x, clientY: y, pointerId: 1, button: 0 });
      canvas.dispatchEvent(e);
    };
    const before = h.snapshot().camera!.worldBounds!;
    pointer("pointerdown", 500, 300);
    pointer("pointermove", 540, 320);
    pointer("pointerup", 540, 320);
    expect(h.snapshot().camera!.worldBounds!.left - before.left).toBeCloseTo(40);
    expect(h.snapshot().camera!.worldBounds!.top - before.top).toBeCloseTo(20);
    const width = h.snapshot().camera!.width!;
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, ctrlKey: true, cancelable: true }));
    expect(h.snapshot().camera!.width).toBeCloseTo(width * Math.exp(0.2));
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, cancelable: true }));
    expect(h.snapshot().camera!.width).toBeCloseTo(width);
    h.controller.destroy();
  });

  it("restores the saved globe pose before morphing the offset Mollweide camera to 2D", async () => {
    const h=createHarness(true);
    await completeSwitch(h,h.controller.select("mollweide"));
    const camera=h.host.viewer.camera;
    const setView=vi.mocked(camera.setView);
    setView.mockClear();
    h.scene.morphTo2D.mockClear();
    await completeSwitch(h,h.controller.select("rectangle"));
    expect(setView.mock.calls[0]![0]).toMatchObject({
      destination:new Cartesian3(50000000,0,0),
      orientation:{direction:new Cartesian3(-1,0,0),up:new Cartesian3(0,0,1)},
      convert:false,
    });
    expect(setView.mock.invocationCallOrder[0]).toBeLessThan(h.scene.morphTo2D.mock.invocationCallOrder[0]!);
  });

  it("camera facade validates schema, maps errors, returns clamp and safe read-only state", async () => {
    const h = createHarness(true);
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.cameraZoom], p => ({ data: h.controller.zoom(p.factor) }));
    agentActions.register(AGENT_DECLARATIONS[AGENT_ACTIONS.cameraPan], p => ({ data: h.controller.pan(p.deltaX, p.deltaY) }));
    agentActions.registerStateSection("projection", () => ({ camera: h.snapshot().camera }));
    expect(await agentActions.execute("camera.zoom", { factor: 2 })).toMatchObject({ ok: false, error: { code: 501 } });
    for (const params of [{}, { factor: "2" }, { factor: 0 }, { factor: NaN }, { factor: 101 }]) {
      expect(await agentActions.execute("camera.zoom", params)).toMatchObject({ ok: false, error: { code: 400 } });
    }
    for (const params of [{ deltaX: 1 }, { deltaX: Infinity, deltaY: 0 }, { deltaX: 0, deltaY: -100001 }]) {
      expect(await agentActions.execute("camera.pan", params)).toMatchObject({ ok: false, error: { code: 400 } });
    }
    await completeSwitch(h, h.controller.select("mollweide"));
    expect(await agentActions.execute("camera.zoom", { factor: 100 })).toMatchObject({ ok: true, data: { mode: "mollweide", factor: 3.25 } });
    expect(await agentActions.execute("camera.pan", { deltaX: 20, deltaY: -10 })).toMatchObject({ ok: true, data: { mode: "mollweide", deltaX: 20, deltaY: -10 } });
    const before = h.snapshot();
    const state = agentActions.getState().projection as { camera: { worldBounds: { left: number } } };
    expect(typeof state.camera.worldBounds.left).toBe("number");
    state.camera.worldBounds.left = 123;
    expect(h.snapshot()).toEqual(before);
    h.controller.destroy();
  });

  it("Globe explicitly rejects flat camera zoom and pan", () => {
    const h = createHarness(true);
    expect(() => h.controller.zoom(2)).toThrow("flat projections only");
    expect(() => h.controller.pan(1, 1)).toThrow("flat projections only");
    h.controller.destroy();
  });
  it("commits intermediate ages during continuous input, coalescing only pending work", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("rectangle"));
    h.renderer.prepareRectangleFrame.mockClear();
    const committed: number[] = [];
    h.host.onCommittedTimeChange = (age) => { committed.push(age); };
    const active = h.controller.setTime(10);
    const overwritten = h.controller.setTime(20).catch((error) => error);
    const latest = h.controller.setTime(30);
    expect(await overwritten).toMatchObject({ reason: "superseded" });
    expect(h.renderer.prepareRectangleFrame).toHaveBeenCalledTimes(1);
    await flush();
    h.scene.firePostRender();
    await active;
    expect(committed).toEqual([10]);
    expect(h.snapshot()).toMatchObject({
      committedTimeMa: 10, requestedTimeMa: 30, status: "preparing",
    });
    // More input arrives before the pending frame confirms, not after stopping.
    const final = h.controller.setTime(40);
    await flush();
    h.scene.firePostRender();
    await latest;
    expect(committed).toEqual([10, 30]);
    expect(h.snapshot()).toMatchObject({ requestedTimeMa: 40, status: "preparing" });
    await flush();
    h.scene.firePostRender();
    await final;
    expect(committed).toEqual([10, 30, 40]);
    expect(h.snapshot()).toMatchObject({
      committedTimeMa: 40, requestedTimeMa: 40, status: "ready",
    });
    expect(h.renderer.prepareRectangleFrame.mock.calls.map((call) => call[0]))
      .toEqual([10, 30, 40]);
  });

  it.each(["destroy", "mode", "renderError", "capability"] as const)(
    "settles active and pending time promises on %s and permits recovery", async (boundary) => {
      const h = createHarness();
      await completeSwitch(h, h.controller.select("rectangle"));
      const active = h.controller.setTime(10).catch((error) => error);
      const pending = h.controller.setTime(20).catch((error) => error);
      await flush();
      if (boundary === "destroy") h.controller.destroy();
      if (boundary === "mode") {
        const back = h.controller.select("globe");
        await flush();
        h.scene.firePostRender();
        await back;
      }
      if (boundary === "renderError") h.scene.fireRenderError(new Error("failed render"));
      if (boundary === "capability") {
        h.setVisible([2]);
        h.controller.refreshCapabilities();
      }
      expect(await active).toBeInstanceOf(Error);
      expect(await pending).toBeInstanceOf(Error);
      expect(h.scene.listenerCount()).toBe(0);
      expect(h.renderer.cancelRectanglePreparation).toHaveBeenCalled();
      const previous = h.snapshot().committedTimeMa;
      h.scene.firePostRender();
      await flush();
      expect(h.snapshot().committedTimeMa).toBe(previous);
      expect(h.renderer.cancelRectangleStaging).toHaveBeenCalled();
      if (boundary === "destroy") {
        await expect(h.controller.select("rectangle")).rejects.toMatchObject({ kind: "busy" });
        await expect(h.controller.setTime(50)).rejects.toMatchObject({ kind: "busy" });
        return;
      }
      h.setVisible([]);
      await completeSwitch(h, h.controller.select("rectangle"));
      const retry = h.controller.setTime(50);
      await flush();
      h.scene.firePostRender();
      await retry;
      expect(h.snapshot()).toMatchObject({ committedTimeMa: 50, status: "ready" });
    },
  );

  it("invalidates active and pending flat requests on source change, preserving the last committed frame", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("mollweide"));
    const prep = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(prep.promise);
    const active = h.controller.setTime(120).catch(error => error);
    const pending = h.controller.setTime(180).catch(error => error);
    await flush();
    h.controller.invalidateSource();
    expect(await active).toMatchObject({ reason: "superseded" });
    expect(await pending).toMatchObject({ reason: "superseded" });
    expect(h.snapshot().committedTimeMa).toBe(100);
    expect(h.snapshot().committedId).toBe("mollweide");
    expect(h.snapshot().lastError?.message).toMatch(/source changed/i);
    prep.resolve({ ...HANDLE, timeMa: 120 });
    await flush();
    expect(h.renderer.commitRectangleFrame).toHaveBeenCalledTimes(1);
    await expect(h.controller.setTime(200)).rejects.toMatchObject({ kind: "busy" });
    await expect(h.controller.select("globe")).rejects.toMatchObject({ kind: "busy" });
  });

  it("invalid age leaves the valid active and pending requests intact", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("rectangle"));
    const first = h.controller.setTime(10);
    const last = h.controller.setTime(20);
    await expect(h.controller.setTime(NaN)).rejects.toMatchObject({ kind: "validation" });
    await flush();
    h.scene.firePostRender();
    await first;
    await flush();
    h.scene.firePostRender();
    await last;
    expect(h.snapshot().committedTimeMa).toBe(20);
  });

  it("starts on the globe, ready, with both plate-only flat modes available", () => {
    const { snapshot } = createHarness();
    const state = snapshot();
    expect(state.committedId).toBe("globe");
    expect(state.requestedId).toBe("globe");
    expect(state.status).toBe("ready");
    const mollweide = state.availableModes.find(
      (mode) => mode.projectionId === "mollweide",
    );
    expect(mollweide?.available).toBe(true);
    expect(mollweide?.reason).toBeUndefined();
  });

  it("switches to rectangle and commits only after a real render", async () => {
    const h = createHarness();
    const prep = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(prep.promise);

    const switching = h.controller.select("rectangle");
    // While preparing, the committed view is still globe and nothing has
    // morphed yet.
    await flush();
    expect(h.snapshot().status).toBe("preparing");
    expect(h.snapshot().committedId).toBe("globe");
    expect(h.scene.morphTo2D).not.toHaveBeenCalled();
    expect(h.renderer.commitRectangleFrame).not.toHaveBeenCalled();
    expect(h.host.captureGlobeCamera).not.toHaveBeenCalled();

    prep.resolve({ ...HANDLE });
    await flush();
    // The frame is staged and committed, but the promise has not settled until
    // a real render happens.
    expect(h.renderer.commitRectangleFrame).toHaveBeenCalledTimes(1);
    expect(h.host.captureGlobeCamera).toHaveBeenCalledTimes(1);
    h.scene.firePostRender();
    await switching;

    const state = h.snapshot();
    expect(state.committedId).toBe("rectangle");
    expect(state.status).toBe("ready");
    expect(state.revision).toBe(1);
    expect(h.scene.morphTo2D).toHaveBeenCalledWith(0);
    expect(h.host.setGlobeInertiaEnabled).toHaveBeenLastCalledWith(false);
  });

  it("returns to globe, restoring the globe frame and camera", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("rectangle"));

    const back = h.controller.select("globe");
    await flush();
    h.scene.firePostRender();
    await back;

    const state = h.snapshot();
    expect(state.committedId).toBe("globe");
    expect(state.revision).toBe(2);
    expect(h.renderer.restoreGlobeFrame).toHaveBeenCalledTimes(1);
    expect(h.host.applyGlobeFrame).toHaveBeenCalled();
    expect(h.scene.morphTo3D).toHaveBeenCalledWith(0);
    expect(h.host.restoreGlobeCamera).toHaveBeenCalledTimes(1);
    expect(h.host.setGlobeInertiaEnabled).toHaveBeenLastCalledWith(true);
  });

  it("commits Mollweide through the shared render-confirmed queue", async () => {
    const h = createHarness();
    const switching=h.controller.select("mollweide");
    await flush();
    expect(h.snapshot().committedId).toBe("globe");
    expect(h.renderer.prepareRectangleFrame).toHaveBeenLastCalledWith(100,h.host.rotationModel,"mollweide");
    h.scene.firePostRender();await switching;
    expect(h.snapshot().committedId).toBe("mollweide");
    const changing=h.controller.setTime(180);await flush();
    expect(h.snapshot().committedTimeMa).toBe(100);
    h.scene.firePostRender();await changing;
    expect(h.snapshot().committedTimeMa).toBe(180);
  });

  it("rejects an unknown projection id as a validation error", async () => {
    const h = createHarness();
    await expect(h.controller.select("cylinder")).rejects.toMatchObject({
      kind: "validation",
    });
  });

  it("refuses rectangle while an incompatible layer is visible and names it", async () => {
    const h = createHarness();
    h.setVisible([2]); // PBDB points
    await expect(h.controller.select("rectangle")).rejects.toMatchObject({
      kind: "unsupported",
    });
    // The committed view is untouched and the reason lists the layer.
    expect(h.snapshot().committedId).toBe("globe");
    expect(h.renderer.prepareRectangleFrame).not.toHaveBeenCalled();
    const rectangle = h
      .snapshot()
      .availableModes.find((mode) => mode.projectionId === "rectangle");
    expect(rectangle?.available).toBe(false);
    expect(rectangle?.reason).toMatch(/layer 2/);
  });

  it("applies the same visible-layer gate to Mollweide and reports its actual mode", async () => {
    const h = createHarness();
    h.setVisible([2]);
    await expect(h.controller.select("mollweide")).rejects.toMatchObject({ kind: "unsupported", message: expect.stringMatching(/Mollweide.*layer 2/) });
    expect(h.renderer.prepareRectangleFrame).not.toHaveBeenCalled();
    expect(h.snapshot().availableModes.filter(mode => mode.projectionId !== "globe").every(mode => !mode.available)).toBe(true);
    h.setVisible([]);
    await completeSwitch(h, h.controller.select("mollweide"));
    expect(() => h.controller.assertLayerMutationAllowed([{ id: 2, active: true, groupId: 101 }], [{ id: 101, active: true }])).toThrow(/Mollweide/);
  });

  it("allows rectangle once the incompatible layer is turned off", async () => {
    const h = createHarness();
    h.setVisible([2]);
    await expect(h.controller.select("rectangle")).rejects.toMatchObject({
      kind: "unsupported",
    });
    h.setVisible([]);
    await completeSwitch(h, h.controller.select("rectangle"));
    expect(h.snapshot().committedId).toBe("rectangle");
  });

  it("treats selecting the already-committed mode as a no-op", async () => {
    const h = createHarness();
    const result = await h.controller.select("globe");
    expect(result.revision).toBe(0);
    expect(h.scene.morphTo3D).not.toHaveBeenCalled();
    expect(h.renderer.commitRectangleFrame).not.toHaveBeenCalled();
  });

  it("confirms Globe time and counts only after the applied frame renders", async () => {
    const h = createHarness();
    h.host.applyGlobeFrame = vi.fn(() => ({ ...COUNTS, activePlateCount: 9 }));
    let completed = false;
    const change = h.controller.setTime(250).then(() => { completed = true; });
    await flush();
    expect(h.host.applyGlobeFrame).toHaveBeenCalledWith(250);
    expect(completed).toBe(false);
    expect(h.snapshot()).toMatchObject({
      status: "preparing", requestedTimeMa: 250, committedTimeMa: 100,
      committedTimeState: { activePlateCount: 3 },
    });
    expect(h.host.onCommittedTimeChange).not.toHaveBeenCalled();
    h.scene.firePostRender();
    await change;
    expect(h.snapshot()).toMatchObject({
      status: "ready", committedTimeMa: 250,
      committedTimeState: { activePlateCount: 9 },
    });
    expect(h.host.onCommittedTimeChange).toHaveBeenCalledExactlyOnceWith(250);
    expect(h.renderer.prepareRectangleFrame).not.toHaveBeenCalled();
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("keeps a Globe active frame progressing while replacing only pending ages", async () => {
    const h = createHarness();
    const committed: number[] = [];
    h.host.onCommittedTimeChange = age => { committed.push(age); };
    const active = h.controller.setTime(10).catch(error => error);
    const overwritten = h.controller.setTime(20).catch(error => error);
    const latest = h.controller.setTime(30).catch(error => error);
    expect(await overwritten).toMatchObject({ reason: "superseded" });
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 100, requestedTimeMa: 30, status: "preparing" });
    expect(h.host.applyGlobeFrame).toHaveBeenCalledExactlyOnceWith(10);
    h.scene.firePostRender();
    expect(await active).toBeUndefined();
    expect(committed).toEqual([10]);
    const final = h.controller.setTime(40).catch(error => error);
    h.scene.firePostRender();
    expect(await latest).toBeUndefined();
    expect(committed).toEqual([10, 30]);
    h.scene.firePostRender();
    expect(await final).toBeUndefined();
    expect(committed).toEqual([10, 30, 40]);
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 40, requestedTimeMa: 40, status: "ready" });
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("restores the committed Globe age after render failure and settles pending work before retry", async () => {
    const h = createHarness();
    let displayedAge = 100;
    h.host.applyGlobeFrame = vi.fn(age => { displayedAge = age; return COUNTS; });
    const active = h.controller.setTime(10).catch(error => error);
    const pending = h.controller.setTime(20).catch(error => error);
    await flush();
    h.scene.fireRenderError(new Error("Globe target draw failed"));
    await flush();
    expect(displayedAge).toBe(100);
    expect(h.snapshot().status).toBe("preparing");
    h.scene.firePostRender();
    expect(await active).toMatchObject({ message: "Globe target draw failed" });
    expect(await pending).toMatchObject({ message: "Globe target draw failed" });
    expect(displayedAge).toBe(100);
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 100, status: "error" });
    expect(h.host.onCommittedTimeChange).not.toHaveBeenCalled();
    expect(h.host.viewer.useDefaultRenderLoop).toBe(true);
    expect(h.scene.listenerCount()).toBe(0);
    const retry = h.controller.setTime(50);
    await flush();
    expect(h.snapshot().committedTimeMa).toBe(100);
    h.scene.firePostRender();
    await retry;
    expect(displayedAge).toBe(50);
    expect(h.snapshot()).toMatchObject({ committedTimeMa: 50, status: "ready" });
  });

  it.each(["source", "destroy", "mode"] as const)("invalidates unconfirmed Globe time on %s without late commits", async boundary => {
    const h = createHarness();
    let displayedAge = 100;
    h.host.applyGlobeFrame = vi.fn(age => { displayedAge = age; return COUNTS; });
    const active = h.controller.setTime(10).catch(error => error);
    const pending = h.controller.setTime(20).catch(error => error);
    await flush();
    let replacement: Promise<unknown> | undefined;
    if (boundary === "source") h.controller.invalidateSource();
    else if (boundary === "destroy") h.controller.destroy();
    else { h.setAge(60); replacement = h.controller.select("rectangle"); }
    expect(await active).toMatchObject({ reason: "superseded" });
    expect(await pending).toMatchObject({ reason: "superseded" });
    expect(displayedAge).toBe(100);
    expect(h.snapshot().committedTimeMa).toBe(100);
    if (replacement) await completeSwitch(h, replacement);
    h.scene.firePostRender();
    await flush();
    expect(h.snapshot().committedTimeMa).toBe(100);
    if (replacement) {
      expect(h.snapshot()).toMatchObject({ committedId: "rectangle", requestedTimeMa: 20 });
      expect(h.renderer.prepareRectangleFrame).toHaveBeenCalledWith(100, h.host.rotationModel, "rectangle");
    }
    expect(h.host.onCommittedTimeChange).not.toHaveBeenCalledWith(10);
    expect(h.host.onCommittedTimeChange).not.toHaveBeenCalledWith(20);
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("settles Globe teardown after the native scene is already destroyed without restoring into it", async () => {
    const h = createHarness();
    let destroyed = false;
    h.scene.isDestroyed = () => destroyed;
    h.host.applyGlobeFrame = age => {
      if (destroyed) throw new Error("Cannot update destroyed native resources");
      return { ...COUNTS, activePlateCount: age };
    };
    const active = h.controller.setTime(10).catch(error => error);
    const pending = h.controller.setTime(20).catch(error => error);
    destroyed = true;
    expect(() => h.controller.destroy()).not.toThrow();
    expect(await active).toMatchObject({ reason: "superseded" });
    expect(await pending).toMatchObject({ reason: "superseded" });
    expect(h.snapshot().committedTimeMa).toBe(100);
    expect(h.scene.listenerCount()).toBe(0);
  });

  it.each(["source", "destroy", "mode"] as const)("invalidates Globe work before a throwing %s rollback", async boundary => {
    const h = createHarness();
    const failure = new Error("Cannot restore the committed Globe frame");
    h.host.applyGlobeFrame = vi.fn(age => {
      if (age === 100) throw failure;
      return COUNTS;
    });
    let activeResult: unknown;
    let pendingResult: unknown;
    const active = h.controller.setTime(10).catch(error => { activeResult = error; });
    const pending = h.controller.setTime(20).catch(error => { pendingResult = error; });
    await flush();
    let boundaryError: unknown;
    try {
      if (boundary === "source") h.controller.invalidateSource();
      else if (boundary === "destroy") h.controller.destroy();
      else await h.controller.select("rectangle");
    } catch (error) { boundaryError = error; }
    expect(boundaryError).toBe(failure);
    h.scene.firePostRender();
    await flush();
    expect(h.snapshot()).toMatchObject({
      committedTimeMa: 100, status: "error",
      lastError: { kind: "internal", message: failure.message },
    });
    expect(activeResult).toMatchObject({ reason: "superseded" });
    expect(pendingResult).toMatchObject({ reason: "superseded" });
    await Promise.all([active, pending]);
    expect(h.scene.listenerCount()).toBe(0);
    expect(h.host.onCommittedTimeChange).not.toHaveBeenCalled();
    expect(h.renderer.prepareRectangleFrame).not.toHaveBeenCalled();
    if (boundary === "destroy") {
      vi.mocked(h.host.applyGlobeFrame).mockClear();
      await expect(h.controller.select("globe")).rejects.toMatchObject({ kind: "busy" });
      await expect(h.controller.setTime(30)).rejects.toMatchObject({ kind: "busy" });
      expect(h.host.applyGlobeFrame).not.toHaveBeenCalled();
      expect(h.scene.listenerCount()).toBe(0);
    }
  });

  it("permanently rejects time and projection entry points after destroy without native side effects", async () => {
    const h = createHarness();
    h.controller.destroy();
    h.renderer.cancelRectanglePreparation.mockClear();
    h.scene.requestRender.mockClear();
    await expect(h.controller.select("globe")).rejects.toMatchObject({ kind: "busy" });
    await expect(h.controller.select("rectangle")).rejects.toMatchObject({ kind: "busy" });
    await expect(h.controller.setTime(200)).rejects.toMatchObject({ kind: "busy" });
    expect(h.host.applyGlobeFrame).not.toHaveBeenCalled();
    expect(h.renderer.prepareRectangleFrame).not.toHaveBeenCalled();
    expect(h.renderer.cancelRectanglePreparation).not.toHaveBeenCalled();
    expect(h.scene.requestRender).not.toHaveBeenCalled();
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("keeps destroyed entry points closed and reports a native cleanup failure", async () => {
    const h = createHarness();
    const active = h.controller.setTime(10).catch(error => error);
    const pending = h.controller.setTime(20).catch(error => error);
    const failure = new Error("Native preparation cleanup failed");
    h.renderer.cancelRectanglePreparation.mockImplementationOnce(() => { throw failure; });
    expect(() => h.controller.destroy()).toThrow(failure);
    expect(await active).toMatchObject({ reason: "superseded" });
    expect(await pending).toMatchObject({ reason: "superseded" });
    expect(h.snapshot()).toMatchObject({
      committedTimeMa: 100, status: "error",
      lastError: { kind: "internal", message: failure.message },
    });
    vi.mocked(h.host.applyGlobeFrame).mockClear();
    await expect(h.controller.setTime(30)).rejects.toMatchObject({ kind: "busy" });
    await expect(h.controller.select("globe")).rejects.toMatchObject({ kind: "busy" });
    h.scene.firePostRender();
    await flush();
    expect(h.snapshot().committedTimeMa).toBe(100);
    expect(h.host.applyGlobeFrame).not.toHaveBeenCalled();
    expect(h.scene.listenerCount()).toBe(0);
  });

  it("prepares and commits a new rectangle frame on a time change", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("rectangle"));
    h.setAge(200);
    h.renderer.prepareRectangleFrame.mockClear();
    const prep = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(prep.promise);

    const changing = h.controller.setTime(200);
    await flush();
    // The old committed picture is kept while the new frame is prepared.
    expect(h.snapshot().status).toBe("preparing");
    expect(h.snapshot().committedTimeMa).toBe(100);

    prep.resolve({ ...HANDLE, timeMa: 200 });
    await flush();
    h.scene.firePostRender();
    await changing;

    expect(h.renderer.prepareRectangleFrame).toHaveBeenCalledWith(
      200,
      h.host.rotationModel,
      "rectangle",
    );
    expect(h.renderer.commitRectangleFrame).toHaveBeenCalledTimes(2);
    expect(h.snapshot().committedTimeMa).toBe(200);
    expect(h.snapshot().status).toBe("ready");
  });

  it("settles a superseded selection explicitly and lets the newest win", async () => {
    const h = createHarness();
    const prep = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(prep.promise);

    const first = h.controller.select("rectangle");
    const stale = expect(first).rejects.toMatchObject({ reason: "superseded" });
    await flush();
    expect(h.snapshot().status).toBe("preparing");

    // A newer request (globe) supersedes the pending rectangle switch.
    const second = h.controller.select("globe");
    await flush();
    h.scene.firePostRender();
    await second;
    expect(h.snapshot().committedId).toBe("globe");

    // Cancellation now settles even before CPU returns; a late result must
    // still never commit.
    prep.resolve({ ...HANDLE });
    await flush();
    await stale;
    expect(h.snapshot().committedId).toBe("globe");
    expect(h.renderer.commitRectangleFrame).not.toHaveBeenCalled();
  });

  it("applies a mid-switch age change to the pending rectangle target (globe->rect)", async () => {
    const h = createHarness();
    h.setAge(30);
    const prep = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(prep.promise);
    const switching = h.controller.select("rectangle");
    const switchingSettled = switching.then(
      () => "ok",
      (error) => error,
    );
    await flush();
    // The switch commits the plate and morphs, then parks on its render wait;
    // committedId is still globe in that window.
    prep.resolve({ ...HANDLE, timeMa: 30 });
    await flush();
    expect(h.scene.morphTo2D).toHaveBeenCalledWith(0);
    expect(h.snapshot().committedId).toBe("globe");

    // A time change lands before the confirmation render: it must inherit the
    // rectangle target (activeMode), not the stale committed globe.
    const prep2 = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(prep2.promise);
    const ageChange = h.controller.setTime(80);
    await flush();
    prep2.resolve({ ...HANDLE, timeMa: 80 });
    await flush();
    h.scene.firePostRender();
    await ageChange;

    const superseded = await switchingSettled;
    expect(superseded).toMatchObject({ reason: "superseded" });
    const state = h.snapshot();
    expect(state.committedId).toBe("rectangle");
    expect(state.committedTimeMa).toBe(80);
    expect(h.scene.morphTo3D).not.toHaveBeenCalled();
  });

  it("applies a mid-switch age change to the pending globe target (rect->globe)", async () => {
    const h = createHarness();
    h.setAge(30);
    await completeSwitch(h, h.controller.select("rectangle"));
    expect(h.snapshot().committedId).toBe("rectangle");

    // Start returning to globe; it morphs to 3D and parks on its render wait
    // with committedId still rectangle.
    const back = h.controller.select("globe");
    const backSettled = back.then(
      () => "ok",
      (error) => error,
    );
    await flush();
    expect(h.scene.morphTo3D).toHaveBeenCalledWith(0);
    expect(h.snapshot().committedId).toBe("rectangle");

    // A time change during that window must complete the globe target.
    const ageChange = h.controller.setTime(80);
    await flush();
    h.scene.firePostRender();
    await ageChange;

    const superseded = await backSettled;
    expect(superseded).toMatchObject({ reason: "superseded" });
    const state = h.snapshot();
    expect(state.committedId).toBe("globe");
    expect(state.committedTimeMa).toBe(80);
    // morphTo2D ran only for the initial rectangle switch, never again for the
    // globe-target age change; morphTo3D is what moved the scene back.
    expect(h.scene.morphTo2D).toHaveBeenCalledTimes(1);
    expect(h.scene.morphTo3D).toHaveBeenCalledWith(0);
    expect(h.host.applyGlobeFrame).toHaveBeenLastCalledWith(80);
  });

  it("rejects a parked render waiter immediately on destroy, without a frame", async () => {
    const h = createHarness();
    const prep = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(prep.promise);
    const switching = h.controller.select("rectangle");
    const settled = switching.then(
      () => "ok",
      (error) => error,
    );
    await flush();
    prep.resolve({ ...HANDLE });
    await flush(); // parked on the confirmation render

    h.controller.destroy(); // must reject now, no postRender fired
    expect(await settled).toMatchObject({ reason: "superseded" });
  });

  it("recovers the real globe mode after a rectangle confirmation renderError", async () => {
    const h = createHarness(); // committed globe at 100 Ma
    const prep = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(prep.promise);
    const switching = h.controller.select("rectangle");
    const settled = switching.then(
      () => "ok",
      (error) => error,
    );
    await flush();
    prep.resolve({ ...HANDLE, timeMa: 80 });
    await flush(); // plate committed + morphed to 2D, parked on the render wait
    expect(h.scene.morphTo2D).toHaveBeenCalledWith(0);

    // The confirmation render fails.
    h.scene.fireRenderError(new Error("gl boom"));
    const failure = await settled;
    expect((failure as Error).message).toMatch(/gl boom/);
    const errored = h.snapshot();
    expect(errored.status).toBe("error");
    expect(errored.committedId).toBe("globe"); // never committed
    expect(errored.committedTimeMa).toBe(100); // failed frame's time NOT committed
    expect(h.controller.sceneMode).toBe("rectangle"); // scene actually 2D

    // Selecting globe must NOT no-op: it re-applies and morphs back to 3D.
    const back = h.controller.select("globe");
    await flush();
    h.scene.firePostRender();
    await back;
    const recovered = h.snapshot();
    expect(recovered.committedId).toBe("globe");
    expect(recovered.status).toBe("ready");
    expect(h.scene.morphTo3D).toHaveBeenCalledWith(0);
    expect(h.renderer.restoreGlobeFrame).toHaveBeenCalled();
    expect(h.controller.sceneMode).toBe("globe");
  });

  it("recovers the real rectangle mode after a globe-return confirmation renderError", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("rectangle"));
    expect(h.snapshot().committedId).toBe("rectangle");

    const back = h.controller.select("globe");
    const settled = back.then(
      () => "ok",
      (error) => error,
    );
    await flush(); // morphed to 3D, parked on the render wait
    expect(h.scene.morphTo3D).toHaveBeenCalledWith(0);

    h.scene.fireRenderError(new Error("gl boom 2"));
    const failure = await settled;
    expect((failure as Error).message).toMatch(/gl boom 2/);
    const errored = h.snapshot();
    expect(errored.status).toBe("error");
    expect(errored.committedId).toBe("rectangle"); // globe never committed
    expect(h.controller.sceneMode).toBe("globe"); // scene actually 3D

    // Selecting rectangle must NOT no-op: it re-applies and morphs to 2D.
    const again = h.controller.select("rectangle");
    await flush();
    h.scene.firePostRender();
    await again;
    const recovered = h.snapshot();
    expect(recovered.committedId).toBe("rectangle");
    expect(recovered.status).toBe("ready");
    expect(h.controller.sceneMode).toBe("rectangle");
    expect(h.scene.morphTo2D).toHaveBeenCalledTimes(2); // initial + recovery
  });

  it("restarts CesiumWidget's stopped render loop on an explicit retry", async () => {
    const h = createHarness();
    h.host.viewer.useDefaultRenderLoop = false;
    const switching = h.controller.select("mollweide");
    await flush();
    expect(h.host.viewer.useDefaultRenderLoop).toBe(true);
    expect(h.snapshot().committedId).toBe("globe");
    h.scene.firePostRender();
    await switching;
    expect(h.snapshot().committedId).toBe("mollweide");
  });

  it("keeps the committed globe and reports an error when staging fails", async () => {
    const h = createHarness();
    h.renderer.stageRectangleFrame.mockRejectedValueOnce(
      new Error("shader compile failed"),
    );
    await expect(h.controller.select("rectangle")).rejects.toThrow(
      /shader compile failed/,
    );
    const state = h.snapshot();
    expect(state.committedId).toBe("globe");
    expect(state.status).toBe("error");
    expect(state.lastError?.kind).toBe("internal");
    expect(state.requestedId).toBe("globe");
    expect(h.scene.morphTo2D).not.toHaveBeenCalled();
    expect(h.host.captureGlobeCamera).not.toHaveBeenCalled();
    expect(h.host.setGlobeInertiaEnabled).toHaveBeenLastCalledWith(true);
  });

  it("refuses a layer mutation that would effective-show an incompatible layer in rectangle", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("rectangle"));
    const groups = [
      { id: 101, active: true },
      { id: 102, active: true },
    ];
    expect(() =>
      h.controller.assertLayerMutationAllowed(
        [
          { id: 2, active: true, groupId: 101 },
          { id: 4, active: true, groupId: 102 },
        ],
        groups,
      ),
    ).toThrow(/layer 2|Rectangle/);
    expect(() =>
      h.controller.assertLayerMutationAllowed(
        [{ id: 2, active: false, groupId: 101 }],
        groups,
      ),
    ).not.toThrow();
    expect(() =>
      h.controller.assertLayerMutationAllowed(
        [{ id: 4, active: true, groupId: 102 }],
        groups,
      ),
    ).not.toThrow();
  });

  it("treats a child active under a hidden group as not shown", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("rectangle"));
    const childActive = [{ id: 1, active: true, groupId: 101 }];
    expect(() =>
      h.controller.assertLayerMutationAllowed(childActive, [
        { id: 101, active: true },
      ]),
    ).toThrow(/layer 1|atlas|Rectangle/i);
    expect(() =>
      h.controller.assertLayerMutationAllowed(childActive, [
        { id: 101, active: false },
      ]),
    ).not.toThrow();
    expect(() =>
      h.controller.assertLayerMutationAllowed(
        [{ id: 1, active: false, groupId: 101 }],
        [{ id: 101, active: true }],
      ),
    ).not.toThrow();
  });

  it("uses every ancestor when guarding nested group edits", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("rectangle"));
    const layers = [{ id: 2, active: true, groupId: 104 }];
    const groups = [
      { id: 101, active: false },
      { id: 103, active: true, parentId: 101 },
      { id: 104, active: true, parentId: 103 },
    ];
    expect(() => h.controller.assertLayerMutationAllowed(layers, groups)).not.toThrow();
    expect(() => h.controller.assertLayerMutationAllowed(layers, groups.map(group => ({ ...group, active: true })))).toThrow(/layer 2|Rectangle/);
    expect(() => h.controller.assertLayerMutationAllowed(layers, groups.map(group => group.id === 103 ? { ...group, parentId: undefined } : group))).toThrow(/layer 2|Rectangle/);
  });

  it("guards layer mutations while a rectangle switch is still pending", async () => {
    const h = createHarness();
    const prep = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(prep.promise);
    const switching = h.controller.select("rectangle");
    await flush();
    expect(h.controller.activeMode).toBe("rectangle");
    expect(h.snapshot().committedId).toBe("globe");
    expect(() =>
      h.controller.assertLayerMutationAllowed(
        [{ id: 2, active: true, groupId: 101 }],
        [{ id: 101, active: true }],
      ),
    ).toThrow(/layer 2|Rectangle/);

    prep.resolve({ ...HANDLE });
    await flush();
    h.scene.firePostRender();
    await switching;
  });

  it.each(["rectangle", "mollweide"] as const)("keeps the %s layer constraint until a return to Globe really commits", async (previous) => {
    const h = createHarness(true);
    await completeSwitch(h, h.controller.select(previous));
    const before = h.snapshot();
    const layers = [{ id: 2, active: true, groupId: 104 }];
    const groups = [
      { id: 101, active: false },
      { id: 103, active: true, parentId: 101 },
      { id: 104, active: true, parentId: 103 },
    ];
    const exposedGroups = groups.map(group => group.id === 103 ? { ...group, parentId: undefined } : group);
    const constraint = previous === "mollweide" ? /Mollweide/ : /Rectangle/;
    const abort = new AbortController();
    let settled = false;
    const returning = h.controller.select("globe", { signal: abort.signal }).catch(error => error).then(value => { settled = true; return value; });
    try {
      await flush();
      expect(h.controller.sceneMode).toBe("globe");
      expect(h.snapshot()).toMatchObject({ committedId: previous, requestedId: "globe", status: "preparing" });
      expect(() => h.controller.assertLayerMutationAllowed(layers, groups)).not.toThrow();
      expect(() => h.controller.assertLayerMutationAllowed(layers, exposedGroups)).toThrow(constraint);

      abort.abort();
      await flush();
      expect(settled).toBe(false);
      expect(h.controller.sceneMode).toBe(previous);
      expect(h.snapshot().camera).toEqual(before.camera);
      expect(() => h.controller.assertLayerMutationAllowed(layers, exposedGroups)).toThrow(constraint);
      h.scene.firePostRender();
      expect(await returning).toMatchObject({ reason: "cancelled" });
      expect(h.snapshot()).toMatchObject({ committedId: previous, requestedId: previous, revision: before.revision, status: "ready" });
      expect(() => h.controller.assertLayerMutationAllowed(layers, groups)).not.toThrow();

      const retry = h.controller.select("globe");
      expect(() => h.controller.assertLayerMutationAllowed(layers, exposedGroups)).toThrow(constraint);
      await completeSwitch(h, retry);
      expect(h.snapshot()).toMatchObject({ committedId: "globe", status: "ready" });
      expect(() => h.controller.assertLayerMutationAllowed(layers, exposedGroups)).not.toThrow();
    } finally { h.controller.destroy(); await returning; }
  });

  it("does not guard layer mutations on the globe path", () => {
    const h = createHarness();
    expect(() =>
      h.controller.assertLayerMutationAllowed(
        [{ id: 2, active: true, groupId: 101 }],
        [{ id: 101, active: true }],
      ),
    ).not.toThrow();
  });

  it("blocks globe-only data creation during either direction of a projection transition", async () => {
    const h = createHarness();
    expect(() => h.controller.assertGlobeRuntimeAvailable()).not.toThrow();
    const away = h.controller.select("rectangle");
    expect(() => h.controller.assertGlobeRuntimeAvailable()).toThrow();
    await completeSwitch(h, away);
    expect(() => h.controller.assertGlobeRuntimeAvailable()).toThrow();
    const back = h.controller.select("globe");
    expect(() => h.controller.assertGlobeRuntimeAvailable()).toThrow();
    await completeSwitch(h, back);
    expect(() => h.controller.assertGlobeRuntimeAvailable()).not.toThrow();
    h.controller.invalidateSource();
    expect(() => h.controller.assertGlobeRuntimeAvailable()).toThrow();
  });

  it("homes to the full map in rectangle and to the globe view otherwise", async () => {
    const h = createHarness();
    h.controller.home();
    expect(h.host.globeHome).toHaveBeenCalledTimes(1);

    await completeSwitch(h, h.controller.select("rectangle"));
    h.controller.home();
    expect(
      (h.host.viewer as unknown as { camera: { setView: ReturnType<typeof vi.fn> } })
        .camera.setView,
    ).toHaveBeenCalled();
  });

  it("exposes the committed mode for the persistence guard", async () => {
    const h = createHarness();
    expect(h.controller.committedMode).toBe("globe");
    await completeSwitch(h, h.controller.select("rectangle"));
    expect(h.controller.committedMode).toBe("rectangle");
  });

  it("publishes a safe snapshot with no GPU objects", () => {
    const h = createHarness();
    const serialized = JSON.stringify(h.snapshot());
    expect(serialized).not.toMatch(/GeometryInstance|Float64Array/);
    expect(h.host.onStateChange).toHaveBeenCalled();
  });

  it("republishes availability when external effective visibility flips", () => {
    const h = createHarness();
    h.setVisible([2]); // PBDB points effective-visible: rectangle blocked
    const before = h.snapshot();
    expect(
      before.availableModes.find((m) => m.projectionId === "rectangle")?.available,
    ).toBe(false);
    const sink = h.stateSink;
    sink.mockClear();

    // The group/layer toggle that hides the blocking layer happens outside the
    // controller; the app refreshes the capabilities so the UI sink learns the
    // new availability without a reload.
    h.setVisible([]);
    h.controller.refreshCapabilities();

    expect(sink).toHaveBeenCalledTimes(1);
    const after = sink.mock.calls[0]?.[0] as ProjectionSnapshot;
    const rectangle = after.availableModes.find(
      (m) => m.projectionId === "rectangle",
    );
    expect(rectangle?.available).toBe(true);
    expect(rectangle?.reason).toBeUndefined();
    // Availability only: no new request, no mode/time/revision change, no frame.
    expect(after.committedId).toBe(before.committedId);
    expect(after.requestedId).toBe(before.requestedId);
    expect(after.status).toBe("ready");
    expect(after.committedTimeMa).toBe(before.committedTimeMa);
    expect(after.revision).toBe(before.revision);
    expect(h.renderer.prepareRectangleFrame).not.toHaveBeenCalled();
    expect(h.renderer.stageRectangleFrame).not.toHaveBeenCalled();
    expect(h.renderer.commitRectangleFrame).not.toHaveBeenCalled();
    expect(h.renderer.restoreGlobeFrame).not.toHaveBeenCalled();
    expect(h.scene.morphTo2D).not.toHaveBeenCalled();
    expect(h.scene.morphTo3D).not.toHaveBeenCalled();
    expect(h.host.applyGlobeFrame).not.toHaveBeenCalled();
    expect(h.host.onCommittedTimeChange).not.toHaveBeenCalled();

    // And back: the same refresh reports the blocked state with its reason.
    h.setVisible([2]);
    h.controller.refreshCapabilities();
    const blocked = sink.mock.calls[1]?.[0] as ProjectionSnapshot;
    const blockedRectangle = blocked.availableModes.find(
      (m) => m.projectionId === "rectangle",
    );
    expect(blockedRectangle?.available).toBe(false);
    expect(blockedRectangle?.reason).toMatch(/layer 2/);
    expect(blocked.revision).toBe(before.revision);
    expect(blocked.status).toBe("ready");
  });

  it("refreshes availability for a group-driven visibility change in rectangle", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("rectangle"));
    h.renderer.prepareRectangleFrame.mockClear();
    h.renderer.commitRectangleFrame.mockClear();
    const sink = h.stateSink;
    sink.mockClear();

    // A group toggle effective-shows an incompatible layer underneath the
    // committed rectangle view; the refresh reports it without moving the view.
    h.setVisible([2]);
    h.controller.refreshCapabilities();

    expect(sink).toHaveBeenCalledTimes(1);
    const state = sink.mock.calls[0]?.[0] as ProjectionSnapshot;
    expect(
      state.availableModes.find((m) => m.projectionId === "rectangle")?.available,
    ).toBe(false);
    expect(state.committedId).toBe("rectangle");
    expect(state.status).toBe("ready");
    expect(state.revision).toBe(1);
    expect(h.renderer.prepareRectangleFrame).not.toHaveBeenCalled();
    expect(h.renderer.commitRectangleFrame).not.toHaveBeenCalled();
    expect(h.scene.morphTo3D).not.toHaveBeenCalled();
  });
});

describe("ProjectionController lifecycle render errors", () => {
  it("surfaces an idle render failure and clears it only after an explicit recovered render", () => {
    const h = createHarness();
    h.scene.fireRenderError(new Error("idle native frame failed"));
    expect(h.snapshot()).toMatchObject({
      status: "error",
      lastError: { message: "idle native frame failed" },
    });
    // No transaction owns this error, so no later frame may clear it silently.
    h.scene.firePostRender();
    expect(h.snapshot().status).toBe("error");
    h.controller.confirmRenderRecovered();
    expect(h.snapshot()).toMatchObject({ status: "ready", lastError: undefined });
  });

  it("keeps a different failure when an explicit recovery completes", () => {
    const h = createHarness();
    h.scene.fireRenderError(new Error("idle native frame failed"));
    h.controller.invalidateSource();
    expect(h.snapshot().lastError?.kind).toBe("busy");
    h.controller.confirmRenderRecovered();
    expect(h.snapshot().status).toBe("error");
    expect(h.snapshot().lastError?.kind).toBe("busy");
  });

  it("detaches the lifecycle listener on destroy and ignores later errors", () => {
    const h = createHarness();
    expect(h.scene.lifecycleListenerCount()).toBe(1);
    h.controller.destroy();
    expect(h.scene.lifecycleListenerCount()).toBe(0);
    h.scene.fireRenderError(new Error("late"));
    expect(h.snapshot().status).not.toBe("error");
  });
});
