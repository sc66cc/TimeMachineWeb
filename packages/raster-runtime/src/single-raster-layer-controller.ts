import { ImageryLayer, Rectangle, Viewer, WebMercatorTilingScheme } from "cesium";
import { SPHERICAL_EARTH } from "@timemachine/cesium-runtime";
import { ObservedAtlasProvider } from "./observed-atlas-provider";
import type { SingleRasterEntry, SingleRasterManifest, SingleRasterRuntimeState, SingleRasterSelectionResult } from "./types";

export type SingleRasterStateListener = (state: SingleRasterRuntimeState) => void;
export type RasterSelectionErrorKind = "invalid" | "cancelled" | "superseded" | "disposed" | "timeout" | "busy" | "load" | "render" | "recovery";
export class RasterSelectionError extends Error {
  constructor(readonly kind: RasterSelectionErrorKind, message: string) {
    super(message);
    this.name = "RasterSelectionError";
  }
}

// Actual operation deadline, independent of any API caller's wait timeout.
const FRAME_TIMEOUT_MS = 30_000;
const MAX_WAITERS = 64;
export interface RasterCleanupContext {
  phase: "retire" | "observer";
  generation: number;
  requestedRasterId: string;
  committedRasterId?: string;
}
export type RasterCleanupListener = (error: RasterSelectionError, context: RasterCleanupContext) => void | Promise<void>;
interface SelectionWaiter {
  resolve: (result: SingleRasterSelectionResult) => void;
  reject: (error: RasterSelectionError) => void;
  removeAbort: () => void;
}
interface SelectionOperation {
  generation: number;
  raster: SingleRasterEntry;
  layer?: ImageryLayer;
  provider?: ObservedAtlasProvider;
  previous: ImageryLayer | undefined;
  phase: "warming" | "showing" | "hidden" | "recovering";
  recoveryFailure?: RasterSelectionError;
  recoveryArmed?: boolean;
  reused: boolean;
  waiters: Set<SelectionWaiter>;
  removeListeners: Array<() => void>;
  timer?: ReturnType<typeof setTimeout>;
}
interface SelectionOutcome {
  generation: number;
  result?: SingleRasterSelectionResult;
  failure?: RasterSelectionError;
}

export class SingleRasterLayerController {
  private currentRaster: SingleRasterEntry | undefined;
  private currentLayer: ImageryLayer | undefined;
  private currentProvider: ObservedAtlasProvider | undefined;
  private requestedRasterId: string | undefined;
  private selectionOutcome: SelectionOutcome | undefined;
  private pendingRemoval: ImageryLayer | undefined;
  private active: SelectionOperation | undefined;
  private switchGeneration = 0;
  private requestSequence = 0;
  private visible = true;
  private opacity = 0.9;
  private disposed = false;

  constructor(
    private readonly viewer: Viewer,
    readonly manifest: SingleRasterManifest,
    private readonly onStateChange: SingleRasterStateListener,
    private readonly onCleanupError?: RasterCleanupListener,
  ) {}

  getCommittedRaster(): SingleRasterEntry | undefined {
    const raster = this.currentRaster;
    return raster ? {
      ...raster, tiles: { ...raster.tiles },
      colorbar: raster.colorbar ? { ...raster.colorbar, stops: raster.colorbar.stops.map(stop => ({ ...stop })) } : null,
    } : undefined;
  }

  /** Captures this selection; a later different selection supersedes this wait. */
  whenReady(options: { signal?: AbortSignal } = {}): Promise<SingleRasterSelectionResult> {
    if (this.disposed) return Promise.reject(new RasterSelectionError("disposed", "Raster runtime is disposed."));
    if (options.signal?.aborted) return Promise.reject(new RasterSelectionError("cancelled", "Raster readiness wait was cancelled before starting."));
    if (this.active) return this.addWaiter(this.active, options.signal);
    const outcome = this.selectionOutcome;
    if (outcome?.failure) return Promise.reject(outcome.failure);
    if (outcome?.result) return Promise.resolve({ ...outcome.result });
    return Promise.reject(new RasterSelectionError("invalid", "No raster has been selected."));
  }

  /** Compatibility entry: operation failures remain visible through onStateChange. */
  select(rasterId: string): void {
    if (this.disposed) return;
    // Keep the legacy synchronous validation contract. Only asynchronous native
    // loading failures are consumed by this void compatibility entry.
    if (!this.manifest.rasters.some(raster => raster.id === rasterId)) {
      throw new RasterSelectionError("invalid", `SingleRaster dataset "${rasterId}" was not found.`);
    }
    void this.selectAsync(rasterId).catch(() => {
      // Runtime failures have already been published. Invalid/disposed requests
      // do not replace the current selection or start native work.
    });
  }

  async selectAsync(rasterId: string, options: { signal?: AbortSignal } = {}): Promise<SingleRasterSelectionResult> {
    if (this.disposed) throw new RasterSelectionError("disposed", "Raster runtime is disposed.");
    if (options.signal?.aborted) throw new RasterSelectionError("cancelled", "Raster selection was cancelled before starting.");
    const raster = this.manifest.rasters.find(entry => entry.id === rasterId);
    if (!raster) throw new RasterSelectionError("invalid", `SingleRaster dataset "${rasterId}" was not found.`);
    const sequence = ++this.requestSequence;
    this.retryPendingRemoval();
    this.assertRequestCurrent(sequence, options.signal);
    if (this.active?.raster.id === rasterId && this.active.phase !== "recovering" &&
        (this.active.phase === "hidden") === !this.visible) return this.addWaiter(this.active, options.signal);
    if (this.active) this.finish(this.active, new RasterSelectionError("superseded", "A new raster selection replaced this target."));
    this.assertRequestCurrent(sequence, options.signal);
    // Superseding can itself create a failed retirement. Never allocate another
    // candidate until that bounded cleanup owner has really been released.
    this.retryPendingRemoval();
    this.assertRequestCurrent(sequence, options.signal);

    this.requestedRasterId = rasterId;
    const generation = ++this.switchGeneration;
    const outcome: SelectionOutcome = { generation };
    this.selectionOutcome = outcome;
    let operation: SelectionOperation | undefined;
    let result: Promise<SingleRasterSelectionResult> | undefined;
    try {
      const hidden = !this.visible;
      const reused = !hidden && this.currentRaster?.id === rasterId;
      const provider = hidden ? undefined : reused ? this.currentProvider! : new ObservedAtlasProvider({
        url: raster.tileUrl,
        credit: this.manifest.attribution,
        minimumLevel: raster.tiles.minimumLevel,
        maximumLevel: raster.tiles.maximumLevel,
        rectangle: Rectangle.fromDegrees(...this.manifest.tileMatrixSet.bounds),
        tilingScheme: new WebMercatorTilingScheme({ ellipsoid: SPHERICAL_EARTH }),
        ellipsoid: SPHERICAL_EARTH,
        hasAlphaChannel: raster.tiles.hasAlphaChannel,
        enablePickFeatures: false,
      }, raster.tiles.emptyTilePolicy);
      const layer = hidden ? undefined : reused ? this.currentLayer! : new ImageryLayer(provider!, { alpha: 0, show: true });
      operation = { generation, raster, layer, provider, previous: this.currentLayer,
        phase: hidden ? "hidden" : reused ? "showing" : "warming", reused, waiters: new Set(), removeListeners: [] };
      const owned = operation;
      this.active = owned;
      result = this.addWaiter(owned, options.signal);
      if (provider) owned.removeListeners.push(provider.observe(
        () => { if (this.isCurrent(owned)) this.viewer.scene.requestRender(); },
        error => { if (owned.phase === "warming" || owned.phase === "showing") this.finish(owned, this.error("load", error)); },
      ));
      owned.removeListeners.push(this.viewer.scene.postRender.addEventListener(() => this.onRender(owned)));
      owned.removeListeners.push(this.viewer.scene.renderError.addEventListener((_scene: unknown, error: unknown) => this.finish(owned, this.error("render", error))));
      if (provider) owned.removeListeners.push(provider.errorEvent.addEventListener((error: unknown) => {
        if (owned.phase === "warming" || owned.phase === "showing") this.finish(owned, this.error("load", error));
      }));
      owned.timer = setTimeout(() => this.finish(owned, new RasterSelectionError("timeout", "Raster selection did not become render-confirmed within 30000ms.")), FRAME_TIMEOUT_MS);
      if (layer && !reused) this.viewer.imageryLayers.add(layer);
      else if (layer) { layer.show = true; layer.alpha = this.opacity; }
      if (hidden && this.currentLayer) this.currentLayer.show = false;
      if (this.isCurrent(owned)) this.onStateChange({ status: "loading", raster });
      if (this.isCurrent(owned)) {
        if (this.viewer.useDefaultRenderLoop === false && !this.viewer.scene.isDestroyed()) this.viewer.useDefaultRenderLoop = true;
        this.viewer.scene.requestRender();
      }
      return result;
    } catch (error) {
      const failure = this.error("load", error);
      if (operation && this.isCurrent(operation)) this.finish(operation, failure);
      else {
        outcome.failure = failure;
        this.onStateChange({ status: "error", raster, message: failure.message });
      }
      // Return the allocated public waiter instead of creating an orphan reject.
      if (result) return result;
      throw failure;
    }
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    // A synchronous state observer may hide the layer while a newer select
    // entry is still retiring its predecessor. That entry must not resurrect it.
    this.requestSequence += 1;
    this.visible = visible;
    if (!visible) {
      if (this.active) this.finish(this.active, undefined, true);
      else {
        if (this.currentLayer) this.currentLayer.show = false;
        if (this.selectionOutcome && this.requestedRasterId !== undefined) {
          this.selectionOutcome = { generation: this.selectionOutcome.generation, result: {
            status: "hidden", requestedRasterId: this.requestedRasterId,
            generation: this.selectionOutcome.generation, reason: "disabled",
          } };
        }
        this.onStateChange({ status: "hidden", raster: this.manifest.rasters.find(raster => raster.id === this.requestedRasterId) });
        this.viewer.scene.requestRender();
      }
    } else if (this.requestedRasterId !== undefined) this.select(this.requestedRasterId);
  }

  setOpacity(opacity: number): void {
    if (this.disposed) return;
    this.opacity = Math.max(0, Math.min(1, opacity));
    if (this.currentLayer) this.currentLayer.alpha = this.opacity;
    if (this.active?.phase === "showing" && this.active.layer) this.active.layer.alpha = this.opacity;
    this.viewer.scene.requestRender();
  }

  raiseToTop(): void {
    if (this.disposed) return;
    for (const layer of [this.currentLayer, this.active?.layer]) {
      if (layer && this.viewer.imageryLayers.contains(layer)) this.viewer.imageryLayers.raiseToTop(layer);
    }
  }

  destroy(): void {
    this.disposed = true;
    if (this.active) this.finish(this.active, new RasterSelectionError("disposed", "Raster runtime was disposed."));
    let failure: RasterSelectionError | undefined;
    try { this.retryPendingRemoval(); }
    catch (error) { failure = this.error("recovery", error); }
    try { this.removeLayer(this.currentLayer); this.currentLayer = undefined; }
    catch (error) { failure ??= this.error("recovery", error); }
    finally { this.currentProvider = undefined; this.currentRaster = undefined; }
    // Retain failed native cleanup refs for a later destroy retry. Disposed
    // entry points remain permanently closed even if native cleanup throws.
    if (failure) throw failure;
  }

  private addWaiter(operation: SelectionOperation, signal?: AbortSignal): Promise<SingleRasterSelectionResult> {
    if (operation.waiters.size >= MAX_WAITERS) return Promise.reject(new RasterSelectionError("busy", "Raster selection already has 64 waiting callers."));
    return new Promise((resolve, reject) => {
      const waiter: SelectionWaiter = { resolve, reject, removeAbort: () => {} };
      const abort = () => {
        if (!operation.waiters.delete(waiter)) return;
        waiter.removeAbort();
        const error = new RasterSelectionError("cancelled", "Raster selection was cancelled.");
        if (operation.waiters.size === 0 && this.isCurrent(operation)) {
          operation.waiters.add(waiter);
          this.finish(operation, error);
        } else reject(error);
      };
      waiter.removeAbort = () => signal?.removeEventListener("abort", abort);
      operation.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private isCurrent(operation: SelectionOperation): boolean { return this.active === operation; }

  private assertRequestCurrent(sequence: number, signal?: AbortSignal): void {
    if (this.disposed) throw new RasterSelectionError("disposed", "Raster runtime was disposed while starting the selection.");
    if (sequence !== this.requestSequence) throw new RasterSelectionError("superseded", "A newer selection replaced this request while notifying state.");
    if (signal?.aborted) throw new RasterSelectionError("cancelled", "Raster selection was cancelled while starting.");
  }

  private onRender(operation: SelectionOperation): void {
    if (!this.isCurrent(operation)) return;
    try {
      if (this.disposed || this.viewer.scene.isDestroyed()) {
        this.finish(operation, new RasterSelectionError("disposed", "Raster scene was disposed."));
        return;
      }
      if (operation.phase === "recovering") {
        // Scene can emit postRender even after renderError in that same frame.
        if (!operation.recoveryArmed) return;
        this.assertRetainedFrame(operation.previous, this.visible);
        if (this.visible && !this.viewer.scene.globe.tilesLoaded) return;
        this.settle(operation, operation.recoveryFailure);
        return;
      }
      if (operation.phase === "hidden") {
        if (this.visible) throw new RasterSelectionError("superseded", "Raster visibility changed before the hidden frame.");
        this.assertRetainedFrame(operation.previous, false);
        this.settle(operation, undefined, true);
        return;
      }
      const layer = operation.layer!;
      if (layer.isDestroyed() || !this.viewer.imageryLayers.contains(layer) || !layer.show ||
          layer.alpha !== (operation.phase === "warming" ? 0 : this.opacity)) {
        throw new RasterSelectionError("render", "The selected raster no longer matches the target frame.");
      }
      if (!this.viewer.scene.globe.tilesLoaded || operation.provider!.pending !== 0) return;
      if (operation.phase === "warming") {
        if (operation.provider!.requested === 0 || operation.provider!.succeeded === 0) return;
        operation.phase = "showing";
        layer.alpha = this.opacity;
        layer.show = true;
        if (operation.previous) operation.previous.show = false;
        this.viewer.scene.requestRender();
        return;
      }
      if (operation.previous && operation.previous !== layer && operation.previous.show) {
        throw new RasterSelectionError("render", "The previous raster is still visible in the target frame.");
      }
      this.settle(operation);
    } catch (error) {
      this.finish(operation, this.error("render", error));
    }
  }

  private assertRetainedFrame(layer: ImageryLayer | undefined, visible: boolean): void {
    if (layer && (layer.isDestroyed() || !this.viewer.imageryLayers.contains(layer) ||
        layer.show !== visible || (visible && layer.alpha !== this.opacity))) {
      throw new RasterSelectionError("recovery", "The retained raster no longer matches the restored frame.");
    }
  }

  private finish(operation: SelectionOperation, failure?: RasterSelectionError, hidden = false): void {
    if (!this.isCurrent(operation)) return;
    if (operation.phase === "recovering") {
      if (hidden) {
        try {
          if (operation.previous) operation.previous.show = false;
          this.viewer.scene.requestRender();
        } catch (error) { this.settle(operation, this.error("recovery", error)); }
        return;
      }
      const interruption = failure?.kind === "superseded" || failure?.kind === "disposed";
      this.settle(operation, interruption ? failure : new RasterSelectionError("recovery", failure?.message ?? "Raster recovery failed."));
      return;
    }
    const recoverFrame = failure !== undefined && failure.kind !== "superseded" && failure.kind !== "disposed" &&
      operation.phase === "showing" && !this.disposed;
    let error = failure;
    try {
      if (!operation.reused && operation.layer) {
        const candidate = operation.layer;
        operation.layer = undefined; // Native removal emits synchronously; this stack alone owns destruction.
        if (!candidate.isDestroyed()) candidate.show = false;
        this.removeLayer(candidate);
      }
    } catch (cleanupError) { error = this.error("recovery", cleanupError); }
    if (!this.isCurrent(operation)) return;
    try {
      if (operation.previous && !this.viewer.scene.isDestroyed()) {
        operation.previous.show = this.visible;
        operation.previous.alpha = this.opacity;
      }
    } catch (recoveryError) { error = this.error("recovery", recoveryError); }
    if (!this.isCurrent(operation)) return;
    if (hidden && !error) {
      operation.layer = undefined;
      operation.provider = undefined;
      operation.phase = "hidden";
    } else if (recoverFrame && error === failure) {
      operation.phase = "recovering";
      operation.recoveryArmed = false;
      operation.recoveryFailure = failure;
      clearTimeout(operation.timer);
      operation.timer = setTimeout(() => this.finish(operation, new RasterSelectionError("recovery", "Raster recovery did not render within 30000ms.")), FRAME_TIMEOUT_MS);
      // CesiumWidget stops its public loop on renderError. Resume only this
      // restored owner, after the error dispatch has unwound, and never retry a
      // second recovery error. The next real postRender still proves restoration.
      void Promise.resolve().then(() => {
        if (!this.isCurrent(operation) || operation.phase !== "recovering" || this.disposed) return;
        try {
          operation.recoveryArmed = true;
          if (this.viewer.useDefaultRenderLoop === false && !this.viewer.scene.isDestroyed()) {
            this.viewer.useDefaultRenderLoop = true;
          }
          this.viewer.scene.requestRender();
        } catch (error) { this.finish(operation, this.error("recovery", error)); }
      });
    } else {
      this.settle(operation, error);
      return;
    }
    try { this.viewer.scene.requestRender(); }
    catch (renderError) { this.settle(operation, this.error("recovery", renderError)); }
  }

  /** This boundary is irreversible once a target postRender has been checked. */
  private settle(operation: SelectionOperation, failure?: RasterSelectionError, hidden = false): void {
    if (!this.isCurrent(operation)) return;
    this.active = undefined;
    clearTimeout(operation.timer);
    const result: SingleRasterSelectionResult = hidden
      ? { status: "hidden", requestedRasterId: operation.raster.id, generation: operation.generation, reason: "disabled" }
      : { status: "ready", requestedRasterId: operation.raster.id, generation: operation.generation, rasterId: operation.raster.id, sourceId: operation.raster.sourceId };
    if (!failure && !hidden) {
      this.currentLayer = operation.layer;
      this.currentProvider = operation.provider;
      this.currentRaster = operation.raster;
    }
    const outcome = this.selectionOutcome?.generation === operation.generation ? this.selectionOutcome : undefined;
    if (outcome) { outcome.result = failure ? undefined : result; outcome.failure = failure; }
    const reports: Array<{ phase: RasterCleanupContext["phase"]; error: unknown }> = [];
    let error = failure;
    const clean = (release: () => void): void => {
      try { release(); } catch (cleanupError) {
        if (failure) error = this.error("recovery", cleanupError);
        else reports.push({ phase: "retire", error: cleanupError });
      }
    };
    for (const remove of operation.removeListeners.splice(0)) clean(remove);
    const waiters = [...operation.waiters];
    operation.waiters.clear();
    for (const waiter of waiters) clean(waiter.removeAbort);
    if (!failure && !hidden && !operation.reused) clean(() => this.removeLayer(operation.previous));
    clean(() => { if (!this.viewer.scene.isDestroyed()) this.viewer.scene.requestRender(); });
    try {
      if (!this.disposed && this.selectionOutcome?.generation === operation.generation) {
        if (error) this.onStateChange({ status: "error", raster: operation.raster, message: error.message });
        else if (hidden) this.onStateChange({ status: "hidden", raster: operation.raster });
        else this.onStateChange({ status: "ready", raster: operation.raster });
      }
    } catch (notificationError) {
      if (failure) error = this.error("recovery", notificationError);
      else reports.push({ phase: "observer", error: notificationError });
    }
    if (outcome && error) { outcome.result = undefined; outcome.failure = error; }
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve({ ...result });
    }
    for (const report of reports) this.reportCleanup(operation, report.phase, report.error);
  }

  private reportCleanup(operation: SelectionOperation, phase: RasterCleanupContext["phase"], error: unknown): void {
    try {
      void Promise.resolve(this.onCleanupError?.(this.error("recovery", error), {
        phase, generation: operation.generation, requestedRasterId: operation.raster.id,
        committedRasterId: operation.phase === "hidden" ? this.currentRaster?.id : operation.raster.id,
      })).catch(() => undefined);
    } catch { /* diagnostics cannot change a committed frame */ }
  }

  private error(kind: RasterSelectionErrorKind, error: unknown): RasterSelectionError {
    return error instanceof RasterSelectionError ? error : new RasterSelectionError(kind, error instanceof Error ? error.message : String(error));
  }

  private removeLayer(layer: ImageryLayer | undefined): void {
    if (!layer) return;
    try {
      if (!this.viewer.scene.isDestroyed()) {
        if (this.viewer.imageryLayers.contains(layer)) this.viewer.imageryLayers.remove(layer, true);
        else if (!layer.isDestroyed()) layer.destroy();
      }
      if (this.pendingRemoval === layer) this.pendingRemoval = undefined;
    } catch (error) { this.pendingRemoval ??= layer; throw error; }
  }

  private retryPendingRemoval(): void {
    try { this.removeLayer(this.pendingRemoval); }
    catch (error) { throw this.error("recovery", error); }
  }
}
