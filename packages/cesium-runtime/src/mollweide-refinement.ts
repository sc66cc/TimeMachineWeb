import type { Vec3 } from "@timemachine/reconstruction-core";
import { createProjection, type MapProjection, type ProjectedPoint } from "./map-projection";
import { projectTriangle, type ProjectedTriangle, type TriangleProjectionResult } from "./projected-triangle";
import { clipTriangleToHemispheres } from "./projected-geometry";
import { mollweideRuntimeProjection, projectMollweideRuntime } from "./mollweide-runtime-projection";

const projection = createProjection("mollweide");
// Compact vertex→face incidence is built only for a polygon that actually
// needs refinement, and reused with its immutable source index buffer.
const adjacencyCache = new WeakMap<Uint16Array | Uint32Array, {
  offsets: Uint32Array;
  faces: Uint32Array;
  canonical: Uint32Array;
  source: Float64Array;
}>();

/** Exact duplicate source directions share endpoints without coordinate strings. */
async function canonicalVertices(positions: Float64Array, signal: AbortSignal, yieldTask: () => Promise<void>): Promise<Uint32Array> {
  const count = positions.length / 3;
  const words = new Uint32Array(positions.buffer, positions.byteOffset, positions.length * 2);
  const canonical = new Uint32Array(count);
  const next = new Int32Array(count);
  next.fill(-1);
  const heads = new Map<number, number>();
  for (let vertex = 0; vertex < count; vertex++) {
    let hash = 2166136261;
    for (let axis = 0; axis < 3; axis++) {
      const offset = 3 * vertex + axis;
      hash = Math.imul(hash ^ (positions[offset] === 0 ? 0 : words[2 * offset]!), 16777619);
      hash = Math.imul(hash ^ (positions[offset] === 0 ? 0 : words[2 * offset + 1]!), 16777619);
    }
    const head = heads.get(hash) ?? -1;
    let match = head;
    while (match >= 0 && !(positions[3*vertex] === positions[3*match] &&
      positions[3*vertex+1] === positions[3*match+1] && positions[3*vertex+2] === positions[3*match+2])) {
      match = next[match]!;
    }
    canonical[vertex] = match < 0 ? vertex : match;
    if (match < 0) { next[vertex] = head; heads.set(hash, vertex); }
    if (vertex % 4096 === 0) {
      if (signal.aborted) throw new DOMException("Mollweide preparation aborted", "AbortError");
      await yieldTask();
    }
  }
  return canonical;
}
type Face = readonly [number, number, number];
type Child = {
  vertices: readonly [Vec3, Vec3, Vec3];
  result: TriangleProjectionResult;
  numericalDegenerate?: boolean;
  areaUpperBoundSteradians?: number;
};
interface Leaf { vertices: Face; depth: number }
interface RefinementRecipe {
  source: Float64Array;
  canonical: Uint32Array;
  added: readonly Vec3[];
  leaves: ReadonlyMap<number, readonly Leaf[]>;
  maxDepth: number;
  maxNewTriangles: number;
}
// One successful recipe per immutable index buffer, not one per age. Weak keys
// let replacing a source release its recipe. No pose or projected output lives here.
const recipeCache = new WeakMap<Uint16Array | Uint32Array, RefinementRecipe>();
export interface MollweideRefinementOptions {
  maxDepth?: number;
  maxNewTriangles?: number;
  /** Fixed classification of the unrotated model, not the current noisy pose. */
  sourceCertificates?: Int8Array;
  /** Unrotated unit source positions make duplicate-endpoint identity static. */
  sourcePositions?: Float64Array;
  /** Rotate/normalize a model-space midpoint for this pose, never reuse a pose. */
  rotateSource?: (point: Vec3) => Vec3;
  /** Verification/benchmark control; the default revalidates the last recipe. */
  reuseRecipe?: boolean;
  onRecipe?: (status: "hit" | "miss") => void;
}

export function signedSphericalArea(a: Vec3, b: Vec3, c: Vec3): number {
  const dot = (u: Vec3, v: Vec3): number => u.x*v.x + u.y*v.y + u.z*v.z;
  const bx=b.x-a.x, by=b.y-a.y, bz=b.z-a.z;
  const cx=c.x-a.x, cy=c.y-a.y, cz=c.z-a.z;
  return 2*Math.atan2(a.x*(by*cz-bz*cy)+a.y*(bz*cx-bx*cz)+a.z*(bx*cy-by*cx), 1+dot(a,b)+dot(b,c)+dot(c,a));
}

export function measureSphericalArea(a: Vec3, b: Vec3, c: Vec3): { area: number; roundingBound: number } {
  const bx = b.x - a.x, by = b.y - a.y, bz = b.z - a.z;
  const cx = c.x - a.x, cy = c.y - a.y, cz = c.z - a.z;
  const determinantMagnitude = Math.abs(a.x * by * cz) + Math.abs(a.x * bz * cy) +
    Math.abs(a.y * bz * cx) + Math.abs(a.y * bx * cz) +
    Math.abs(a.z * bx * cy) + Math.abs(a.z * by * cx);
  const denominator = 1 + a.x*b.x + a.y*b.y + a.z*b.z +
    b.x*c.x + b.y*c.y + b.z*c.z + c.x*a.x + c.y*a.y + c.z*a.z;
  const area = signedSphericalArea(a, b, c);
  const crossLength = (u: Vec3, v: Vec3): number => Math.hypot(
    u.y*v.z-u.z*v.y, u.z*v.x-u.x*v.z, u.x*v.y-u.y*v.x,
  );
  const gamma32 = 32 * Number.EPSILON / (1 - 32 * Number.EPSILON);
  // First term bounds determinant arithmetic (edge differences, six products
  // and their sum). Second bounds up to a few ulps of unit-vector/midpoint
  // normalization using the spherical-area derivative at each vertex.
  // Short-arc source triangles have denominator >= 1; no global area tolerance
  // is used as permission to lose geometry.
  const roundingBound = gamma32 * (
    2 * determinantMagnitude / Math.abs(denominator) + 4 * Math.abs(area) +
    2 * (crossLength(a,b) + crossLength(b,c) + crossLength(c,a)) / Math.abs(denominator)
  );
  return { area, roundingBound };
}

type SourcePoints = readonly [Vec3, Vec3, Vec3];
type SphericalMeasurement = ReturnType<typeof measureSphericalArea>;
type MeasureSource = (points: SourcePoints) => SphericalMeasurement;
const measureSource: MeasureSource = points => measureSphericalArea(...points);

/** One preparation only; keys and their coordinate objects must remain immutable. */
export function createSphericalAreaMeasurementCache(measure: MeasureSource = measureSource): MeasureSource {
  const measurements = new WeakMap<SourcePoints, SphericalMeasurement>();
  return points => {
    let measurement = measurements.get(points);
    if (!measurement) {
      measurement = measure(points);
      measurements.set(points, measurement);
    }
    return measurement;
  };
}

export function validateSphericalCoverage(
  source: readonly [Vec3, Vec3, Vec3], children: readonly (readonly [Vec3, Vec3, Vec3])[],
  measure: MeasureSource = measureSource,
): { roundingBound: number; coveredArea: number } {
  const original = measure(source);
  let coveredArea = 0, magnitude = 0, roundingBound = original.roundingBound;
  for (const points of children) {
    const child = measure(points);
    if (child.area * original.area < 0 && Math.abs(child.area) > child.roundingBound) {
      throw new Error("refinement child lost source spherical orientation");
    }
    coveredArea += child.area;
    magnitude += Math.abs(child.area);
    roundingBound += child.roundingBound;
  }
  roundingBound += (children.length * Number.EPSILON / (1 - children.length * Number.EPSILON)) * magnitude;
  if (!Number.isFinite(roundingBound) || Math.abs(coveredArea - original.area) > roundingBound + Math.abs(original.area) * 1e-7) {
    throw new Error("refinement did not conserve spherical source area");
  }
  return { roundingBound, coveredArea };
}

/** Only the frozen spherical oracle, never a projection failure, permits omission. */
export function numericalLeafUpperBound(
  points: readonly [Vec3, Vec3, Vec3],
  measure: MeasureSource = measureSource,
): number | undefined {
  const measurement=measure(points);
  const upper=Math.abs(measurement.area)+measurement.roundingBound;
  if(!Number.isFinite(upper)||upper>1e-14)return;
  const oracle=clipTriangleToHemispheres(...points,0);
  if(oracle.status==="degenerate" && /no spherical area/.test(oracle.reason??""))return upper;
}

/** Per-original-source omission budget; all leaves still participate in coverage. */
export function validateRefinedSphericalCoverage(
  source: readonly [Vec3, Vec3, Vec3], children: readonly Child[],
  measure: MeasureSource = measureSource,
): { omittedUpperBound: number; omissionCap: number; omittedCount: number } {
  const coverage=validateSphericalCoverage(source,children.map(child=>child.vertices),measure);
  const original=measure(source);
  const omissionCap=Math.min(1e-14,Math.max(0,Math.abs(original.area)-original.roundingBound)*1e-7);
  let omittedUpperBound=0,omittedCount=0,retainedArea=0;
  for(const child of children){
    if(child.numericalDegenerate){
      const upper=numericalLeafUpperBound(child.vertices,measure);
      if(upper===undefined || child.result.status!=="degenerate" ||
        !Number.isFinite(child.areaUpperBoundSteradians) || child.areaUpperBoundSteradians!<upper){
        throw new Error("refinement numerical omission lacks a finite spherical certificate");
      }
      omittedUpperBound+=child.areaUpperBoundSteradians!;
      omittedCount++;
    }else{
      if(child.result.status!=="ok")throw new Error("refinement retained an uncertified leaf");
      retainedArea+=measure(child.vertices).area;
    }
  }
  // Rounding in summing upper bounds must not buy extra omission allowance.
  const sumRounding=omittedCount*Number.EPSILON/(1-omittedCount*Number.EPSILON)*omittedUpperBound;
  if(!Number.isFinite(omittedUpperBound+sumRounding) || omittedUpperBound+sumRounding>omissionCap){
    throw new Error("refinement numerical omission exceeded the source budget");
  }
  if(Math.abs(original.area-retainedArea)>coverage.roundingBound+omissionCap){
    throw new Error("refinement retained leaves did not conserve spherical source area");
  }
  return {omittedUpperBound:omittedUpperBound+sumRounding,omissionCap,omittedCount};
}

const projectedVertexCache = new WeakMap<Vec3, { x: number; y: number }>();

/** Exact keys only, scoped to one preparation; seam signs are never canonicalized. */
export function memoizeMollweideProjection(projection: MapProjection): MapProjection {
  const coordinates=new Map<number|string,Map<number|string,ProjectedPoint>>();
  const key=(value:number):number|string=>Object.is(value,-0)?"-0":value;
  return {...projection,projectRelative:(longitude,latitude)=>{
    if(!Number.isFinite(longitude)||!Number.isFinite(latitude))return projection.projectRelative(longitude,latitude);
    const lon=key(longitude),lat=key(latitude);
    let latitudes=coordinates.get(lon);
    if(!latitudes){latitudes=new Map();coordinates.set(lon,latitudes);}
    let point=latitudes.get(lat);
    if(!point){point=projection.projectRelative(longitude,latitude);latitudes.set(lat,point);}
    return point;
  }};
}

/** Retain all frozen clipped pieces when only 3B's fixed planar-area floor fails. */
function projectSmallClippedLeaf(points: readonly [Vec3,Vec3,Vec3],face:number,reference:MapProjection,measure:MeasureSource):TriangleProjectionResult|undefined {
  const clipped=clipTriangleToHemispheres(...points,face);
  if(clipped.status!=="ok"||clipped.winding===undefined)return;
  const winding=clipped.winding,triangles:ProjectedTriangle[]=[],spherical: [Vec3,Vec3,Vec3][]=[];
  for(const piece of clipped.pieces){
    if(piece.vertices.length!==3&&piece.vertices.length!==4)return;
    const projected=piece.vertices.map(v=>reference.projectRelative(v.relativeLongitudeDeg??0,v.latitudeDeg));
    const candidates=piece.vertices.length===3?[[[0,1,2]]]:[[[0,1,2],[0,2,3]],[[0,1,3],[1,2,3]]];
    const selected=candidates.find(candidate=>candidate.every(([i,j,k])=>{
      const a=projected[i!]!,b=projected[j!]!,c=projected[k!]!;
      const positive=(b.x-a.x)*(c.y-a.y),negative=(b.y-a.y)*(c.x-a.x),determinant=positive-negative;
      return Number.isFinite(determinant)&&determinant*winding>8*Number.EPSILON*(Math.abs(positive)+Math.abs(negative));
    }));
    if(!selected)return;
    for(const [i,j,k] of selected){
      triangles.push({sourceId:face,hemisphere:piece.hemisphere,vertices:[projected[i!]!,projected[j!]!,projected[k!]!]});
      spherical.push([piece.vertices[i!]!.direction,piece.vertices[j!]!.direction,piece.vertices[k!]!.direction]);
    }
  }
  try{validateSphericalCoverage(points,spherical,measure);}catch{return;}
  return {status:"ok",sourceId:face,winding,triangles};
}

function projectLeaf(points: readonly [Vec3, Vec3, Vec3], face: number, runtime: MapProjection, reference: MapProjection, measure: MeasureSource): TriangleProjectionResult {
  const sameHalfSpace = points.every(p => p.y > 1e-10) || points.every(p => p.y < -1e-10);
  if (sameHalfSpace) {
    const dot = (a: Vec3, b: Vec3): number => a.x*b.x + a.y*b.y + a.z*b.z;
    const source = measure(points);
    if (Math.min(dot(points[0],points[1]),dot(points[1],points[2]),dot(points[2],points[0])) > 0.001 && Math.abs(source.area) > 1e-14 + source.roundingBound) {
      const xy = points.map(p => {
        let projected = projectedVertexCache.get(p);
        if (!projected) {
          projected = projectMollweideRuntime(Math.atan2(p.y,p.x)*180/Math.PI,Math.atan2(p.z,Math.hypot(p.x,p.y))*180/Math.PI);
          projectedVertexCache.set(p, projected);
        }
        return projected;
      }) as [{x:number;y:number},{x:number;y:number},{x:number;y:number}];
      const [a,b,c] = xy;
      const positive=(b.x-a.x)*(c.y-a.y),negative=(b.y-a.y)*(c.x-a.x);
      const determinant=positive-negative,winding=source.area>0?1:-1;
      if (Number.isFinite(determinant) && determinant*winding > 8*Number.EPSILON*(Math.abs(positive)+Math.abs(negative))) {
        return {status:"ok",sourceId:face,winding,triangles:[{sourceId:face,hemisphere:points[0].y>0?1:-1,vertices:xy}]};
      }
    }
  }
  const runtimeResult = projectTriangle(...points, face, runtime);
  if (runtimeResult.status === "ok") return runtimeResult;
  const result = projectTriangle(...points, face, reference);
  if (result.status === "ok") return result;
  if(result.status==="unsupported"&&/loses the source orientation/.test(result.reason??"")){
    const retained=projectSmallClippedLeaf(points,face,reference,measure);
    if(retained)return retained;
  }
  const winding = result.winding ?? Math.sign(measure(points).area);
  if (winding !== 1 && winding !== -1) return result;
  // Tolerance-degenerate is not mathematically zero. Retain such a child only
  // with a continuous domain and robust XY determinant certificate. Invalid or
  // long-arc sources can never enter this post-oracle numerical fallback.
  if (!(result.status === "unsupported" && /loses the source orientation/.test(result.reason ?? "")) &&
      !(result.status === "degenerate" && /no spherical area/.test(result.reason ?? ""))) return result;
  const continuous = points.every(p => p.y > 1e-10) || points.every(p => p.y < -1e-10) || points.every(p => p.x > 1e-10);
  if (!continuous) return result;
  const projected = points.map(p => reference.projectRelative(
    Math.atan2(p.y,p.x)*180/Math.PI, Math.atan2(p.z,Math.hypot(p.x,p.y))*180/Math.PI,
  )) as [ReturnType<typeof projection.projectRelative>, ReturnType<typeof projection.projectRelative>, ReturnType<typeof projection.projectRelative>];
  const [a,b,c] = projected;
  const positive=(b.x-a.x)*(c.y-a.y), negative=(b.y-a.y)*(c.x-a.x);
  const determinant=positive-negative;
  if (!Number.isFinite(determinant) || determinant*winding <= 8*Number.EPSILON*(Math.abs(positive)+Math.abs(negative))) return result;
  return {status:"ok",sourceId:face,winding,triangles:[{sourceId:face,hemisphere:points[0].y>0?1:-1,vertices:projected}]};
}

/** Local, delayed-output conforming refinement; source buffers stay immutable. */
export async function refineMollweideFaces(
  positions: Float64Array, indices: Uint16Array | Uint32Array,
  initialFaces: readonly number[], sourceId: (face: number) => string,
  signal: AbortSignal, yieldTask: () => Promise<void>,
  options: MollweideRefinementOptions = {},
): Promise<Map<number, readonly Child[]>> {
  const measure=createSphericalAreaMeasurementCache();
  const sourceVertices=new Map<number,Vec3>();
  const sourcePoints=new Map<number,SourcePoints>();
  const runtime=memoizeMollweideProjection(mollweideRuntimeProjection);
  const reference=memoizeMollweideProjection(projection);
  const maxDepth = options.maxDepth ?? 40;
  const maxNewTriangles = options.maxNewTriangles ?? 16384;
  const checkAbort = (): void => {
    if (signal.aborted) throw new DOMException("Mollweide preparation aborted", "AbortError");
  };
  checkAbort();
  const saved = options.reuseRecipe !== false && options.sourcePositions && options.rotateSource
    ? recipeCache.get(indices) : undefined;
  if (saved && saved.source === options.sourcePositions && saved.maxDepth === maxDepth &&
      saved.maxNewTriangles === maxNewTriangles && initialFaces.every(face => saved.leaves.has(face))) {
    const added = saved.added.map(options.rotateSource!);
    const count = positions.length / 3;
    const vertex = (index: number): Vec3 => {
      if (index >= count) return added[index-count]!;
      let p=sourceVertices.get(index);
      if (!p) { p={x:positions[3*index]!,y:positions[3*index+1]!,z:positions[3*index+2]!}; sourceVertices.set(index,p); }
      return p;
    };
    const output = new Map<number, readonly Child[]>();
    let valid = true;
    for (const [face, leaves] of saved.leaves) {
      checkAbort();
      const source = [0,1,2].map(i => vertex(saved.canonical[indices[3*face+i]!]!)) as [Vec3,Vec3,Vec3];
      sourcePoints.set(face,source);
      const children: Child[] = leaves.map(leaf => {
        const vertices = leaf.depth===0?source:leaf.vertices.map(vertex) as [Vec3,Vec3,Vec3];
        const result = projectLeaf(vertices, face, runtime, reference, measure);
        const upper = leaf.depth > 0 && result.status === "degenerate" ? numericalLeafUpperBound(vertices,measure) : undefined;
        return {vertices, result, numericalDegenerate: upper !== undefined, areaUpperBoundSteradians: upper};
      });
      try { validateRefinedSphericalCoverage(source, children,measure); }
      catch { valid = false; break; }
      output.set(face, children);
      await yieldTask();
    }
    checkAbort();
    if (valid) { options.onRecipe?.("hit"); return output; }
  }
  options.onRecipe?.("miss");
  const originalCount=positions.length/3, added:Vec3[]=[], modelAdded:Vec3[]=[];
  const vertex = (index: number): Vec3 => {
    if (index >= originalCount) return added[index-originalCount]!;
    let value = sourceVertices.get(index);
    if (!value) {
      value = {x:positions[3*index]!,y:positions[3*index+1]!,z:positions[3*index+2]!};
      sourceVertices.set(index, value);
    }
    return value;
  };
  let adjacency = adjacencyCache.get(indices);
  if (adjacency && options.sourcePositions && adjacency.source !== options.sourcePositions) adjacency = undefined;
  const canonical = adjacency?.canonical ?? await canonicalVertices(options.sourcePositions ?? positions, signal, yieldTask);
  checkAbort();
  const original = (face: number): Face => [
    canonical[indices[3 * face]!]!, canonical[indices[3 * face + 1]!]!, canonical[indices[3 * face + 2]!]!,
  ];
  const originalPoints=(face:number):SourcePoints=>{
    let points=sourcePoints.get(face);
    if(!points){points=original(face).map(vertex) as [Vec3,Vec3,Vec3];sourcePoints.set(face,points);}
    return points;
  };
  const leaves=new Map<number,Leaf[]>();
  const numericalSources = new Set<number>();
  const isNumericalSource = (face: number): boolean => {
    if (options.sourceCertificates) return options.sourceCertificates[face] === 2;
    const points = originalPoints(face);
    return Math.abs(measure(points).area) <= 1e-14 &&
      clipTriangleToHemispheres(...points, face).status === "degenerate";
  };
  for (const face of initialFaces) {
    if (isNumericalSource(face)) numericalSources.add(face);
    else leaves.set(face, [{ vertices: original(face), depth: 0 }]);
  }
  const pending=new Set(leaves.keys()), splitVertices=new Map<string,number>();
  const incident=new Map<number,Set<number>>();
  const register=(vertex:number,face:number):void=>{
    let faces = incident.get(vertex);
    if (!faces) {
      faces = new Set();
      incident.set(vertex, faces);
    }
    faces.add(face);
  };
  for (const face of leaves.keys()) for (const v of original(face)) register(v, face);
  if(!adjacency){
    const offsets=new Uint32Array(originalCount+1);
    for (let i = 0; i < indices.length; i++) {
      const vertex = canonical[indices[i]!]!;
      offsets[vertex + 1] = offsets[vertex + 1]! + 1;
      if (i % 8192 === 0) { checkAbort(); await yieldTask(); checkAbort(); }
    }
    for(let i=1;i<offsets.length;i++)offsets[i]=offsets[i]!+offsets[i-1]!;
    const cursor=offsets.slice(),faces=new Uint32Array(indices.length);
    for (let i = 0; i < indices.length; i++) {
      faces[cursor[canonical[indices[i]!]!]!++] = Math.floor(i / 3);
      if (i % 8192 === 0) { checkAbort(); await yieldTask(); checkAbort(); }
    }
    adjacency = { offsets, faces, canonical, source: options.sourcePositions ?? positions };
    adjacencyCache.set(indices, adjacency);
  }
  type Evaluation = Child & {area:number};
  const evaluations=new WeakMap<Leaf,Evaluation>();
  const evaluate=(leaf:Leaf,face:number):Evaluation=>{
    let value=evaluations.get(leaf);
    if(!value){
      const vertices=leaf.depth===0?originalPoints(face):leaf.vertices.map(vertex) as [Vec3,Vec3,Vec3];
      value={vertices,result:projectLeaf(vertices,face,runtime,reference,measure),area:measure(vertices).area};
      evaluations.set(leaf,value);
    }
    return value;
  };
  let newTriangles=0;
  const check=(face:number):void => {
    checkAbort();
    if(newTriangles>maxNewTriangles)throw new Error(`${sourceId(face)}: Mollweide refinement triangle budget exhausted`);
  };
  const edgeLength=(u:number,v:number):number=>{
    const a=vertex(u),b=vertex(v);
    return (a.x-b.x)**2+(a.y-b.y)**2+(a.z-b.z)**2;
  };
  const longestEdge=(t:Face):number=>{
    let edge=0;
    for(let e=1;e<3;e++)if(edgeLength(t[e]!,t[(e+1)%3]!)>edgeLength(t[edge]!,t[(edge+1)%3]!))edge=e;
    return edge;
  };
  const edgeIndex=(t:Face,u:number,v:number):number=>{
    for(let e=0;e<3;e++)if((t[e]===u&&t[(e+1)%3]===v)||(t[e]===v&&t[(e+1)%3]===u))return e;
    return -1;
  };
  // Longest-edge propagation: do not force a short-edge split into a neighbour.
  // First bisect that neighbour's longer edge, then revisit the shared edge.
  // Dependencies strictly increase length, so propagation cannot form cycles.
  const splitConforming=(u:number,v:number,face:number):void=>{
    check(face);
    const lo=Math.min(u,v),hi=Math.max(u,v),key=`${lo}/${hi}`;
    if(splitVertices.has(key))return;
    if(u<originalCount&&v<originalCount){
      for(let i=adjacency.offsets[u]!;i<adjacency.offsets[u+1]!;i++){
        const f=adjacency.faces[i]!,t=original(f);
        if(t.includes(v)&&!leaves.has(f)&&!isNumericalSource(f)){
          leaves.set(f,[{vertices:t,depth:0}]);
          for(const vertex of t)register(vertex,f);
        }
      }
    }
    const candidates=[...(incident.get(u)??[])].filter(f=>incident.get(v)?.has(f));
    const length=edgeLength(u,v);
    for(const neighbour of candidates){
      for(const child of leaves.get(neighbour)!){
        if(edgeIndex(child.vertices,u,v)<0)continue;
        const e=longestEdge(child.vertices),a=child.vertices[e]!,b=child.vertices[(e+1)%3]!;
        if(edgeLength(a,b)>length){
          splitConforming(a,b,neighbour);
          splitConforming(u,v,face);
          return;
        }
      }
    }
    const a=vertex(lo),b=vertex(hi),n=Math.hypot(a.x+b.x,a.y+b.y,a.z+b.z);
    if(n<1e-12)throw new Error(`${sourceId(face)}: cannot refine antipodal edge`);
    const mid=originalCount+added.length;
    added.push({x:(a.x+b.x)/n,y:(a.y+b.y)/n,z:(a.z+b.z)/n});
    if (options.reuseRecipe !== false && options.sourcePositions && options.rotateSource) {
      const sourceVertex = (index: number): Vec3 => index >= originalCount ? modelAdded[index-originalCount]! :
        {x:options.sourcePositions![3*index]!,y:options.sourcePositions![3*index+1]!,z:options.sourcePositions![3*index+2]!};
      const sa=sourceVertex(lo),sb=sourceVertex(hi),sn=Math.hypot(sa.x+sb.x,sa.y+sb.y,sa.z+sb.z);
      modelAdded.push({x:(sa.x+sb.x)/sn,y:(sa.y+sb.y)/sn,z:(sa.z+sb.z)/sn});
    }
    splitVertices.set(key,mid);
    for(const neighbour of candidates){
      const replacement:Leaf[]=[];
      let changed=false;
      for(const child of leaves.get(neighbour)!){
        const t=child.vertices,e=edgeIndex(t,u,v);
        if(e<0){replacement.push(child);continue;}
        if(child.depth>=maxDepth)throw new Error(`${sourceId(neighbour)}: Mollweide conforming refinement depth budget exhausted`);
        replacement.push({vertices:[t[e]!,mid,t[(e+2)%3]!],depth:child.depth+1},
          {vertices:[mid,t[(e+1)%3]!,t[(e+2)%3]!],depth:child.depth+1});
        newTriangles++;
        check(neighbour);
        changed=true;
      }
      if(changed){leaves.set(neighbour,replacement);register(mid,neighbour);pending.add(neighbour);}
    }
  };
  while(pending.size){
    const face = pending.values().next().value!;
    pending.delete(face);
    check(face);
    for(const leaf of leaves.get(face)!){
      const evaluation=evaluate(leaf,face);
      const points=evaluation.vertices,result=evaluation.result;
      if (result.status === "ok") continue;
      if (leaf.depth>0 && result.status === "degenerate") {
        const upper=numericalLeafUpperBound(points,measure);
        if(upper!==undefined){
          evaluation.numericalDegenerate = true;
          evaluation.areaUpperBoundSteradians = upper;
          continue;
        }
      }
      if(result.status!=="degenerate" && !(result.status==="unsupported" && /loses the source orientation|folds or crosses|simplified to/.test(result.reason ?? ""))) {
        throw new Error(`${sourceId(face)}: ${result.status}: ${result.reason}`);
      }
      if(leaf.depth>=maxDepth)throw new Error(`${sourceId(face)}: Mollweide refinement depth budget exhausted: ${result.reason}; source=${JSON.stringify(original(face).map(vertex))}`);
      const edge=longestEdge(leaf.vertices);
      splitConforming(leaf.vertices[edge]!,leaf.vertices[(edge+1)%3]!,face);
      break;
    }
    await yieldTask();
  }
  const output=new Map<number,readonly Child[]>();
  for (const face of numericalSources) {
    const vertices = originalPoints(face);
    const measurement = measure(vertices);
    output.set(face, [{ vertices, result: projectTriangle(...vertices, face, projection), numericalDegenerate: true,
      areaUpperBoundSteradians: Math.abs(measurement.area) + measurement.roundingBound }]);
  }
  for(const [face,children] of leaves){
    check(face);
    const source = originalPoints(face);
    const sourceWinding = Math.sign(measure(source).area);
    const projected = children.map(child => {
      const value = evaluate(child, face);
      if (value.area * sourceWinding < 0) {
        const measurement = measure(value.vertices);
        const oracle = projectTriangle(...value.vertices, face, projection);
        const upper=numericalLeafUpperBound(value.vertices,measure);
        if (Math.abs(value.area) <= measurement.roundingBound && oracle.status === "degenerate" && upper!==undefined) {
          value.result = oracle;
          value.numericalDegenerate = true;
          value.areaUpperBoundSteradians = upper;
        } else {
          throw new Error(`${sourceId(face)}: refinement child lost source spherical orientation`);
        }
      }
      const { vertices, result, numericalDegenerate, areaUpperBoundSteradians } = value;
      return { vertices, result, numericalDegenerate, areaUpperBoundSteradians };
    });
    try {
      validateRefinedSphericalCoverage(source,projected,measure);
    } catch (error) {
      throw new Error(`${sourceId(face)}: ${(error as Error).message}`);
    }
    output.set(face, projected);
  }
  checkAbort();
  if (options.reuseRecipe !== false && options.sourcePositions && options.rotateSource && numericalSources.size === 0) {
    recipeCache.set(indices, {
      source: options.sourcePositions, canonical, added: modelAdded,
      leaves, maxDepth, maxNewTriangles,
    });
  }
  return output;
}
