// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

import {
  ProjectionController,
  type ProjectionHost,
  type ProjectionSnapshot,
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
  firePostRender: () => void;
  fireRenderError: (error: unknown) => void;
}

function createFakeScene(): FakeScene {
  const listeners = new Set<() => void>();
  const errorListeners = new Set<(scene: unknown, error: unknown) => void>();
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
        errorListeners.add(fn);
        return () => {
          errorListeners.delete(fn);
        };
      },
    },
    isDestroyed: () => false,
    listenerCount: () => listeners.size + errorListeners.size,
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
  };
  setAge: (age: number) => void;
  setVisible: (ids: number[]) => void;
  /** The controller's UI sink, kept as the mock so a refresh can be inspected. */
  stateSink: ReturnType<typeof vi.fn>;
  snapshot: () => ProjectionSnapshot;
}

function createHarness(): Harness {
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

describe("ProjectionController", () => {
  it("commits intermediate ages during continuous input, coalescing only pending work", async () => {
    const h = createHarness();
    await completeSwitch(h, h.controller.select("rectangle"));
    h.renderer.prepareRectangleFrame.mockClear();
    const committed: number[] = [];
    h.host.onCommittedTimeChange = (age) => { committed.push(age); };
    const active = h.controller.setTime(10);
    const overwritten = h.controller.setTime(20).catch((error) => error);
    const latest = h.controller.setTime(30);
    expect(await overwritten).toMatchObject({ kind: "busy" });
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
      h.setVisible([]);
      await completeSwitch(h, h.controller.select("rectangle"));
      const retry = h.controller.setTime(50);
      await flush();
      h.scene.firePostRender();
      await retry;
      expect(h.snapshot()).toMatchObject({ committedTimeMa: 50, status: "ready" });
    },
  );

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

  it("starts on the globe, ready, with Mollweide unavailable", () => {
    const { snapshot } = createHarness();
    const state = snapshot();
    expect(state.committedId).toBe("globe");
    expect(state.requestedId).toBe("globe");
    expect(state.status).toBe("ready");
    const mollweide = state.availableModes.find(
      (mode) => mode.projectionId === "mollweide",
    );
    expect(mollweide?.available).toBe(false);
    expect(mollweide?.reason).toMatch(/not implemented/i);
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

    prep.resolve({ ...HANDLE });
    await flush();
    // The frame is staged and committed, but the promise has not settled until
    // a real render happens.
    expect(h.renderer.commitRectangleFrame).toHaveBeenCalledTimes(1);
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

  it("rejects Mollweide as unsupported without touching the view", async () => {
    const h = createHarness();
    await expect(h.controller.select("mollweide")).rejects.toMatchObject({
      kind: "unsupported",
    });
    expect(h.snapshot().committedId).toBe("globe");
    expect(h.scene.morphTo2D).not.toHaveBeenCalled();
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

  it("runs the globe time fast path synchronously", async () => {
    const h = createHarness();
    await h.controller.setTime(250);
    expect(h.host.applyGlobeFrame).toHaveBeenCalledWith(250);
    expect(h.snapshot().committedTimeMa).toBe(250);
    expect(h.renderer.prepareRectangleFrame).not.toHaveBeenCalled();
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
    );
    expect(h.renderer.commitRectangleFrame).toHaveBeenCalledTimes(2);
    expect(h.snapshot().committedTimeMa).toBe(200);
    expect(h.snapshot().status).toBe("ready");
  });

  it("settles a superseded request as busy and lets the newest win", async () => {
    const h = createHarness();
    const prep = deferred<typeof HANDLE>();
    h.renderer.prepareRectangleFrame.mockReturnValueOnce(prep.promise);

    const first = h.controller.select("rectangle");
    await flush();
    expect(h.snapshot().status).toBe("preparing");

    // A newer request (globe) supersedes the pending rectangle switch.
    const second = h.controller.select("globe");
    await flush();
    h.scene.firePostRender();
    await second;
    expect(h.snapshot().committedId).toBe("globe");

    // Attach the stale rejection handler before it settles, then let the stale
    // preparation resolve: it must settle as busy, never commit.
    const stale = expect(first).rejects.toMatchObject({ kind: "busy" });
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
    expect(superseded).toMatchObject({ kind: "busy" });
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
    expect(superseded).toMatchObject({ kind: "busy" });
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
    expect(await settled).toMatchObject({ kind: "busy" });
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

  it("does not guard layer mutations on the globe path", () => {
    const h = createHarness();
    expect(() =>
      h.controller.assertLayerMutationAllowed(
        [{ id: 2, active: true, groupId: 101 }],
        [{ id: 101, active: true }],
      ),
    ).not.toThrow();
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
