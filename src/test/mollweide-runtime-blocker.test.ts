import { describe, expect, it } from "vitest";
import { createProjection } from "../../packages/cesium-runtime/src/map-projection";
import { projectTriangle } from "../../packages/cesium-runtime/src/projected-triangle";
import { createSphericalAreaMeasurementCache, measureSphericalArea, numericalLeafUpperBound, refineMollweideFaces, signedSphericalArea, validateRefinedSphericalCoverage, validateSphericalCoverage } from "../../packages/cesium-runtime/src/mollweide-refinement";
import { projectMollweideRuntime } from "../../packages/cesium-runtime/src/plate-mollweide-frame";

describe("Mollweide runtime/reference integration evidence", () => {
  it("counts real 180 Ma source 889 in the frozen numerical-degenerate domain",async()=>{
    const values=new Float64Array([0.006924538170388071,-0.9275632300710874,0.37360206770201065,0.004396892585932343,-0.928616828299563,0.37101408805387365,0.002761321695505081,-0.9292915442514974,0.369336703950692]);
    const patch=await refineMollweideFaces(values,new Uint16Array([0,1,2]),[0],()=>"889",new AbortController().signal,async()=>{});
    const child = patch.get(0)![0]!;
    expect(child.result.status).toBe("degenerate");
    expect(child.numericalDegenerate).toBe(true);
    expect(Math.abs(signedSphericalArea(...child.vertices))).toBeLessThan(1e-14);
    expect(child.areaUpperBoundSteradians).toBeGreaterThanOrEqual(Math.abs(signedSphericalArea(...child.vertices)));
    expect(child.areaUpperBoundSteradians).toBeLessThan(1e-15);
  });
  it("retains real nondegenerate source 842 with recursive longest-edge midpoint splits", async () => {
    const a = {x:-.07128247414284442,y:-.08356014815677294,z:-.9939499537301126};
    const b = {x:-.08237572695051454,y:-.07338832520115658,z:-.9938955646010014};
    const c = {x:-.07066749857146253,y:-.0841060304270731,z:-.9939478257390839};
    const midpoint = (u: typeof a, v: typeof a) => {
      const n = Math.hypot(u.x+v.x,u.y+v.y,u.z+v.z);
      return {x:(u.x+v.x)/n,y:(u.y+v.y)/n,z:(u.z+v.z)/n};
    };
    const m=midpoint(b,c), n=midpoint(m,c), reference=createProjection("mollweide");
    const certified = [[b,m,a],[m,n,a],[n,c,a]] as const;
    expect(certified.every(points=>projectTriangle(points[0],points[1],points[2],842,reference).status==="ok")).toBe(true);
    expect(Math.abs(validateSphericalCoverage([a,b,c],certified).coveredArea-signedSphericalArea(a,b,c))).toBeLessThan(2e-20);
    const values=new Float64Array([a,b,c].flatMap(p=>[p.x,p.y,p.z]));
    const patch=await refineMollweideFaces(values,new Uint16Array([0,1,2]),[0],()=>"GPlates-9486c1fa-a6d6-494f-973a-f246becd1697#0#842",new AbortController().signal,async()=>{},{maxDepth:2});
    expect(patch.get(0)).toHaveLength(3);
    expect(patch.get(0)!.map(child=>child.vertices)).toEqual(certified);
    expect(patch.get(0)!.every(child=>projectTriangle(...child.vertices,842,reference).status==="ok")).toBe(true);
    expect(patch.get(0)!.every(child=>child.result.status==="ok"&&!child.numericalDegenerate)).toBe(true);
    const budget=validateRefinedSphericalCoverage([a,b,c],patch.get(0)!);
    expect(budget.omittedCount).toBe(0);
    expect(budget.omissionCap).toBeCloseTo(9.50941623e-15,22);
    expect(()=>validateRefinedSphericalCoverage([a,b,c],patch.get(0)!.slice(0,2))).toThrow(/conserve/);
    expect(()=>validateRefinedSphericalCoverage([a,b,c],patch.get(0)!.map((child,i)=>i===2?{...child,numericalDegenerate:true,areaUpperBoundSteradians:Math.abs(signedSphericalArea(...child.vertices))}:child))).toThrow(/certificate/);
    validateSphericalCoverage([a,b,c],patch.get(0)!.map(child=>child.vertices));
  });
  it("retains both seam pieces below the frozen planar area floor without dropping source 169",async()=>{
    // Actual 25.63 Ma conforming patch: a nondegenerate source, but its small
    // negative-hemisphere piece is below 3B's fixed dimensionless planar floor.
    const points=[{x:-.37377037898292287,y:.000005494094226418272,z:.9275212686320338},
      {x:-.3737749474939294,y:.0000028569524091422,z:.9275194276228117},
      {x:-.3737730675465835,y:-3.301282010690889e-8,z:.9275201852126002}] as const;
    const frozen=projectTriangle(points[0],points[1],points[2],169,createProjection("mollweide"));
    expect(frozen.status).toBe("unsupported");
    expect(frozen.reason).toMatch(/loses the source orientation/);
    const values=new Float64Array(points.flatMap(p=>[p.x,p.y,p.z])),untouched=values.slice();
    const patch=await refineMollweideFaces(values,new Uint16Array([0,1,2]),[0],()=>"seam#169",new AbortController().signal,async()=>{});
    const leaves=patch.get(0)!;
    expect(leaves).toHaveLength(1);
    expect(validateRefinedSphericalCoverage(points,leaves).omittedCount).toBe(0);
    const triangles=leaves.flatMap(child=>child.result.triangles);
    expect(new Set(triangles.map(t=>t.hemisphere))).toEqual(new Set([-1,1]));
    expect(triangles).toHaveLength(3);
    const winding=Math.sign(signedSphericalArea(...points));
    for(const triangle of triangles){
      const [a,b,c]=triangle.vertices;
      const positive=(b.x-a.x)*(c.y-a.y),negative=(b.y-a.y)*(c.x-a.x);
      expect((positive-negative)*winding).toBeGreaterThan(8*Number.EPSILON*(Math.abs(positive)+Math.abs(negative)));
    }
    expect(values).toEqual(untouched);
  });
  it("bounds accumulated leaf omissions per original source and rejects false certificates", () => {
    const a={x:1,y:0,z:0}, b={x:Math.cos(.01),y:Math.sin(.01),z:0}, c={x:Math.cos(.01),y:0,z:Math.sin(.01)};
    const source=[a,b,c] as const, reference=createProjection("mollweide");
    const point=(t:number)=>{
      const x=b.x+(c.x-b.x)*t,y=b.y+(c.y-b.y)*t,z=b.z+(c.z-b.z)*t,n=Math.hypot(x,y,z);
      return {x:x/n,y:y/n,z:z/n};
    };
    const p=point(1.15615e-10),q=point(2.31230e-10);
    const child=(vertices:readonly [typeof a,typeof a,typeof a],omitted=false)=>({vertices,
      result:projectTriangle(...vertices,0,reference),numericalDegenerate:omitted,
      areaUpperBoundSteradians:omitted?numericalLeafUpperBound(vertices):undefined});
    const tiny=child([a,b,p],true),tiny2=child([a,p,q],true),rest=child([a,p,c]),rest2=child([a,q,c]);
    expect(tiny.result.status).toBe("degenerate");
    expect(tiny.areaUpperBoundSteradians).toBeGreaterThan(5.7e-15);
    expect(tiny.areaUpperBoundSteradians).toBeLessThan(5.9e-15);
    expect(validateRefinedSphericalCoverage(source,[tiny,rest]).omittedCount).toBe(1);
    expect(()=>validateRefinedSphericalCoverage(source,[tiny,tiny2,rest2])).toThrow(/source budget/);
    expect(()=>validateRefinedSphericalCoverage(source,[{...tiny,areaUpperBoundSteradians:Infinity},rest])).toThrow(/finite/);
    expect(()=>validateRefinedSphericalCoverage(source,[{...tiny,result:{...tiny.result,status:"unsupported"}},rest])).toThrow(/certificate/);
    expect(numericalLeafUpperBound([{x:NaN,y:0,z:0},b,p])).toBeUndefined();
    expect(numericalLeafUpperBound([a,{x:-1,y:0,z:0},c])).toBeUndefined();
    const reversed=child([a,c,b]);
    expect(reversed.result.status).toBe("ok");
    expect(()=>validateRefinedSphericalCoverage(source,[reversed])).toThrow(/orientation/);
    const measure=createSphericalAreaMeasurementCache();
    expect(validateRefinedSphericalCoverage(source,[tiny,rest],measure)).toEqual(validateRefinedSphericalCoverage(source,[tiny,rest]));
    expect(()=>validateRefinedSphericalCoverage(source,[tiny,tiny2,rest2],measure)).toThrow(/source budget/);
    expect(()=>validateRefinedSphericalCoverage(source,[{...tiny,areaUpperBoundSteradians:Infinity},rest],measure)).toThrow(/finite/);
    expect(()=>validateRefinedSphericalCoverage(source,[{...tiny,result:{...tiny.result,status:"unsupported"}},rest],measure)).toThrow(/certificate/);
    expect(()=>validateRefinedSphericalCoverage(source,[reversed],measure)).toThrow(/orientation/);
  });
  it("certifies real central-meridian sliver 2478",async()=>{
    const values=new Float64Array([0.17300776295471695,-0.0020699096669768145,0.984918285662001,0.16577569208507426,-0.0071088702650409065,0.9861378625107493,0.17901607512186954,0.002097778624905265,0.9838439125048251]);
    const patch=await refineMollweideFaces(values,new Uint16Array([0,1,2]),[0],()=>"2478",new AbortController().signal,async()=>{});
    expect(patch.get(0)!.every(child=>child.result.status==="ok")).toBe(true);
  });
  it("uses an audited numerical bound for a rounded tiny original source",async()=>{
    const values=new Float64Array([0.006909058625949433,-0.008813982874066782,0.9999372873409607,0.006909237546216087,-0.008814211159290172,0.9999372840924421,0.00690914775113577,-0.008814096589182103,0.9999372857227946]);
    const patch = await refineMollweideFaces(values,new Uint16Array([0,1,2]),[0],()=>"tiny conforming 4218",new AbortController().signal,async()=>{});
    const child = patch.get(0)![0]!;
    expect(child.numericalDegenerate).toBe(true);
    const measurement = measureSphericalArea(...child.vertices);
    expect(child.areaUpperBoundSteradians).toBeCloseTo(Math.abs(measurement.area) + measurement.roundingBound, 30);
  });
  it("certifies the real near-pole narrow 4218 face without dropping tiny children",async()=>{
    const values=new Float64Array([0.007732820583575414,-0.0098623435562615,0.9999214657488861,6.123233995736766e-17,0,1,0.010190276935782817,-0.013000010442829061,0.999863569685614]);
    const patch=await refineMollweideFaces(values,new Uint16Array([0,1,2]),[0],()=>"GPlates-4e33738c-136a-4d4f-9bca-64a179cc2967#0#4218",new AbortController().signal,async()=>{});
    expect(patch.get(0)!.every(child=>child.result.status==="ok")).toBe(true);
  });
  it("rejects deliberately lost visible source coverage and reversed children", () => {
    const a = {x:1,y:0,z:0}, b = {x:0.8,y:0.6,z:0}, c = {x:0.8,y:0,z:0.6};
    const source = [a,b,c] as const;
    expect(() => validateSphericalCoverage(source, [])).toThrow(/conserve/);
    const n = Math.hypot(b.x+c.x, b.y+c.y, b.z+c.z);
    const midpoint = {x:(b.x+c.x)/n, y:(b.y+c.y)/n, z:(b.z+c.z)/n};
    expect(() => validateSphericalCoverage(source, [[a,b,midpoint]])).toThrow(/conserve/);
    expect(() => validateSphericalCoverage(source, [[a,c,b]])).toThrow(/orientation/);
    expect(validateSphericalCoverage(source, [source]).coveredArea).toBe(signedSphericalArea(...source));
    expect(measureSphericalArea(...source).roundingBound).toBeLessThan(1e-12);
  });

  it("never reclassifies invalid directions or unsupported long arcs as numerical degenerates", async () => {
    for (const values of [new Float64Array([1,0,0,-1,0,0,0,1,0]), new Float64Array([NaN,0,0,1,0,0,0,1,0])]) {
      await expect(refineMollweideFaces(values,new Uint16Array([0,1,2]),[0],()=>"bad-source",new AbortController().signal,async()=>{})).rejects.toThrow(/bad-source.*(unsupported|invalid)/);
    }
  });

  it("uses the theta table only as a Newton seed, not as an approximate projection",()=>{
    const reference=createProjection("mollweide");
    let maxError=0;
    for(let i=0;i<=35600;i++){
      const latitude=-89+i*.005;
      const actual=projectMollweideRuntime(179.123,latitude),expected=reference.projectRelative(179.123,latitude);
      maxError=Math.max(maxError,Math.hypot(actual.x-expected.x,actual.y-expected.y));
    }
    console.log("Mollweide theta-seed maximum reference error metres",maxError);
    expect(maxError).toBeLessThan(1e-6);
    for(const [lon,lat] of [[NaN,0],[0,NaN],[181,0],[0,91]])expect(()=>projectMollweideRuntime(lon!,lat!)).toThrow(RangeError);
    expect(Object.is(projectMollweideRuntime(-0,0).x,-0)).toBe(true);
    expect(Object.is(projectMollweideRuntime(0,-0).y,-0)).toBe(true);
  });
  it("matches the frozen forward oracle, including near-pole samples", () => {
    const reference = createProjection("mollweide");
    for (const lat of [-90, -89.9999999, -89.5, -89, -70, -30, 0, 30, 70, 89, 89.5, 89.9999999, 90]) {
      for (const lon of [-180, -179.999, -90, 0, 90, 179.999, 180]) {
        const expected = reference.projectRelative(lon, lat);
        const actual = projectMollweideRuntime(lon, lat);
        expect(Math.hypot(actual.x - expected.x, actual.y - expected.y)).toBeLessThan(1e-6);
      }
    }
  });

  it("keeps the real PALEOMAP 0 Ma oracle rejection, but refines a conforming runtime patch", async () => {
    // Source: GPlates-16c50bd7-f067-4348-b4aa-10002f0229d1#0#412.
    // Captured from the actual retained Cesium mesh, rotated at 0 Ma in the production browser.
    const a = { x: -0.6125983907587035, y: 0.17256207608703655, z: -0.7713271300404122 };
    const b = { x: -0.6061061071801722, y: 0.16992994119750496, z: -0.7770194347141584 };
    const c = { x: -0.6134662501035464, y: 0.17289892999925452, z: -0.7705615614530783 };
    const reference = createProjection("mollweide");
    const expected = projectTriangle(a, b, c, 412, reference);
    const actual = projectTriangle(a, b, c, 412, { ...reference, projectRelative: projectMollweideRuntime });
    expect(expected.status).toBe("unsupported");
    expect(expected.reason).toMatch(/loses the source orientation/);
    expect(actual.status).toBe(expected.status);
    expect(actual.reason).toBe(expected.reason);

    const d = {x:-0.60,y:0.18,z:-0.78};
    const n = Math.hypot(d.x,d.y,d.z);d.x/=n;d.y/=n;d.z/=n;
    // BC is the longest edge. Its neighbour uses CB in the opposite order.
    const positions = new Float64Array([a.x,a.y,a.z,b.x,b.y,b.z,c.x,c.y,c.z,d.x,d.y,d.z]);
    const indices = new Uint16Array([0,1,2,2,1,3]);
    const untouched = positions.slice();
    const patch = await refineMollweideFaces(positions,indices,[0],face=>`GPlates-16c50bd7-f067-4348-b4aa-10002f0229d1#0#${face===0?412:413}`,new AbortController().signal,async()=>{});
    expect(patch.size).toBe(2);
    const area = signedSphericalArea(a,b,c);
    const children = patch.get(0)!;
    expect(children).toHaveLength(2);
    expect(children.every(child=>child.result.status==="ok")).toBe(true);
    const sum=children.reduce((total,child)=>total+signedSphericalArea(...child.vertices),0);
    expect(Math.abs(sum/area-1)).toBeLessThan(1e-8);
    for(const [face,leaves] of patch){
      const original=face===0?[a,b,c]:[c,b,d];
      for(const child of leaves)expect(Math.sign(signedSphericalArea(...child.vertices))).toBe(Math.sign(signedSphericalArea(original[0]!,original[1]!,original[2]!)));
    }
    const midpoint=children[0]!.vertices.find(p=>![a,b,c].some(v=>v.x===p.x&&v.y===p.y&&v.z===p.z))!;
    expect(patch.get(1)!.filter(child=>child.vertices.includes(midpoint))).toHaveLength(2);
    const sharedSegments=(leaves:typeof children)=>{
      const normal={x:b.y*c.z-b.z*c.y,y:b.z*c.x-b.x*c.z,z:b.x*c.y-b.y*c.x};
      const onEdge=(v:typeof a)=>Math.abs(normal.x*v.x+normal.y*v.y+normal.z*v.z)<1e-14;
      const key=(v:typeof a)=>`${v.x}/${v.y}/${v.z}`;
      return leaves.flatMap(child=>child.vertices.flatMap((v,i)=>{
        const w=child.vertices[(i+1)%3]!;
        return onEdge(v)&&onEdge(w)?[[key(v),key(w)].sort().join("|")]:[];
      })).sort();
    };
    expect(sharedSegments(patch.get(1)!)).toEqual(sharedSegments(children));
    expect(sharedSegments(children)).toHaveLength(2);
    expect(positions).toEqual(untouched);
    // A retained mesh may duplicate positions at a polygon boundary. Canonical
    // endpoint identity still propagates the same split to the aliased edge.
    const duplicated = new Float64Array([a,b,c,c,b,d].flatMap(p => [p.x,p.y,p.z]));
    const aliased = await refineMollweideFaces(duplicated,new Uint16Array([0,1,2,3,4,5]),[0],face=>`aliased#${face}`,new AbortController().signal,async()=>{});
    expect(aliased.size).toBe(2);
    const shared = aliased.get(0)![0]!.vertices.find(p => ![a,b,c].some(v => v.x===p.x && v.y===p.y && v.z===p.z))!;
    expect(aliased.get(1)!.filter(child => child.vertices.includes(shared))).toHaveLength(2);
    await expect(refineMollweideFaces(positions,indices,[0],()=>"real-source#412",new AbortController().signal,async()=>{},{maxDepth:0})).rejects.toThrow(/real-source#412.*depth budget/);
    await expect(refineMollweideFaces(positions,indices,[0],()=>"real-source#412",new AbortController().signal,async()=>{},{maxNewTriangles:0})).rejects.toThrow(/real-source#412.*triangle budget/);
    const abort=new AbortController();abort.abort();
    await expect(refineMollweideFaces(positions,indices,[0],()=>"real-source#412",abort.signal,async()=>{})).rejects.toMatchObject({name:"AbortError"});
  });
});
