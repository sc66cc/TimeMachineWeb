import { Cartesian3, Color, ColorGeometryInstanceAttribute, Material, Matrix4, PerInstanceColorAppearance, PointPrimitiveCollection, PolylineCollection, Primitive, type PointPrimitive, type Polyline, type GeometryInstance, type JulianDate, type Viewer } from "cesium";
import { EARTH_RADIUS_METRES, SPHERICAL_EARTH } from "@timemachine/cesium-runtime";
import { AgentActionFailureError, AgentActionUnsupportedError, AgentActionValidationError } from "../agent-actions/registry";
import { OperationInterruptedError } from "../agent-actions/operation";
import { redactSensitive } from "../agent-actions/types";
import { defaultNativePointStyle, readNativePointStyle, type NativePointStyle } from "./native-point-style";
import { readNativeLineStyle, type NativeLineStyle } from "./native-line-style";
import { readNativePolygonStyle, type NativePolygonStyle } from "./native-polygon-style";
import { prepareSphericalPolygons, sampleSphericalLine } from "./spherical-vector-geometry";

/** Globe display separation, aligned with GPU points; never source or reconstructed height. */
export const NATIVE_VECTOR_DISPLAY_OFFSET_METRES = 24_000;
const DISPLAY_SCALE = (EARTH_RADIUS_METRES + NATIVE_VECTOR_DISPLAY_OFFSET_METRES) / EARTH_RADIUS_METRES;

export type VectorLayerKind = "point" | "line" | "polygon";
export type NativeVectorStyle = NativePointStyle | NativeLineStyle | NativePolygonStyle;
export interface VectorLayerEffectiveState { visible: boolean; opacity: number; style: NativeVectorStyle }

export interface VectorLayerSource {
  kind?: VectorLayerKind;
  sourceRef: string;
  /** Standard GeoJSON Feature/FeatureCollection. Missing kind preserves the point contract. */
  geojson: unknown;
}

export interface VectorFeatureKey {
  layerId: number;
  featureId: string;
  sourceRef: string;
}

export interface VectorLayerHandle {
  readonly kind: VectorLayerKind;
  isAttached(): boolean;
  isDetached(): boolean;
  prepareFrame(): void;
  matches(state: VectorLayerEffectiveState, time: JulianDate): boolean;
  getAttributes(featureId: string): Record<string, unknown> | null | undefined;
  resolvePick(picked: unknown): VectorFeatureKey | undefined;
  setVisible(visible: boolean): void;
  setOpacity(opacity: number): void;
  setStyle(style: NativeVectorStyle): void;
  dispose(): void;
}

/** The application must retain this cleanup owner; never serialize it into an API result. */
export class VectorAttachmentError extends AggregateError {
  readonly cleanupHandle!: Readonly<Pick<VectorLayerHandle, "dispose" | "isDetached">>;

  constructor(error: unknown, cleanupError: unknown, handle: VectorLayerHandle) {
    super([error, cleanupError], "Vector attachment failed and cleanup reported an error.");
    this.name = "VectorAttachmentError";
    Object.defineProperty(this, "cleanupHandle", {
      value: Object.freeze({ dispose: () => handle.dispose(), isDetached: () => handle.isDetached() }),
      enumerable: false, writable: false,
    });
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Preserve JSON property types without borrowing mutable source references. */
function cloneJson(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (!value || typeof value !== "object" || ancestors.has(value) ||
      (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new AgentActionValidationError("Feature properties must contain finite, acyclic JSON values.");
  }
  ancestors.add(value);
  const copy = Array.isArray(value)
    ? value.map(item => cloneJson(item, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item, ancestors)]));
  ancestors.delete(value);
  return copy;
}

function sourceId(value: unknown): string {
  if ((typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value))) return String(value);
  throw new AgentActionValidationError("A supplied feature ID must be a nonempty string or finite number.");
}

function position(value: unknown): [number, number, number] {
  if (!Array.isArray(value) || (value.length !== 2 && value.length !== 3) ||
      !Array.from(value).every(coordinate => typeof coordinate === "number" && Number.isFinite(coordinate)) ||
      value[0] < -180 || value[0] > 180 || value[1] < -90 || value[1] > 90) {
    throw new AgentActionValidationError("Point coordinates must be finite [longitude, latitude, optional height] within geographic bounds.");
  }
  return [value[0], value[1], value[2] ?? 0];
}

function readFeatures(source: VectorLayerSource, kind: VectorLayerKind) {
  if (!source || typeof source.sourceRef !== "string" || !source.sourceRef.trim() || !object(source.geojson)) {
    throw new AgentActionValidationError("A stable sourceRef and a GeoJSON Feature or FeatureCollection are required.");
  }
  const geojson = source.geojson;
  const features = geojson.type === "Feature" ? [geojson]
    : geojson.type === "FeatureCollection" && Array.isArray(geojson.features) ? geojson.features : undefined;
  if (!features) throw new AgentActionValidationError("Expected a GeoJSON Feature or FeatureCollection.");
  if (kind === "polygon" && features.length === 0) throw new AgentActionValidationError("A polygon source must contain at least one feature.");
  const ids = new Set<string>();
  return Array.from(features, (feature: unknown, index: number) => {
    let featureId: string | undefined;
    try {
      if (object(feature) && feature.type === "Feature" && feature.id !== undefined) featureId = sourceId(feature.id);
      if (!object(feature) || feature.type !== "Feature" || !object(feature.geometry)) {
        throw new AgentActionValidationError("Each vector feature must contain a non-null geometry.");
      }
      const geometry = feature.geometry;
      const properties = feature.properties === undefined ? null : feature.properties;
      if (properties !== null && !object(properties)) throw new AgentActionValidationError("Feature properties must be an object or null.");
      const attributes = cloneJson(properties) as Record<string, unknown> | null;
      const explicitId = feature.id === undefined ? undefined : sourceId(feature.id);
      const propertyId = attributes?.featureId === undefined ? undefined : sourceId(attributes.featureId);
      if (explicitId !== undefined && propertyId !== undefined && explicitId !== propertyId) {
        throw new AgentActionValidationError("Feature.id and properties.featureId disagree.");
      }
      featureId = explicitId ?? propertyId ?? `${source.sourceRef}#feature:${index}`;
      if (ids.has(featureId)) throw new AgentActionValidationError("Duplicate feature ID within the source.");
      ids.add(featureId);
      if (attributes?.plateId !== undefined) {
        if (!Number.isSafeInteger(attributes.plateId) || (attributes.plateId as number) < 0) throw new AgentActionValidationError("plateId must be a nonnegative safe integer.");
      }
      // Named fixture/business extension, not Cesium time or a new service schema.
      if (attributes?.validTimeMa !== undefined) {
        const range = attributes.validTimeMa;
        if (!object(range) || typeof range.youngest !== "number" || typeof range.oldest !== "number" ||
            !Number.isFinite(range.youngest) || !Number.isFinite(range.oldest) || range.youngest < 0 ||
            range.youngest > range.oldest || range.endpoints !== "inclusive") {
          throw new AgentActionValidationError("validTimeMa must contain finite nonnegative youngest/oldest ages and inclusive endpoints.");
        }
      }
      let parts: Cartesian3[][];
      let fills: GeometryInstance[] = [];
      const polygonRings: Array<{ polygonPart: number; ring: number }> = [];
      if (kind === "point") {
        if (geometry.type !== "Point" && geometry.type !== "MultiPoint") throw new AgentActionUnsupportedError("A point source must contain only Point or MultiPoint geometry.");
        const coordinates = geometry.type === "Point" ? [position(geometry.coordinates)]
          : Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0 ? Array.from(geometry.coordinates, position) : undefined;
        if (!coordinates) throw new AgentActionValidationError("MultiPoint must contain at least one position.");
        // Derive display positions from source lon/lat/height. Scaling a Point's
        // Cartesian would also scale its real height; adding here preserves it.
        parts = coordinates.map(([longitude, latitude, height]) => [Cartesian3.fromDegrees(longitude, latitude, height + NATIVE_VECTOR_DISPLAY_OFFSET_METRES, SPHERICAL_EARTH)]);
      } else if (kind === "line") {
        if (geometry.type !== "LineString" && geometry.type !== "MultiLineString") throw new AgentActionUnsupportedError("A line source must contain only LineString or MultiLineString geometry.");
        if (geometry.type === "LineString") parts = [sampleSphericalLine(geometry.coordinates)];
        else {
          if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length === 0) throw new AgentActionValidationError("MultiLineString must contain at least one line.");
          parts = Array.from(geometry.coordinates, sampleSphericalLine);
        }
      } else {
        if (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") throw new AgentActionUnsupportedError("A polygon source must contain only Polygon or MultiPolygon geometry.");
        fills = prepareSphericalPolygons(geometry, undefined);
        // Native preparation validated every ring first; boundary sampling must
        // retain every exterior and hole, or the whole feature is rejected.
        const polygons = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates) as unknown[][][];
        parts = [];
        polygons.forEach((rings, polygonPart) => rings.forEach((coordinates, ring) => {
          parts.push(sampleSphericalLine(coordinates)); polygonRings.push({ polygonPart, ring });
        }));
      }
      return { featureId, attributes, parts, fills, polygonRings };
    } catch (error) {
      // Preserve error classification; identities are diagnostic context, never raw attributes.
      if (error instanceof AgentActionFailureError && featureId !== undefined) Object.defineProperty(error, "featureId", { value: featureId, enumerable: false });
      throw error;
    }
  });
}

/**
 * Attach a hidden native vector layer. The caller applies effective visibility.
 * Resolution proves collection membership only, never a rendered frame.
 */
export async function attachVectorLayer(
  viewer: Viewer,
  layerId: number,
  source: VectorLayerSource,
  signal?: AbortSignal,
): Promise<VectorLayerHandle> {
  const assertRequest = (): void => {
    if (signal?.aborted) throw signal.reason instanceof OperationInterruptedError ? signal.reason : new OperationInterruptedError("cancelled");
    if (viewer.scene.isDestroyed() || viewer.dataSources.isDestroyed()) throw new OperationInterruptedError("cancelled", "The vector layer viewer has been disposed.");
  };
  assertRequest();
  if (!Number.isSafeInteger(layerId) || layerId <= 0) throw new AgentActionValidationError("layerId must be a positive safe integer.");
  const kind = source?.kind === undefined ? "point" : source.kind;
  if (kind !== "point" && kind !== "line" && kind !== "polygon") throw new AgentActionUnsupportedError("Unsupported native vector source kind.");
  const features = readFeatures(source, kind);
  const points = kind === "point" ? new PointPrimitiveCollection({ show: false }) : undefined;
  const pointIdentities = new Map<PointPrimitive, { key: VectorFeatureKey; id: object; position: Cartesian3 }>();
  const polylines = kind === "point" ? undefined : new PolylineCollection({ show: false });
  const attributes = new Map<string, Record<string, unknown> | null>();
  const polylineIdentities = new Map<Polyline, { key: VectorFeatureKey; id: object; positions: Cartesian3[] }>();
  const fillIdentities = new Map<object, VectorFeatureKey>();
  const fillDisplayMatrix = Matrix4.fromUniformScale(DISPLAY_SCALE);
  let fill: Primitive | undefined;
  let fillColorsPending = true;
  let disposed = false;
  let released = false;
  let style: NativeVectorStyle = kind === "point" ? readNativePointStyle(undefined)
    : kind === "line" ? readNativeLineStyle(undefined) : readNativePolygonStyle(undefined);
  let opacity = 1;
  const primitiveDetached = (owner: Primitive | PolylineCollection | PointPrimitiveCollection) => viewer.scene.isDestroyed() || viewer.scene.primitives.isDestroyed() || !viewer.scene.primitives.contains(owner);
  const isDetached = () =>
    (!points || (primitiveDetached(points) && points.isDestroyed())) &&
    (!fill || (primitiveDetached(fill) && fill.isDestroyed())) && (!polylines || (primitiveDetached(polylines) && polylines.isDestroyed()));
  const isAttached = () => !disposed &&
    (!points || (!points.isDestroyed() && !primitiveDetached(points) && points.length === pointIdentities.size &&
      [...pointIdentities.keys()].every(point => points.contains(point)))) &&
    (!fill || (!fill.isDestroyed() && !primitiveDetached(fill))) &&
    (!polylines || (!polylines.isDestroyed() && !primitiveDetached(polylines) && polylines.length === polylineIdentities.size &&
      [...polylineIdentities.keys()].every(line => polylines.contains(line))));
  const assertAttached = (): void => {
    if (!isAttached()) throw new Error("The vector layer is disposed or detached.");
  };
  const applyFillColor = (): void => {
    if (!fill || !fillColorsPending || !fill.ready || !("fillColor" in style)) return;
    const color = Color.fromCssColorString(style.fillColor)!.withAlpha(opacity);
    for (const id of fillIdentities.keys()) {
      const value = fill.getGeometryInstanceAttributes(id);
      if (!value?.color) throw new Error("A polygon fill part has no native color attributes.");
      value.color = ColorGeometryInstanceAttribute.toValue(color, value.color);
    }
    fillColorsPending = false;
  };
  const applyStyle = (): void => {
    const color = Color.fromCssColorString("singleColor" in style ? style.singleColor : "lineColor" in style ? style.lineColor : style.outlineColor)!.withAlpha(opacity);
    if ("singleColor" in style) {
      for (const point of pointIdentities.keys()) { point.color = color; point.pixelSize = style.pointSize; }
    } else {
      if ("fillColor" in style) fillColorsPending = true;
      for (const line of polylineIdentities.keys()) {
        line.material.uniforms.color = Color.clone(color);
        line.width = "lineColor" in style ? style.lineWidth : style.outlineWidth;
      }
    }
    applyFillColor();
    viewer.scene.requestRender();
  };
  const positionsMatch = (actual: Cartesian3[], expected: Cartesian3[]) => Array.isArray(actual) && actual.length === expected.length &&
    expected.every((point, index) => Cartesian3.equals(point, actual[index]));
  const matchesPolylines = (visible: boolean, alpha: number, rgb: string, width: number) => {
    const color = Color.fromCssColorString(rgb)!.withAlpha(alpha);
    return !!polylines && polylines.show === visible && Matrix4.equals(polylines.modelMatrix, Matrix4.IDENTITY) && [...polylineIdentities].every(([line, identity]) => line.show &&
      line.id === identity.id && positionsMatch(line.positions, identity.positions) && line.width === width &&
      line.material.type === "Color" && Color.equals(line.material.uniforms.color, color));
  };
  const handle: VectorLayerHandle = {
    kind, isAttached, isDetached,
    prepareFrame() {
      assertAttached();
      // Fill ready first becomes true after rendering; apply its pending colors
      // before the next frame. Direct Point/Polyline collections prepare in the
      // Scene's synchronous update. Hidden frames do not promise GPU warmup.
      applyFillColor();
    },
    matches(state) {
      if (!isAttached()) return false;
      if (kind === "point" && "singleColor" in state.style) {
        const target = state.style;
        const color = Color.fromCssColorString(target.singleColor)!.withAlpha(state.opacity);
        return !!points && points.show === state.visible && Matrix4.equals(points.modelMatrix, Matrix4.IDENTITY) && [...pointIdentities].every(([point, identity]) => point.show &&
          point.id === identity.id && Cartesian3.equals(point.position, identity.position) &&
          Color.equals(point.color, color) && point.pixelSize === target.pointSize);
      }
      if (kind === "line" && "lineColor" in state.style) {
        return matchesPolylines(state.visible, state.opacity, state.style.lineColor, state.style.lineWidth);
      }
      if (kind === "polygon" && "fillColor" in state.style) {
        if (!fill || !fill.ready || fillColorsPending || fill.show !== state.visible || !Matrix4.equals(fill.modelMatrix, fillDisplayMatrix) || !polylines || polylines.show !== state.visible) return false;
        const bytes = ColorGeometryInstanceAttribute.toValue(Color.fromCssColorString(state.style.fillColor)!.withAlpha(state.opacity));
        for (const id of fillIdentities.keys()) {
          const actual = fill.getGeometryInstanceAttributes(id)?.color;
          if (!actual || actual.length !== 4 || !bytes.every((value, index) => value === actual[index])) return false;
        }
        return matchesPolylines(state.visible, state.opacity, state.style.outlineColor, state.style.outlineWidth);
      }
      return false;
    },
    getAttributes(featureId) {
      const value = attributes.get(featureId);
      return value === undefined ? undefined : redactSensitive(value) as Record<string, unknown> | null;
    },
    resolvePick(picked) {
      if (!isAttached()) return undefined;
      if (fill && object(picked) && picked.primitive === fill && object(picked.id)) {
        const key = fillIdentities.get(picked.id);
        return key ? { ...key } : undefined;
      }
      if (points && object(picked) && picked.collection === points) {
        const identity = pointIdentities.get(picked.primitive as PointPrimitive);
        return identity && picked.id === identity.id && points.contains(picked.primitive as PointPrimitive) ? { ...identity.key } : undefined;
      }
      if (polylines && object(picked) && picked.collection === polylines) {
        const identity = polylineIdentities.get(picked.primitive as Polyline);
        return identity && picked.id === identity.id && polylines.contains(picked.primitive as Polyline) ? { ...identity.key } : undefined;
      }
      return undefined;
    },
    setVisible(visible) {
      assertAttached();
      if (typeof visible !== "boolean") throw new AgentActionValidationError("Visibility must be boolean.");
      if (points) points.show = visible;
      if (fill) fill.show = visible;
      if (polylines) polylines.show = visible;
      viewer.scene.requestRender();
    },
    setOpacity(value) {
      assertAttached();
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new AgentActionValidationError("Opacity must be within [0, 1].");
      opacity = value; applyStyle();
    },
    setStyle(value) {
      assertAttached();
      style = kind === "point" ? readNativePointStyle({ ...defaultNativePointStyle(), ...value })
        : kind === "line" ? readNativeLineStyle(value) : readNativePolygonStyle(value);
      applyStyle();
    },
    dispose() {
      if (released) return;
      disposed = true;
      attributes.clear(); pointIdentities.clear(); fillIdentities.clear(); polylineIdentities.clear();
      const errors: unknown[] = [];
      for (const owner of [points, fill, polylines]) {
        if (!owner) continue;
        if (!owner.isDestroyed()) {
          try { owner.show = false; } catch (error) { errors.push(error); }
        }
        let removalFailed = false;
        try { if (!primitiveDetached(owner)) viewer.scene.primitives.remove(owner); }
        catch (error) { removalFailed = true; errors.push(error); }
        // remove may splice before destroy throws. Retain the exact direct owner
        // for a later retry, without double destruction in this pass.
        if (!removalFailed && primitiveDetached(owner) && !owner.isDestroyed()) {
          try { owner.destroy(); } catch (error) { errors.push(error); }
        }
        if (!primitiveDetached(owner) || !owner.isDestroyed()) errors.push(new Error("Native vector owner cleanup is incomplete."));
      }
      try { if (!viewer.scene.isDestroyed()) viewer.scene.requestRender(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, "Vector layer cleanup failed.");
      released = true;
    },
  };
  try {
    const fillInstances: GeometryInstance[] = [];
    for (const feature of features) {
      attributes.set(feature.featureId, feature.attributes);
      feature.fills.forEach((instance, part) => {
        const id = Object.freeze({ layerId, featureId: feature.featureId, part });
        instance.id = id;
        instance.attributes.color = ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(readNativePolygonStyle(undefined).fillColor)!);
        fillIdentities.set(id, { layerId, featureId: feature.featureId, sourceRef: source.sourceRef });
        fillInstances.push(instance);
      });
      feature.parts.forEach((positions, part) => {
        const key = { layerId, featureId: feature.featureId, sourceRef: source.sourceRef };
        // Pure line/ring preparation remains on R at h=0. Only these display
        // copies move outward; source positions and native fill geometry stay intact.
        const displayPositions = points ? positions.map(point => Cartesian3.clone(point))
          : positions.map(point => Cartesian3.multiplyByScalar(point, DISPLAY_SCALE, new Cartesian3()));
        const expectedPositions = displayPositions.map(point => Cartesian3.clone(point));
        if (points) {
          const id = Object.freeze({ layerId, featureId: feature.featureId, part });
          const point = points.add({ position: displayPositions[0], pixelSize: 6, color: Color.WHITE, outlineColor: Color.BLACK, outlineWidth: 0, id });
          pointIdentities.set(point, { key, id, position: expectedPositions[0]! });
        } else if (polylines) {
          const id = Object.freeze({ layerId, featureId: feature.featureId, ...(kind === "line" ? { part } : feature.polygonRings[part]) });
          const line = polylines.add({ positions: displayPositions, width: 2, material: Material.fromType("Color", { color: kind === "line" ? Color.fromCssColorString("#38bdf8")! : Color.clone(Color.WHITE) }), id });
          polylineIdentities.set(line, { key, id, positions: expectedPositions });
        }
      });
    }
    if (kind === "polygon") fill = new Primitive({ geometryInstances: fillInstances, modelMatrix: fillDisplayMatrix,
      appearance: new PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }), show: false, asynchronous: false });
    assertRequest();
    // Each layer directly owns its native collections. Their synchronous add
    // observers may cancel, remove the candidate, or throw after attachment.
    if (points) viewer.scene.primitives.add(points);
    if (fill) viewer.scene.primitives.add(fill);
    if (polylines) viewer.scene.primitives.add(polylines);
    assertRequest();
    if (!isAttached()) throw new OperationInterruptedError("superseded", "A native vector owner was removed during attachment.");
    return handle;
  } catch (error) {
    try { handle.dispose(); }
    catch (cleanupError) { throw new VectorAttachmentError(error, cleanupError, handle); }
    throw error;
  }
}
