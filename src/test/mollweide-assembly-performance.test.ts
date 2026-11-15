// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseGpmlPlatePolygons, parsePlatesRotationFile, RotationModel, type PlateFeature } from "@timemachine/reconstruction-core";
import { ComponentDatatype, Geometry, GeometryAttribute, GeometryAttributes, PrimitiveType } from "cesium";
import { triangulatePlatePolygon } from "../../packages/cesium-runtime/src/geometry";
import { capturePlatePolygonMesh } from "../../packages/cesium-runtime/src/plate-mesh-snapshot";
import { buildMollweidePlateCpuFrame, type MollweideCpuPolygon } from "../../packages/cesium-runtime/src/plate-mollweide-frame";

describe("Mollweide assembly allocation evidence", () => {
  it("grows exceptional append buffers while retaining 32-bit indices and original face IDs", async () => {
    const feature: PlateFeature = { id: "wide-seam", plateId: 1, name: "fixture", description: "", sourceIndex: 0, validFromMa: 200, validToMa: -1,
      polygons: [{ exterior: [[170, -5], [-170, -5], [-170, 5], [170, -5]], holes: [] }] };
    const direction = (longitude: number, latitude: number) => {
      const lon = longitude * Math.PI / 180, lat = latitude * Math.PI / 180;
      return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    };
    const positions = new Float64Array(65537 * 3);
    const a = direction(170, -5), b = direction(-170, -5), c = direction(-170, 5);
    for (let i = 0; i < 65537; i++) positions.set(a, 3 * i);
    positions.set(b, 3); positions.set(c, 65536 * 3);
    const indices = new Uint32Array(100 * 3);
    for (let face = 0; face < 100; face++) indices.set([0, 1, 65536], 3 * face);
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: positions });
    const snapshot = capturePlatePolygonMesh(feature, 0, new Geometry({ attributes, indices, primitiveType: PrimitiveType.TRIANGLES }));
    const build = () => buildMollweidePlateCpuFrame([snapshot], 100, new Map([[1, { x: 0, y: 0, z: 0, w: 1 }]]), new AbortController().signal);
    const first = await build();
    const polygon = first.plates[0]!.polygons[0]! as MollweideCpuPolygon;
    expect(polygon.geometry.indices).toBeInstanceOf(Uint32Array);
    expect(polygon.triangleCount).toBe(300);
    expect(polygon.vertexCount).toBe(65537 + 900);
    expect(polygon.geometry.indices!.length).toBe(900);
    expect(Array.from(polygon.sourceTriangleIndices)).toEqual(Array.from({ length: 100 }, (_, face) => [face, face, face]).flat());
    const original = new Float64Array(polygon.geometry.attributes.position!.values);
    polygon.geometry.attributes.position!.values[0] = 123;
    const repeated = await build();
    expect(repeated.plates[0]!.polygons[0]!.geometry.attributes.position!.values).toEqual(original);
    expect(snapshot.positions).toEqual(positions);
    expect(snapshot.indices).toEqual(indices);
  });
  it("preserves used buffers and source mappings across warm immutable-snapshot reuse", async () => {
    const parsed = parseGpmlPlatePolygons(readFileSync("data/PlateModelData/PALEOMAP_PlatePolygons.gpml", "utf8"));
    const model = new RotationModel(parsePlatesRotationFile(readFileSync("data/PlateModelData/PALEOMAP_PlateModel.rot", "utf8")).sequences);
    const snapshots = parsed.features.flatMap(feature => feature.polygons.map((polygon, index) => capturePlatePolygonMesh(feature, index, triangulatePlatePolygon(polygon).geometry)));
    // Pre-allocation baseline: byte-exact geometry, original-face mapping and outlines.
    const baseline = new Map([
      [0, "0333d7e31fcddf462f1da367bf9a5c7390da43dfe8bafcc5be2fe2317b969e80"],
      [100, "4c2adfb6a586482e0dd2b5213166399d04dcca4e362215f78314c2fb21ed6b02"],
      [0.6, "0b777a2350e084e5d9afb98f2595308da901fd5c99846ff947605222b2598861"],
      [100.6, "4bfde25d179ad769cb42740fbf1c10144f3c07ccd6927cb987ac6da523142d64"],
      [10.2, "d04346f81d93b8c21735fc5336ec772cff833913968ecfeff74b0d599ab73e73"],
      [110.2, "6183a6040f2145a38a2a4f55d90967798a67d5e252d6fb6b0de7b26478566e09"],
      [20.4, "ff1b8dc71820e754175cbd5123a3b7e2b04fef61e121dae2b9c014c6958a7de3"],
      [120.4, "26e44feaabed63c88e6df4f68a9f5d4f5e2a5521eab2afcfe445d0a1f6b4671d"],
      [30, "2508be1ccfac1739d8bb0146bbed6b9ae736d0ab1b76f4d6b2726faaae9e901b"],
      [130, "ae9d51a685d84ee2aa80278f3c4f3b5c2abb7b47585481a89280188c7a325d86"],
    ]);
    const rows = [];
    for (const age of [0, 100, 0.6, 100.6, 10.2, 110.2, 20.4, 120.4, 30, 130, 0.6, 100.6]) {
      // Keep the pre-recipe byte-exact baseline as an independent uncached oracle.
      const frame = await buildMollweidePlateCpuFrame(snapshots, age, model.getRotationMap(age, 0), new AbortController().signal, { reuseRecipe: false });
      const hash = createHash("sha256");
      let positionBytes = 0, indexBytes = 0;
      for (const plate of frame.plates) for (const polygon of plate.polygons) {
        const positions = polygon.geometry.attributes.position!.values;
        const indices = polygon.geometry.indices!;
        if (!ArrayBuffer.isView(indices)) throw new Error("Expected typed indices");
        const sources = (polygon as MollweideCpuPolygon).sourceTriangleIndices;
        expect(positions.length).toBe(3 * polygon.vertexCount);
        expect(indices.length).toBe(3 * polygon.triangleCount);
        expect(sources.length).toBe(polygon.triangleCount);
        expect(indices).toBeInstanceOf(polygon.vertexCount > 65536 ? Uint32Array : Uint16Array);
        for (const values of [positions, indices, sources]) {
          if (!ArrayBuffer.isView(values)) throw new Error("Expected typed output");
          hash.update(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
          expect(snapshots.some(snapshot => snapshot.positions.buffer === values.buffer || snapshot.indices.buffer === values.buffer)).toBe(false);
        }
        hash.update(JSON.stringify(polygon.outlineRings));
        positionBytes += positions.length * 8;
        indexBytes += indices.byteLength;
      }
      expect(positionBytes).toBe(frame.stats.workingPositionByteLength);
      expect(indexBytes).toBe(frame.stats.workingIndexByteLength);
      expect(frame.mollweideStats.triangleMs).toBeGreaterThanOrEqual(frame.mollweideStats.refinementMs);
      const digest = hash.digest("hex");
      expect(digest).toBe(baseline.get(age));
      rows.push({ age, hash: digest, outputVertices: frame.stats.vertexCount, positionBytes, indexBytes, prepareMs: frame.stats.prepareMs, ...frame.mollweideStats });
    }
    // Explicit opt-in artifact, no wall-clock threshold in correctness tests.
    if (process.env.MOLLWEIDE_PERF_OUTPUT) writeFileSync(process.env.MOLLWEIDE_PERF_OUTPUT, JSON.stringify(rows, null, 2));
  }, 30000);
});
