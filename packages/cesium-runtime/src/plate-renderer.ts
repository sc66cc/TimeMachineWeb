import {
  Cartesian2,
  Cartesian3,
  Cartographic,
  Color,
  ColorGeometryInstanceAttribute,
  GeometryInstance,
  Material,
  PerInstanceColorAppearance,
  PolylineCollection,
  Primitive,
  type PrimitiveCollection,
  ScreenSpaceEventHandler,
  ScreenSpaceEventType,
  ShowGeometryInstanceAttribute,
  Viewer,
} from "cesium";

import {
  isFeatureValidAtTime,
  type PlateFeature,
  type Quaternion,
  type RotationModel,
} from "@timemachine/reconstruction-core";
import {
  OUTLINE_ELLIPSOID,
  lonLatToCartesian,
  triangulatePlatePolygon,
} from "./geometry";
import {
  buildRectanglePlateCpuFrame,
  createRectanglePlateAbortError,
  type RectanglePlateCpuFrame,
  type RectanglePlateCpuFrameStats,
  type RectanglePlateTimeState,
} from "./plate-rectangle-frame";
import { quaternionToCesiumMatrix } from "./plate-rotation-matrix";
import { buildMollweidePlateCpuFrame, type MollweideFrameStats } from "./plate-mollweide-frame";
import { MollweideWorkerClient } from "./mollweide-worker-client";
import {
  capturePlatePolygonMesh,
  type PlatePolygonMeshSnapshot,
} from "./plate-mesh-snapshot";

export {
  capturePlatePolygonMesh,
  createWorkingPlateGeometry,
  plateTriangleSourceId,
  retainPlatePolygonMesh,
  type PlatePolygonMeshSnapshot,
} from "./plate-mesh-snapshot";

export { quaternionToCesiumMatrix } from "./plate-rotation-matrix";
export type {
  RectanglePlateCpuFrameStats,
  RectanglePlateTimeState,
} from "./plate-rectangle-frame";

const GEOLOGICAL_PALETTE = [
  "#d99a52",
  "#c86552",
  "#6fa89b",
  "#7894b3",
  "#a7a269",
  "#a67f98",
  "#d1b873",
  "#5f9aa6",
] as const;

export interface PlatePick {
  kind: "plate-feature";
  feature: PlateFeature;
  polygonIndex: number;
  layerId?: number;
}

export interface PlateRendererOptions {
  layerId?: number;
  graticule?: boolean;
  signal?: AbortSignal;
}

/** Creation failed and cleanup also failed; the caller still owns this renderer. */
export class PlateRendererCreateError extends Error {
  readonly renderer: PlateRenderer;
  readonly cleanupError: unknown;

  constructor(cause: unknown, cleanupError: unknown, renderer: PlateRenderer) {
    super("PlateRenderer creation failed and its resources could not all be released.", { cause });
    this.name = "PlateRendererCreateError";
    this.cleanupError = cleanupError;
    this.renderer = renderer;
  }
}

interface RenderedInstance {
  id: PlatePick;
  feature: PlateFeature;
}

interface RenderedOutline {
  feature: PlateFeature;
  polyline: ReturnType<PolylineCollection["add"]>;
}

interface PlateBundle {
  plateId: number;
  fill: Primitive;
  outlines: PolylineCollection;
  instances: RenderedInstance[];
  renderedOutlines: RenderedOutline[];
}

export interface RendererBuildStats {
  renderedFeatureCount: number;
  polygonCount: number;
  plateCount: number;
  triangleCount: number;
  vertexCount: number;
  skippedPolygonCount: number;
  warnings: string[];
}

export interface RenderTimeState {
  activeFeatureCount: number;
  activePlateCount: number;
  disconnectedFeatureCount: number;
  rotationMap: ReadonlyMap<number, Quaternion>;
}

export type BuildProgressCallback = (
  completedPlates: number,
  totalPlates: number,
) => void;

/** Aggregate view over the CPU-side meshes retained for a future projection runtime. */
export interface RetainedMeshStats {
  snapshotCount: number;
  vertexCount: number;
  triangleCount: number;
  positionByteLength: number;
  indexByteLength: number;
}

/**
 * Public handle of one prepared rectangle frame.
 *
 * Deliberately narrow: generation, time and accounting only. The CPU geometry
 * and its buffers stay in the renderer's private single slot, so a handle can
 * never be mistaken for a committed view, and a future staging step must match
 * the slot by object identity plus generation - equal numbers alone are not
 * proof that a frame is still the prepared one.
 */
export interface PreparedRectanglePlateFrame {
  readonly generation: number;
  readonly timeMa: number;
  readonly timeState: RectanglePlateTimeState;
  readonly stats: RectanglePlateCpuFrameStats;
}

/**
 * Opaque token proving a rectangle frame was staged and verified GL-ready.
 *
 * The commit is a separate, generation-checked step: holding this token says
 * the CPU geometry was uploaded and warmed without a render error, not that
 * the view shows it. No GPU object or buffer is exposed.
 */
export interface StagedRectangleFrame {
  readonly generation: number;
  readonly timeMa: number;
  /** False when the frame had no drawable polygon (an empty but valid view). */
  readonly hasContent: boolean;
}

interface ReleasablePrimitive {
  isDestroyed(): boolean;
  destroy(): void;
}

/** The in-flight staged rectangle frame: warmed up, not yet committed. */
interface RectangleStaging {
  generation: number;
  timeMa: number;
  fill: Primitive | undefined;
  outlines: PolylineCollection | undefined;
  instances: RenderedInstance[];
  renderedOutlines: RenderedOutline[];
  /** Settles the warm-up promise; installed by {@link PlateRenderer.warmUpRectangleFrame}. */
  settle?: (error?: Error) => void;
}

/** The committed rectangle frame currently owning the 2D view. */
interface RectangleCommitted {
  generation: number;
  timeMa: number;
  fill: Primitive | undefined;
  outlines: PolylineCollection | undefined;
  instances: RenderedInstance[];
  renderedOutlines: RenderedOutline[];
}

/**
 * True when the value carries a working `isDestroyed` that reports destroyed.
 * The check tolerates a missing method so that a viewer stand-in which never
 * implements it behaves exactly as before.
 */
function reportsDestroyed(value: unknown): boolean {
  const candidate = value as
    | { isDestroyed?: () => boolean }
    | null
    | undefined;
  return (
    typeof candidate?.isDestroyed === "function" && candidate.isDestroyed()
  );
}

function colorForPlate(plateId: number, alpha = 1): Color {
  const css =
    GEOLOGICAL_PALETTE[
      Math.abs(plateId * 17 + Math.floor(plateId / 10)) %
        GEOLOGICAL_PALETTE.length
    ] ?? GEOLOGICAL_PALETTE[0];
  return Color.fromCssColorString(css).withAlpha(alpha);
}

function populateGraticule(collection: PolylineCollection): void {
  const color = Color.fromCssColorString("#9fc3c2").withAlpha(0.14);

  for (let latitude = -75; latitude <= 75; latitude += 15) {
    const positions: Cartesian3[] = [];
    for (let longitude = -180; longitude <= 180; longitude += 2) {
      positions.push(
        OUTLINE_ELLIPSOID.cartographicToCartesian(
          Cartographic.fromDegrees(longitude, latitude),
        ),
      );
    }
    // A fresh material per polyline: Cesium destroys the material of every
    // polyline it owns, so sharing one across a collection breaks destroy.
    collection.add({
      positions,
      width: latitude === 0 ? 1.1 : 0.55,
      material: Material.fromType("Color", { color }),
    });
  }

  for (let longitude = -180; longitude < 180; longitude += 30) {
    const positions: Cartesian3[] = [];
    for (let latitude = -90; latitude <= 90; latitude += 2) {
      positions.push(
        OUTLINE_ELLIPSOID.cartographicToCartesian(
          Cartographic.fromDegrees(longitude, latitude),
        ),
      );
    }
    collection.add({
      positions,
      width: 0.55,
      material: Material.fromType("Color", { color }),
    });
  }
}

function createAbortError(): DOMException {
  return new DOMException("PlateRenderer creation aborted.", "AbortError");
}

function checkCreateSignal(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw createAbortError();
}

function nextFrame(signal?: AbortSignal): Promise<void> {
  checkCreateSignal(signal);
  return new Promise((resolve, reject) => {
    const frame = requestAnimationFrame(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    });
    const abort = (): void => {
      cancelAnimationFrame(frame);
      reject(createAbortError());
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class PlateRenderer {
  readonly buildStats: RendererBuildStats;

  private readonly viewer: Viewer;
  private readonly layerId: number | undefined;
  private readonly ownedPickIds = new WeakSet<PlatePick>();
  /** Includes allocated objects before scene insertion and failed releases. */
  private readonly ownedPrimitives = new Set<ReleasablePrimitive>();
  private readonly bundles = new Map<number, PlateBundle>();
  private readonly retainedMeshes: PlatePolygonMeshSnapshot[] = [];
  private readonly clickHandler: ScreenSpaceEventHandler;
  private graticule: PolylineCollection | undefined;
  private pickCallback: ((pick: PlatePick) => void) | undefined;
  private destroyed = false;
  private plateGeometryVisible = true;
  private plateGeometryOpacity = 1;
  /** Single slot for the prepared CPU frame; `data` never leaves the renderer. */
  private rectanglePreparation:
    | { handle: PreparedRectanglePlateFrame; data: RectanglePlateCpuFrame }
    | undefined;
  private rectanglePreparationGeneration = 0;
  private rectanglePreparationController: AbortController | undefined;
  /** In-flight staged rectangle frame (warmed, not committed). */
  private rectangleStaging: RectangleStaging | undefined;
  /** Committed rectangle frame currently owning the 2D view. */
  private rectangleCommitted: RectangleCommitted | undefined;
  private retiredFrame: { generation: number; frame: RectangleCommitted | undefined } | undefined;
  private flatMode: "rectangle" | "mollweide" | undefined;
  private retiredMode: "rectangle" | "mollweide" | undefined;
  private mollweideStats: MollweideFrameStats | undefined;
  private mollweideWorker: MollweideWorkerClient | undefined;
  get lastMollweideWorkerTiming() { return this.mollweideWorker?.lastTiming; }
  private pickFilter: ((position: Cartesian2) => boolean) | undefined;

  setFlatPickFilter(filter: ((position: Cartesian2) => boolean) | undefined): void { this.pickFilter = filter; }
  get lastMollweideFrameStats(): MollweideFrameStats | undefined { return this.mollweideStats; }

  /** Retain only the old committed resources until the replacement really renders. */
  beginFlatSwap(generation: number): void {
    if (this.retiredFrame) this.rollbackFlatSwap(this.retiredFrame.generation);
    this.retiredMode = this.flatMode;
    this.retiredFrame = { generation, frame: this.rectangleCommitted };
    this.rectangleCommitted = undefined;
  }
  confirmFlatSwap(generation: number): void {
    if (this.retiredFrame?.generation !== generation) return;
    const old = this.retiredFrame.frame;
    this.retiredFrame = undefined;
    this.releasePrimitives([old?.fill, old?.outlines]);
  }
  rollbackFlatSwap(generation: number): void {
    if (this.retiredFrame?.generation !== generation) return;
    this.disposeCommittedRectangle();
    this.rectangleCommitted = this.retiredFrame.frame;
    this.flatMode = this.retiredMode;
    this.retiredFrame = undefined;
    for (const bundle of this.bundles.values()) {
      bundle.fill.show = !this.flatMode && this.plateGeometryVisible;
      bundle.outlines.show = !this.flatMode && this.plateGeometryVisible;
    }
    if (this.graticule) this.graticule.show = !this.flatMode;
    if (this.rectangleCommitted?.fill) this.rectangleCommitted.fill.show = true;
    if (this.rectangleCommitted?.outlines) this.rectangleCommitted.outlines.show = true;
    this.applyRectangleCommittedVisibility();
    this.applyRectangleCommittedOpacity();
    this.viewer.scene.requestRender();
  }

  private constructor(viewer: Viewer, buildStats: RendererBuildStats, layerId?: number) {
    this.viewer = viewer;
    this.buildStats = buildStats;
    this.layerId = layerId;
    this.clickHandler = new ScreenSpaceEventHandler(viewer.scene.canvas);
    this.clickHandler.setInputAction(
      (event: { position: Cartesian2 }) => {
        if (this.destroyed) return;
        if (this.pickFilter && !this.pickFilter(event.position)) return;
        const picked = this.viewer.scene.pick(event.position);
        const id = picked?.id as PlatePick | undefined;
        if (id?.kind === "plate-feature" && this.ownedPickIds.has(id)) {
          this.pickCallback?.(id);
        }
      },
      ScreenSpaceEventType.LEFT_CLICK,
    );
  }

  static async create(
    viewer: Viewer,
    features: readonly PlateFeature[],
    onProgress?: BuildProgressCallback,
    options: PlateRendererOptions = {},
  ): Promise<PlateRenderer> {
    checkCreateSignal(options.signal);
    const stats: RendererBuildStats = {
      renderedFeatureCount: 0,
      polygonCount: 0,
      plateCount: 0,
      triangleCount: 0,
      vertexCount: 0,
      skippedPolygonCount: 0,
      warnings: [],
    };
    const renderer = new PlateRenderer(viewer, stats, options.layerId);
    try {
    if (options.graticule !== false) {
      renderer.graticule = renderer.ownPrimitive(new PolylineCollection());
      populateGraticule(renderer.graticule);
      viewer.scene.primitives.add(renderer.graticule);
    }
    const featuresByPlate = new Map<number, PlateFeature[]>();

    for (const feature of features) {
      checkCreateSignal(options.signal);
      if (feature.polygons.length === 0) {
        continue;
      }
      const plateFeatures = featuresByPlate.get(feature.plateId) ?? [];
      plateFeatures.push(feature);
      featuresByPlate.set(feature.plateId, plateFeatures);
    }

    const plateGroups = [...featuresByPlate.entries()];
    for (const [plateIndex, [plateId, plateFeatures]] of plateGroups.entries()) {
      checkCreateSignal(options.signal);
      const instances: GeometryInstance[] = [];
      const renderedInstances: RenderedInstance[] = [];
      const outlines = renderer.ownPrimitive(new PolylineCollection());
      const renderedOutlines: RenderedOutline[] = [];

      for (const feature of plateFeatures) {
        let featureWasRendered = false;
        for (const [polygonIndex, polygon] of feature.polygons.entries()) {
          checkCreateSignal(options.signal);
          let triangulated: ReturnType<typeof triangulatePlatePolygon>;
          try {
            triangulated = triangulatePlatePolygon(polygon);
            // Keep the CPU-side source mesh before Cesium takes ownership of
            // the geometry, so a future projection runtime can rebuild it.
            renderer.retainedMeshes.push(
              capturePlatePolygonMesh(
                feature,
                polygonIndex,
                triangulated.geometry,
              ),
            );
          } catch (error) {
            stats.skippedPolygonCount += 1;
            stats.warnings.push(
              `${feature.id} polygon ${polygonIndex}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            continue;
          }
            const id = renderer.createPickId(feature, polygonIndex);
            const initiallyVisible = isFeatureValidAtTime(feature, 0);
            instances.push(
              new GeometryInstance({
                id,
                geometry: triangulated.geometry,
                attributes: {
                  color: ColorGeometryInstanceAttribute.fromColor(
                    colorForPlate(plateId, 0.9),
                  ),
                  show: new ShowGeometryInstanceAttribute(initiallyVisible),
                },
              }),
            );
            renderedInstances.push({ id, feature });

            const outlineColor = Color.fromCssColorString("#e6dec8").withAlpha(
              0.46,
            );
            for (const ring of [polygon.exterior, ...polygon.holes]) {
              const closedRing = [...ring, ring[0]].filter(
                (coordinate): coordinate is NonNullable<typeof coordinate> =>
                  coordinate !== undefined,
              );
              const polyline = outlines.add({
                id,
                positions: closedRing.map((coordinate) =>
                  lonLatToCartesian(coordinate, OUTLINE_ELLIPSOID),
                ),
                width: 0.75,
                // One material per polyline: Cesium destroys the material of
                // every polyline it owns, so sharing one across a collection
                // breaks destroy.
                material: Material.fromType("Color", { color: outlineColor }),
                show: initiallyVisible,
              });
              renderedOutlines.push({ feature, polyline });
            }

            featureWasRendered = true;
            stats.polygonCount += 1;
            stats.triangleCount += triangulated.triangleCount;
            stats.vertexCount += triangulated.vertexCount;
        }
        if (featureWasRendered) {
          stats.renderedFeatureCount += 1;
        }
      }

      if (instances.length > 0) {
        const fill = renderer.ownPrimitive(new Primitive({
          geometryInstances: instances,
          appearance: new PerInstanceColorAppearance({
            flat: true,
            translucent: true,
            closed: false,
            faceForward: true,
          }),
          asynchronous: false,
          releaseGeometryInstances: true,
        }));
        viewer.scene.primitives.add(fill);
        viewer.scene.primitives.add(outlines);

        renderer.bundles.set(plateId, {
          plateId,
          fill,
          outlines,
          instances: renderedInstances,
          renderedOutlines,
        });
      } else {
        renderer.releaseOwnedPrimitive(outlines);
      }

      stats.plateCount = renderer.bundles.size;
      onProgress?.(plateIndex + 1, plateGroups.length);
      checkCreateSignal(options.signal);
      if ((plateIndex + 1) % 8 === 0) {
        viewer.scene.requestRender();
        await nextFrame(options.signal);
        checkCreateSignal(options.signal);
      }
    }

    checkCreateSignal(options.signal);
    return renderer;
    } catch (error) {
      try {
        renderer.destroy();
      } catch (cleanupError) {
        throw new PlateRendererCreateError(error, cleanupError, renderer);
      }
      throw error;
    }
  }

  private createPickId(feature: PlateFeature, polygonIndex: number): PlatePick {
    const id: PlatePick = { kind: "plate-feature", feature, polygonIndex };
    if (this.layerId !== undefined) id.layerId = this.layerId;
    this.ownedPickIds.add(id);
    return id;
  }

  setPickCallback(callback: (pick: PlatePick) => void): void {
    this.pickCallback = callback;
  }

  /**
   * Read-only view of the retained source meshes. Callers must not mutate the
   * buffers; they belong to the renderer until it is destroyed.
   */
  get retainedMeshSnapshots(): readonly PlatePolygonMeshSnapshot[] {
    return this.retainedMeshes;
  }

  get retainedMeshStats(): RetainedMeshStats {
    let vertexCount = 0;
    let triangleCount = 0;
    let positionByteLength = 0;
    let indexByteLength = 0;
    for (const snapshot of this.retainedMeshes) {
      vertexCount += snapshot.vertexCount;
      triangleCount += snapshot.triangleCount;
      positionByteLength += snapshot.positionByteLength;
      indexByteLength += snapshot.indexByteLength;
    }
    return {
      snapshotCount: this.retainedMeshes.length,
      vertexCount,
      triangleCount,
      positionByteLength,
      indexByteLength,
    };
  }

  /**
   * Prepares the CPU-side plate frame for a future rectangle projection.
   *
   * Preparation is not a commit: no primitive is added, the scene's primitive
   * count and the displayed globe frame are untouched, and resolving this
   * promise says nothing about what the view shows. A new request supersedes
   * whatever is pending or already prepared - the older promise settles with
   * an AbortError and the older frame leaves the slot - and `updateTime`,
   * `cancelRectanglePreparation` and `destroy` invalidate it the same way.
   * Every returned promise settles, so callers must handle the rejection of a
   * superseded or cancelled preparation.
   */
  async prepareRectangleFrame(
    timeMa: number,
    rotationModel: RotationModel,
    mode: "rectangle" | "mollweide" = "rectangle",
  ): Promise<PreparedRectanglePlateFrame> {
    if (this.destroyed) {
      throw new Error("PlateRenderer has been destroyed.");
    }
    // An invalid request is rejected before anything is invalidated, so it can
    // never cancel a preparation that is already running.
    if (!Number.isFinite(timeMa)) {
      throw new Error("prepareRectangleFrame requires a finite time in Ma.");
    }
    this.invalidateRectanglePreparation();
    const generation = this.rectanglePreparationGeneration + 1;
    this.rectanglePreparationGeneration = generation;
    const controller = new AbortController();
    this.rectanglePreparationController = controller;

    try {
      const rotationMap = rotationModel.getRotationMap(timeMa, 0);
      if (mode === "mollweide" && typeof Worker !== "undefined") this.mollweideWorker ??= new MollweideWorkerClient(this.retainedMeshes);
      const frame = mode === "mollweide" && this.mollweideWorker
        ? await this.mollweideWorker.prepare(timeMa, rotationMap, controller.signal)
        : await (mode === "mollweide" ? buildMollweidePlateCpuFrame : buildRectanglePlateCpuFrame)(this.retainedMeshes, timeMa, rotationMap, controller.signal);
      if (
        this.destroyed ||
        controller.signal.aborted ||
        generation !== this.rectanglePreparationGeneration
      ) {
        // Only the current preparation may occupy the slot; a superseded,
        // cancelled or post-destroy result settles as an abort instead.
        throw createRectanglePlateAbortError();
      }
      const handle: PreparedRectanglePlateFrame = {
        generation,
        timeMa,
        timeState: frame.timeState,
        stats: frame.stats,
      };
      if ("mollweideStats" in frame) this.mollweideStats = frame.mollweideStats as MollweideFrameStats;
      this.rectanglePreparation = { handle, data: frame };
      return handle;
    } finally {
      // Clear the pending marker on every exit path - success, failure and
      // abort alike - but only while this request is still the registered one:
      // an older request settling late must not clear a newer request's
      // controller or slot.
      if (this.rectanglePreparationController === controller) {
        this.rectanglePreparationController = undefined;
      }
    }
  }

  /** Cancels the pending preparation and drops any prepared frame. */
  cancelRectanglePreparation(releaseWorker = false): void {
    this.invalidateRectanglePreparation();
    // An active abort terminates its worker through the client's signal handler.
    // Keep an idle model worker/cache resident across ordinary mode changes.
    if (releaseWorker) this.mollweideWorker?.dispose();
  }

  /**
   * Stages the prepared CPU frame for `handle` as GPU primitives and warms
   * them up, without touching the committed frame.
   *
   * The prepared frame is consumed exactly once (single-use): the working
   * geometry is handed to Cesium, whose pipeline may transform it, so it can
   * never be staged twice. A handle that is not the current prepared slot -
   * superseded, cancelled, time-changed or already consumed - settles with an
   * AbortError instead of staging stale geometry.
   *
   * Warm-up uses the pattern proven in the browser diagnostics: the fill
   * primitive and the outline collection are added with `show=true`, but every
   * instance and every line carries `show=false`, so nothing is drawn and the
   * old picture is untouched while GL resources are allocated. The promise
   * resolves only after the primitive is `ready` and every expected instance
   * id is confirmed through the public `getGeometryInstanceAttributes` - a
   * primitive that reports `ready` after a failed compile is rejected, not
   * accepted. `scene.renderError` rejects too. There is no timeout: the
   * postRender loop keeps requesting renders until the primitive is ready, and
   * a supersede/cancel/destroy settles it through the staging's `settle`.
   */
  async stageRectangleFrame(
    handle: PreparedRectanglePlateFrame,
    generation: number,
  ): Promise<StagedRectangleFrame> {
    if (this.destroyed) {
      throw new Error("PlateRenderer has been destroyed.");
    }
    const slot = this.rectanglePreparation;
    if (!slot || slot.handle !== handle) {
      throw createRectanglePlateAbortError();
    }
    const frame = slot.data;
    // Single-use: the CPU working geometry is about to be lent to Cesium.
    this.rectanglePreparation = undefined;

    const instances: GeometryInstance[] = [];
    const renderedInstances: RenderedInstance[] = [];
    const outlines = this.ownPrimitive(new PolylineCollection());
    const renderedOutlines: RenderedOutline[] = [];
    let fill: Primitive | undefined;
    let staging: RectangleStaging | undefined;

    try {
    for (const group of frame.plates) {
      if (!group.hasRotation) {
        continue;
      }
      for (const polygon of group.polygons) {
        // Validity is pinned per frame; an invalid polygon is not staged at
        // all rather than staged hidden, so the committed frame never shows a
        // stale reconstruction.
        if (!polygon.timeValid) {
          continue;
        }
        const id = this.createPickId(polygon.feature, polygon.pick.polygonIndex);
        instances.push(
          new GeometryInstance({
            id,
            geometry: polygon.geometry,
            // The plate rotation is baked here, at build time; the primitive
            // itself stays identity and lets the native pipeline do the
            // Geographic (IDL) projection.
            modelMatrix: group.rotationMatrix,
            attributes: {
              color: ColorGeometryInstanceAttribute.fromColor(
                colorForPlate(group.plateId, 0.9 * this.plateGeometryOpacity),
              ),
              show: new ShowGeometryInstanceAttribute(false),
            },
          }),
        );
        renderedInstances.push({ id, feature: polygon.feature });

        const outlineColor = Color.fromCssColorString("#e6dec8").withAlpha(
          0.46 * this.plateGeometryOpacity,
        );
        for (const ring of polygon.outlineRings) {
          const polyline = outlines.add({
            // Rotated on the CPU; Mollweide seam pieces deliberately stay open.
            // The collection stays identity. Cesium owns a fresh material per line.
            id,
            positions: ring,
            width: 0.75,
            material: Material.fromType("Color", { color: outlineColor }),
            show: false,
          });
          renderedOutlines.push({ feature: polygon.feature, polyline });
        }
      }
    }

    const collection = this.scenePrimitiveCollection();
    if (collection === null) {
      throw new Error("Cannot stage a rectangle frame: the scene is gone.");
    }
    if (instances.length > 0) {
      fill = this.ownPrimitive(new Primitive({
        geometryInstances: instances,
        appearance: new PerInstanceColorAppearance({
          flat: true,
          translucent: true,
          closed: false,
          faceForward: true,
        }),
        asynchronous: false,
        releaseGeometryInstances: true,
      }));
      fill.show = true;
      collection.add(fill);
    }
    if (renderedOutlines.length > 0) {
      outlines.show = true;
      collection.add(outlines);
    } else {
      this.releaseOwnedPrimitive(outlines);
    }

    staging = {
      generation,
      timeMa: frame.timeMa,
      fill,
      outlines: renderedOutlines.length > 0 ? outlines : undefined,
      instances: renderedInstances,
      renderedOutlines,
    };
    this.rectangleStaging = staging;

      await this.warmUpRectangleFrame(staging);
    } catch (error) {
      // If another operation cleared the slot, it already attempted cleanup.
      // Failed releases remain in ownedPrimitives for explicit destroy retry.
      if (!staging || this.rectangleStaging === staging) {
        this.rectangleStaging = undefined;
        try {
          this.releasePrimitives([fill, outlines]);
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], "Rectangle staging failed and cleanup failed.", { cause: error });
        }
      }
      throw error;
    }

    return { generation, timeMa: frame.timeMa, hasContent: fill !== undefined };
  }

  /**
   * Commits the staged rectangle frame: hides the globe bundles and graticule,
   * disposes any previously committed rectangle frame, and flips the staged
   * instances and lines to visible using the latest visibility and opacity.
   *
   * `generation` must match the in-flight staging, so a superseded or already
   * committed frame can never be committed twice.
   */
  commitRectangleFrame(generation: number, mode: "rectangle" | "mollweide" = "rectangle"): void {
    this.flatMode = mode;
    const staging = this.rectangleStaging;
    if (!staging || staging.generation !== generation) {
      throw new Error(
        "No staged rectangle frame matches this generation to commit.",
      );
    }
    this.rectangleStaging = undefined;
    if (this.retiredFrame?.frame?.fill) this.retiredFrame.frame.fill.show = false;
    if (this.retiredFrame?.frame?.outlines) this.retiredFrame.frame.outlines.show = false;
    this.disposeCommittedRectangle();

    for (const bundle of this.bundles.values()) {
      bundle.fill.show = false;
      bundle.outlines.show = false;
    }
    if (this.graticule) {
      this.graticule.show = false;
    }

    const visible = this.plateGeometryVisible;
    if (staging.fill) {
      staging.fill.show = true;
      if (staging.fill.ready) {
        for (const instance of staging.instances) {
          const attributes = staging.fill.getGeometryInstanceAttributes(
            instance.id,
          );
          if (attributes) {
            attributes.show = ShowGeometryInstanceAttribute.toValue(
              visible,
              attributes.show,
            );
            attributes.color = ColorGeometryInstanceAttribute.toValue(
              colorForPlate(instance.feature.plateId, 0.9 * this.plateGeometryOpacity),
              attributes.color,
            );
          }
        }
      }
    }
    if (staging.outlines) {
      staging.outlines.show = true;
      for (const outline of staging.renderedOutlines) {
        outline.polyline.show = visible;
        outline.polyline.material.uniforms.color = Color.fromCssColorString(
          "#e6dec8",
        ).withAlpha(0.46 * this.plateGeometryOpacity);
      }
    }

    this.rectangleCommitted = {
      generation,
      timeMa: staging.timeMa,
      fill: staging.fill,
      outlines: staging.outlines,
      instances: staging.instances,
      renderedOutlines: staging.renderedOutlines,
    };
    this.viewer.scene.requestRender();
  }

  /**
   * Returns the view to the globe: disposes the committed rectangle frame and
   * structurally un-hides the globe bundles and graticule. The host re-applies
   * the correct per-plate rotation and validity for the committed time through
   * `updateTime`, so the globe never shows a stale reconstruction.
   */
  restoreGlobeFrame(): void {
    this.flatMode = undefined;
    if (this.retiredFrame?.frame?.fill) this.retiredFrame.frame.fill.show = false;
    if (this.retiredFrame?.frame?.outlines) this.retiredFrame.frame.outlines.show = false;
    this.disposeCommittedRectangle();
    for (const bundle of this.bundles.values()) {
      bundle.fill.show = this.plateGeometryVisible;
      bundle.outlines.show = this.plateGeometryVisible;
    }
    if (this.graticule) {
      this.graticule.show = true;
    }
    this.viewer.scene.requestRender();
  }

  /**
   * Cancels the in-flight staging: settles its warm-up promise as an
   * AbortError and releases the staged primitives. The committed frame is left
   * exactly as it was.
   */
  cancelRectangleStaging(): void {
    const staging = this.rectangleStaging;
    if (!staging) {
      return;
    }
    this.rectangleStaging = undefined;
    staging.settle?.(createRectanglePlateAbortError());
    this.releasePrimitives([staging.fill, staging.outlines]);
  }

  /**
   * Drives renders until the staged fill primitive is ready and verified, or
   * fails. An empty frame (no fill) resolves immediately. Cancellation is
   * observed by comparing the live staging slot, so a supersede or a
   * `cancelRectangleStaging`/`destroy` settles as an AbortError.
   */
  private warmUpRectangleFrame(staging: RectangleStaging): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const scene = this.viewer.scene;
      let settled = false;
      let removePostRender: () => void = () => {};
      let removeRenderError: () => void = () => {};
      const finish = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        removePostRender();
        removeRenderError();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      staging.settle = finish;

      const verify = (): void => {
        if (settled) {
          return;
        }
        if (
          this.rectangleStaging !== staging ||
          reportsDestroyed(this.viewer) ||
          reportsDestroyed(scene)
        ) {
          finish(createRectanglePlateAbortError());
          return;
        }
        const fill = staging.fill;
        if (!fill) {
          finish();
          return;
        }
        if (fill.ready) {
          // A primitive can report `ready` after a failed shader compile, so
          // the public per-instance attributes are the real proof.
          for (const instance of staging.instances) {
            const attributes = fill.getGeometryInstanceAttributes(instance.id);
            if (!attributes || attributes.show === undefined) {
              finish(
                new Error(
                  "Rectangle fill primitive reported ready without its per-instance attributes.",
                ),
              );
              return;
            }
          }
          finish();
          return;
        }
        scene.requestRender();
      };

      removePostRender = scene.postRender.addEventListener(verify);
      removeRenderError = scene.renderError.addEventListener(
        (_scene: unknown, error: unknown) => {
          finish(error instanceof Error ? error : new Error(String(error)));
        },
      );
      scene.requestRender();
    });
  }

  private disposeCommittedRectangle(): void {
    const committed = this.rectangleCommitted;
    if (!committed) {
      return;
    }
    this.rectangleCommitted = undefined;
    this.releasePrimitives([committed.fill, committed.outlines]);
  }

  private applyRectangleCommittedVisibility(): void {
    const committed = this.rectangleCommitted;
    if (!committed) {
      return;
    }
    const visible = this.plateGeometryVisible;
    if (committed.fill?.ready) {
      for (const instance of committed.instances) {
        const attributes = committed.fill.getGeometryInstanceAttributes(
          instance.id,
        );
        if (attributes) {
          attributes.show = ShowGeometryInstanceAttribute.toValue(
            visible,
            attributes.show,
          );
        }
      }
    }
    for (const outline of committed.renderedOutlines) {
      outline.polyline.show = visible;
    }
  }

  private applyRectangleCommittedOpacity(): void {
    const committed = this.rectangleCommitted;
    if (!committed) {
      return;
    }
    if (committed.fill?.ready) {
      for (const instance of committed.instances) {
        const attributes = committed.fill.getGeometryInstanceAttributes(
          instance.id,
        );
        if (attributes) {
          attributes.color = ColorGeometryInstanceAttribute.toValue(
            colorForPlate(
              instance.feature.plateId,
              0.9 * this.plateGeometryOpacity,
            ),
            attributes.color,
          );
        }
      }
    }
    for (const outline of committed.renderedOutlines) {
      outline.polyline.material.uniforms.color = Color.fromCssColorString(
        "#e6dec8",
      ).withAlpha(0.46 * this.plateGeometryOpacity);
    }
  }

  /**
   * Aborts the pending preparation and clears the slot. Nothing GPU-owned is
   * touched: the committed frame, matrices, show flags and primitive count all
   * stay exactly as they were.
   */
  private invalidateRectanglePreparation(): void {
    this.rectanglePreparationController?.abort();
    this.rectanglePreparationController = undefined;
    this.rectanglePreparation = undefined;
  }

  setGraticuleVisible(visible: boolean): void {
    if (this.graticule) {
      this.graticule.show = visible;
    }
    this.viewer.scene.requestRender();
  }

  setPlateGeometryVisible(visible: boolean): void {
    this.plateGeometryVisible = visible;
    if (!visible) {
      for (const bundle of this.bundles.values()) {
        bundle.fill.show = false;
        bundle.outlines.show = false;
      }
    }
    this.applyRectangleCommittedVisibility();
    this.viewer.scene.requestRender();
  }

  setPlateGeometryOpacity(opacity: number): void {
    this.plateGeometryOpacity = Math.max(0, Math.min(1, opacity));
    for (const bundle of this.bundles.values()) {
      this.applyBundleOpacity(bundle);
    }
    this.applyRectangleCommittedOpacity();
    this.viewer.scene.requestRender();
  }

  updateTime(timeMa: number, rotationModel: RotationModel): RenderTimeState {
    // The globe fast path owns the visible globe frame. When a rectangle frame
    // is committed the globe bundles are hidden, so running this would re-show a
    // second, globe-projected copy of the same plates. Refuse instead of
    // producing that: the host must dispatch time by mode (the projection
    // controller re-prepares a rectangle frame for the new age).
    if (this.rectangleCommitted) {
      throw new Error(
        "PlateRenderer.updateTime is globe-only and the Rectangle projection is committed; change time through the projection controller instead.",
      );
    }
    // The globe path owns the visible frame: the moment it moves, any prepared
    // CPU rectangle frame is stale and must not be committed later.
    this.invalidateRectanglePreparation();
    const rotationMap = rotationModel.getRotationMap(timeMa, 0);
    const activeFeatureIds = new Set<string>();
    const activePlateIds = new Set<number>();
    let disconnectedFeatureCount = 0;

    for (const bundle of this.bundles.values()) {
      this.applyBundleOpacity(bundle);
      const rotation = rotationMap.get(bundle.plateId);
      const hasRotation = rotation !== undefined;
      bundle.fill.show = this.plateGeometryVisible && hasRotation;
      bundle.outlines.show = this.plateGeometryVisible && hasRotation;

      if (rotation) {
        quaternionToCesiumMatrix(rotation, bundle.fill.modelMatrix);
        quaternionToCesiumMatrix(rotation, bundle.outlines.modelMatrix);
      }

      for (const instance of bundle.instances) {
        const timeValid = isFeatureValidAtTime(instance.feature, timeMa);
        const show = hasRotation && timeValid;
        if (show) {
          activeFeatureIds.add(instance.feature.id);
          activePlateIds.add(bundle.plateId);
        } else if (timeValid && !hasRotation) {
          disconnectedFeatureCount += 1;
        }

        if (bundle.fill.ready) {
          const attributes = bundle.fill.getGeometryInstanceAttributes(
            instance.id,
          );
          if (attributes) {
            attributes.show = ShowGeometryInstanceAttribute.toValue(
              this.plateGeometryVisible && show,
              attributes.show,
            );
          }
        }
      }

      for (const outline of bundle.renderedOutlines) {
        outline.polyline.show =
          this.plateGeometryVisible &&
          hasRotation &&
          isFeatureValidAtTime(outline.feature, timeMa);
      }
    }

    this.viewer.scene.requestRender();
    return {
      activeFeatureCount: activeFeatureIds.size,
      activePlateCount: activePlateIds.size,
      disconnectedFeatureCount,
      rotationMap,
    };
  }

  /**
   * Releases everything this renderer owns and forgets it.
   *
   * Deterministic GPU release is `renderer.destroy()` followed by
   * `viewer.destroy()`: while the scene is still alive the primitives are
   * removed from the collection and destroyed through Cesium's own paths.
   * Destroying the viewer first lands in the late branch of
   * `releaseOwnedPrimitive`, which only clears this renderer's own state
   * safely - it does not guarantee that every primitive reports
   * `isDestroyed`, that GPU memory is reclaimed immediately, or that no canvas
   * reference survives (the readonly input handler may still hold one).
   * A failed release is reported and retained for a later destroy() retry.
   * Successfully released objects are never destroyed twice.
   */
  destroy(): void {
    this.destroyed = true;
    this.pickCallback = undefined;
    const errors: unknown[] = [];
    const attempt = (release: () => void): void => {
      try { release(); } catch (error) { errors.push(error); }
    };
    attempt(() => {
      this.mollweideWorker?.dispose();
      this.mollweideWorker = undefined;
    });
    // Invalidate CPU preparation before the owned GPU cleanup: a pending build
    // must never outlive this renderer or store a frame it would drop.
    attempt(() => this.invalidateRectanglePreparation());
    // Settle before releasing primitives; the ownership set also covers flat
    // resources whose former slot was cleared by a previous failed release.
    attempt(() => this.rectangleStaging?.settle?.(createRectanglePlateAbortError()));
    this.rectangleStaging = undefined;
    this.rectangleCommitted = undefined;
    this.retiredFrame = undefined;
    attempt(() => {
      if (!this.clickHandler.isDestroyed()) this.clickHandler.destroy();
    });
    for (const primitive of this.ownedPrimitives) {
      attempt(() => this.releaseOwnedPrimitive(primitive));
    }
    this.bundles.clear();
    this.graticule = undefined;
    this.retainedMeshes.length = 0;
    if (errors.length > 0) {
      throw new AggregateError(errors, "PlateRenderer could not release all owned resources; retry destroy().");
    }
  }

  private ownPrimitive<T extends ReleasablePrimitive>(primitive: T): T {
    this.ownedPrimitives.add(primitive);
    return primitive;
  }

  private releasePrimitives(primitives: readonly (ReleasablePrimitive | undefined)[]): void {
    const errors: unknown[] = [];
    for (const primitive of primitives) {
      if (!primitive) continue;
      try { this.releaseOwnedPrimitive(primitive); } catch (error) { errors.push(error); }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "PlateRenderer could not release all frame resources; destroy() can retry.");
    }
  }

  /**
   * Removes a primitive this renderer added to `scene.primitives` and makes
   * sure it is really destroyed afterwards.
   *
   * `PrimitiveCollection#remove` reports success whenever the primitive was in
   * the collection, but it only destroys it when the collection owns it
   * (`destroyPrimitives`, default true): with `destroyPrimitives: false` the
   * primitive is merely detached and stays alive, so the return value can never
   * be the last word. The actual `isDestroyed` state is checked instead, and
   * whatever is still alive is destroyed here.
   *
   * A viewer or a scene destroyed before this renderer is a different story.
   * `Context#destroy` drops the shader cache but does not release every
   * primitive vertex array and buffer, so a late primitive destructor can run
   * into `ShaderProgram`'s throwOnDestroyed guard instead of freeing anything,
   * and no public API offers that late release. The renderer therefore checks
   * the viewer and the scene before it touches the primitive at all and leaves
   * the primitive completely alone when either is gone: this branch is a safe
   * late CPU and cache cleanup, not a guarantee of destruction, GPU release or
   * dropped canvas references. Only primitives this renderer added are ever
   * passed here, so other code's primitives survive, and destroy stays
   * idempotent.
   */
  private releaseOwnedPrimitive(primitive: ReleasablePrimitive): void {
    if (!this.ownedPrimitives.has(primitive)) return;
    const collection = this.scenePrimitiveCollection();
    if (collection === null) {
      this.ownedPrimitives.delete(primitive);
      return;
    }
    if (primitive.isDestroyed()) {
      this.ownedPrimitives.delete(primitive);
      return;
    }
    collection.remove(primitive);
    if (!primitive.isDestroyed()) {
      primitive.destroy();
    }
    this.ownedPrimitives.delete(primitive);
  }

  /**
   * The scene's primitive collection, or null when the viewer or the scene is
   * destroyed and must not be touched. A destroyed viewer has torn its scene
   * down, and every method of a destroyed scene's collection throws.
   */
  private scenePrimitiveCollection(): PrimitiveCollection | null {
    if (reportsDestroyed(this.viewer)) {
      return null;
    }
    const scene = this.viewer.scene;
    if (reportsDestroyed(scene)) {
      return null;
    }
    return scene.primitives;
  }

  private applyBundleOpacity(bundle: PlateBundle): void {
    if (bundle.fill.ready) {
      for (const instance of bundle.instances) {
        const attributes = bundle.fill.getGeometryInstanceAttributes(
          instance.id,
        );
        if (attributes) {
          attributes.color = ColorGeometryInstanceAttribute.toValue(
            colorForPlate(
              bundle.plateId,
              0.9 * this.plateGeometryOpacity,
            ),
            attributes.color,
          );
        }
      }
    }
    for (const outline of bundle.renderedOutlines) {
      outline.polyline.material.uniforms.color =
        Color.fromCssColorString("#e6dec8").withAlpha(
          0.46 * this.plateGeometryOpacity,
        );
    }
  }
}
