// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PlateFeature, Vec3 } from "@timemachine/reconstruction-core";
import { Cartesian3 } from "cesium";
import { triangulatePlatePolygon } from "../../packages/cesium-runtime/src/geometry";
import { capturePlatePolygonMesh } from "../../packages/cesium-runtime/src/plate-mesh-snapshot";
import { buildMollweidePlateCpuFrame, type MollweideCpuFrame, type MollweideCpuPolygon } from "../../packages/cesium-runtime/src/plate-mollweide-frame";
import { createSphericalAreaMeasurementCache, measureSphericalArea, numericalLeafUpperBound, validateSphericalCoverage, validateRefinedSphericalCoverage, memoizeMollweideProjection, refineMollweideFaces } from "../../packages/cesium-runtime/src/mollweide-refinement";
import { projectSegment } from "../../packages/cesium-runtime/src/projected-geometry";
import { mollweideRuntimeProjection } from "../../packages/cesium-runtime/src/mollweide-runtime-projection";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const frameOutput = (frame: MollweideCpuFrame) => frame.plates.flatMap(plate=>plate.polygons.map(polygon=>({
  positions: Array.from(polygon.geometry.attributes.position!.values),
  indices: Array.from(polygon.geometry.indices!),
  sources: Array.from((polygon as MollweideCpuPolygon).sourceTriangleIndices),
  outlines: polygon.outlineRings.map(ring=>ring.map(point=>Cartesian3.clone(point))),
})));

describe("Mollweide CPU reuse boundaries",()=>{
  it("reuses the complete immutable-pose measurement across coverage and certificates without changing arithmetic",()=>{
    type Points = readonly [Vec3,Vec3,Vec3];
    const source:Points = [{x:1,y:0,z:0},{x:0.8,y:0.6,z:0},{x:0.8,y:0,z:0.6}];
    const midpoint = {x:1.6/Math.sqrt(3.28),y:0.6/Math.sqrt(3.28),z:0.6/Math.sqrt(3.28)};
    const leaves:readonly Points[] = [[source[0],source[1],midpoint],[source[0],midpoint,source[2]]];
    const raw=vi.fn((points:Points)=>measureSphericalArea(...points));
    const measure=createSphericalAreaMeasurementCache(raw);
    const original=measure(source);
    expect(original).toEqual(measureSphericalArea(...source));
    expect(measure(source)).toBe(original);
    const children=leaves.map(vertices=>({vertices,result:{status:"ok" as const,sourceId:0,triangles:[]}}));
    expect(validateSphericalCoverage(source,leaves,measure)).toEqual(validateSphericalCoverage(source,leaves));
    expect(validateRefinedSphericalCoverage(source,children,measure)).toEqual(validateRefinedSphericalCoverage(source,children));
    for(const points of leaves){
      expect(numericalLeafUpperBound(points,measure)).toBe(numericalLeafUpperBound(points));
      expect(measure(points)).toEqual(measureSphericalArea(...points));
    }
    expect(raw).toHaveBeenCalledTimes(3);
    // Equal coordinates in a new tuple are not a cached pose or rounded key.
    expect(measure([...source])).toEqual(original);
    expect(raw).toHaveBeenCalledTimes(4);
    const fresh=createSphericalAreaMeasurementCache(raw);
    expect(fresh(source)).toEqual(original);
    expect(raw).toHaveBeenCalledTimes(5);
    const changed=source.map(p=>({x:p.x,y:-p.y,z:-p.z})) as unknown as Points;
    expect(fresh(changed)).toEqual(measureSphericalArea(...changed));
    expect(raw).toHaveBeenCalledTimes(6);
  });
  it("memoizes only exact finite coordinates within one runtime/reference preparation",()=>{
    const runtime=vi.fn(mollweideRuntimeProjection.projectRelative);
    const reference=vi.fn(mollweideRuntimeProjection.projectRelative);
    const memo=memoizeMollweideProjection({...mollweideRuntimeProjection,projectRelative:runtime});
    const oracle=memoizeMollweideProjection({...mollweideRuntimeProjection,projectRelative:reference});
    const east=memo.projectRelative(180,30),west=memo.projectRelative(-180,30);
    expect(east.x).toBeGreaterThan(0);expect(west.x).toBeLessThan(0);
    expect(memo.projectRelative(180,30)).toBe(east);
    expect(memo.projectRelative(-180,30)).toBe(west);
    expect(runtime).toHaveBeenCalledTimes(2);
    oracle.projectRelative(180,30);
    expect(reference).toHaveBeenCalledTimes(1);
    memo.projectRelative(0,0);memo.projectRelative(-0,0);
    memo.projectRelative(0,-0);memo.projectRelative(-0,-0);
    expect(runtime).toHaveBeenCalledTimes(6);
    expect(()=>memo.projectRelative(Number.NaN,0)).toThrow(RangeError);
    expect(()=>memo.projectRelative(Number.NaN,0)).toThrow(RangeError);
    expect(runtime).toHaveBeenCalledTimes(8);
    memoizeMollweideProjection({...mollweideRuntimeProjection,projectRelative:runtime}).projectRelative(180,30);
    expect(runtime).toHaveBeenCalledTimes(9);
  });
  it("preserves exact split output and source IDs for oppositely oriented conforming neighbours",async()=>{
    const source=[
      [-0.6125983907587035,0.17256207608703655,-0.7713271300404122],
      [-0.6061061071801722,0.16992994119750496,-0.7770194347141584],
      [-0.6134662501035464,0.17289892999925452,-0.7705615614530783],
      [-0.60,0.18,-0.78],
    ];
    const last=source[3]!,n=Math.hypot(...last);source[3]=last.map(v=>v/n);
    const positions=new Float64Array(source.flat()),indices=new Uint16Array([0,1,2,2,1,3]);
    const untouched=positions.slice(),untouchedIndices=indices.slice();
    const atan2=vi.spyOn(Math,"atan2");
    let patch;
    let calls=0;
    try {
      patch=await refineMollweideFaces(positions,indices,[0],String,new AbortController().signal,async()=>{});
      calls=atan2.mock.calls.length;
    } finally { atan2.mockRestore(); }
    console.log("Mollweide split CPU evidence",{atan2Calls:calls,hash:hash([...patch!])});
    // Longest-edge conformity now refines the neighbour's longer edge first;
    // topology intentionally differs from the former short-edge propagation.
    expect(hash([...patch!])).toMatchInlineSnapshot(`"b39222f05a9ca58d5e415924f2281a47b778272b193760f002d79f6117997a54"`);
    for(const [face,children] of patch!)for(const child of children){
      expect(child.result.sourceId).toBe(face);
      for(const triangle of child.result.triangles)expect(triangle.sourceId).toBe(face);
    }
    expect(positions).toEqual(untouched);expect(indices).toEqual(untouchedIndices);
    const repeated=await refineMollweideFaces(positions,indices,[0],String,new AbortController().signal,async()=>{});
    expect([...repeated]).toEqual([...patch!]);
  });

  it("keeps seam sides, hole edges, repeated closure and fresh poses exact without borrowing source buffers",async()=>{
    const feature:PlateFeature={id:"outline-reuse",plateId:1,name:"fixture",description:"",sourceIndex:0,validFromMa:4500,validToMa:-1,
      polygons:[{exterior:[[175,-6],[-175,-6],[-175,6],[175,6],[175,-6],[175,-6]],holes:[[[178,-2],[-178,-2],[-178,2],[178,2],[178,-2]]]}]};
    const polygon=feature.polygons[0]!;
    const geometry=triangulatePlatePolygon(polygon).geometry;
    const snapshot=capturePlatePolygonMesh(feature,0,geometry);
    const before=hash({positions:Array.from(snapshot.positions),indices:Array.from(snapshot.indices),exterior:snapshot.exterior,holes:snapshot.holes});
    const identity={x:0,y:0,z:0,w:1};
    const build=(pose:typeof identity)=>buildMollweidePlateCpuFrame([snapshot],100,new Map([[1,pose]]),new AbortController().signal);
    const first=await build(identity);
    const original=frameOutput(first),outlines=original[0]!.outlines;
    expect(hash(original)).toMatchInlineSnapshot(`"69df7d403dfd832b3861501dd31587375bca5fc5a2ab8fc141251345482c0b6e"`);
    const ringCoordinates=[polygon.exterior, ...polygon.holes];
    for(const ring of ringCoordinates){
      let count=ring.length;
      while(count>1 && ring[0]![0]===ring[count-1]![0] && ring[0]![1]===ring[count-1]![1])count--;
      const directions=ring.slice(0,count).map(([lon,lat])=>{
        const a=lon!*Math.PI/180,b=lat!*Math.PI/180;
        return {x:Math.cos(b)*Math.cos(a),y:Math.cos(b)*Math.sin(a),z:Math.sin(b)};
      });
      for(let edge=0;edge<count;edge++){
        const result=projectSegment(directions[edge]!,directions[(edge+1)%count]!,edge,mollweideRuntimeProjection);
        expect(result.status).toBe("ok");
        for(const segment of result.segments)expect(outlines.some(line=>line.some((point,index)=>index+1<line.length &&
          point.y===segment.start.x && point.z===segment.start.y && line[index+1]!.y===segment.end.x && line[index+1]!.z===segment.end.y))).toBe(true);
      }
    }
    expect(outlines.some(line=>line.some(p=>p.y<0))).toBe(true);
    expect(outlines.some(line=>line.some(p=>p.y>0))).toBe(true);
    // Poison only Cesium-owned output; neither static nor pose caches may borrow it.
    first.plates[0]!.polygons[0]!.geometry.attributes.position!.values[0]=123;
    first.plates[0]!.polygons[0]!.outlineRings[0]![0]!.x=1;
    const next=await build({x:0,y:0,z:Math.sin(0.04),w:Math.cos(0.04)});
    expect(frameOutput(next)).not.toEqual(original);
    const repeated=await build(identity);
    expect(frameOutput(repeated)).toEqual(original);
    expect(repeated.mollweideStats.coldSnapshots).toBe(0);
    expect(hash({positions:Array.from(snapshot.positions),indices:Array.from(snapshot.indices),exterior:snapshot.exterior,holes:snapshot.holes})).toBe(before);
  });
});
