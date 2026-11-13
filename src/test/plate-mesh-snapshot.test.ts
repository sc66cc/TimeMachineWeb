// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BoundingSphere,
  ComponentDatatype,
  Geometry,
  GeometryAttribute,
  GeometryAttributes,
  PolylineCollection,
  PrimitiveCollection,
  PrimitiveType,
  type Viewer,
} from "cesium";
import { describe, expect, it } from "vitest";

import {
  parseGpmlPlatePolygons,
  type LonLat,
  type PlateFeature,
} from "@timemachine/reconstruction-core";
import {
  capturePlatePolygonMesh,
  createWorkingPlateGeometry,
  plateTriangleSourceId,
  PlateRenderer,
  triangulatePlatePolygon,
} from "@timemachine/cesium-runtime";

// jsdom lacks these browser globals; Cesium's Material only needs the
// constructors to exist when it resolves uniform types.
for (const globalName of ["ImageBitmap", "OffscreenCanvas"]) {
  if (typeof (globalThis as Record<string, unknown>)[globalName] === "undefined") {
    (globalThis as Record<string, unknown>)[globalName] = class {};
  }
}

function createFeature(
  id: string,
  plateId: number,
  withHole: boolean,
): PlateFeature {
  const exterior: LonLat[] = [
    [0, 0],
    [12, 0],
    [12, 12],
    [0, 12],
  ];
  const hole: LonLat[] = [
    [4, 4],
    [8, 4],
    [8, 8],
    [4, 8],
  ];
  return {
    id,
    plateId,
    name: id,
    description: "",
    validFromMa: 100,
    validToMa: 0,
    polygons: [{ exterior, holes: withHole ? [hole] : [] }],
    sourceIndex: 0,
  };
}

function createGeometry(
  positions: Float64Array,
  indices: Uint16Array,
  primitiveType: PrimitiveType = PrimitiveType.TRIANGLES,
): Geometry {
  const attributes = new GeometryAttributes();
  attributes.position = new GeometryAttribute({
    componentDatatype: ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: positions,
  });
  return new Geometry({
    attributes,
    primitiveType,
    indices,
  });
}

/** `Geometry#indices` is loosely typed upstream; the fixtures are Uint16. */
function triangleIndices(geometry: Geometry): Uint16Array {
  return geometry.indices as unknown as Uint16Array;
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

/**
 * A viewer that can be destroyed underneath a live renderer. Destroying it
 * makes every scene accessor throw, the way a real `Viewer#destroy` tears the
 * scene down, so the renderer has nothing left to ask.
 */
function createDestroyableFakeViewer(): {
  viewer: Viewer;
  primitives: PrimitiveCollection;
  added: unknown[];
  destroyViewer: () => void;
} {
  const { viewer, primitives, added } = createFakeViewer();
  const scene = viewer.scene as unknown as Record<string, unknown>;
  const refuse = (name: string): void => {
    Object.defineProperty(scene, name, {
      get: () => {
        throw new Error(`a destroyed scene must not be asked for ${name}`);
      },
    });
  };
  return {
    viewer,
    primitives,
    added,
    destroyViewer: () => {
      Object.defineProperty(viewer, "isDestroyed", { value: () => true });
      Object.defineProperty(scene, "isDestroyed", { value: () => true });
      refuse("primitives");
      refuse("requestRender");
    },
  };
}

describe("plate mesh snapshots", () => {
  it("keeps an independent CPU copy of the triangulated mesh", () => {
    const feature = createFeature("plate-a", 101, true);
    const polygon = feature.polygons[0]!;
    const triangulated = triangulatePlatePolygon(polygon);
    const snapshot = capturePlatePolygonMesh(feature, 0, triangulated.geometry);

    expect(snapshot.feature).toBe(feature);
    expect(snapshot.plateId).toBe(101);
    expect(snapshot.polygonIndex).toBe(0);
    expect(snapshot.vertexCount).toBe(triangulated.vertexCount);
    expect(snapshot.triangleCount).toBe(triangulated.triangleCount);
    expect(snapshot.triangleCount).toBeGreaterThan(0);

    expect(snapshot.positions).not.toBe(
      triangulated.geometry.attributes.position!.values,
    );
    expect(snapshot.indices).not.toBe(triangulated.geometry.indices);
    expect(snapshot.positions.length).toBe(snapshot.vertexCount * 3);
    expect(snapshot.indices.length).toBe(snapshot.triangleCount * 3);
    expect(snapshot.positionByteLength).toBe(snapshot.positions.byteLength);
    expect(snapshot.indexByteLength).toBe(snapshot.indices.byteLength);
    expect(snapshot.indices).toBeInstanceOf(Uint16Array);

    const originalFirstPosition = snapshot.positions[0]!;
    const originalFirstIndex = snapshot.indices[0]!;
    expect(Array.from(snapshot.positions)).toEqual(
      Array.from(
        triangulated.geometry.attributes.position!.values as Float64Array,
      ),
    );

    // Mutating the geometry that was handed to Cesium must not reach the
    // snapshot, which is the whole point of capturing before the hand-off.
    const sourcePositions = triangulated.geometry.attributes.position!
      .values as Float64Array;
    sourcePositions[0] = 999_999;
    triangleIndices(triangulated.geometry)[0] =
      triangleIndices(triangulated.geometry)[0]! + 1;

    expect(snapshot.positions[0]).toBe(originalFirstPosition);
    expect(snapshot.indices[0]).toBe(originalFirstIndex);
  });

  it("copies the outline rings independently of the input polygon", () => {
    const feature = createFeature("plate-b", 202, true);
    const polygon = feature.polygons[0]!;
    const snapshot = capturePlatePolygonMesh(
      feature,
      0,
      triangulatePlatePolygon(polygon).geometry,
    );

    expect(snapshot.exterior).toEqual(polygon.exterior);
    expect(snapshot.holes).toHaveLength(1);
    expect(snapshot.holes[0]).toEqual(polygon.holes[0]);

    const originalExterior = polygon.exterior.map(
      ([longitude, latitude]) => [longitude, latitude] as LonLat,
    );
    const originalHole = polygon.holes[0]!.map(
      ([longitude, latitude]) => [longitude, latitude] as LonLat,
    );
    polygon.exterior[0] = [55, 66];
    polygon.holes[0]![0] = [77, 88];

    expect(snapshot.exterior).toEqual(originalExterior);
    expect(snapshot.holes[0]).toEqual(originalHole);
  });

  it("builds fresh working geometry that shares no buffers", () => {
    const feature = createFeature("plate-c", 303, false);
    const polygon = feature.polygons[0]!;
    const snapshot = capturePlatePolygonMesh(
      feature,
      0,
      triangulatePlatePolygon(polygon).geometry,
    );

    const first = createWorkingPlateGeometry(snapshot);
    const second = createWorkingPlateGeometry(snapshot);
    const firstPositions = first.attributes.position!.values as Float64Array;

    expect(first).not.toBe(second);
    expect(firstPositions).not.toBe(snapshot.positions);
    expect(firstPositions).not.toBe(second.attributes.position!.values);
    expect(first.indices).not.toBe(snapshot.indices);
    expect(first.indices).not.toBe(second.indices);
    expect(first.primitiveType).toBe(PrimitiveType.TRIANGLES);
    expect(first.indices).toBeInstanceOf(Uint16Array);
    expect(Array.from(firstPositions)).toEqual(Array.from(snapshot.positions));
    expect(Array.from(first.indices!)).toEqual(Array.from(snapshot.indices));

    const expectedRadius = BoundingSphere.fromVertices(snapshot.positions)
      .radius;
    expect(first.boundingSphere!.radius).toBeCloseTo(expectedRadius, 6);

    firstPositions[0] = 12_345;
    triangleIndices(first)[0] = triangleIndices(first)[0]! + 1;
    expect(snapshot.positions[0]).not.toBe(12_345);
    expect(
      (second.attributes.position!.values as Float64Array)[0],
    ).not.toBe(12_345);
  });

  it("generates stable triangle source ids on demand", () => {
    const feature = createFeature("plate-d", 404, false);
    const polygon = feature.polygons[0]!;
    const snapshot = capturePlatePolygonMesh(
      feature,
      0,
      triangulatePlatePolygon(polygon).geometry,
    );

    expect(plateTriangleSourceId(snapshot, 0)).toBe("plate-d#0#0");
    expect(plateTriangleSourceId(snapshot, 1)).toBe("plate-d#0#1");
    expect(plateTriangleSourceId(snapshot, 0)).toBe(
      plateTriangleSourceId(snapshot, 0),
    );
    expect(() =>
      plateTriangleSourceId(snapshot, snapshot.triangleCount),
    ).toThrow();
    expect(() => plateTriangleSourceId(snapshot, -1)).toThrow();
  });

  it("keeps a polygon whose only hole is empty", async () => {
    // Cesium skips any hole with fewer than three vertices, so an empty hole
    // is renderable input: the capture has to copy it instead of refusing the
    // whole polygon, and the renderer must still count the polygon as
    // rendered rather than skipped.
    const feature = createFeature("plate-empty-hole", 707, false);
    feature.polygons[0]!.holes = [[]];
    const polygon = feature.polygons[0]!;

    const triangulated = triangulatePlatePolygon(polygon);
    expect(triangulated.triangleCount).toBeGreaterThan(0);
    const snapshot = capturePlatePolygonMesh(feature, 0, triangulated.geometry);
    expect(snapshot.holes).toHaveLength(1);
    expect(snapshot.holes[0]).toEqual([]);
    expect(snapshot.triangleCount).toBe(triangulated.triangleCount);
    expect(snapshot.vertexCount).toBe(triangulated.vertexCount);

    const { viewer } = createFakeViewer();
    const renderer = await PlateRenderer.create(viewer, [feature]);
    expect(renderer.buildStats.polygonCount).toBe(1);
    expect(renderer.buildStats.skippedPolygonCount).toBe(0);
    expect(renderer.buildStats.warnings).toEqual([]);
    expect(renderer.buildStats.triangleCount).toBe(triangulated.triangleCount);
    expect(renderer.retainedMeshSnapshots).toHaveLength(1);
    renderer.destroy();
  });

  it("rejects malformed capture input", () => {
    const feature = createFeature("plate-e", 505, false);
    const geometry = triangulatePlatePolygon(feature.polygons[0]!).geometry;

    expect(() => capturePlatePolygonMesh(feature, 5, geometry)).toThrow();
    expect(() => capturePlatePolygonMesh(feature, -1, geometry)).toThrow();
    expect(() =>
      capturePlatePolygonMesh(feature, 0, createGeometry(
        new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        new Uint16Array([0, 1, 2]),
        PrimitiveType.LINES,
      )),
    ).toThrow();
    expect(() =>
      capturePlatePolygonMesh(
        feature,
        0,
        new Geometry({
          attributes: new GeometryAttributes(),
          primitiveType: PrimitiveType.TRIANGLES,
          indices: new Uint16Array([0, 1, 2]),
        }),
      ),
    ).toThrow();
    expect(() =>
      capturePlatePolygonMesh(
        feature,
        0,
        createGeometry(
          new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          new Uint16Array([0, 1]),
        ),
      ),
    ).toThrow();
    expect(() =>
      capturePlatePolygonMesh(
        feature,
        0,
        createGeometry(
          new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          new Uint16Array([0, 1, 99]),
        ),
      ),
    ).toThrow();
    expect(() =>
      capturePlatePolygonMesh(
        feature,
        0,
        createGeometry(
          new Float64Array([0, 0, Number.NaN, 1, 0, 0, 0, 1, 0]),
          new Uint16Array([0, 1, 2]),
        ),
      ),
    ).toThrow();

    const brokenFeature = createFeature("plate-f", 606, false);
    brokenFeature.polygons[0]!.exterior[0] = [Number.NaN, 0];
    expect(() =>
      capturePlatePolygonMesh(brokenFeature, 0, geometry),
    ).toThrow();
  });

  it("rejects malformed working geometry input", () => {
    expect(() => createWorkingPlateGeometry({} as never)).toThrow();
  });

  it("captures every polygon of the real GPML plate model", () => {
    const xml = readFileSync(
      resolve("data/PlateModelData/PALEOMAP_PlatePolygons.gpml"),
      "utf8",
    );
    const parsed = parseGpmlPlatePolygons(xml);
    let capturedCount = 0;
    let capturedTriangles = 0;

    for (const feature of parsed.features) {
      for (const [polygonIndex, polygon] of feature.polygons.entries()) {
        const triangulated = triangulatePlatePolygon(polygon);
        const snapshot = capturePlatePolygonMesh(
          feature,
          polygonIndex,
          triangulated.geometry,
        );
        expect(snapshot.triangleCount).toBe(triangulated.triangleCount);
        expect(snapshot.vertexCount).toBe(triangulated.vertexCount);
        capturedCount += 1;
        capturedTriangles += snapshot.triangleCount;
      }
    }

    expect(capturedCount).toBe(parsed.polygonCount);
    expect(capturedTriangles).toBeGreaterThan(20_000);
  });
});

describe("PlateRenderer resource ownership", () => {
  it("retains one snapshot per rendered polygon", async () => {
    const { viewer } = createFakeViewer();
    const renderer = await PlateRenderer.create(viewer, [
      createFeature("plate-a", 101, false),
      createFeature("plate-b", 202, false),
    ]);

    const snapshots = renderer.retainedMeshSnapshots;
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]!.feature.id).toBe("plate-a");
    expect(snapshots[0]!.polygonIndex).toBe(0);
    expect(snapshots[1]!.feature.id).toBe("plate-b");

    const stats = renderer.retainedMeshStats;
    expect(stats.snapshotCount).toBe(2);
    expect(stats.triangleCount).toBe(
      snapshots[0]!.triangleCount + snapshots[1]!.triangleCount,
    );
    expect(stats.vertexCount).toBe(
      snapshots[0]!.vertexCount + snapshots[1]!.vertexCount,
    );
    expect(stats.positionByteLength).toBe(
      snapshots[0]!.positionByteLength + snapshots[1]!.positionByteLength,
    );
    expect(stats.indexByteLength).toBe(
      snapshots[0]!.indexByteLength + snapshots[1]!.indexByteLength,
    );

    renderer.destroy();
  });

  it("destroys only renderer-owned primitives and is idempotent", async () => {
    const { viewer, primitives, added } = createFakeViewer();
    const renderer = await PlateRenderer.create(viewer, [
      createFeature("plate-a", 101, false),
    ]);
    const ownedPrimitives = [...added];
    // graticule + fill + outlines
    expect(ownedPrimitives).toHaveLength(3);

    const external = new PolylineCollection();
    primitives.add(external);
    expect(primitives.length).toBe(4);

    renderer.destroy();

    for (const primitive of ownedPrimitives) {
      expect(
        (primitive as PolylineCollection).isDestroyed(),
      ).toBe(true);
    }
    expect(primitives.length).toBe(1);
    expect(primitives.contains(external)).toBe(true);
    expect(external.isDestroyed()).toBe(false);
    expect(renderer.retainedMeshSnapshots).toHaveLength(0);

    expect(() => renderer.destroy()).not.toThrow();
    expect(primitives.length).toBe(1);
    expect(external.isDestroyed()).toBe(false);
  });

  it("destroys owned primitives the collection refuses to destroy", async () => {
    // A collection with destroyPrimitives: false detaches a primitive without
    // destroying it, so a successful remove is not proof of a release.
    const { viewer, primitives, added } = createFakeViewer();
    const renderer = await PlateRenderer.create(viewer, [
      createFeature("plate-leak", 909, false),
    ]);
    const ownedPrimitives = [...added];
    expect(ownedPrimitives).toHaveLength(3);

    primitives.destroyPrimitives = false;
    renderer.destroy();

    for (const primitive of ownedPrimitives) {
      expect((primitive as PolylineCollection).isDestroyed()).toBe(true);
    }
    expect(primitives.length).toBe(0);
    expect(renderer.retainedMeshSnapshots).toHaveLength(0);
    // Repeat destroy stays a no-op rather than touching the collection again.
    expect(() => renderer.destroy()).not.toThrow();
    expect(primitives.length).toBe(0);
  });

  it("leaves its primitives alone when the viewer was destroyed first", async () => {
    const { viewer, primitives, added, destroyViewer } =
      createDestroyableFakeViewer();
    const renderer = await PlateRenderer.create(viewer, [
      createFeature("plate-gone", 808, false),
    ]);
    const ownedPrimitives = [...added];
    expect(ownedPrimitives).toHaveLength(3);

    // Guard the one method the renderer must not reach: a late primitive
    // destructor runs into Cesium's throwOnDestroyed shader guards once the
    // context is gone, so "not called" is the whole point of this branch.
    const destroyCalls: unknown[] = [];
    for (const primitive of ownedPrimitives) {
      (primitive as { destroy: () => void }).destroy = () => {
        destroyCalls.push(primitive);
      };
    }
    const collectionLength = primitives.length;

    // The viewer goes first: its scene is gone, so the renderer must not ask
    // it for anything and must not touch the primitives it still holds.
    destroyViewer();
    expect(() => renderer.destroy()).not.toThrow();

    expect(destroyCalls).toEqual([]);
    for (const primitive of ownedPrimitives) {
      expect((primitive as PolylineCollection).isDestroyed()).toBe(false);
    }
    expect(primitives.length).toBe(collectionLength);
    expect(renderer.retainedMeshSnapshots).toHaveLength(0);

    // Repeat destroy still stays a no-op rather than reaching the primitives.
    expect(() => renderer.destroy()).not.toThrow();
    expect(destroyCalls).toEqual([]);
  });

  it("never enters primitive.destroy for a live destroyPrimitives:false collection", async () => {
    // The real GPU order: primitives are allocated, the collection is told not
    // to destroy what it holds, the viewer goes first and only then does the
    // renderer get its turn. Entering primitive.destroy here is what actually
    // threw on a real WebGL context, so this asserts the guard, not an outcome.
    const { viewer, primitives, added, destroyViewer } =
      createDestroyableFakeViewer();
    const renderer = await PlateRenderer.create(viewer, [
      createFeature("plate-late", 818, false),
    ]);
    const ownedPrimitives = [...added];
    expect(ownedPrimitives).toHaveLength(3);

    const destroyCalls: unknown[] = [];
    for (const primitive of ownedPrimitives) {
      (primitive as { destroy: () => void }).destroy = () => {
        destroyCalls.push(primitive);
      };
    }
    const collectionLength = primitives.length;

    primitives.destroyPrimitives = false;
    destroyViewer();
    expect(() => renderer.destroy()).not.toThrow();

    expect(destroyCalls).toEqual([]);
    for (const primitive of ownedPrimitives) {
      expect((primitive as PolylineCollection).isDestroyed()).toBe(false);
    }
    expect(primitives.length).toBe(collectionLength);
    expect(renderer.retainedMeshSnapshots).toHaveLength(0);
  });

  it("toggles the graticule without touching plate primitives", async () => {
    const { viewer, added } = createFakeViewer();
    const renderer = await PlateRenderer.create(viewer, [
      createFeature("plate-a", 101, false),
    ]);

    const graticule = added[0] as PolylineCollection;
    expect(graticule.show).toBe(true);

    renderer.setGraticuleVisible(false);
    expect(graticule.show).toBe(false);

    renderer.setGraticuleVisible(true);
    expect(graticule.show).toBe(true);

    renderer.destroy();
  });
});
