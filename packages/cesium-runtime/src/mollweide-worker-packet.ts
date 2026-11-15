import { BoundingSphere, Cartesian3, ComponentDatatype, Geometry, GeometryAttribute, GeometryAttributes, Matrix4, PrimitiveType } from "cesium";
import type { MollweideCpuFrame } from "./plate-mollweide-frame";
import type { PlatePolygonMeshSnapshot } from "./plate-mesh-snapshot";

export interface MollweideFramePacket {
  timeMa: number;
  stats: MollweideCpuFrame["stats"];
  timeState: MollweideCpuFrame["timeState"];
  mollweideStats: MollweideCpuFrame["mollweideStats"];
  plates: { plateId: number; hasRotation: boolean; polygons: {
    snapshotIndex: number; positions: Float64Array; indices: Uint16Array | Uint32Array;
    outlines: Float64Array; offsets: Uint32Array; timeValid: boolean;
  }[] }[];
}

export function packMollweideFrame(frame: MollweideCpuFrame, snapshots: readonly PlatePolygonMeshSnapshot[]): { packet: MollweideFramePacket; transfers: ArrayBuffer[] } {
  const transfers: ArrayBuffer[] = [];
  const packet: MollweideFramePacket = {
    timeMa: frame.timeMa, stats: frame.stats, timeState: frame.timeState, mollweideStats: frame.mollweideStats,
    plates: frame.plates.map(group => ({ plateId: group.plateId, hasRotation: group.hasRotation, polygons: group.polygons.map(polygon => {
      const snapshotIndex = snapshots.findIndex(s => s.feature === polygon.feature && s.polygonIndex === polygon.pick.polygonIndex);
      if (snapshotIndex < 0) throw new Error("Mollweide source identity missing.");
      const positions = polygon.geometry.attributes.position!.values as Float64Array;
      const indices = polygon.geometry.indices as unknown as Uint16Array | Uint32Array;
      const offsets = new Uint32Array(polygon.outlineRings.length + 1);
      let count = 0;
      polygon.outlineRings.forEach((ring, i) => { offsets[i] = count; count += ring.length; });
      offsets[offsets.length - 1] = count;
      const outlines = new Float64Array(count * 3);
      let at = 0;
      for (const ring of polygon.outlineRings) for (const p of ring) { outlines[at++] = p.x; outlines[at++] = p.y; outlines[at++] = p.z; }
      transfers.push(positions.buffer as ArrayBuffer, indices.buffer as ArrayBuffer, outlines.buffer, offsets.buffer);
      return { snapshotIndex, positions, indices, outlines, offsets, timeValid: polygon.timeValid };
    }) })),
  };
  return { packet, transfers: [...new Set(transfers)] };
}

export function unpackMollweideFrame(packet: MollweideFramePacket, snapshots: readonly PlatePolygonMeshSnapshot[]): MollweideCpuFrame {
  return { ...packet, plates: packet.plates.map(group => ({ ...group, rotationMatrix: Matrix4.clone(Matrix4.IDENTITY), polygons: group.polygons.map(p => {
    const source = snapshots[p.snapshotIndex];
    if (!source) throw new Error("Unknown Mollweide snapshot index.");
    const outlineRings: Cartesian3[][] = [];
    for (let ring = 0; ring + 1 < p.offsets.length; ring++) {
      const points: Cartesian3[] = [];
      for (let i = p.offsets[ring]!; i < p.offsets[ring + 1]!; i++) points.push(new Cartesian3(p.outlines[i * 3], p.outlines[i * 3 + 1], p.outlines[i * 3 + 2]));
      outlineRings.push(points);
    }
    const attributes = new GeometryAttributes();
    attributes.position = new GeometryAttribute({ componentDatatype: ComponentDatatype.DOUBLE, componentsPerAttribute: 3, values: p.positions });
    return {
      feature: source.feature, pick: { kind: "plate-feature" as const, feature: source.feature, polygonIndex: source.polygonIndex },
      timeValid: p.timeValid, vertexCount: p.positions.length / 3, triangleCount: p.indices.length / 3, outlineRings,
      geometry: new Geometry({ attributes, indices: p.indices, primitiveType: PrimitiveType.TRIANGLES, boundingSphere: BoundingSphere.fromVertices(p.positions) }),
    };
  }) })) };
}
