import { BoundingSphere, Cartesian3, ComponentDatatype, Geometry, GeometryAttribute, GeometryAttributes, Matrix4, PrimitiveType } from "cesium";
import { isFeatureValidAtTime, type Quaternion, type Vec3 } from "@timemachine/reconstruction-core";
import { EARTH_RADIUS_METRES } from "./geometry";
import type { ProjectedPoint } from "./map-projection";
import { mollweideRuntimeProjection as runtimeProjection, projectMollweideRuntime as projectRuntime } from "./mollweide-runtime-projection";
import { clipTriangleToHemispheres, projectSegment } from "./projected-geometry";
import { projectTriangle } from "./projected-triangle";
import { measureSphericalArea, memoizeMollweideProjection, refineMollweideFaces, signedSphericalArea } from "./mollweide-refinement";
import { plateTriangleSourceId, type PlatePolygonMeshSnapshot } from "./plate-mesh-snapshot";
import { quaternionToCesiumMatrix } from "./plate-rotation-matrix";
import type { RectanglePlateCpuFrame, RectanglePlateCpuPolygon } from "./plate-rectangle-frame";

export const MOLLWEIDE_DEPTH = 8 * EARTH_RADIUS_METRES;
const mollweideScale=Math.SQRT2*EARTH_RADIUS_METRES;
let thetaSeeds:Float64Array|undefined;

/** A table seeds Newton only; every vertex solves the equation anew. */
export function projectMollweideRuntime(longitude:number,latitude:number,out:{x:number;y:number}={x:0,y:0}):ProjectedPoint {
  if(!Number.isFinite(longitude)||Math.abs(longitude)>180||!Number.isFinite(latitude)||Math.abs(latitude)>89){
    const point=projectRuntime(longitude,latitude);
    out.x=point.x;out.y=point.y;return out;
  }
  if(!thetaSeeds){
    thetaSeeds=Float64Array.from({length:179},(_,i)=>Math.asin(projectRuntime(0,i/2).y/mollweideScale));
  }
  const at=Math.abs(latitude)*2,lower=Math.floor(at),upper=Math.min(178,lower+1);
  let theta=(thetaSeeds[lower]!+(thetaSeeds[upper]!-thetaSeeds[lower]!)*(at-lower))*Math.sign(latitude);
  const target=Math.PI*Math.sin(latitude*Math.PI/180);
  for(let iteration=0;iteration<8;iteration++){
    const correction=(2*theta+Math.sin(2*theta)-target)/(2+2*Math.cos(2*theta));
    theta-=correction;
    if(Math.abs(correction)<3e-16)break;
    if(iteration===7){
      const point=projectRuntime(longitude,latitude);
      out.x=point.x;out.y=point.y;return out;
    }
  }
  out.x=2*mollweideScale/Math.PI*longitude*Math.PI/180*Math.cos(theta);
  out.y=mollweideScale*Math.sin(theta);
  return out;
}
export interface NumericalDegenerateSource {
  sourceId: string;
  signedAreaSteradians: number;
  areaUpperBoundSteradians: number;
}
interface CachedMesh {
  ringDirections: readonly (readonly Vec3[])[];
  unit: Float64Array;
  projectionSources: Uint32Array;
  certificate: Int8Array;
  numericalDegenerates: NumericalDegenerateSource[];
}
const cache = new WeakMap<PlatePolygonMeshSnapshot, CachedMesh>();
export interface MollweideFrameStats {
  timeMa: number;
  inputVertices: number;
  inputTriangles: number;
  outputTriangles: number;
  fastTriangles: number;
  exceptionalTriangles: number;
  degenerateTriangles: number;
  coldSnapshots: number;
  cacheMs: number;
  vertexMs: number;
  triangleMs: number;
  outlineMs: number;
  geometryMs: number;
  refinementMs: number;
  refinementRecipeHits: number;
  refinementRecipeMisses: number;
  refinementSourceFaces: number;
  refinementLeafCount: number;
  numericalDegenerateCount: number;
  numericalDegenerateAreaSteradians: number;
  numericalDegenerateAreaUpperBoundSteradians: number;
  numericalDegenerateSources: NumericalDegenerateSource[];
  refinementDegenerateCount: number;
  refinementDegenerateAreaUpperBoundSteradians: number;
}
export interface MollweideCpuFrame extends RectanglePlateCpuFrame {
  readonly mollweideStats: MollweideFrameStats;
}
export interface MollweideCpuPolygon extends RectanglePlateCpuPolygon {
  readonly sourceTriangleIndices: Uint32Array;
}

function vector(values: Float64Array, index: number): Vec3 {
  return { x: values[3 * index]!, y: values[3 * index + 1]!, z: values[3 * index + 2]! };
}

function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/** Indexed vertex projection plus conservative fast faces; exceptional faces use the accepted oracle. */
export async function buildMollweidePlateCpuFrame(snapshots: readonly PlatePolygonMeshSnapshot[], timeMa: number, rotations: ReadonlyMap<number, Quaternion>, signal: AbortSignal, options: { reuseRecipe?: boolean } = {}): Promise<MollweideCpuFrame> {
  if (!Number.isFinite(timeMa)) throw new Error("Mollweide requires a finite age.");
  const start=performance.now();
  const stats: MollweideFrameStats = {
    timeMa,
    inputVertices: 0, inputTriangles: 0, outputTriangles: 0,
    fastTriangles: 0, exceptionalTriangles: 0, degenerateTriangles: 0,
    coldSnapshots: 0, cacheMs: 0, vertexMs: 0, triangleMs: 0, outlineMs: 0, geometryMs: 0,
    refinementMs: 0, refinementRecipeHits: 0, refinementRecipeMisses: 0, refinementSourceFaces: 0, refinementLeafCount: 0,
    numericalDegenerateCount: 0,
    numericalDegenerateAreaSteradians: 0,
    numericalDegenerateAreaUpperBoundSteradians: 0,
    numericalDegenerateSources: [],
    refinementDegenerateCount: 0,
    refinementDegenerateAreaUpperBoundSteradians: 0,
  };
  const pinned=new Map([...rotations].map(([id,q])=>[id,{...q}]));
  const validity=new Map(snapshots.map(s=>[s.feature,isFeatureValidAtTime(s.feature,timeMa)]));
  const groups=new Map<number,{ plateId:number; hasRotation:boolean; rotationMatrix:Matrix4; polygons:MollweideCpuPolygon[] }>();
  const activeFeatures=new Set<string>(), activePlates=new Set<number>();
  let disconnected=0, positionBytes=0,indexBytes=0,vertices=0,rings=0,outlinePoints=0;
  const channel=typeof globalThis.MessageChannel==="function" ? new globalThis.MessageChannel():undefined;
  let lastYield=performance.now();
  let cancelYield: (()=>void)|undefined;
  const check = (): void => {
    if (signal.aborted) throw new DOMException("Mollweide preparation aborted", "AbortError");
  };
  const yieldTask=async ():Promise<void>=>{
    check();
    if(performance.now()-lastYield<6) return;
    await new Promise<void>((resolve,reject)=>{
      let timer:ReturnType<typeof setTimeout>|undefined;
      const finish = (aborted = false): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (channel) channel.port1.onmessage = null;
        signal.removeEventListener("abort", abort);
        cancelYield = undefined;
        if (aborted) reject(new DOMException("Mollweide preparation aborted", "AbortError"));
        else resolve();
      };
      const abort = (): void => finish(true);
      cancelYield = abort;
      signal.addEventListener("abort", abort, { once: true });
      if (channel) {
        channel.port1.onmessage = () => finish();
        channel.port2.postMessage(null);
      } else {
        timer = setTimeout(() => finish(), 0);
      }
    });
    lastYield = performance.now();
    check();
  };
  try {
    check();
    for(const snapshot of snapshots){
      check();
      let group=groups.get(snapshot.plateId);
      if (!group) {
        const q = pinned.get(snapshot.plateId);
        group = {
          plateId: snapshot.plateId,
          hasRotation: !!q,
          rotationMatrix: Matrix4.clone(Matrix4.IDENTITY),
          polygons: [],
        };
        if (q) quaternionToCesiumMatrix(q, group.rotationMatrix);
        groups.set(snapshot.plateId, group);
      }
      const timeValid=validity.get(snapshot.feature)!;
      if (timeValid && group.hasRotation) {
        activeFeatures.add(snapshot.feature.id);
        activePlates.add(snapshot.plateId);
      } else if (timeValid) {
        disconnected++;
      }
      // Invalid/disconnected polygons have no visible geometry; no work or fake copies required.
      if(!timeValid || !group.hasRotation) continue;
      let mark=performance.now();
      let cached=cache.get(snapshot);
      if(!cached){
        stats.coldSnapshots++;
        const unit=new Float64Array(snapshot.positions.length), cert=new Int8Array(snapshot.triangleCount);
        const projectionSources=new Uint32Array(snapshot.vertexCount);
        const identicalDirections=new Map<string,number>();
        const exactKey=(value:number):string=>Object.is(value,-0)?"-0":String(value);
        for (let i = 0; i < unit.length; i += 3) {
          const n = Math.hypot(snapshot.positions[i]!, snapshot.positions[i + 1]!, snapshot.positions[i + 2]!);
          if (!Number.isFinite(n) || n === 0) throw new Error(`${snapshot.feature.id}: invalid source vertex ${i / 3}`);
          unit[i] = snapshot.positions[i]! / n;
          unit[i + 1] = snapshot.positions[i + 1]! / n;
          unit[i + 2] = snapshot.positions[i + 2]! / n;
          // Exact normalized triples only, including signed zero. Reusing their
          // projection is independent of age, never an approximate pose cache.
          const key=`${exactKey(unit[i]!)}|${exactKey(unit[i+1]!)}|${exactKey(unit[i+2]!)}`;
          const prior=identicalDirections.get(key);
          projectionSources[i/3]=prior??i/3;
          if(prior===undefined)identicalDirections.set(key,i/3);
          if (i % 3072 === 0) await yieldTask();
        }
        const numericalDegenerates: NumericalDegenerateSource[] = [];
        for (let face = 0; face < cert.length; face++) {
          const a = snapshot.indices[3 * face]!;
          const b = snapshot.indices[3 * face + 1]!;
          const c = snapshot.indices[3 * face + 2]!;
          const points = [vector(unit, a), vector(unit, b), vector(unit, c)] as const;
          const sourceArea = signedSphericalArea(...points);
          // Mirror the frozen source tolerance, never the planar-area tolerance.
          // The oracle must ALSO classify the original source as degenerate;
          // invalid directions and unsupported arcs cannot be silently omitted.
          if (Math.abs(sourceArea) <= 1e-14) {
            const oracle = clipTriangleToHemispheres(...points, face);
            if (oracle.status === "degenerate") {
              const measurement = measureSphericalArea(...points);
              cert[face] = 2;
              numericalDegenerates.push({
                sourceId: plateTriangleSourceId(snapshot, face),
                signedAreaSteradians: measurement.area,
                areaUpperBoundSteradians: Math.abs(measurement.area) + measurement.roundingBound,
              });
            } else if (oracle.status !== "ok") {
              throw new Error(`${plateTriangleSourceId(snapshot, face)}: ${oracle.status}: ${oracle.reason}`);
            }
          }
          if (cert[face] !== 2 && Math.abs(sourceArea) > 1e-14 &&
              Math.min(dot(points[0],points[1]),dot(points[1],points[2]),dot(points[2],points[0])) > 0.001) {
            cert[face] = Math.sign(sourceArea);
          }
          if (face % 1024 === 0) await yieldTask();
        }
        const ringDirections = [snapshot.exterior,...snapshot.holes].map(source=>{
          let count=source.length;
          while(count>1 && source[0]![0]===source[count-1]![0] && source[0]![1]===source[count-1]![1])count--;
          return source.slice(0,count).map(coordinate=>{
            const lon=coordinate[0]!*Math.PI/180,lat=coordinate[1]!*Math.PI/180;
            return {x:Math.cos(lat)*Math.cos(lon),y:Math.cos(lat)*Math.sin(lon),z:Math.sin(lat)};
          });
        });
        cached = { unit, projectionSources, certificate: cert, numericalDegenerates, ringDirections };
        cache.set(snapshot, cached);
      }
      stats.numericalDegenerateCount += cached.numericalDegenerates.length;
      for (const source of cached.numericalDegenerates) {
        stats.numericalDegenerateAreaSteradians += Math.abs(source.signedAreaSteradians);
        stats.numericalDegenerateAreaUpperBoundSteradians += source.areaUpperBoundSteradians;
        stats.numericalDegenerateSources.push(source);
      }
      stats.cacheMs += performance.now() - mark;
      mark = performance.now();
      const rotated=new Float64Array(cached.unit.length), xy=new Float64Array(snapshot.vertexCount*2);
      // Frame-local owned buffers: Cesium never receives cached source storage.
      // Keep indexed storage fixed; grow only the exceptional append buffer,
      // avoiding repeated copies (and retained spare capacity) of the full mesh.
      const output=new Float64Array(cached.unit.length);
      const m=group.rotationMatrix;
      const projected={x:0,y:0};
      for(let i=0;i<snapshot.vertexCount;i++){
        const prior=cached.projectionSources[i]!;
        if(prior!==i){
          for(let axis=0;axis<3;axis++){
            rotated[3*i+axis]=rotated[3*prior+axis]!;
            output[3*i+axis]=output[3*prior+axis]!;
          }
          xy[2*i]=xy[2*prior]!;xy[2*i+1]=xy[2*prior+1]!;
        }else{
          const x=cached.unit[3*i]!,y=cached.unit[3*i+1]!,z=cached.unit[3*i+2]!;
          let rx=m[0]!*x+m[4]!*y+m[8]!*z,ry=m[1]!*x+m[5]!*y+m[9]!*z,rz=m[2]!*x+m[6]!*y+m[10]!*z;
          const n = Math.hypot(rx, ry, rz);
          rx /= n;
          ry /= n;
          rz /= n;
          rotated[3 * i] = rx;
          rotated[3 * i + 1] = ry;
          rotated[3 * i + 2] = rz;
          const p=projectMollweideRuntime(Math.atan2(ry,rx)*180/Math.PI,Math.atan2(rz,Math.hypot(rx,ry))*180/Math.PI,projected);
          xy[2 * i] = p.x;
          xy[2 * i + 1] = p.y;
          output[3 * i] = MOLLWEIDE_DEPTH;
          output[3 * i + 1] = p.x;
          output[3 * i + 2] = p.y;
        }
        if(i%1024===0)await yieldTask();
      }
      stats.vertexMs += performance.now() - mark;
      mark = performance.now();
      let indices=new Uint32Array(snapshot.indices.length + 96);
      let mapping=new Uint32Array(indices.length / 3);
      let triangleCount=0;
      let extra=new Float64Array(96), extraLength=0;
      const appendIndices=(a:number,b:number,c:number,face:number):void=>{
        if(3*triangleCount===indices.length){
          const grown=new Uint32Array(indices.length*2);
          grown.set(indices);indices=grown;
          const sources=new Uint32Array(mapping.length*2);
          sources.set(mapping);mapping=sources;
        }
        const at=3*triangleCount;
        indices[at]=a;indices[at+1]=b;indices[at+2]=c;
        mapping[triangleCount++]=face;
      };
      const appendTriangle=(points:readonly ProjectedPoint[],face:number):void=>{
        if(extraLength+9>extra.length){
          const grown=new Float64Array(extra.length*2);
          grown.set(extra);extra=grown;
        }
        const offset=snapshot.vertexCount+extraLength/3;
        for(const point of points){
          extra[extraLength++]=MOLLWEIDE_DEPTH;
          extra[extraLength++]=point.x;
          extra[extraLength++]=point.y;
        }
        appendIndices(offset,offset+1,offset+2,face);
      };
      const refinementSeeds:number[]=[];
      const frameProjection=memoizeMollweideProjection(runtimeProjection);
      const fastFaces=new Uint8Array(snapshot.triangleCount);
      for(let face=0;face<snapshot.triangleCount;face++){
        if (cached.certificate[face] === 2) {
          stats.degenerateTriangles++;
          continue;
        }
        const a=snapshot.indices[3*face]!,b=snapshot.indices[3*face+1]!,c=snapshot.indices[3*face+2]!;
        const ya=rotated[3*a+1]!,yb=rotated[3*b+1]!,yc=rotated[3*c+1]!;
        const ax=xy[2*a]!,ay=xy[2*a+1]!,bx=xy[2*b]!,by=xy[2*b+1]!,cx=xy[2*c]!,cy=xy[2*c+1]!;
        const area=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
        const winding=cached.certificate[face]!;
        const sameHalfSpace = (ya > 1e-10 && yb > 1e-10 && yc > 1e-10) ||
          (ya < -1e-10 && yb < -1e-10 && yc < -1e-10);
        const areaError = 8 * Number.EPSILON * (
          Math.abs((bx - ax) * (cy - ay)) + Math.abs((by - ay) * (cx - ax))
        );
        if (winding !== 0 && sameHalfSpace && Number.isFinite(area) && area * winding > areaError &&
            Math.min((ax-bx)**2+(ay-by)**2,(bx-cx)**2+(by-cy)**2,(cx-ax)**2+(cy-ay)**2) > 1e-10) {
          appendIndices(a,b,c,face);
          fastFaces[face] = 1;
          stats.fastTriangles++;
        }else{
          stats.exceptionalTriangles++;
          const result=projectTriangle(vector(rotated,a),vector(rotated,b),vector(rotated,c),face,frameProjection);
          if(result.status!=="ok") refinementSeeds.push(face);
          else for (const triangle of result.triangles) {
            appendTriangle(triangle.vertices,face);
          }
        }
        if(face%1024===0)await yieldTask();
      }
      if(refinementSeeds.length){
        const refinementStart = performance.now();
        const refined = await refineMollweideFaces(
          rotated, snapshot.indices, refinementSeeds,
          face => plateTriangleSourceId(snapshot, face), signal, yieldTask,
          { sourceCertificates: cached.certificate, sourcePositions: cached.unit, reuseRecipe: options.reuseRecipe,
            onRecipe: status => { if (status === "hit") stats.refinementRecipeHits++; else stats.refinementRecipeMisses++; },
            rotateSource: ({x,y,z}) => {
              const rx=m[0]!*x+m[4]!*y+m[8]!*z,ry=m[1]!*x+m[5]!*y+m[9]!*z,rz=m[2]!*x+m[6]!*y+m[10]!*z;
              const n=Math.hypot(rx,ry,rz);
              return {x:rx/n,y:ry/n,z:rz/n};
            },
          },
        );
        stats.refinementMs += performance.now() - refinementStart;
        stats.refinementSourceFaces += refined.size;
        for (const children of refined.values()) stats.refinementLeafCount += children.length;
        for(const face of refined.keys()){
          if(fastFaces[face]===1)stats.fastTriangles--;
          fastFaces[face]=2;
        }
        // Delay replacement until the complete conforming patch succeeds. A
        // neighbour may already have taken the indexed fast path above.
        let write=0;
        for(let triangle=0;triangle<triangleCount;triangle++){
          if(fastFaces[mapping[triangle]!]===2)continue;
          indices[3*write]=indices[3*triangle]!;
          indices[3*write+1]=indices[3*triangle+1]!;
          indices[3*write+2]=indices[3*triangle+2]!;
          mapping[write++]=mapping[triangle]!;
        }
        triangleCount = write;
        for(const [face,children] of refined)for(const child of children){
          if (child.result.status === "degenerate" && child.numericalDegenerate) {
            stats.degenerateTriangles++;
            stats.refinementDegenerateCount++;
            stats.refinementDegenerateAreaUpperBoundSteradians += child.areaUpperBoundSteradians ?? 0;
            continue;
          }
          if(child.result.status!=="ok")throw new Error(`${plateTriangleSourceId(snapshot,face)}: refinement did not certify a nondegenerate child`);
          for(const triangle of child.result.triangles){
            appendTriangle(triangle.vertices,face);
          }
        }
      }
      stats.triangleMs += performance.now() - mark;
      mark = performance.now();
      const outlineRings:Cartesian3[][]=[];
      for(const [ringIndex,source]of cached.ringDirections.entries()){
        // Source directions are immutable and pose-independent; rotated values
        // live only in this frame and are never lent to Cesium as source buffers.
        const ring=source.map(({x,y,z})=>({
          x:m[0]!*x+m[4]!*y+m[8]!*z,
          y:m[1]!*x+m[5]!*y+m[9]!*z,
          z:m[2]!*x+m[6]!*y+m[10]!*z,
        }));
        let line:Cartesian3[]=[];
        let previous:ProjectedPoint|undefined;
        for(let edge=0;edge<ring.length;edge++){
          const result=projectSegment(ring[edge]!,ring[(edge+1)%ring.length]!,edge,frameProjection);
          if(result.status!=="ok"&&result.status!=="degenerate")throw new Error(`${snapshot.feature.id}/polygon/${snapshot.polygonIndex}/ring/${ringIndex}/edge/${edge}: ${result.status}: ${result.reason}`);
          for(const segment of result.segments){
            if (!previous || Math.hypot(previous.x - segment.start.x, previous.y - segment.start.y) > 1e-6) {
              if (line.length > 1) outlineRings.push(line);
              line = [new Cartesian3(MOLLWEIDE_DEPTH + 1000, segment.start.x, segment.start.y)];
            }
            line.push(new Cartesian3(MOLLWEIDE_DEPTH + 1000, segment.end.x, segment.end.y));
            previous = segment.end;
          }
          if(edge%128===0)await yieldTask();
        }
        if(line.length>1)outlineRings.push(line);
      }
      stats.outlineMs+=performance.now()-mark;
      mark = performance.now();
      const positions = extraLength ? new Float64Array(output.length+extraLength) : output;
      if(extraLength){
        positions.set(output);
        positions.set(extra.subarray(0,extraLength),output.length);
      }
      const usedIndices=indices.subarray(0,3*triangleCount);
      const typedIndices=positions.length/3>65536?usedIndices:new Uint16Array(usedIndices);
      const attributes = new GeometryAttributes();
      attributes.position = new GeometryAttribute({
        componentDatatype: ComponentDatatype.DOUBLE,
        componentsPerAttribute: 3,
        values: positions,
      });
      const geometry = new Geometry({
        attributes,
        indices: typedIndices,
        primitiveType: PrimitiveType.TRIANGLES,
        boundingSphere: BoundingSphere.fromVertices(positions),
      });
      stats.geometryMs += performance.now() - mark;
      group.polygons.push({
        feature: snapshot.feature,
        pick: { kind: "plate-feature", feature: snapshot.feature, polygonIndex: snapshot.polygonIndex },
        geometry, timeValid, outlineRings,
        vertexCount: positions.length / 3,
        triangleCount,
        sourceTriangleIndices: mapping.subarray(0,triangleCount),
      });
      stats.inputVertices += snapshot.vertexCount;
      stats.inputTriangles += snapshot.triangleCount;
      stats.outputTriangles += triangleCount;
      vertices += positions.length / 3;
      positionBytes += positions.byteLength;
      indexBytes += typedIndices.byteLength;
      rings += outlineRings.length;
      for (const ring of outlineRings) outlinePoints += ring.length;
      await yieldTask();
    }
    check();
    // All Mollweide coordinates already include rotation. Instances must remain identity.
    const plates=[...groups.values()].map(group=>({...group,rotationMatrix:Matrix4.clone(Matrix4.IDENTITY)}));
    return {
      timeMa, plates,
      timeState: {
        activeFeatureCount: activeFeatures.size,
        activePlateCount: activePlates.size,
        disconnectedFeatureCount: disconnected,
      },
      stats: {
        plateCount: plates.length,
        polygonCount: plates.reduce((n, group) => n + group.polygons.length, 0),
        vertexCount: vertices,
        triangleCount: stats.outputTriangles,
        workingPositionByteLength: positionBytes,
        workingIndexByteLength: indexBytes,
        outlineRingCount: rings,
        outlinePointCount: outlinePoints,
        prepareMs: performance.now() - start,
      },
      mollweideStats: stats,
    };
  } finally {
    cancelYield?.();
    channel?.port1.close();
    channel?.port2.close();
  }
}
