import { describe, expect, it, vi } from "vitest";
import type { Vec3 } from "@timemachine/reconstruction-core";
import { refineMollweideFaces, signedSphericalArea } from "../../packages/cesium-runtime/src/mollweide-refinement";

const fixture = () => {
  const positions=new Float64Array([
    -0.6125983907587035,0.17256207608703655,-0.7713271300404122,
    -0.6061061071801722,0.16992994119750496,-0.7770194347141584,
    -0.6134662501035464,0.17289892999925452,-0.7705615614530783,
    -0.60,0.18,-0.78,
  ]);
  const n=Math.hypot(...positions.subarray(9));
  for(let i=9;i<12;i++)positions[i]=positions[i]!/n;
  return {positions,indices:new Uint16Array([0,1,2,2,1,3])};
};
const pose=(angle:number,tilt=0)=>(p:Vec3):Vec3=>{
  const x=p.x*Math.cos(angle)-p.y*Math.sin(angle),y=p.x*Math.sin(angle)+p.y*Math.cos(angle);
  const z=p.z*Math.cos(tilt)-x*Math.sin(tilt),rx=x*Math.cos(tilt)+p.z*Math.sin(tilt),n=Math.hypot(rx,y,z);
  return {x:rx/n,y:y/n,z:z/n};
};
const rotate=(source:Float64Array,f:(p:Vec3)=>Vec3)=>{
  const out=new Float64Array(source.length);
  for(let i=0;i<source.length;i+=3){const p=f({x:source[i]!,y:source[i+1]!,z:source[i+2]!});out.set([p.x,p.y,p.z],i);}
  return out;
};

describe("bounded model-space refinement recipe",()=>{
  it("revalidates current poses, source-face coverage, winding and conforming shared endpoints",async()=>{
    const {positions,indices}=fixture(),before=positions.slice(),indexBefore=indices.slice();
    const status=vi.fn();
    const build=(angle:number,tilt=0,reuseRecipe=true)=>refineMollweideFaces(rotate(positions,pose(angle,tilt)),indices,[0],String,new AbortController().signal,async()=>{},
      {sourcePositions:positions,rotateSource:pose(angle,tilt),reuseRecipe,onRecipe:status});
    await build(0);
    expect(status).toHaveBeenLastCalledWith("miss");
    for(const [angle,tilt] of [[0,0],[0.00001,0],[0.3,0],[0.31,0],[0.4,0],[-0.8,0],[2.7,0],[0.275,-0.67],[0,0]] as const){
      const cached=await build(angle,tilt),plain=await build(angle,tilt,false);
      for(const [face,children]of cached){
        const plainChildren=plain.get(face);
        const area=children.reduce((n,c)=>n+signedSphericalArea(...c.vertices),0);
        // A reused conforming patch may retain a neighbour that the fresh
        // search no longer needs; compare against its original spherical face.
        const rotated=rotate(positions,pose(angle,tilt));
        const source=[0,1,2].map(i=>{const j=3*indices[3*face+i]!;return {x:rotated[j]!,y:rotated[j+1]!,z:rotated[j+2]!};}) as [Vec3,Vec3,Vec3];
        expect(area).toBeCloseTo(signedSphericalArea(...source),13);
        if(plainChildren)expect(area).toBeCloseTo(plainChildren.reduce((n,c)=>n+signedSphericalArea(...c.vertices),0),13);
        for(const child of children){
          expect(child.numericalDegenerate).not.toBe(true);
          expect(child.result.status).toBe("ok");
          for(const triangle of child.result.triangles){
            expect(triangle.sourceId).toBe(face);
            const [a,b,c]=triangle.vertices;
            expect(((b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x))*Math.sign(area)).toBeGreaterThan(0);
          }
        }
      }
      // Every shared spherical edge has the same exact endpoint objects' values;
      // no T-junction may split an edge in just one original source face.
      const all=[...cached.values()].flat();
      for(const child of all)for(let e=0;e<3;e++){
        const a=child.vertices[e]!,b=child.vertices[(e+1)%3]!;
        const mid={x:a.x+b.x,y:a.y+b.y,z:a.z+b.z},n=Math.hypot(mid.x,mid.y,mid.z);
        expect(all.some(other=>other.vertices.some(v=>Math.hypot(v.x-mid.x/n,v.y-mid.y/n,v.z-mid.z/n)<1e-13))).toBe(false);
      }
    }
    expect(status.mock.calls.some(([s])=>s==="hit")).toBe(true);
    expect(positions).toEqual(before);expect(indices).toEqual(indexBefore);
  });

  it("does not publish aborted/failed attempts or cross source identity",async()=>{
    const {positions,indices}=fixture(),status=vi.fn(),rotateSource=pose(0);
    const run=(signal:AbortSignal,extra={})=>refineMollweideFaces(positions,indices,[0],String,signal,async()=>{},
      {sourcePositions:positions,rotateSource,onRecipe:status,...extra});
    await run(new AbortController().signal);
    const abort=new AbortController();abort.abort();
    await expect(run(abort.signal)).rejects.toMatchObject({name:"AbortError"});
    const during=new AbortController();
    await expect(refineMollweideFaces(positions,indices,[0],String,during.signal,async()=>{during.abort();},
      {sourcePositions:positions,rotateSource,onRecipe:status})).rejects.toMatchObject({name:"AbortError"});
    await run(new AbortController().signal);expect(status).toHaveBeenLastCalledWith("hit");
    await expect(run(new AbortController().signal,{maxDepth:0})).rejects.toThrow(/depth budget/);
    await run(new AbortController().signal);expect(status).toHaveBeenLastCalledWith("hit");
    await run(new AbortController().signal,{sourcePositions:positions.slice()});
    expect(status).toHaveBeenLastCalledWith("miss");
    await run(new AbortController().signal);expect(status).toHaveBeenLastCalledWith("miss");
    await run(new AbortController().signal);expect(status).toHaveBeenLastCalledWith("hit");
    // New seed outside the saved patch must go through normal conforming search.
    const separate=new Float64Array([...positions,1,0,0,0.99,0.1,0,0.99,0,0.1]);
    for(let i=12;i<separate.length;i+=3){const n=Math.hypot(...separate.subarray(i,i+3));for(let j=0;j<3;j++)separate[i+j]=separate[i+j]!/n;}
    const wider=new Uint16Array([...indices,4,5,6]);
    await refineMollweideFaces(separate,wider,[0],String,new AbortController().signal,async()=>{}, {sourcePositions:separate,rotateSource,onRecipe:status});
    await refineMollweideFaces(separate,wider,[2],String,new AbortController().signal,async()=>{}, {sourcePositions:separate,rotateSource,onRecipe:status});
    expect(status).toHaveBeenLastCalledWith("miss");
  });
});
