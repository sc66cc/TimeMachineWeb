// @vitest-environment jsdom

import {
  Matrix4,
  PolylineCollection,
  Primitive,
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
import { PlateRenderer } from "@timemachine/cesium-runtime";

for (const globalName of ["ImageBitmap", "OffscreenCanvas"]) {
  if (typeof (globalThis as Record<string, unknown>)[globalName] === "undefined") {
    (globalThis as Record<string, unknown>)[globalName] = class {};
  }
}

const POLYGON_COUNT = 10;

function createFeature(
  id: string,
  plateId: number,
  validFromMa = 100,
  validToMa = 0,
): PlateFeature {
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
    validFromMa,
    validToMa,
    polygons: [{ exterior, holes: [] }],
    sourceIndex: 0,
  };
}

function createRotationModel(
  rotations: ReadonlyMap<number, Quaternion>,
): RotationModel {
  return { getRotationMap: () => rotations } as unknown as RotationModel;
}

/** Fake viewer whose scene exposes the postRender/renderError events the
 *  renderer's warm-up subscribes to. No GL, so a real Primitive never becomes
 *  ready; the tests drive the warm-up explicitly. */
function createFakeViewer(): {
  viewer: Viewer;
  primitives: PrimitiveCollection;
  added: unknown[];
  firePostRender: () => void;
} {
  const canvas = document.createElement("canvas");
  const primitives = new PrimitiveCollection();
  const added: unknown[] = [];
  const postRender = new Set<() => void>();
  const renderError = new Set<(scene: unknown, error: unknown) => void>();
  primitives.add = ((primitive: unknown) => {
    added.push(primitive);
    return PrimitiveCollection.prototype.add.call(primitives, primitive);
  }) as typeof primitives.add;
  const scene = {
    canvas,
    primitives,
    requestRender: () => undefined,
    pick: () => undefined,
    isDestroyed: () => false,
    postRender: {
      addEventListener: (fn: () => void) => {
        postRender.add(fn);
        return () => {
          postRender.delete(fn);
        };
      },
    },
    renderError: {
      addEventListener: (fn: (scene: unknown, error: unknown) => void) => {
        renderError.add(fn);
        return () => {
          renderError.delete(fn);
        };
      },
    },
  };
  const viewer = { scene, isDestroyed: () => false };
  return {
    viewer: viewer as unknown as Viewer,
    primitives,
    added,
    firePostRender: () => {
      for (const fn of [...postRender]) {
        fn();
      }
    },
  };
}

async function createRenderer(plateId = 101): Promise<{
  renderer: PlateRenderer;
  viewer: Viewer;
  primitives: PrimitiveCollection;
  added: unknown[];
  firePostRender: () => void;
}> {
  const features: PlateFeature[] = [];
  for (let index = 0; index < POLYGON_COUNT; index += 1) {
    features.push(createFeature(`plate-${index}`, plateId));
  }
  const fake = createFakeViewer();
  const renderer = await PlateRenderer.create(fake.viewer, features);
  return { renderer, ...fake };
}

describe("rectangle frame staging / commit / restore", () => {
  it("keeps a warming Moll frame alive while preparing one single-use successor", async () => {
    const { renderer, primitives, added } = await createRenderer();
    const model = createRotationModel(new Map([[101, IDENTITY_QUATERNION]]));
    const a = await renderer.prepareRectangleFrame(50, model, "mollweide");
    const warming = renderer.stageRectangleFrame(a, 10);
    const rejected = expect(warming).rejects.toThrow(/abort/i);
    const fill = added[added.length - 2] as Primitive;
    const count = primitives.length;
    const b = await renderer.prepareRectangleFrame(51, model, "mollweide");
    expect(fill.isDestroyed()).toBe(false);
    expect(primitives.length).toBe(count);
    await expect(renderer.stageRectangleFrame(a, 10)).rejects.toThrow(/abort/i);
    expect(fill.isDestroyed()).toBe(false);
    renderer.cancelRectangleStaging(); await rejected;
    const next = renderer.stageRectangleFrame(b, 11);
    const nextRejected = expect(next).rejects.toThrow(/abort/i);
    await expect(renderer.stageRectangleFrame(b, 11)).rejects.toThrow(/abort/i);
    renderer.destroy(); await nextRejected;
  });
  it("rejects staging a stale or already-consumed handle", async () => {
    const { renderer } = await createRenderer();
    const model = createRotationModel(new Map([[101, IDENTITY_QUATERNION]]));
    const handle = await renderer.prepareRectangleFrame(50, model);

    // A handle that does not match the current prepared slot never stages.
    await expect(
      renderer.stageRectangleFrame(
        { ...handle, generation: 999 },
        1,
      ),
    ).rejects.toThrow(/abort/i);

    renderer.destroy();
  });

  it("throws when committing with nothing staged", async () => {
    const { renderer } = await createRenderer();
    expect(() => renderer.commitRectangleFrame(1)).toThrow(/No staged/);
    renderer.destroy();
  });

  it("stages with the warm-up show pattern and keeps the globe frame intact", async () => {
    const { renderer, primitives, added } = await createRenderer();
    const model = createRotationModel(new Map([[101, IDENTITY_QUATERNION]]));
    const handle = await renderer.prepareRectangleFrame(50, model);

    const globeFillShowBefore = (added[1] as { show: boolean }).show;
    const primitiveCountBefore = primitives.length;

    // The synchronous part of staging runs before the first await, so the
    // staged primitives are already in the collection here.
    const staging = renderer.stageRectangleFrame(handle, 1);
    expect(primitives.length).toBe(primitiveCountBefore + 2); // fill + outlines
    const stagedFill = added[added.length - 2] as Primitive;
    const stagedOutlines = added[added.length - 1] as PolylineCollection;
    // Warm-up pattern: the primitive/collection are visible but every instance
    // and line is hidden, so nothing is drawn and the globe is untouched.
    expect(stagedFill.show).toBe(true);
    expect(stagedOutlines.show).toBe(true);
    expect((added[1] as { show: boolean }).show).toBe(globeFillShowBefore);

    // No GL here, so the fill never becomes ready: cancelling settles the
    // staging promise as an abort and releases the staged GPU objects.
    renderer.cancelRectangleStaging();
    await expect(staging).rejects.toThrow(/abort/i);
    expect(stagedFill.isDestroyed()).toBe(true);
    expect(stagedOutlines.isDestroyed()).toBe(true);
    expect(primitives.length).toBe(primitiveCountBefore);

    renderer.destroy();
  });

  it("stages an empty frame as content-free and resolves without a primitive", async () => {
    const { renderer, primitives, firePostRender } = await createRenderer();
    // No rotation for the plate: every group has hasRotation=false, so nothing
    // is drawable and no fill primitive is created.
    const model = createRotationModel(new Map<number, Quaternion>());
    const handle = await renderer.prepareRectangleFrame(50, model);
    const countBefore = primitives.length;

    const staging = renderer.stageRectangleFrame(handle, 1);
    firePostRender(); // an empty frame has nothing to warm up
    const staged = await staging;
    expect(staged.hasContent).toBe(false);
    expect(primitives.length).toBe(countBefore);

    renderer.destroy();
  });

  it("restores the globe bundles from a hidden state", async () => {
    const { renderer, added } = await createRenderer();
    const globeFill = added[1] as { show: boolean };
    const graticule = added[0] as { show: boolean };

    // Simulate a committed rectangle frame having hidden the globe objects.
    globeFill.show = false;
    graticule.show = false;

    renderer.restoreGlobeFrame();
    expect(globeFill.show).toBe(true);
    expect(graticule.show).toBe(true);

    renderer.destroy();
  });

  it("keeps per-instance model matrices identity on the primitive itself", async () => {
    const { renderer, added } = await createRenderer();
    const model = createRotationModel(new Map([[101, IDENTITY_QUATERNION]]));
    const handle = await renderer.prepareRectangleFrame(50, model);
    const staging = renderer.stageRectangleFrame(handle, 1);
    const stagedFill = added[added.length - 2] as Primitive;
    // The primitive body stays identity; the rotation is baked per-instance.
    expect(Array.from(stagedFill.modelMatrix)).toEqual(Array.from(Matrix4.IDENTITY));
    renderer.cancelRectangleStaging();
    await expect(staging).rejects.toThrow(/abort/i);
    renderer.destroy();
  });

  it("refuses the globe updateTime while a rectangle frame is committed", async () => {
    const { renderer } = await createRenderer();
    const model = createRotationModel(new Map([[101, IDENTITY_QUATERNION]]));
    // The globe path still works normally when no rectangle is committed.
    const timeState = renderer.updateTime(50, model);
    expect(timeState.activePlateCount).toBe(1);

    // Simulate a committed rectangle frame: updateTime must refuse rather than
    // re-show the hidden globe bundles (two copies of the plates).
    (
      renderer as unknown as { rectangleCommitted: unknown }
    ).rectangleCommitted = {
      generation: 1,
      timeMa: 50,
      fill: undefined,
      outlines: undefined,
      instances: [],
      renderedOutlines: [],
    };
    expect(() => renderer.updateTime(50, model)).toThrow(/globe-only/i);

    renderer.destroy();
  });

  it("cancels staging on destroy and releases staged GPU objects", async () => {
    const { renderer, added } = await createRenderer();
    const model = createRotationModel(new Map([[101, IDENTITY_QUATERNION]]));
    const handle = await renderer.prepareRectangleFrame(50, model);
    const staging = renderer.stageRectangleFrame(handle, 1);
    const stagedFill = added[added.length - 2] as Primitive;

    renderer.destroy();
    await expect(staging).rejects.toThrow(/abort/i);
    expect(stagedFill.isDestroyed()).toBe(true);
    expect(() => renderer.destroy()).not.toThrow();
  });
});
