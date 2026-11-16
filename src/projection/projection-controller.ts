import { Matrix4, Rectangle } from "cesium";

import type { RotationModel } from "@timemachine/reconstruction-core";
import type { PlateRenderer } from "@timemachine/cesium-runtime";
import {
  AgentActionBusyError,
  AgentActionFailureError,
  AgentActionUnsupportedError,
  AgentActionValidationError,
} from "../agent-actions/registry";
import { OperationInterruptedError } from "../agent-actions/operation";

import { FlatMapCamera } from "./flat-map-camera";

/** Plate-only projections sharing the same bounded native-frame queue. */
export type ProjectionModeId = "globe" | "rectangle" | "mollweide";

export type ProjectionStatus = "idle" | "preparing" | "ready" | "error";

export interface ProjectionModeAvailability {
  available: boolean;
  projectionId: ProjectionModeId;
  reason?: string;
}

export interface ProjectionErrorSnapshot {
  code: number;
  kind: string;
  message: string;
}

/** Active-plate/feature accounting of the committed view. */
export interface ProjectionTimeCounts {
  activeFeatureCount: number;
  activePlateCount: number;
  disconnectedFeatureCount: number;
}

/** The public projection state, safe to expose through the agent facade. */
export interface ProjectionSnapshot {
  camera?: ReturnType<FlatMapCamera["getSnapshot"]>;
  availableModes: ProjectionModeAvailability[];
  committedId: ProjectionModeId;
  committedTimeMa: number;
  committedTimeState: ProjectionTimeCounts;
  lastError?: ProjectionErrorSnapshot;
  requestedId: ProjectionModeId;
  requestedTimeMa: number;
  /** Bumped once per committed mode change, never per request. */
  revision: number;
  status: ProjectionStatus;
}

/** A minimal layer/group row the guard reads to reason about effective visibility. */
export interface ProjectionLayerRow {
  id: number;
  active: boolean;
  groupId: number;
}

export interface ProjectionGroupRow {
  id: number;
  active: boolean;
  parentId?: number;
}

/** The current application's layers, retained until their shared frame commits. */
export interface TimeLayerPreparation {
  ready: Promise<void>;
  activate(): void;
  canConfirm(): boolean;
  accept(): void;
  rollback(): void;
  retire(): void;
}

export interface TimeLayerContext {
  owner: object;
  generation: number;
  ageMa: number;
  mode: ProjectionModeId;
  signal: AbortSignal;
  onFailure(error: unknown): void;
}

/**
 * Everything the controller needs from the app. The app owns the viewer, the
 * layer session, the camera and the globe fast path; the controller owns the
 * requested/committed projection state and the latest-request-wins policy.
 */
export interface ProjectionHost {
  readonly viewer: import("cesium").Viewer;
  readonly plateRenderer: PlateRenderer;
  readonly rotationModel: RotationModel;
  /** Layer ids the rectangle projection cannot render (points/raster/atlas). */
  readonly incompatibleLayerIds: readonly number[];
  getCurrentTimeMa(): number;
  /** Effective visibility of a layer (its own flag AND its group's flag). */
  isLayerVisible(layerId: number): boolean;
  describeLayer(layerId: number): string;
  onCommittedTimeChange(timeMa: number): void;
  onStateChange(snapshot: ProjectionSnapshot): void;
  setGlobeInertiaEnabled(enabled: boolean): void;
  captureGlobeCamera(): void;
  restoreGlobeCamera(): void;
  applyGlobeFrame(timeMa: number): ProjectionTimeCounts;
  captureTimeLayers?(context: TimeLayerContext): TimeLayerPreparation;
  onTimeLayerCleanupError?(error: unknown): void;
  globeHome(): void;
}

const MODE_IDS: readonly ProjectionModeId[] = [
  "globe",
  "rectangle",
  "mollweide",
];

const ERROR_CODES: Record<string, number> = {
  auth: 401,
  busy: 409,
  internal: 500,
  unsupported: 501,
  validation: 400,
};

/** The full-map rectangle in the Geographic (Plate Carree) projection, radians. */
const FULL_MAP_RECTANGLE = Rectangle.fromRadians(
  -Math.PI,
  -Math.PI / 2,
  Math.PI,
  Math.PI / 2,
);

function reportsSceneDestroyed(scene: unknown): boolean {
  const candidate = scene as { isDestroyed?: () => boolean } | null | undefined;
  return (
    typeof candidate?.isDestroyed === "function" && candidate.isDestroyed()
  );
}

/** One active render-confirmation waiter, rejectable without waiting for a frame. */
interface RenderWaiter {
  readonly token: object;
  reject: (error: Error) => void;
  remove: () => void;
}

interface TimeRequest {
  readonly owner: object;
  readonly abortController: AbortController;
  generation?: number;
  layers?: TimeLayerPreparation;
  layerFailure?: Promise<never>;
  failure?: Error;
  cancellation?: OperationInterruptedError;
  accepted?: boolean;
  layersRolledBack?: boolean;
  releaseLayerObservers?: () => void;
  cleanupError?: unknown;
  prepared?: Promise<Awaited<ReturnType<PlateRenderer["prepareRectangleFrame"]>>>;
  ageMa: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * The single place that decides which projection is shown.
 *
 * Both the UI select and the `projection.select` agent action call
 * {@link select}; both the timeline and `time.set` call {@link setTime}. One
 * mode/source epoch governs all of them through {@link applyView}. All
 * time changes keep one active frame and one latest pending request, so ongoing
 * input cannot starve confirmation. Mode changes cancel both; overwritten
 * pending requests reject as `busy` (409).
 *
 * Three mode fields make the applied/pending split explicit so a mode or age
 * change always completes against the latest target, never a stale one:
 *
 * - `committedId` - the last mode that fully committed AND rendered (reporting).
 * - `activeModeId` - the mode the newest request is applying (dispatch target).
 * - `morphedModeId` - the mode the scene is actually morphed to right now.
 *
 * A time change inherits `activeModeId`, so a `setTime` that arrives while a
 * switch is still waiting for its render finishes the *new* target's scene and
 * renderer instead of dispatching by the not-yet-committed mode.
 */
export class ProjectionController {
  private requestedId: ProjectionModeId = "globe";
  private committedId: ProjectionModeId = "globe";
  /** The mode the newest request is applying; diverges from committedId mid-switch. */
  private activeModeId: ProjectionModeId = "globe";
  /** The mode the scene is currently morphed to; advances with the (sync) morph. */
  private morphedModeId: ProjectionModeId = "globe";
  private status: ProjectionStatus = "ready";
  private revision = 0;
  private committedTimeMa = 0;
  private requestedTimeMa = 0;
  private committedTimeState: ProjectionTimeCounts = {
    activeFeatureCount: 0,
    activePlateCount: 0,
    disconnectedFeatureCount: 0,
  };
  private lastError: ProjectionErrorSnapshot | undefined;
  /** Set only by the lifecycle renderError listener, so an explicit recovery
   * may clear it without erasing an unrelated API failure. */
  private lifecycleError: ProjectionErrorSnapshot | undefined;
  private removeLifecycleRenderError: (() => void) | undefined;
  /** Mode/source epoch; same-mode queued times do not invalidate active work. */
  private requestGeneration = 0;
  private sourceInvalidated = false;
  private activeTimeRequest: TimeRequest | undefined;
  private pendingTimeRequest: TimeRequest | undefined;
  /** Moll only: one CPU-active/ready successor while the current frame warms/renders. */
  private prefetchedTimeRequest: TimeRequest | undefined;
  private mollGpuActive = false;
  /** The in-flight render-confirmation waiter, rejectable without a new frame. */
  private renderWaiter: RenderWaiter | undefined;
  /** Owner of a synchronous Globe update not yet confirmed by postRender. */
  private globeFrameOwner: number | undefined;

  private readonly flatCamera: FlatMapCamera | undefined;
  private swap: { generation: number; owner: number; camera: ReturnType<FlatMapCamera["capture"]>; mode: ProjectionModeId } | undefined;

  constructor(private readonly host: ProjectionHost) {
    // Read-only unit stand-ins have no DOM camera; real viewers always take this path.
    if (typeof host.viewer.scene.canvas?.addEventListener === "function" && typeof host.viewer.camera.frustum?.clone === "function") {
      this.flatCamera = new FlatMapCamera(host.viewer);
      host.plateRenderer.setFlatPickFilter(position => this.flatCamera!.contains(position));
    }
    // Transaction waiters only cover their own request. A native gesture (or a
    // stopped Widget loop between requests) can fail while no transaction is
    // active, so the scene error must still reach the published state instead
    // of leaving the projection reporting ready.
    if (typeof host.viewer.scene.renderError?.addEventListener === "function") {
      this.removeLifecycleRenderError = host.viewer.scene.renderError.addEventListener(
        (_scene: unknown, error: unknown) => this.onLifecycleRenderError(error),
      );
    }
  }

  getSnapshot(): ProjectionSnapshot {
    return {
      camera: this.flatCamera?.getSnapshot(),
      availableModes: this.computeAvailableModes(),
      committedId: this.committedId,
      committedTimeMa: this.committedTimeMa,
      committedTimeState: this.committedTimeState,
      lastError: this.lastError,
      requestedId: this.requestedId,
      requestedTimeMa: this.requestedTimeMa,
      revision: this.revision,
      status: this.status,
    };
  }

  /** Seeds the committed time so the first status read is honest. */
  initialize(timeMa: number, timeState: ProjectionTimeCounts): void {
    this.committedTimeMa = timeMa;
    this.requestedTimeMa = timeMa;
    this.committedTimeState = timeState;
    this.publish();
  }

  /** Last mode that fully committed and rendered. */
  get committedMode(): ProjectionModeId {
    return this.committedId;
  }

  /** Mode the newest request is applying (the dispatch target). */
  get activeMode(): ProjectionModeId {
    return this.activeModeId;
  }

  /** Mode the scene is actually morphed to right now (drives the camera guard). */
  get sceneMode(): ProjectionModeId {
    return this.morphedModeId;
  }

  /**
   * The shared projection handler. Resolves only after the target view has
   * actually committed and rendered; rejects with a structured failure for a
   * cancelled, superseded, unsupported or internal problem.
   */
  async select(projectionId: unknown, options: { signal?: AbortSignal } = {}): Promise<{ projectionId: ProjectionModeId; revision: number }> {
    this.assertSourceCurrent();
    if (
      typeof projectionId !== "string" ||
      !MODE_IDS.includes(projectionId as ProjectionModeId)
    ) {
      throw new AgentActionValidationError(
        `projectionId must be one of ${MODE_IDS.join(", ")}.`,
      );
    }
    const signal = options.signal;
    if (signal?.aborted) throw new OperationInterruptedError("cancelled");
    const target = projectionId as ProjectionModeId;
    // A no-op only when the target is already committed, the scene is
    // actually in that mode, and the last request fully succeeded. After an
    // error - for example a confirmation renderError that morphed the scene but
    // never committed - the same committed target must re-apply/morph/restore
    // rather than skip and leave the wrong picture on screen.
    if (
      target === this.committedId &&
      target === this.activeModeId &&
      target === this.morphedModeId &&
      this.status === "ready"
    ) {
      return { projectionId: this.committedId, revision: this.revision };
    }
    if (target !== "globe") {
      this.assertRectangleCapability(target);
    }

    const generation = ++this.requestGeneration;
    const cancelledTime = this.cancelTimeRequests();
    if (generation !== this.requestGeneration) {
      this.rollbackTimeLayers(cancelledTime);
      throw new OperationInterruptedError("superseded");
    }
    this.cancelRenderWaiter();
    this.rollbackInterruptedView(cancelledTime);
    if (generation !== this.requestGeneration) throw new OperationInterruptedError("superseded");
    this.activeModeId = target;
    this.requestedId = target;
    this.status = "preparing";
    this.lastError = undefined;
    let frameConfirmed = false;
    let cancellation: OperationInterruptedError | undefined;
    let recovery: Promise<void> | undefined;
    let recoveryFailure: Error | undefined;
    let rejectCancellation: (error: Error) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const abort = (): void => {
      // A signal belongs to this selection, never to whichever request is now active.
      if (frameConfirmed || cancellation || generation !== this.requestGeneration) return;
      cancellation = new OperationInterruptedError("cancelled");
      const needsRecoveryRender = this.swap?.owner === generation || this.globeFrameOwner === generation;
      const recoveryGeneration = ++this.requestGeneration;
      try {
        this.cancelRenderWaiter(cancellation);
        this.host.plateRenderer.cancelRectanglePreparation();
        this.host.plateRenderer.cancelRectangleStaging();
        this.rollbackGlobeFrame(generation);
        this.rollbackSwap(generation);
        this.host.setGlobeInertiaEnabled(this.morphedModeId === "globe");
        this.activeModeId = this.morphedModeId;
        this.requestedId = this.committedId;
        this.requestedTimeMa = this.committedTimeMa;
        this.status = needsRecoveryRender ? "preparing" : "ready";
        this.lastError = undefined;
        if (needsRecoveryRender) {
          recovery = this.awaitNextRender(recoveryGeneration).then(() => {
            if (recoveryGeneration !== this.requestGeneration) return;
            this.status = "ready";
            this.publish();
          }).catch(error => {
            // A newer owner may replace this recovery; its state is never ours to reset.
            if (recoveryGeneration !== this.requestGeneration) return;
            this.status = "error";
            this.lastError = this.toError(error);
            this.publish();
            throw error;
          });
        }
      } catch (error) {
        // AbortSignal callbacks must not leak errors or claim a failed rollback succeeded.
        recoveryFailure = error instanceof Error ? error : new Error(String(error));
        this.status = "error";
        this.lastError = this.toError(recoveryFailure);
      }
      this.publish();
      rejectCancellation(recoveryFailure ?? cancellation);
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.publish();

    try {
      // An application state observer may synchronously abort during publish.
      if (signal?.aborted) abort();
      if (cancellation) await interrupted;
      if (generation !== this.requestGeneration) throw new OperationInterruptedError("superseded");
      // Changing the projection must not apply an uncommitted timeline request
      // through the plate-only path. Cancelled time callers have an explicit
      // result; retain their requested age so the UI can offer an honest retry.
      const ageMa = this.committedTimeMa;
      const applied = this.applyView(target, ageMa, generation, undefined, Boolean(signal), () => { frameConfirmed = true; });
      await Promise.race([applied, interrupted]);
      if (generation !== this.requestGeneration) {
        throw new OperationInterruptedError("superseded");
      }
      this.commitSuccess(target);
      return { projectionId: target, revision: this.revision };
    } catch (error) {
      if (cancellation) {
        if (recoveryFailure) throw recoveryFailure;
        await recovery;
        throw cancellation;
      }
      if (generation !== this.requestGeneration) {
        throw new OperationInterruptedError("superseded");
      }
      this.rollbackGlobeFrame(generation);
      this.rollbackSwap(generation);
      this.host.setGlobeInertiaEnabled(this.morphedModeId === "globe");
      this.status = "error";
      this.requestedId = this.committedId;
      // The scene did not reach the committed target, so dispatch follows what
      // the scene is actually morphed to (a half-applied mode whose confirmation
      // failed), not the stale committed id - otherwise a follow-up would drive
      // the wrong renderer.
      this.activeModeId = this.morphedModeId;
      this.lastError = this.toError(error);
      this.publish();
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  /**
   * The shared time handler. Dispatches by {@link activeMode} - the latest
   * target - so a time change that lands mid-switch completes that switch's
   * scene and renderer. Each mode confirms the active frame before starting
   * the latest pending time; Globe's synchronous update still needs a render.
   * Overwritten pending changes settle as `busy`; active changes resolve only
   * after their own age has really rendered.
   */
  async setTime(ageMa: number, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.assertSourceCurrent();
    if (!Number.isFinite(ageMa)) {
      throw new AgentActionValidationError("ageMa must be a finite number.");
    }
    if (options.signal?.aborted) throw new OperationInterruptedError("cancelled");
    this.requestedTimeMa = ageMa;
    // Retry input may arrive while an existing ticket is waiting on a stopped
    // Widget loop. Resume now, not only when that queued input becomes active.
    this.resumeRenderLoop();
    this.status = "preparing";
    this.lastError = undefined;
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        if (error === undefined) resolve(); else reject(error);
      };
      const request: TimeRequest = {
        owner: {}, abortController: new AbortController(), ageMa,
        resolve: () => finish(), reject: error => finish(error),
      };
      const abort = () => { if (!settled) this.cancelTimeRequest(request); };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (this.activeTimeRequest) {
        this.pendingTimeRequest?.reject(
          new OperationInterruptedError("superseded", "Superseded by a newer time request."),
        );
        this.pendingTimeRequest = request;
        this.prefetchMollTime();
      } else {
        const generation = ++this.requestGeneration;
        this.activeTimeRequest = request;
        if (this.swap) this.swap.owner = generation;
        void this.runTime(request, generation);
      }
    });
    this.publish();
    return promise;
  }

  /** Caller cancellation belongs to one ticket, not the mode/source epoch. */
  private cancelTimeRequest(request: TimeRequest): void {
    if (request.accepted || request.failure || request.cancellation) return;
    const error = new OperationInterruptedError("cancelled");
    if (this.activeTimeRequest === request) {
      request.cancellation = error;
      request.abortController.abort(error);
      return;
    }
    const promoted = this.prefetchedTimeRequest === request;
    if (!promoted && this.pendingTimeRequest !== request) return;
    if (promoted) this.prefetchedTimeRequest = undefined;
    else this.pendingTimeRequest = undefined;
    request.cancellation = error;
    request.abortController.abort(error);
    let failure: unknown = error;
    if (promoted) {
      try { this.host.plateRenderer.cancelRectanglePreparation(); }
      catch (cleanupError) { failure = cleanupError; }
    }
    request.reject(failure);
    this.requestedTimeMa = this.pendingTimeRequest?.ageMa ?? this.prefetchedTimeRequest?.ageMa ?? this.activeTimeRequest?.ageMa ?? this.committedTimeMa;
    this.prefetchMollTime();
    this.publish();
  }

  private async runTime(
    request: TimeRequest,
    generation: number,
  ): Promise<void> {
    try {
      const mode = this.activeModeId;
      request.generation = generation;
      this.captureTimeLayers(request, generation, mode);
      this.assertTimeOwner(request, generation);
      // Every time replacement needs its predecessor until postRender confirms
      // it, including Rectangle frames with no external cancellation signal.
      const applied = this.applyView(mode, request.ageMa, generation, request.prepared, true, undefined, request);
      await (request.layerFailure ? Promise.race([applied, request.layerFailure]) : applied);
      if (generation !== this.requestGeneration) {
        if (request.accepted) { request.resolve(); return; }
        throw new OperationInterruptedError("superseded", "Superseded by a newer request.");
      }
      // Do not overwrite requestedTimeMa: it belongs to the newest input.
      this.commitSuccess(this.activeModeId);
      if (request.cleanupError !== undefined && !this.host.onTimeLayerCleanupError) {
        this.lastError = this.toError(request.cleanupError);
        this.publish();
      }
      request.resolve();
    } catch (error) {
      if (request.accepted) {
        this.reportTimeLayerCleanupError(request, error);
        request.resolve();
        return;
      }
      if (generation !== this.requestGeneration || this.activeTimeRequest !== request) {
        try { this.rollbackTimeLayers(request); }
        catch (recoveryError) {
          this.reportTimeLayerCleanupError(request, recoveryError);
          request.reject(recoveryError); return;
        }
        request.reject(error); return;
      }
      // A failed native frame invalidates queued work; a fresh input can retry.
      let failure = error;
      const needsRecoveryRender = this.globeFrameOwner === generation || this.swap?.owner === generation;
      request.abortController.abort(error);
      if (generation !== this.requestGeneration || this.activeTimeRequest !== request) {
        request.reject(error); return;
      }
      try {
        this.cancelPreparedFrame(request, false, generation, Boolean(request.cancellation && this.prefetchedTimeRequest));
      } catch (recoveryError) {
        failure = recoveryError;
      }
      if (generation !== this.requestGeneration || this.activeTimeRequest !== request) {
        request.reject(failure); return;
      }
      this.activeModeId = this.morphedModeId;
      this.requestedId = this.committedId;
      if ((request.cancellation || needsRecoveryRender) && failure === error) {
        if (request.cancellation) this.requestedTimeMa = this.pendingTimeRequest?.ageMa ?? this.prefetchedTimeRequest?.ageMa ?? this.committedTimeMa;
        this.lastError = request.cancellation ? undefined : this.toError(error);
        this.status = needsRecoveryRender || this.pendingTimeRequest || this.prefetchedTimeRequest ? "preparing" : "ready";
        try {
          this.publish();
          if (generation !== this.requestGeneration || this.activeTimeRequest !== request) { request.reject(failure); return; }
          if (needsRecoveryRender) await this.awaitNextRender(generation, undefined, 30_000);
        } catch (recoveryError) {
          failure = recoveryError;
        }
        if (generation !== this.requestGeneration || this.activeTimeRequest !== request) { request.reject(failure); return; }
        if (request.cancellation && failure === error) {
          this.status = this.pendingTimeRequest || this.prefetchedTimeRequest ? "preparing" : "ready";
          request.reject(request.cancellation);
          this.publish();
          return;
        }
        // A failed recovery is a real failure, not a successful cancellation.
        if (request.cancellation) {
          try { this.host.plateRenderer.cancelRectanglePreparation(); }
          catch (cleanupError) { failure = cleanupError; }
        }
      }
      request.reject(failure);
      this.pendingTimeRequest?.reject(failure);
      this.prefetchedTimeRequest?.reject(failure);
      this.pendingTimeRequest = undefined;
      this.prefetchedTimeRequest = undefined;
      this.host.setGlobeInertiaEnabled(this.morphedModeId === "globe");
      this.status = "error";
      // Keep the latest input honest even when a CPU/GPU ticket fails.
      this.lastError = this.toError(failure);
      this.publish();
    } finally {
      const releaseLayerObservers = request.releaseLayerObservers;
      request.releaseLayerObservers = undefined;
      try { releaseLayerObservers?.(); }
      catch (cleanupError) { this.reportTimeLayerCleanupError(request, cleanupError); }
      if (this.activeTimeRequest === request) {
        this.activeTimeRequest = undefined;
        this.mollGpuActive = false;
        const next = this.prefetchedTimeRequest ?? this.pendingTimeRequest;
        if (this.prefetchedTimeRequest) this.prefetchedTimeRequest = undefined;
        else this.pendingTimeRequest = undefined;
        if (next) {
          this.activeTimeRequest = next;
          void this.runTime(next, generation);
        }
      }
    }
  }

  private prefetchMollTime(): void {
    if (this.activeModeId !== "mollweide" || !this.mollGpuActive || this.prefetchedTimeRequest || !this.pendingTimeRequest) return;
    const next = this.pendingTimeRequest;
    this.pendingTimeRequest = undefined;
    this.prefetchedTimeRequest = next;
    next.prepared = this.host.plateRenderer.prepareRectangleFrame(next.ageMa, this.host.rotationModel, "mollweide");
    // The promoted ticket cannot be overwritten by later input. Its failure is
    // consumed by runTime after the preceding actual render settles.
    void next.prepared.catch(() => undefined);
  }

  private cancelTimeRequests(): TimeRequest | undefined {
    const error = new OperationInterruptedError("superseded", "Superseded by a newer projection request.");
    const active = this.activeTimeRequest;
    if (active?.accepted) active.resolve();
    else active?.reject(error);
    this.pendingTimeRequest?.reject(error);
    this.prefetchedTimeRequest?.reject(error);
    this.activeTimeRequest = undefined;
    this.pendingTimeRequest = undefined;
    this.prefetchedTimeRequest = undefined;
    this.mollGpuActive = false;
    if (!active?.accepted) active?.abortController.abort(error);
    return active;
  }

  private captureTimeLayers(request: TimeRequest, generation: number, mode: ProjectionModeId): void {
    let rejectFailure!: (error: Error) => void;
    request.layerFailure = new Promise<never>((_resolve, reject) => { rejectFailure = reject; });
    // Capture and native subscriptions can fail synchronously, before runTime races it.
    void request.layerFailure.catch(() => undefined);
    const fail = (error: unknown): void => {
      if (request.accepted || request.failure) return;
      request.failure = error instanceof Error ? error : new Error(String(error));
      rejectFailure(request.failure);
      if (this.activeTimeRequest === request && generation === this.requestGeneration) this.cancelRenderWaiter(request.failure);
    };
    const onFailure = (error: unknown): void => {
      if (this.activeTimeRequest === request && generation === this.requestGeneration) fail(error);
    };
    const abort = () => fail(request.abortController.signal.reason);
    request.abortController.signal.addEventListener("abort", abort, { once: true });
    let removeRenderError = () => {};
    request.releaseLayerObservers = () => {
      try { request.abortController.signal.removeEventListener("abort", abort); }
      finally { removeRenderError(); }
    };
    if (!this.host.captureTimeLayers) return;
    removeRenderError = this.host.viewer.scene.renderError.addEventListener((_scene: unknown, error: unknown) => onFailure(error));
    request.layers = this.host.captureTimeLayers({
      owner: request.owner, generation, ageMa: request.ageMa, mode,
      signal: request.abortController.signal, onFailure,
    });
    void request.layers.ready.catch(onFailure);
  }

  private assertTimeOwner(request: TimeRequest | undefined, generation: number): void {
    if (generation !== this.requestGeneration || (request && this.activeTimeRequest !== request)) {
      throw new OperationInterruptedError("superseded", "Superseded by a newer request.");
    }
    if (request?.failure) throw request.failure;
  }

  private rollbackTimeLayers(request?: TimeRequest): void {
    if (!request?.layers || request.accepted || request.layersRolledBack) return;
    request.layersRolledBack = true;
    request.layers.rollback();
  }

  /** Attempt every retained restoration even when one native cleanup throws. */
  private cancelPreparedFrame(request?: TimeRequest, discardPrepared = false, generation?: number, preservePrepared = false): void {
    const epoch = this.requestGeneration;
    const globeOwner = generation ?? this.globeFrameOwner;
    const swapOwner = generation ?? this.swap?.owner;
    let failure: unknown;
    let failed = false;
    for (const restore of [
      () => { if (!preservePrepared && epoch === this.requestGeneration) this.host.plateRenderer.cancelRectanglePreparation(discardPrepared); },
      () => { if (epoch === this.requestGeneration) this.host.plateRenderer.cancelRectangleStaging(); },
      () => this.rollbackTimeLayers(request),
      () => { if (globeOwner !== undefined) this.rollbackGlobeFrame(globeOwner); },
      () => { if (swapOwner !== undefined) this.rollbackSwap(swapOwner); },
    ]) {
      try { restore(); } catch (error) { failed = true; failure = error; }
    }
    if (failed) throw failure;
  }

  private reportTimeLayerCleanupError(request: TimeRequest, error: unknown): void {
    request.cleanupError = error;
    try { this.host.onTimeLayerCleanupError?.(error); }
    catch (diagnosticError) { request.cleanupError = diagnosticError; }
  }

  private acceptTimeFrame(request: TimeRequest, ageMa: number, counts: ProjectionTimeCounts, swapOwner: number): void {
    this.assertTimeOwner(request, request.generation!);
    request.layers?.accept();
    this.assertTimeOwner(request, request.generation!);
    request.accepted = true;
    this.globeFrameOwner = undefined;
    this.committedTimeMa = ageMa;
    this.committedTimeState = counts;
    // The displayed frame is now fact. Retirement/notification cannot undo it.
    for (const finish of [
      () => this.confirmSwap(swapOwner),
      () => request.layers?.retire(),
      () => this.host.onCommittedTimeChange(ageMa),
    ]) {
      try { finish(); } catch (error) { this.reportTimeLayerCleanupError(request, error); }
    }
  }

  /** Mode-aware home: the full map when the scene is 2D, the globe view otherwise. */
  home(): void {
    if (this.morphedModeId !== "globe") {
      if (this.flatCamera) this.flatCamera.home();
      else this.setRectangleCamera();
    } else {
      this.host.globeHome();
    }
  }

  zoom(factor: unknown) {
    if (typeof factor !== "number" || !Number.isFinite(factor) || factor < 0.01 || factor > 100) {
      throw new AgentActionValidationError("factor must be finite and within [0.01, 100].");
    }
    return this.requireFlatCamera().zoom(factor);
  }

  pan(deltaX: unknown, deltaY: unknown) {
    if (typeof deltaX !== "number" || typeof deltaY !== "number" ||
      !Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > 100000 || Math.abs(deltaY) > 100000) {
      throw new AgentActionValidationError("deltaX and deltaY must be finite CSS pixels within [-100000, 100000].");
    }
    return this.requireFlatCamera().panBy(deltaX, deltaY);
  }

  private requireFlatCamera(): FlatMapCamera {
    this.assertSourceCurrent();
    if (this.morphedModeId === "globe" || !this.flatCamera) {
      throw new AgentActionUnsupportedError("camera.zoom/pan support flat projections only.");
    }
    return this.flatCamera;
  }

  /** Shared guard for the existing globe-only GPU point loader. */
  assertGlobeRuntimeAvailable(): void {
    this.assertSourceCurrent();
    if (this.status === "preparing") {
      throw new AgentActionBusyError("Wait for the projection transition to finish before loading points.");
    }
    if (this.activeModeId !== "globe" || this.morphedModeId !== "globe") {
      throw new AgentActionUnsupportedError("Points require the Globe projection in this build.");
    }
  }

  /**
   * Rejects a layer mutation that would make a rectangle-incompatible layer
   * effective-visible while a flat mode is active, pending, or still committed
   * during an unconfirmed return to Globe. The caller passes
   * the layers and groups *as they would be after the change*; effective
   * visibility includes every ancestor, so a child whose parent group
   * stays hidden is correctly not treated as shown. On throw nothing has been
   * applied yet, so runtime and persistence are unchanged. Turning a layer off
   * or keeping it under a hidden group is always allowed.
   */
  assertLayerMutationAllowed(
    layers: readonly ProjectionLayerRow[],
    groups: readonly ProjectionGroupRow[],
  ): void {
    // The requested Globe frame can still fail or roll back to its retained
    // flat predecessor. Keep that predecessor's constraint until Globe commits.
    const constraintMode = this.activeModeId === "globe" ? this.committedId : this.activeModeId;
    if (constraintMode === "globe") {
      return;
    }
    const groupById = new Map(groups.map(group => [group.id, group]));
    for (const layer of layers) {
      if (!this.host.incompatibleLayerIds.includes(layer.id)) {
        continue;
      }
      let effective = layer.active;
      const visited = new Set<number>();
      for (let group = groupById.get(layer.groupId); effective && group;
        group = group.parentId === undefined ? undefined : groupById.get(group.parentId)) {
        if (visited.has(group.id)) throw new AgentActionValidationError("Layer groups must not contain a cycle.");
        visited.add(group.id);
        effective = group.active;
      }
      if (effective) {
        throw new AgentActionValidationError(
          `Layer ${this.host.describeLayer(
            layer.id,
          )} cannot be shown while the ${constraintMode === "mollweide" ? "Mollweide" : "Rectangle"} projection is active. Switch back to Globe first.`,
        );
      }
    }
  }

  /**
   * Republishes the current snapshot after an external capability change -
   * for example a layer/group/order mutation that flipped an incompatible
   * layer's effective visibility. No new frame is prepared; an in-flight
   * rectangle transaction is cancelled if its capability has become invalid.
   */
  refreshCapabilities(): void {
    if (
      this.activeModeId !== "globe" && this.status === "preparing" &&
      this.blockingLayers().length > 0
    ) {
      // Invalidate before native cleanup/restoration: either can throw while
      // the old postRender would otherwise still be allowed to commit.
      const generation = ++this.requestGeneration;
      const cancelledTime = this.cancelTimeRequests();
      if (generation !== this.requestGeneration) {
        this.rollbackTimeLayers(cancelledTime);
        return;
      }
      this.cancelRenderWaiter();
      try {
        this.cancelPreparedFrame(cancelledTime);
        if (generation !== this.requestGeneration) return;
        this.host.setGlobeInertiaEnabled(this.morphedModeId === "globe");
        this.status = "error";
        this.requestedTimeMa = this.committedTimeMa;
        this.lastError = this.toError(new AgentActionUnsupportedError(
          `${this.activeModeId === "mollweide" ? "Mollweide" : "Rectangle"} projection has incompatible visible layers.`,
        ));
      } catch (error) {
        this.reportInterruptedFailure(error);
        throw error;
      }
    }
    this.publish();
  }

  /** A source selection reload keeps the old picture, but cannot commit old work. */
  invalidateSource(): void {
    if (this.sourceInvalidated) return;
    this.sourceInvalidated = true;
    this.requestGeneration += 1;
    const cancelledTime = this.cancelTimeRequests();
    this.cancelRenderWaiter();
    this.rollbackInterruptedView(cancelledTime, true);
    this.activeModeId = this.morphedModeId;
    this.requestedId = this.committedId;
    this.requestedTimeMa = this.committedTimeMa;
    this.status = "error";
    this.lastError = this.toError(new AgentActionBusyError("Plate source changed; reload is required."));
    this.host.setGlobeInertiaEnabled(this.morphedModeId === "globe");
    this.publish();
  }

  private assertSourceCurrent(): void {
    if (this.sourceInvalidated) throw new AgentActionBusyError("Plate source changed or runtime disposed; reload is required.");
  }

  /**
   * An explicit user recovery (Home/reset) installed a finite pose and its own
   * matching postRender completed. Only the render error this listener actually
   * published may be cleared; a later API failure stays.
   */
  confirmRenderRecovered(): void {
    if (this.sourceInvalidated || !this.lifecycleError) return;
    if (this.lastError !== this.lifecycleError) return;
    if (this.renderWaiter || this.activeTimeRequest || this.pendingTimeRequest || this.prefetchedTimeRequest) return;
    this.lifecycleError = undefined;
    this.lastError = undefined;
    this.status = "ready";
    this.publish();
  }

  private onLifecycleRenderError(error: unknown): void {
    if (this.sourceInvalidated) return;
    // An active frame waiter owns this failure and reports it through its own
    // transaction; publishing here first would race its cancellation state.
    if (this.renderWaiter) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    const snapshot = this.toError(failure);
    this.lifecycleError = snapshot;
    this.lastError = snapshot;
    this.status = "error";
    this.publish();
  }

  /** Cancels any in-flight work; called when the renderer is torn down. */
  destroy(): void {
    // Close entry points before any native cleanup can throw.
    this.sourceInvalidated = true;
    this.removeLifecycleRenderError?.();
    this.removeLifecycleRenderError = undefined;
    this.requestGeneration += 1;
    const cancelledTime = this.cancelTimeRequests();
    this.cancelRenderWaiter();
    try {
      this.cancelPreparedFrame(cancelledTime, true);
    } catch (error) {
      this.reportInterruptedFailure(error);
      throw error;
    } finally {
      this.flatCamera?.destroy();
    }
  }

  /** The caller has already invalidated tickets and removed their waiter. */
  private rollbackInterruptedView(request?: TimeRequest, discardPrepared = false): void {
    const generation = this.requestGeneration;
    try {
      this.cancelPreparedFrame(request, discardPrepared);
    } catch (error) {
      // A failed restoration is observable, never a successful cancellation.
      if (generation === this.requestGeneration) this.reportInterruptedFailure(error);
      else if (request) this.reportTimeLayerCleanupError(request, error);
      throw error;
    }
  }

  private reportInterruptedFailure(error: unknown): void {
    this.activeModeId = this.morphedModeId;
    this.requestedId = this.committedId;
    this.requestedTimeMa = this.committedTimeMa;
    this.status = "error";
    this.lastError = this.toError(error);
    this.publish();
  }

  private rollbackGlobeFrame(generation?: number): void {
    if (this.globeFrameOwner === undefined || (generation !== undefined && this.globeFrameOwner !== generation)) return;
    this.globeFrameOwner = undefined;
    // A retained flat swap owns restoration across a mode change. Otherwise
    // the public host update restores both the plate and point transforms.
    if (!this.swap && this.committedId === "globe" && !reportsSceneDestroyed(this.host.viewer.scene)) {
      this.host.applyGlobeFrame(this.committedTimeMa);
      this.resumeRenderLoop();
      this.host.viewer.scene.requestRender();
    }
  }

  private beginSwap(generation: number): void {
    if (!this.flatCamera) return;
    if (this.swap) {
      this.swap.owner = generation;
      return;
    }
    this.swap = { generation, owner: generation, camera: this.flatCamera.capture(), mode: this.morphedModeId };
    this.host.plateRenderer.beginFlatSwap(generation);
  }
  private rollbackSwap(generation?: number): void {
    const swap = this.swap;
    if (!swap || (generation !== undefined && generation !== swap.owner)) return;
    this.swap = undefined;
    this.host.plateRenderer.rollbackFlatSwap(swap.generation);
    this.flatCamera!.restore(swap.camera);
    this.morphedModeId = swap.mode;
    this.host.setGlobeInertiaEnabled(swap.mode === "globe");
    if (swap.mode === "globe") this.host.applyGlobeFrame(this.committedTimeMa);
    // CesiumWidget stops its public render loop on renderError. The target
    // resources are gone and the prior confirmed frame is restored, so render
    // that old frame again. A genuinely lost context can still fail normally.
    this.resumeRenderLoop();
  }

  private resumeRenderLoop(): void {
    if (this.host.viewer.useDefaultRenderLoop === false && !reportsSceneDestroyed(this.host.viewer.scene)) {
      this.host.viewer.useDefaultRenderLoop = true;
      this.host.viewer.scene.requestRender();
    }
  }
  private confirmSwap(generation: number): void {
    if (this.swap?.owner !== generation) return;
    const swap = this.swap;
    this.swap = undefined;
    this.host.plateRenderer.confirmFlatSwap(swap.generation);
  }

  // --- transaction --------------------------------------------------------

  /**
   * Applies one (mode, age) transaction and confirms it with a real render.
   * `generation` guards every await so a superseded request never commits.
   */
  private async applyView(
    mode: ProjectionModeId,
    ageMa: number,
    generation: number,
    prepared?: Promise<Awaited<ReturnType<PlateRenderer["prepareRectangleFrame"]>>>,
    retainForCancellation = false,
    onFrameConfirmed?: () => void,
    timeRequest?: TimeRequest,
  ): Promise<void> {
    // An explicit retry must not wait forever on a loop stopped by CesiumWidget.
    this.resumeRenderLoop();
    // A newer request supersedes any render we were still waiting to confirm;
    // reject it now instead of leaving it parked on a frame that may never come.
    this.cancelRenderWaiter();
    const needsMorph = this.morphedModeId !== mode;

    if (mode !== "globe") {
      this.host.plateRenderer.cancelRectangleStaging();
      if (needsMorph) {
        this.host.setGlobeInertiaEnabled(false);
      }
      const handle = await this.awaitPreparation(() => prepared ?? this.host.plateRenderer.prepareRectangleFrame(
        ageMa,
        this.host.rotationModel,
        mode,
      ));
      if (generation !== this.requestGeneration) {
        throw new OperationInterruptedError("superseded", "Superseded by a newer request.");
      }
      this.assertTimeOwner(timeRequest, generation);
      this.resumeRenderLoop();
      const staged = this.host.plateRenderer.stageRectangleFrame(handle, generation);
      if (mode === "mollweide" && this.activeTimeRequest) {
        this.mollGpuActive = true;
        this.prefetchMollTime();
      }
      await staged;
      if (generation !== this.requestGeneration) {
        // The new epoch already cancelled this staging. Do not cancel a
        // replacement frame that may now occupy the renderer's staging slot.
        throw new OperationInterruptedError("superseded", "Superseded by a newer request.");
      }
      if (timeRequest?.layers) await timeRequest.layers.ready;
      this.assertTimeOwner(timeRequest, generation);
      // Final capability recheck on the *effective* visible layers, right before
      // the irreversible commit: a layer turned on while this frame warmed up
      // must abort the switch, not silently ship a mis-projected view.
      this.assertRectangleCapability(mode);
      // Capture only when the staged target is actually leaving Globe. A long
      // preparation can outlive native camera settling or fail without a swap.
      if (needsMorph && this.morphedModeId === "globe") this.host.captureGlobeCamera();
      if (retainForCancellation || mode === "mollweide" || this.morphedModeId === "mollweide") this.beginSwap(generation);
      this.host.plateRenderer.commitRectangleFrame(generation, mode);
      timeRequest?.layers?.activate();
      this.assertTimeOwner(timeRequest, generation);
      if (needsMorph) {
        if (this.flatCamera) this.flatCamera.setMode(mode);
        else {
          this.host.viewer.scene.morphTo2D(0);
          this.setRectangleCamera();
        }
        this.morphedModeId = mode;
      }
      // Hold the committed time/counts and the host notification until a real
      // render confirms the frame, so a failed confirmation never reports a time
      // that did not actually render (and never rolls back a newer request).
      await this.awaitNextRender(generation, timeRequest);
      if (generation !== this.requestGeneration) {
        throw new OperationInterruptedError("superseded", "Superseded before the view rendered.");
      }
      this.assertTimeOwner(timeRequest, generation);
      if (timeRequest) {
        this.acceptTimeFrame(timeRequest, ageMa, handle.timeState, generation);
        return;
      }
      // Once the confirmed frame releases its predecessor, cancellation can no
      // longer restore that predecessor. Publish the rest of this commit atomically.
      onFrameConfirmed?.();
      this.confirmSwap(generation);
      this.committedTimeMa = ageMa;
      this.committedTimeState = handle.timeState;
      this.host.onCommittedTimeChange(ageMa);
      return;
    }

    // globe
    if (timeRequest?.layers) await timeRequest.layers.ready;
    this.assertTimeOwner(timeRequest, generation);
    if (needsMorph) {
      this.host.plateRenderer.cancelRectangleStaging();
      if (retainForCancellation || this.morphedModeId === "mollweide") this.beginSwap(generation);
      this.host.plateRenderer.restoreGlobeFrame();
      const globeCounts = this.host.applyGlobeFrame(ageMa);
      timeRequest?.layers?.activate();
      this.assertTimeOwner(timeRequest, generation);
      this.host.setGlobeInertiaEnabled(true);
      if (this.flatCamera) this.flatCamera.setMode("globe");
      else this.host.viewer.scene.morphTo3D(0);
      this.morphedModeId = "globe";
      this.host.restoreGlobeCamera();
      await this.awaitNextRender(generation, timeRequest);
      if (generation !== this.requestGeneration) {
        throw new OperationInterruptedError("superseded", "Superseded before the view rendered.");
      }
      this.assertTimeOwner(timeRequest, generation);
      if (timeRequest) {
        this.acceptTimeFrame(timeRequest, ageMa, globeCounts, generation);
        return;
      }
      onFrameConfirmed?.();
      this.confirmSwap(generation);
      this.committedTimeMa = ageMa;
      this.committedTimeState = globeCounts;
      this.host.onCommittedTimeChange(ageMa);
      return;
    }
    // Globe updates are synchronous, but committing their age/counts still
    // requires the same real-frame evidence as a prepared flat frame.
    this.host.plateRenderer.cancelRectangleStaging();
    this.host.setGlobeInertiaEnabled(true);
    this.globeFrameOwner = generation;
    const globeCounts = this.host.applyGlobeFrame(ageMa);
    timeRequest?.layers?.activate();
    this.assertTimeOwner(timeRequest, generation);
    await this.awaitNextRender(generation, timeRequest);
    if (generation !== this.requestGeneration) {
      throw new OperationInterruptedError("superseded", "Superseded before the view rendered.");
    }
    this.assertTimeOwner(timeRequest, generation);
    if (timeRequest) {
      this.acceptTimeFrame(timeRequest, ageMa, globeCounts, this.swap?.owner ?? generation);
      return;
    }
    this.globeFrameOwner = undefined;
    onFrameConfirmed?.();
    // A superseding Globe time accepts the already-morphed view. Retire the
    // predecessor's retained flat frame using its owning token before reporting
    // this newer success; that stale token must never roll it back later.
    if (this.swap) this.confirmSwap(this.swap.owner);
    this.committedTimeMa = ageMa;
    this.committedTimeState = globeCounts;
    this.host.onCommittedTimeChange(ageMa);
  }

  /** CPU preparation also belongs to the render transaction: the old frame can
   * fail while the Worker is busy, stopping Widget before GPU warm-up begins.
   * Settle immediately with that render error, and never stage a late CPU result.
   * Reuse the waiter slot so mode/source cancellation removes this listener too.
   */
  private awaitPreparation(
    prepare: () => ReturnType<PlateRenderer["prepareRectangleFrame"]>,
  ): ReturnType<PlateRenderer["prepareRectangleFrame"]> {
    return new Promise((resolve, reject) => {
      const token = {};
      let settled = false;
      let remove = () => {};
      const finish = (error?: Error, handle?: Awaited<ReturnType<PlateRenderer["prepareRectangleFrame"]>>) => {
        if (settled) return;
        settled = true;
        remove();
        if (this.renderWaiter?.token === token) this.renderWaiter = undefined;
        if (error) reject(error);
        else resolve(handle!);
      };
      remove = this.host.viewer.scene.renderError.addEventListener((_scene: unknown, error: unknown) => {
        // Reject before cancellation can deliver AbortError: preserve the 500.
        finish(error instanceof Error ? error : new Error(String(error)));
        this.host.plateRenderer.cancelRectanglePreparation();
      });
      this.renderWaiter = { token, remove: () => remove(), reject: error => finish(error) };
      try {
        void prepare().then(handle => finish(undefined, handle), error => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Publishes a committed view: bumps revision only when the mode changed. */
  private commitSuccess(mode: ProjectionModeId): void {
    if (this.committedId !== mode) {
      this.revision += 1;
      this.committedId = mode;
    }
    this.status = this.pendingTimeRequest || this.prefetchedTimeRequest ? "preparing" : "ready";
    this.lastError = undefined;
    this.publish();
  }

  private setRectangleCamera(): void {
    this.host.viewer.camera.setView({
      destination: FULL_MAP_RECTANGLE,
      endTransform: Matrix4.IDENTITY,
    });
    this.host.viewer.scene.requestRender();
  }

  /**
   * Rejects the in-flight render waiter immediately: removes its postRender and
   * renderError listeners and rejects it once, so a supersede or destroy never
   * leaves a promise parked on a frame that may never arrive. The token check
   * keeps an old waiter's settle from clearing a newer one.
   */
  private cancelRenderWaiter(error: Error = new OperationInterruptedError("superseded", "Superseded before the view rendered.")): void {
    const waiter = this.renderWaiter;
    if (!waiter) {
      return;
    }
    this.renderWaiter = undefined;
    // The waiter's settle path owns listener removal on both success and failure.
    waiter.reject(error);
  }

  /**
   * Resolves after the next real render, or rejects if superseded, destroyed or
   * a render error fires. The waiter is stored so a new request or destroy can
   * reject it without waiting for that frame.
   */
  private awaitNextRender(generation: number, timeRequest?: TimeRequest, timeoutMs?: number): Promise<void> {
    if (reportsSceneDestroyed(this.host.viewer.scene)) return Promise.reject(new Error("The scene was destroyed before the frame rendered."));
    this.resumeRenderLoop();
    return new Promise<void>((resolve, reject) => {
      const scene = this.host.viewer.scene;
      const token = {};
      let settled = false;
      let removePostRender: () => void = () => {};
      let removeRenderError: () => void = () => {};
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        // Only clear the slot if it is still this waiter; a newer request may
        // already own it.
        if (this.renderWaiter?.token === token) {
          this.renderWaiter = undefined;
        }
        removePostRender();
        removeRenderError();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      removePostRender = scene.postRender.addEventListener(() => {
        if (
          generation !== this.requestGeneration ||
          (timeRequest && this.activeTimeRequest !== timeRequest) ||
          reportsSceneDestroyed(scene)
        ) {
          settle(
            new OperationInterruptedError("superseded", "Superseded before the view rendered."),
          );
          return;
        }
        try {
          this.assertTimeOwner(timeRequest, generation);
          if (timeRequest?.layers && !timeRequest.layers.canConfirm()) {
            scene.requestRender();
            return;
          }
        } catch (error) {
          settle(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        settle();
      });
      removeRenderError = scene.renderError.addEventListener(
        (_scene: unknown, error: unknown) => {
          settle(error instanceof Error ? error : new Error(String(error)));
        },
      );
      this.renderWaiter = {
        token,
        reject: (error: Error) => settle(error),
        remove: () => {
          clearTimeout(timer);
          removePostRender();
          removeRenderError();
        },
      };
      if (timeoutMs !== undefined) timer = setTimeout(() => settle(new Error(`The restored frame did not render within ${timeoutMs}ms.`)), timeoutMs);
      try { scene.requestRender(); }
      catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
  }

  private assertRectangleCapability(mode: "rectangle" | "mollweide"): void {
    const blocking = this.blockingLayers();
    if (blocking.length > 0) {
      throw new AgentActionUnsupportedError(
        `${mode === "mollweide" ? "Mollweide" : "Rectangle"} projection cannot show: ${blocking
          .map((id) => this.host.describeLayer(id))
          .join(", ")}. Turn those layers off first.`,
      );
    }
  }

  private blockingLayers(): number[] {
    return this.host.incompatibleLayerIds.filter((id) =>
      this.host.isLayerVisible(id),
    );
  }

  private computeAvailableModes(): ProjectionModeAvailability[] {
    const blocking = this.blockingLayers();
    const rectangleReason =
      blocking.length > 0
        ? `Incompatible visible layers: ${blocking
            .map((id) => this.host.describeLayer(id))
            .join(", ")}.`
        : undefined;
    return [
      { available: true, projectionId: "globe" },
      {
        available: blocking.length === 0,
        projectionId: "rectangle",
        reason: rectangleReason,
      },
      {
        available: blocking.length === 0,
        projectionId: "mollweide",
        reason: rectangleReason,
      },
    ];
  }

  private toError(error: unknown): ProjectionErrorSnapshot {
    if (error instanceof AgentActionFailureError) {
      return {
        code: ERROR_CODES[error.kind] ?? 500,
        kind: error.kind,
        message: error.message,
      };
    }
    return {
      code: 500,
      kind: "internal",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  private publish(): void {
    this.host.onStateChange(this.getSnapshot());
  }
}
