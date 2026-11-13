// @vitest-environment jsdom

import {
  Geometry,
  Matrix4,
  PolylineCollection,
  PrimitiveCollection,
  type Viewer,
} from "cesium";
import { describe, expect, it, vi } from "vitest";

import {
  IDENTITY_QUATERNION,
  type PlateFeature,
  type Quaternion,
  type RotationModel,
} from "@timemachine/reconstruction-core";
import {
  PlateRenderer,
  type PreparedRectanglePlateFrame,
  type RenderTimeState,
} from "@timemachine/cesium-runtime";
import type { RectanglePlateCpuFrame } from "../../packages/cesium-runtime/src/plate-rectangle-frame";

// jsdom lacks these browser globals; Cesium's Material only needs the
// constructors to exist when it resolves uniform types.
for (const globalName of ["ImageBitmap", "OffscreenCanvas"]) {
  if (typeof (globalThis as Record<string, unknown>)[globalName] === "undefined") {
    (globalThis as Record<string, unknown>)[globalName] = class {};
  }
}

/** Polygons per preparation; above the builder's batch size so it yields. */
const POLYGON_COUNT = 10;

interface PreparationSlot {
  handle: PreparedRectanglePlateFrame;
  data: RectanglePlateCpuFrame;
}

function createFeature(id: string, plateId: number): PlateFeature {
  const exterior: [number, number][] = [
    [0, 0],
    [12, 0],
    [12, 12],
    [0, 12],
  ];
  return {
    id,
    plateId,
    name: id,
    description: "",
    validFromMa: 100,
    validToMa: 0,
    polygons: [{ exterior, holes: [] }],
    sourceIndex: 0,
  };
}

function createFeatures(plateId: number): PlateFeature[] {
  const features: PlateFeature[] = [];
  for (let index = 0; index < POLYGON_COUNT; index += 1) {
    features.push(createFeature(`plate-a-${index}`, plateId));
  }
  return features;
}

function createRotationModel(
  rotations: ReadonlyMap<number, Quaternion>,
): RotationModel {
  return { getRotationMap: () => rotations } as unknown as RotationModel;
}

function createFakeViewer(): {
  viewer: Viewer;
  primitives: PrimitiveCollection;
  added: unknown[];
} {
  const canvas = document.createElement("canvas");
  const primitives = new PrimitiveCollection();
  const added: unknown[] = [];
  primitives.add = ((primitive: unknown) => {
    added.push(primitive);
    return PrimitiveCollection.prototype.add.call(primitives, primitive);
  }) as typeof primitives.add;
  const viewer = {
    scene: {
      canvas,
      primitives,
      requestRender: () => undefined,
      pick: () => undefined,
      isDestroyed: () => false,
    },
    isDestroyed: () => false,
  };
  return { viewer: viewer as unknown as Viewer, primitives, added };
}

/** Minimal read-only view of the renderer's private preparation slot. */
function readPreparationSlot(
  renderer: PlateRenderer,
): PreparationSlot | undefined {
  return (renderer as unknown as { rectanglePreparation?: PreparationSlot })
    .rectanglePreparation;
}

/** Minimal read-only view of the renderer's pending preparation controller. */
function readPreparationController(
  renderer: PlateRenderer,
): AbortController | undefined {
  return (
    renderer as unknown as {
      rectanglePreparationController?: AbortController;
    }
  ).rectanglePreparationController;
}

/** Snapshot of everything the committed globe frame owns right now. */
function captureCommittedState(viewer: {
  primitives: PrimitiveCollection;
  added: unknown[];
}): unknown {
  return {
    primitiveCount: viewer.primitives.length,
    show: viewer.added.map(
      (primitive) => (primitive as { show: boolean }).show,
    ),
    modelMatrices: viewer.added.map((primitive) => {
      const modelMatrix = (primitive as { modelMatrix?: Matrix4 }).modelMatrix;
      return modelMatrix ? Array.from(modelMatrix) : undefined;
    }),
  };
}

async function createRenderer(): Promise<{
  renderer: PlateRenderer;
  viewer: Viewer;
  primitives: PrimitiveCollection;
  added: unknown[];
}> {
  const { viewer, primitives, added } = createFakeViewer();
  const renderer = await PlateRenderer.create(viewer, createFeatures(101));
  return { renderer, viewer, primitives, added };
}

describe("rectangle plate preparation lifecycle", () => {
  it("prepares a handle that exposes accounting only", async () => {
    const { renderer, primitives, added } = await createRenderer();
    const model = createRotationModel(
      new Map([[101, IDENTITY_QUATERNION]]),
    );
    const before = captureCommittedState({ primitives, added });

    const handle = await renderer.prepareRectangleFrame(50, model);

    expect(handle.generation).toBe(1);
    expect(handle.timeMa).toBe(50);
    expect(handle.timeState).toEqual({
      activeFeatureCount: POLYGON_COUNT,
      activePlateCount: 1,
      disconnectedFeatureCount: 0,
    });
    expect(Object.keys(handle).sort()).toEqual([
      "generation",
      "stats",
      "timeMa",
      "timeState",
    ]);
    // No geometry, matrix or buffer leaks through the public handle.
    for (const value of Object.values(handle)) {
      expect(value).not.toBeInstanceOf(Geometry);
      expect(ArrayBuffer.isView(value)).toBe(false);
    }
    expect(Object.keys(handle.stats).sort()).toEqual([
      "outlinePointCount",
      "outlineRingCount",
      "plateCount",
      "polygonCount",
      "prepareMs",
      "triangleCount",
      "vertexCount",
      "workingIndexByteLength",
      "workingPositionByteLength",
    ]);
    expect(handle.stats.polygonCount).toBe(POLYGON_COUNT);
    expect(handle.stats.prepareMs).toBeGreaterThanOrEqual(0);

    // The data itself stays in the renderer's private slot.
    const slot = readPreparationSlot(renderer);
    expect(slot?.handle).toBe(handle);
    expect(slot?.data.plates).toHaveLength(1);
    expect(slot?.data.plates[0]!.polygons[0]!.geometry).toBeInstanceOf(
      Geometry,
    );
    // Preparation is not a commit: the displayed frame is untouched.
    expect(captureCommittedState({ primitives, added })).toEqual(before);

    renderer.destroy();
  });

  it("supersedes a pending preparation and keeps only the newest frame", async () => {
    vi.useFakeTimers();
    try {
      const { renderer } = await createRenderer();
      const model = createRotationModel(
        new Map([[101, IDENTITY_QUATERNION]]),
      );

      const first = renderer.prepareRectangleFrame(50, model);
      const second = renderer.prepareRectangleFrame(60, model);

      await expect(first).rejects.toThrow(/aborted/i);
      await vi.advanceTimersByTimeAsync(10);
      const handle = await second;

      expect(handle.generation).toBe(2);
      expect(handle.timeMa).toBe(60);
      expect(readPreparationSlot(renderer)?.handle).toBe(handle);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles the pending promise and clears the slot on an explicit cancel", async () => {
    vi.useFakeTimers();
    try {
      const { renderer } = await createRenderer();
      const model = createRotationModel(
        new Map([[101, IDENTITY_QUATERNION]]),
      );

      const pending = renderer.prepareRectangleFrame(50, model);
      renderer.cancelRectanglePreparation();
      await expect(pending).rejects.toThrow(/aborted/i);
      expect(readPreparationSlot(renderer)).toBeUndefined();

      // A later preparation still works after a cancel.
      const second = renderer.prepareRectangleFrame(50, model);
      await vi.advanceTimersByTimeAsync(10);
      const handle = await second;
      expect(handle.generation).toBe(2);
      expect(readPreparationSlot(renderer)?.handle).toBe(handle);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles a failed preparation without touching the committed frame", async () => {
    const { renderer, primitives, added } = await createRenderer();
    const before = captureCommittedState({ primitives, added });
    const broken = {
      getRotationMap: (): ReadonlyMap<number, Quaternion> => {
        throw new Error("rotation model exploded");
      },
    } as unknown as RotationModel;

    await expect(
      renderer.prepareRectangleFrame(50, broken),
    ).rejects.toThrow(/rotation model exploded/);
    expect(readPreparationSlot(renderer)).toBeUndefined();
    expect(captureCommittedState({ primitives, added })).toEqual(before);

    renderer.destroy();
  });

  it("clears the pending controller when the rotation model fails", async () => {
    // A failed preparation must not leave a stale pending controller behind:
    // that would make the renderer look like a preparation is still in flight.
    const { renderer } = await createRenderer();
    const broken = {
      getRotationMap: (): ReadonlyMap<number, Quaternion> => {
        throw new Error("rotation model exploded");
      },
    } as unknown as RotationModel;

    await expect(
      renderer.prepareRectangleFrame(50, broken),
    ).rejects.toThrow(/rotation model exploded/);
    expect(readPreparationController(renderer)).toBeUndefined();
    expect(readPreparationSlot(renderer)).toBeUndefined();

    renderer.destroy();
  });

  it("keeps a newer pending preparation registered when an older one settles", async () => {
    vi.useFakeTimers();
    try {
      const { renderer } = await createRenderer();
      const model = createRotationModel(
        new Map([[101, IDENTITY_QUATERNION]]),
      );

      const first = renderer.prepareRectangleFrame(50, model);
      const second = renderer.prepareRectangleFrame(60, model);
      // The superseded request settles while the newer one is still pending.
      await expect(first).rejects.toThrow(/aborted/i);
      expect(readPreparationController(renderer)).toBeDefined();

      await vi.advanceTimersByTimeAsync(10);
      const handle = await second;
      expect(handle.generation).toBe(2);
      expect(readPreparationController(renderer)).toBeUndefined();
      expect(readPreparationSlot(renderer)?.handle).toBe(handle);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cancel a running preparation for an invalid request", async () => {
    vi.useFakeTimers();
    try {
      const { renderer } = await createRenderer();
      const model = createRotationModel(
        new Map([[101, IDENTITY_QUATERNION]]),
      );

      const pending = renderer.prepareRectangleFrame(50, model);
      await expect(
        renderer.prepareRectangleFrame(Number.NaN, model),
      ).rejects.toThrow(/finite time in Ma/);
      // The rejected request must leave the running preparation alone.
      expect(readPreparationController(renderer)).toBeDefined();

      await vi.advanceTimersByTimeAsync(10);
      const handle = await pending;
      expect(handle.timeMa).toBe(50);
      expect(readPreparationSlot(renderer)?.handle).toBe(handle);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles the pending preparation on destroy and still releases owned GPU primitives", async () => {
    vi.useFakeTimers();
    try {
      const { renderer, primitives, added } = await createRenderer();
      const model = createRotationModel(
        new Map([[101, IDENTITY_QUATERNION]]),
      );
      const owned = [...added];
      // graticule + fill + outlines
      expect(owned).toHaveLength(3);

      const pending = renderer.prepareRectangleFrame(50, model);
      renderer.destroy();

      await expect(pending).rejects.toThrow(/aborted/i);
      expect(readPreparationSlot(renderer)).toBeUndefined();
      for (const primitive of owned) {
        expect((primitive as PolylineCollection).isDestroyed()).toBe(true);
      }
      expect(primitives.length).toBe(0);
      expect(() => renderer.destroy()).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates a pending preparation when the globe updates synchronously", async () => {
    vi.useFakeTimers();
    try {
      const { renderer, primitives, added } = await createRenderer();
      const model = createRotationModel(
        new Map([[101, IDENTITY_QUATERNION]]),
      );
      const before = captureCommittedState({ primitives, added });

      const pending = renderer.prepareRectangleFrame(50, model);
      // The globe path keeps its synchronous contract while a preparation is
      // parked in a yield.
      const timeState: RenderTimeState = renderer.updateTime(50, model);
      expect(timeState.activeFeatureCount).toBe(POLYGON_COUNT);
      expect(timeState.activePlateCount).toBe(1);
      expect(timeState.disconnectedFeatureCount).toBe(0);
      expect(timeState.rotationMap.get(101)).toBe(IDENTITY_QUATERNION);

      await expect(pending).rejects.toThrow(/aborted/i);
      expect(readPreparationSlot(renderer)).toBeUndefined();

      const second = renderer.prepareRectangleFrame(50, model);
      await vi.advanceTimersByTimeAsync(10);
      const handle = await second;
      expect(handle.generation).toBe(2);
      expect(readPreparationSlot(renderer)?.handle).toBe(handle);
      expect(captureCommittedState({ primitives, added })).toEqual(before);

      renderer.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects preparation on a destroyed renderer", async () => {
    const { renderer } = await createRenderer();
    const model = createRotationModel(
      new Map([[101, IDENTITY_QUATERNION]]),
    );
    renderer.destroy();

    await expect(renderer.prepareRectangleFrame(50, model)).rejects.toThrow(
      /destroyed/i,
    );
    expect(readPreparationSlot(renderer)).toBeUndefined();
  });

  it("rejects a non-finite preparation time", async () => {
    const { renderer } = await createRenderer();
    const model = createRotationModel(
      new Map([[101, IDENTITY_QUATERNION]]),
    );

    await expect(
      renderer.prepareRectangleFrame(Number.NaN, model),
    ).rejects.toThrow(/finite time in Ma/);
    expect(readPreparationSlot(renderer)).toBeUndefined();

    renderer.destroy();
  });
});
