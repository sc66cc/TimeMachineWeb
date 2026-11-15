import { ImageryLayer, Rectangle, Viewer, WebMercatorTilingScheme } from "cesium";
import { SPHERICAL_EARTH } from "@timemachine/cesium-runtime";
import { AtlasFrameResolver } from "./atlas-frame-resolver";
import { ObservedAtlasProvider } from "./observed-atlas-provider";
import type { PaleoAtlasFrame, PaleoAtlasRuntimeState, PaleoAtlasTimeResult } from "./types";

export type PaleoAtlasStateListener = (state: PaleoAtlasRuntimeState) => void;
export type AtlasTimeErrorKind = "invalid" | "cancelled" | "superseded" | "disposed" | "timeout" | "busy" | "load" | "render" | "recovery";

export class AtlasTimeError extends Error {
  constructor(readonly kind: AtlasTimeErrorKind, message: string) {
    super(message);
    this.name = "AtlasTimeError";
  }
}

export interface AtlasTimeTicket {
  readonly owner: object;
  readonly generation: number;
  readonly requestedAgeMa: number;
  readonly ready: Promise<void>;
  activate(): void;
  canConfirm(): boolean;
  accept(): PaleoAtlasTimeResult;
  rollback(): void;
  retire(): void;
}

export interface AtlasTimePreparationOptions {
  owner: object;
  signal?: AbortSignal;
  onFailure?: (error: AtlasTimeError) => void;
}

// This is the actual frame-operation deadline, not an API caller's wait timeout.
const FRAME_TIMEOUT_MS = 30_000;
const MAX_WAITERS = 64;
interface TimeWaiter {
  ageMa: number;
  resolve: (result: PaleoAtlasTimeResult) => void;
  reject: (error: AtlasTimeError) => void;
  removeAbort: () => void;
}
interface FrameOperation {
  owner: object;
  coordinated: boolean;
  ageMa: number;
  generation: number;
  frame: PaleoAtlasFrame | undefined;
  layer: ImageryLayer | undefined;
  provider: ObservedAtlasProvider | undefined;
  hidden?: "disabled" | "out-of-range";
  previous: ImageryLayer | undefined;
  phase: "warming" | "prepared" | "showing" | "accepted" | "finished";
  reused: boolean;
  accepted: boolean;
  renderConfirmed: boolean;
  failure?: AtlasTimeError;
  onFailure?: (error: AtlasTimeError) => void;
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (error: AtlasTimeError) => void;
  waiters: Set<TimeWaiter>;
  removeListeners: Array<() => void>;
  timer?: ReturnType<typeof setTimeout>;
}

export class PaleoAtlasLayerController {
  private currentFrame: PaleoAtlasFrame | undefined;
  private currentLayer: ImageryLayer | undefined;
  private currentProvider: ObservedAtlasProvider | undefined;
  private pendingRemoval: ImageryLayer | undefined;
  private active: FrameOperation | undefined;
  private switchGeneration = 0;
  private requestSequence = 0;
  private requestedAgeMa = 0;
  private visible = true;
  private opacity = 1;
  private disposed = false;

  constructor(
    private readonly viewer: Viewer,
    private readonly resolver: AtlasFrameResolver,
    private readonly onStateChange: PaleoAtlasStateListener,
  ) {}

  getCommittedFrame(): PaleoAtlasFrame | undefined {
    return this.currentFrame ? { ...this.currentFrame } : undefined;
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return;
    this.requestSequence += 1;
    this.visible = visible;
    if (this.active?.coordinated && !this.active.accepted) {
      this.finish(this.active, new AtlasTimeError("superseded", "Atlas visibility changed during coordinated preparation."));
      if (this.currentLayer) this.currentLayer.show = visible;
      this.viewer.scene.requestRender();
      return;
    }
    if (!visible) {
      const operation = this.active;
      if (operation) this.finish(operation, undefined, "disabled");
      else {
        if (this.currentLayer) this.currentLayer.show = false;
        this.onStateChange({ status: "hidden", requestedAgeMa: this.requestedAgeMa, reason: "disabled" });
        this.viewer.scene.requestRender();
      }
    } else {
      this.setTime(this.requestedAgeMa);
    }
  }

  setOpacity(opacity: number): void {
    if (this.disposed) return;
    const nextOpacity = Math.max(0, Math.min(1, opacity));
    const changed = nextOpacity !== this.opacity;
    this.opacity = nextOpacity;
    if (changed && this.active?.coordinated && !this.active.accepted) {
      this.finish(this.active, new AtlasTimeError("superseded", "Atlas opacity changed during coordinated preparation."));
    }
    if (this.currentLayer) this.currentLayer.alpha = this.opacity;
    if (this.active?.phase === "showing" && this.active.layer) {
      this.active.layer.alpha = this.opacity;
      this.active.renderConfirmed = false;
    }
    this.viewer.scene.requestRender();
  }

  raiseToTop(): void {
    if (this.disposed) return;
    for (const layer of [this.currentLayer, this.active?.layer]) {
      if (layer && this.viewer.imageryLayers.contains(layer)) this.viewer.imageryLayers.raiseToTop(layer);
    }
  }

  /** Compatibility entry: failures are published by the owner and consumed here. */
  setTime(ageMa: number, _forceNotification = false): void {
    void this.setTimeAsync(ageMa).catch(() => {
      // The operation has already emitted its error/hidden state. Disposed
      // controllers intentionally do not publish or start native work.
    });
  }

  async setTimeAsync(ageMa: number, options: { signal?: AbortSignal } = {}): Promise<PaleoAtlasTimeResult> {
    if (this.disposed) throw new AtlasTimeError("disposed", "Atlas runtime is disposed.");
    if (options.signal?.aborted) throw new AtlasTimeError("cancelled", "Atlas request was cancelled before starting.");
    if (!Number.isFinite(ageMa)) throw new AtlasTimeError("invalid", "Atlas age must be finite.");
    if (this.active?.coordinated) throw new AtlasTimeError("busy", "A coordinated Atlas owner is active.");
    const requestSequence = ++this.requestSequence;
    // Keep at most one failed retirement. Do not allocate more native layers
    // until it has really left the collection and been destroyed.
    this.retryPendingRemoval();
    this.assertRequestCurrent(requestSequence, options.signal);
    const frame = this.resolver.resolve(ageMa);
    if (!frame || !this.visible) {
      if (this.active) this.finish(this.active, new AtlasTimeError("superseded", "A new Atlas request replaced this target."));
      this.assertRequestCurrent(requestSequence, options.signal);
      this.retryPendingRemoval();
      this.assertRequestCurrent(requestSequence, options.signal);
      this.requestedAgeMa = ageMa;
      const reason = frame ? "disabled" : "out-of-range";
      if (!frame) {
        this.removeLayer(this.currentLayer);
        this.currentLayer = undefined;
        this.currentProvider = undefined;
        this.currentFrame = undefined;
      }
      this.onStateChange({ status: "hidden", requestedAgeMa: ageMa, reason });
      this.viewer.scene.requestRender();
      return { status: "hidden", requestedAgeMa: ageMa, generation: ++this.switchGeneration, reason };
    }
    if (this.active?.frame?.sourceId === frame.sourceId) {
      this.requestedAgeMa = ageMa;
      return this.addWaiter(this.active, ageMa, options.signal);
    }
    if (this.active) this.finish(this.active, new AtlasTimeError("superseded", "A new Atlas request replaced this target."));
    this.assertRequestCurrent(requestSequence, options.signal);
    // Superseding can itself fail to retire the previous candidate. Check the
    // newly created cleanup owner before allocating any replacement layer.
    this.retryPendingRemoval();
    this.assertRequestCurrent(requestSequence, options.signal);

    this.requestedAgeMa = ageMa;
    let operation: FrameOperation | undefined;
    let result: Promise<PaleoAtlasTimeResult> | undefined;
    try {
      operation = this.createOperation(ageMa, frame, false, {});
      this.active = operation;
      result = this.addWaiter(operation, ageMa, options.signal);
      this.startOperation(operation);
      return result;
    } catch (error) {
      const failure = this.error("load", error);
      if (operation && this.isCurrent(operation)) this.finish(operation, failure);
      else this.onStateChange({ status: "error", requestedAgeMa: ageMa, frame, message: failure.message });
      // Once allocated, this is the single public promise for this request.
      // Throwing a second rejection would leave the original waiter orphaned.
      if (result) return result;
      throw failure;
    }
  }

  /** One owner's layer preparation; ordering remains with ProjectionController. */
  prepareTime(ageMa: number, options: AtlasTimePreparationOptions): AtlasTimeTicket {
    if (this.disposed) throw new AtlasTimeError("disposed", "Atlas runtime is disposed.");
    if (options.signal?.aborted) throw new AtlasTimeError("cancelled", "Atlas request was cancelled before starting.");
    if (!Number.isFinite(ageMa)) throw new AtlasTimeError("invalid", "Atlas age must be finite.");
    if (this.active) throw new AtlasTimeError("busy", "An Atlas owner is already active.");
    const sequence = ++this.requestSequence;
    this.retryPendingRemoval();
    this.assertRequestCurrent(sequence, options.signal);
    const operation = this.createOperation(ageMa, this.resolver.resolve(ageMa), true, options.owner);
    operation.onFailure = options.onFailure;
    this.requestedAgeMa = ageMa;
    this.active = operation;
    try {
      const abort = () => this.finish(operation, new AtlasTimeError("cancelled", "Atlas request was cancelled."));
      operation.removeListeners.push(() => options.signal?.removeEventListener("abort", abort));
      options.signal?.addEventListener("abort", abort, { once: true });
      this.startOperation(operation);
    } catch (error) {
      this.finish(operation, this.error("load", error));
    }
    return {
      owner: operation.owner, generation: operation.generation, requestedAgeMa: ageMa, ready: operation.ready,
      activate: () => this.activateOperation(operation),
      canConfirm: () => this.canConfirmOperation(operation),
      accept: () => this.acceptOperation(operation),
      rollback: () => {
        if (operation.accepted || operation.phase === "finished") return;
        this.finish(operation, new AtlasTimeError("cancelled", "Atlas preparation was rolled back."));
        if (operation.failure?.kind === "recovery") throw operation.failure;
      },
      retire: () => this.retireOperation(operation),
    };
  }

  private createOperation(ageMa: number, frame: PaleoAtlasFrame | undefined, coordinated: boolean, owner: object): FrameOperation {
    const hidden = !frame ? "out-of-range" : !this.visible ? "disabled" : undefined;
    const reused = !hidden && this.currentFrame?.sourceId === frame?.sourceId;
    const provider = hidden ? undefined : reused ? this.currentProvider! : new ObservedAtlasProvider({
      url: frame!.tileUrl, credit: this.resolver.manifest.attribution,
      minimumLevel: this.resolver.manifest.tiles.minimumLevel, maximumLevel: this.resolver.manifest.tiles.maximumLevel,
      rectangle: Rectangle.fromDegrees(...this.resolver.manifest.tiles.bounds),
      tilingScheme: new WebMercatorTilingScheme({ ellipsoid: SPHERICAL_EARTH }),
      ellipsoid: SPHERICAL_EARTH, hasAlphaChannel: false, enablePickFeatures: false,
    });
    const layer = hidden ? undefined : reused ? this.currentLayer! : new ImageryLayer(provider!, { alpha: 0, show: true });
    let resolveReady!: () => void;
    let rejectReady!: (error: AtlasTimeError) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    // Standalone callers await their result; a failed unused preparation promise
    // must not leak a second unhandled rejection.
    void ready.catch(() => undefined);
    return {
      owner, coordinated, ageMa, generation: ++this.switchGeneration, frame, layer, provider, hidden,
      previous: this.currentLayer, phase: reused || hidden ? "prepared" : "warming", reused,
      accepted: false, renderConfirmed: false, ready, resolveReady, rejectReady,
      waiters: new Set(), removeListeners: [],
    };
  }

  private startOperation(operation: FrameOperation): void {
    const { provider, layer } = operation;
    if (provider) {
      operation.removeListeners.push(provider.observe(
        () => {
          if (!this.isCurrent(operation) || operation.accepted) return;
          operation.renderConfirmed = false;
          this.viewer.scene.requestRender();
        },
        error => this.finish(operation, this.error("load", error)),
      ));
    }
    operation.removeListeners.push(this.viewer.scene.postRender.addEventListener(() => this.onRender(operation)));
    operation.removeListeners.push(this.viewer.scene.renderError.addEventListener((_scene: unknown, error: unknown) => this.finish(operation, this.error("render", error))));
    if (provider) operation.removeListeners.push(provider.errorEvent.addEventListener((error: unknown) => this.finish(operation, this.error("load", error))));
    operation.timer = setTimeout(() => this.finish(operation, new AtlasTimeError("timeout", "Atlas frame did not become render-confirmed within 30000ms.")), FRAME_TIMEOUT_MS);
    if (layer && !operation.reused) this.viewer.imageryLayers.add(layer, 0);
    if (operation.phase === "prepared") {
      operation.resolveReady();
      if (!operation.coordinated) this.activateOperation(operation);
    }
    if (this.isCurrent(operation) && operation.frame && !operation.hidden) {
      this.onStateChange({ status: "loading", requestedAgeMa: operation.ageMa, frame: operation.frame });
    }
    if (this.isCurrent(operation)) this.viewer.scene.requestRender();
  }

  destroy(): void {
    this.disposed = true;
    let failure: AtlasTimeError | undefined;
    // Invalidate ownership and settle callers even if native cleanup fails.
    if (this.active?.accepted) {
      try { this.retireOperation(this.active); }
      catch (error) { failure = this.error("recovery", error); }
    } else if (this.active) this.finish(this.active, new AtlasTimeError("disposed", "Atlas runtime was disposed."));
    try { this.retryPendingRemoval(); }
    catch (error) { failure = this.error("recovery", error); }
    try {
      this.removeLayer(this.currentLayer);
      this.currentLayer = undefined;
    } catch (error) { failure ??= this.error("recovery", error); }
    finally {
      this.currentProvider = undefined;
      this.currentFrame = undefined;
    }
    // The disposed controller may be asked to retry cleanup, but no entry can
    // start new requests. Failed cleanup retains its small set of owned refs.
    if (failure) throw failure;
  }

  private addWaiter(operation: FrameOperation, ageMa: number, signal?: AbortSignal): Promise<PaleoAtlasTimeResult> {
    if (operation.waiters.size >= MAX_WAITERS) return Promise.reject(new AtlasTimeError("busy", "Atlas frame already has 64 waiting callers."));
    return new Promise((resolve, reject) => {
      const waiter: TimeWaiter = { ageMa, resolve, reject, removeAbort: () => {} };
      const abort = () => {
        if (!operation.waiters.delete(waiter)) return;
        waiter.removeAbort();
        const error = new AtlasTimeError("cancelled", "Atlas request was cancelled.");
        if (operation.waiters.size === 0 && this.isCurrent(operation)) {
          // Keep this caller until cleanup has completed so restoration failures
          // are not misreported as a successful cancellation.
          operation.waiters.add(waiter);
          this.finish(operation, error);
        } else reject(error);
      };
      waiter.removeAbort = () => signal?.removeEventListener("abort", abort);
      operation.waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  private isCurrent(operation: FrameOperation): boolean {
    return this.active === operation;
  }

  private assertRequestCurrent(sequence: number, signal?: AbortSignal): void {
    if (this.disposed) throw new AtlasTimeError("disposed", "Atlas runtime was disposed while starting the request.");
    if (sequence !== this.requestSequence) throw new AtlasTimeError("superseded", "A newer Atlas request replaced this request while notifying state.");
    if (signal?.aborted) throw new AtlasTimeError("cancelled", "Atlas request was cancelled while starting.");
  }

  private onRender(operation: FrameOperation): void {
    if (!this.isCurrent(operation) || operation.accepted) return;
    if (this.disposed || this.viewer.scene.isDestroyed()) {
      this.finish(operation, new AtlasTimeError("disposed", "Atlas scene was disposed."));
      return;
    }
    if (!this.viewer.scene.globe.tilesLoaded || (operation.provider?.pending ?? 0) !== 0) {
      operation.renderConfirmed = false;
      return;
    }
    if (operation.phase === "warming") {
      if (!operation.provider || operation.provider.requested === 0 || operation.provider.succeeded === 0) return;
      operation.phase = "prepared";
      operation.resolveReady();
      if (!operation.coordinated) this.activateOperation(operation);
      return;
    }
    if (operation.phase !== "showing") return;
    operation.renderConfirmed = true;
    if (!operation.coordinated && this.canConfirmOperation(operation)) this.finish(operation);
  }

  private assertOperation(operation: FrameOperation): void {
    if (operation.failure) throw operation.failure;
    if (this.disposed) throw new AtlasTimeError("disposed", "Atlas runtime is disposed.");
    if (!this.isCurrent(operation)) throw new AtlasTimeError("superseded", "Atlas ticket no longer owns the active target.");
  }

  private activateOperation(operation: FrameOperation): void {
    this.assertOperation(operation);
    if (operation.phase === "showing") return;
    if (operation.phase !== "prepared") throw new AtlasTimeError("invalid", "Atlas ticket is not prepared for activation.");
    operation.phase = "showing";
    operation.renderConfirmed = false;
    try {
      if (operation.layer) {
        operation.layer.alpha = this.opacity;
        operation.layer.show = true;
      }
      if (operation.previous && operation.previous !== operation.layer) operation.previous.show = false;
      this.viewer.scene.requestRender();
    } catch (error) {
      this.finish(operation, this.error("render", error));
      throw operation.failure ?? error;
    }
  }

  private canConfirmOperation(operation: FrameOperation): boolean {
    if (operation.failure) throw operation.failure;
    if (operation.accepted) return true;
    this.assertOperation(operation);
    if (operation.phase !== "showing" || !operation.renderConfirmed) return false;
    if (!this.viewer.scene.globe.tilesLoaded || (operation.provider?.pending ?? 0) !== 0) return false;
    if (operation.layer && (operation.layer.isDestroyed() || !this.viewer.imageryLayers.contains(operation.layer)
      || !operation.layer.show || operation.layer.alpha !== this.opacity)) return false;
    return !operation.previous || operation.previous === operation.layer || !operation.previous.show;
  }

  private resultFor(operation: FrameOperation, ageMa = operation.ageMa): PaleoAtlasTimeResult {
    return operation.hidden
      ? { status: "hidden", reason: operation.hidden, requestedAgeMa: ageMa, generation: operation.generation }
      : { status: "ready", requestedAgeMa: ageMa, generation: operation.generation,
        actualFrameAgeMa: operation.frame!.timeMa, sourceId: operation.frame!.sourceId };
  }

  private acceptOperation(operation: FrameOperation): PaleoAtlasTimeResult {
    if (operation.accepted) return this.resultFor(operation);
    if (!this.canConfirmOperation(operation)) throw new AtlasTimeError("invalid", "Atlas target has not been confirmed by a post-activation render.");
    // Pure synchronous commit: no observer, native removal or requestRender
    // can interrupt a coordinator accepting its other layers in this stack.
    operation.accepted = true;
    operation.phase = "accepted";
    if (operation.hidden !== "disabled") {
      this.currentLayer = operation.layer;
      this.currentProvider = operation.provider;
      this.currentFrame = operation.hidden ? undefined : operation.frame;
    }
    return this.resultFor(operation);
  }

  private retireOperation(operation: FrameOperation): void {
    if (!operation.accepted) {
      if (operation.failure) throw operation.failure;
      throw new AtlasTimeError("invalid", "Atlas ticket must be accepted before retirement.");
    }
    if (operation.phase === "finished") return;
    const requestedAgeMa = operation.coordinated ? operation.ageMa : this.requestedAgeMa;
    if (this.isCurrent(operation)) this.active = undefined;
    operation.phase = "finished";
    clearTimeout(operation.timer);
    let error: AtlasTimeError | undefined;
    for (const remove of operation.removeListeners.splice(0)) {
      try { remove(); } catch (cleanupError) { error = this.error("recovery", cleanupError); }
    }
    const waiters = [...operation.waiters];
    operation.waiters.clear();
    for (const waiter of waiters) {
      try { waiter.removeAbort(); } catch (cleanupError) { error = this.error("recovery", cleanupError); }
    }
    try {
      if (operation.hidden !== "disabled" && !operation.reused) this.removeLayer(operation.previous);
    } catch (cleanupError) { error = this.error("recovery", cleanupError); }
    try {
      if (!this.viewer.scene.isDestroyed()) this.viewer.scene.requestRender();
      if (!this.disposed) {
        if (error) this.onStateChange({ status: "error", requestedAgeMa, frame: operation.frame, message: error.message });
        else if (operation.hidden) this.onStateChange({ status: "hidden", requestedAgeMa, reason: operation.hidden });
        else this.onStateChange({ status: "ready", requestedAgeMa, frame: operation.frame! });
      }
    } catch (notificationError) { error = this.error("recovery", notificationError); }
    operation.failure = error;
    for (const waiter of waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve(this.resultFor(operation, waiter.ageMa));
    }
    if (error) throw error;
  }

  private finish(operation: FrameOperation, failure?: AtlasTimeError, hidden?: "disabled"): void {
    if (!this.isCurrent(operation) || operation.accepted) return;
    if (!failure && !hidden) {
      try {
        this.acceptOperation(operation);
        this.retireOperation(operation);
      } catch (error) {
        // Retirement already settled callers and cannot undo an accepted frame.
        if (!operation.accepted) this.finish(operation, this.error("render", error));
      }
      return;
    }
    this.active = undefined;
    operation.phase = "finished";
    clearTimeout(operation.timer);
    let error = failure;
    for (const remove of operation.removeListeners.splice(0)) {
      try { remove(); }
      catch (cleanupError) { error = this.error("recovery", cleanupError); }
    }
    const waiters = [...operation.waiters];
    operation.waiters.clear();
    for (const waiter of waiters) {
      try { waiter.removeAbort(); }
      catch (cleanupError) { error = this.error("recovery", cleanupError); }
    }
    {
      try {
        if (!operation.reused && operation.layer) {
          // A failed native removal must not leave the rejected frame visible.
          operation.layer.show = false;
          this.removeLayer(operation.layer);
        }
      } catch (recoveryError) { error = this.error("recovery", recoveryError); }
      // Restoration is independent of candidate removal. Native collection
      // errors must not skip the last confirmed frame's visibility or alpha.
      try {
        if (operation.previous && !this.viewer.scene.isDestroyed()) {
          operation.previous.show = this.visible;
          operation.previous.alpha = this.opacity;
        }
      } catch (recoveryError) { error = this.error("recovery", recoveryError); }
    }
    try {
      if (!this.viewer.scene.isDestroyed()) this.viewer.scene.requestRender();
    } catch (recoveryError) { error = this.error("recovery", recoveryError); }
    operation.failure = error;
    operation.rejectReady(error ?? new AtlasTimeError("cancelled", "Atlas target was disabled."));
    try {
      if (!this.disposed) {
        if (error) this.onStateChange({ status: "error", requestedAgeMa: this.requestedAgeMa, frame: operation.frame, message: error.message });
        else if (hidden) this.onStateChange({ status: "hidden", requestedAgeMa: this.requestedAgeMa, reason: hidden });
      }
    } catch (notificationError) {
      error = this.error("recovery", notificationError);
    } finally {
      operation.failure = error;
      for (const waiter of waiters) {
        if (error) waiter.reject(error);
        else if (hidden) waiter.resolve({ status: "hidden", requestedAgeMa: waiter.ageMa, generation: operation.generation, reason: hidden });
      }
      if (operation.coordinated && error) {
        try { void Promise.resolve(operation.onFailure?.(error)).catch(() => undefined); }
        catch { /* observer failure cannot replace the operation failure */ }
      }
    }
  }

  private error(kind: AtlasTimeErrorKind, error: unknown): AtlasTimeError {
    return error instanceof AtlasTimeError ? error : new AtlasTimeError(kind, error instanceof Error ? error.message : String(error));
  }

  private removeLayer(layer: ImageryLayer | undefined): void {
    if (!layer) return;
    try {
      if (!this.viewer.scene.isDestroyed()) {
        if (this.viewer.imageryLayers.contains(layer)) this.viewer.imageryLayers.remove(layer, true);
        else if (!layer.isDestroyed()) layer.destroy();
      }
      if (this.pendingRemoval === layer) this.pendingRemoval = undefined;
    } catch (error) {
      this.pendingRemoval ??= layer;
      throw error;
    }
  }

  private retryPendingRemoval(): void {
    try { this.removeLayer(this.pendingRemoval); }
    catch (error) { throw this.error("recovery", error); }
  }
}
