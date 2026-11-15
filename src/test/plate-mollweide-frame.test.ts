// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseGpmlPlatePolygons, parsePlatesRotationFile, RotationModel, type PlateFeature } from "@timemachine/reconstruction-core";
import { triangulatePlatePolygon } from "../../packages/cesium-runtime/src/geometry";
import { capturePlatePolygonMesh, plateTriangleSourceId } from "../../packages/cesium-runtime/src/plate-mesh-snapshot";
import { buildMollweidePlateCpuFrame, type MollweideCpuPolygon } from "../../packages/cesium-runtime/src/plate-mollweide-frame";

describe("real PALEOMAP Mollweide frames",()=>{
  it("does no vertex or geometry work for invalid-time or disconnected polygons", async () => {
    const source: PlateFeature = {
      id: "fixture", plateId: 1, name: "fixture", description: "", sourceIndex: 0,
      validFromMa: 4500, validToMa: -1,
      polygons: [{ exterior: [[0,0],[4,0],[4,4],[0,4]], holes: [] }],
    };
    const geometry = triangulatePlatePolygon(source.polygons[0]!).geometry;
    const valid = { ...source, id: "disconnected", plateId: 987654, validFromMa: 4500, validToMa: -1 };
    const invalid = { ...source, id: "invalid-time", plateId: 987655, validFromMa: 50, validToMa: 0 };
    const disconnected = capturePlatePolygonMesh(valid, 0, geometry);
    const expired = capturePlatePolygonMesh(invalid, 0, geometry);
    const frame = await buildMollweidePlateCpuFrame([disconnected, disconnected, expired], 100, new Map(), new AbortController().signal);
    expect(frame.stats.vertexCount).toBe(0);
    expect(frame.stats.triangleCount).toBe(0);
    expect(frame.mollweideStats.coldSnapshots).toBe(0);
    expect(frame.mollweideStats.inputVertices).toBe(0);
    expect(frame.timeState).toEqual({ activeFeatureCount: 0, activePlateCount: 0, disconnectedFeatureCount: 2 });
    expect(frame.plates.every(plate => plate.polygons.length === 0)).toBe(true);
  });
  it("retains and projects the complete model at 0, 100, 180 and 100.60 Ma",async()=>{
    const parsed=parseGpmlPlatePolygons(readFileSync("data/PlateModelData/PALEOMAP_PlatePolygons.gpml","utf8"));
    const rotations=parsePlatesRotationFile(readFileSync("data/PlateModelData/PALEOMAP_PlateModel.rot","utf8"));
    const model=new RotationModel(rotations.sequences);
    const snapshots=parsed.features.flatMap(feature=>feature.polygons.map((polygon,index)=>capturePlatePolygonMesh(feature,index,triangulatePlatePolygon(polygon).geometry)));
    const originals=snapshots.map(snapshot=>snapshot.positions.slice());
    const originalIndices=snapshots.map(snapshot=>snapshot.indices.slice());
    const byPolygon=new Map(snapshots.map(snapshot=>[`${snapshot.feature.id}/${snapshot.polygonIndex}`,snapshot]));
    const numericalCounts: number[] = [];
    const numericalBounds: number[] = [];
    const outputHashes: string[] = [];
    for(const time of [25.63,0,100,180,100.60,0.6,10.2,20.4,30,100.01,110.2,120.4,130]){
      console.log("Mollweide real-model age",time);
      // Preserve the original byte-exact oracle; recipe replay is validated by
      // the noninteger sweep below and the explicit cached/uncached recipe tests.
      const frame=await buildMollweidePlateCpuFrame(snapshots,time,model.getRotationMap(time,0),new AbortController().signal,{reuseRecipe:false});
      console.log("Mollweide frame stats",frame.mollweideStats);
      const hash=createHash("sha256");
      for(const plate of frame.plates)for(const polygon of plate.polygons){
        for(const values of [polygon.geometry.attributes.position!.values,polygon.geometry.indices!,(polygon as MollweideCpuPolygon).sourceTriangleIndices]){
          if(!ArrayBuffer.isView(values))throw new Error("Mollweide output must use owned typed buffers");
          hash.update(new Uint8Array(values.buffer,values.byteOffset,values.byteLength));
        }
        hash.update(JSON.stringify(polygon.outlineRings));
      }
      outputHashes.push(hash.digest("hex"));
      numericalCounts.push(frame.mollweideStats.numericalDegenerateCount);
      numericalBounds.push(frame.mollweideStats.numericalDegenerateAreaUpperBoundSteradians);
      expect(frame.mollweideStats.numericalDegenerateSources.some(source => source.sourceId === "GPlates-bca3ad77-3ed6-44bd-b960-113891b1a986#0#889")).toBe(true);
      expect(frame.mollweideStats.numericalDegenerateAreaUpperBoundSteradians).toBeLessThan(1e-14);
      expect(frame.mollweideStats.numericalDegenerateSources.some(source=>source.sourceId.endsWith("#842"))).toBe(false);
      expect(frame.mollweideStats.refinementDegenerateCount).toBe(0);
      expect(frame.stats.triangleCount).toBeGreaterThan(100000);
      expect(frame.mollweideStats.fastTriangles).toBeGreaterThan(frame.mollweideStats.inputTriangles*0.9);
      for(const plate of frame.plates)for(const polygon of plate.polygons){
        expect(polygon.geometry.boundingSphere!.center.x-polygon.geometry.boundingSphere!.radius).toBeGreaterThan(0);
      }
    }
    // Longest-edge propagation topology baseline, not the former short-edge
    // heuristic's topology. Includes source mapping and both seam-side outlines.
    expect(outputHashes).toMatchInlineSnapshot(`
      [
        "261133c51c33a509b62966d1e83af7b8b3ccc6398cfef16c7f86626e544b0ab7",
        "0333d7e31fcddf462f1da367bf9a5c7390da43dfe8bafcc5be2fe2317b969e80",
        "4c2adfb6a586482e0dd2b5213166399d04dcca4e362215f78314c2fb21ed6b02",
        "e993e64e282e6974e700bfd1267a8cfd5a5cdfb35176e90a57b289cc2f408f24",
        "4bfde25d179ad769cb42740fbf1c10144f3c07ccd6927cb987ac6da523142d64",
        "0b777a2350e084e5d9afb98f2595308da901fd5c99846ff947605222b2598861",
        "d04346f81d93b8c21735fc5336ec772cff833913968ecfeff74b0d599ab73e73",
        "ff1b8dc71820e754175cbd5123a3b7e2b04fef61e121dae2b9c014c6958a7de3",
        "2508be1ccfac1739d8bb0146bbed6b9ae736d0ab1b76f4d6b2726faaae9e901b",
        "e6181e67a5333a5306130eafa53efebcd5039feb4b5981c243f2d02e443c9e28",
        "6183a6040f2145a38a2a4f55d90967798a67d5e252d6fb6b0de7b26478566e09",
        "26e44feaabed63c88e6df4f68a9f5d4f5e2a5521eab2afcfe445d0a1f6b4671d",
        "ae9d51a685d84ee2aa80278f3c4f3b5c2abb7b47585481a89280188c7a325d86",
      ]
    `);
    expect(new Set(numericalCounts).size).toBe(1);
    expect(new Set(numericalBounds).size).toBe(1);
    const sweepTimes=[0,100].flatMap(start=>Array.from({length:60},(_,i)=>start+.13+i*.5));
    let sweepOmissions=0;
    const sweepStart=performance.now();
    for(const time of sweepTimes){
      const frame=await buildMollweidePlateCpuFrame(snapshots,time,model.getRotationMap(time,0),new AbortController().signal).catch(error=>{throw new Error(`Sweep age ${time}: ${error.message}`);});
      expect(frame.timeMa).toBe(time);
      expect(frame.stats.triangleCount).toBeGreaterThan(100000);
      expect(frame.mollweideStats.numericalDegenerateSources.map(source=>source.sourceId)).toEqual(["GPlates-bca3ad77-3ed6-44bd-b960-113891b1a986#0#889"]);
      sweepOmissions+=frame.mollweideStats.refinementDegenerateCount;
      const omitted=new Set(frame.mollweideStats.numericalDegenerateSources.map(source=>source.sourceId));
      for(const plate of frame.plates)for(const polygon of plate.polygons){
        const snapshot=byPolygon.get(`${polygon.feature.id}/${polygon.pick.polygonIndex}`)!;
        const present=new Uint8Array(snapshot.triangleCount);
        for(const face of (polygon as MollweideCpuPolygon).sourceTriangleIndices){
          if(face>=snapshot.triangleCount)throw new Error(`Invalid original-face mapping at ${time}`);
          present[face]=1;
        }
        for(let face=0;face<present.length;face++)if(!present[face]&&!omitted.has(plateTriangleSourceId(snapshot,face))){
          throw new Error(`Recipe lost source face ${plateTriangleSourceId(snapshot,face)} at ${time}`);
        }
      }
    }
    console.log("Mollweide noninteger sweep",{frames:sweepTimes.length,elapsedMs:performance.now()-sweepStart,refinementOmissions:sweepOmissions});
    expect(sweepOmissions).toBe(0);
    for(let i=0;i<snapshots.length;i++){
      expect(snapshots[i]!.positions).toEqual(originals[i]);
      expect(snapshots[i]!.indices).toEqual(originalIndices[i]);
    }
  },60000);
});
