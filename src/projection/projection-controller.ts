import { Matrix4, Rectangle } from "cesium";

import type { RotationModel } from "@timemachine/reconstruction-core";
import type { PlateRenderer } from "@timemachine/cesium-runtime";
import {
  AgentActionBusyError,
  AgentActionFailureError,
  AgentActionUnsupportedError,
  AgentActionValidationError,
} from "../agent-actions/registry";

/** Projection modes. Mollweide is declared but has no runtime yet. */
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

interface RectangleTimeRequest {
  ageMa: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * The single place that decides which projection is shown.
 *
 * Both the UI select and the `projection.select` agent action call
 * {@link select}; both the timeline and `time.set` call {@link setTime}. One
 * mode/source epoch governs all of them through {@link applyView}. Rectangle
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
  /** Mode/source epoch; same-mode queued times do not invalidate active work. */
  private requestGeneration = 0;
  private activeTimeRequest: RectangleTimeRequest | undefined;
  private pendingTimeRequest: RectangleTimeRequest | undefined;
  /** The in-flight render-confirmation waiter, rejectable without a new frame. */
  private renderWaiter: RenderWaiter | undefined;

  constructor(private readonly host: ProjectionHost) {}

  getSnapshot(): ProjectionSnapshot {
    return {
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
   * superseded (`busy`), unsupported or internal problem.
   */
  async select(projectionId: unknown): Promise<{ projectionId: ProjectionModeId; revision: number }> {
    if (
      typeof projectionId !== "string" ||
      !MODE_IDS.includes(projectionId as ProjectionModeId)
    ) {
      throw new AgentActionValidationError(
        `projectionId must be one of ${MODE_IDS.join(", ")}.`,
      );
    }
    const target = projectionId as ProjectionModeId;
    if (target === "mollweide") {
      throw new AgentActionUnsupportedError(
        "Mollweide projection is not implemented yet.",
      );
    }
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
    if (target === "rectangle") {
      this.assertRectangleCapability();
    }

    this.cancelTimeRequests();
    this.host.plateRenderer.cancelRectanglePreparation();
    const generation = ++this.requestGeneration;
    this.activeModeId = target;
    this.requestedId = target;
    this.status = "preparing";
    this.lastError = undefined;
    this.publish();

    try {
      const ageMa = this.host.getCurrentTimeMa();
      this.requestedTimeMa = ageMa;
      await this.applyView(target, ageMa, generation);
      if (generation !== this.requestGeneration) {
        throw new AgentActionBusyError("Superseded by a newer request.");
      }
      this.commitSuccess(target);
      return { projectionId: target, revision: this.revision };
    } catch (error) {
      if (generation !== this.requestGeneration) {
        // Superseded: settle as busy, leave the newer request's state alone and
        // raise no error toast for this stale attempt.
        throw new AgentActionBusyError(
          "Superseded by a newer projection request.",
        );
      }
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
    }
  }

  /**
   * The shared time handler. Dispatches by {@link activeMode} - the latest
   * target - so a time change that lands mid-switch completes that switch's
   * scene and renderer. In globe it is the synchronous fast path; in rectangle
   * it confirms the active frame before starting the latest pending time.
   * Overwritten pending changes settle as `busy`; active changes resolve only
   * after their own age has really rendered.
   */
  async setTime(ageMa: number): Promise<void> {
    if (!Number.isFinite(ageMa)) {
      throw new AgentActionValidationError("ageMa must be a finite number.");
    }
    this.requestedTimeMa = ageMa;
    if (this.activeModeId === "rectangle") {
      const promise = new Promise<void>((resolve, reject) => {
        const request = { ageMa, resolve, reject };
        if (this.activeTimeRequest) {
          this.pendingTimeRequest?.reject(
            new AgentActionBusyError("Superseded by a newer time request."),
          );
          this.pendingTimeRequest = request;
        } else {
          const generation = ++this.requestGeneration;
          this.activeTimeRequest = request;
          void this.runRectangleTime(request, generation);
        }
      });
      this.status = "preparing";
      this.lastError = undefined;
      this.publish();
      return promise;
    }
    const generation = ++this.requestGeneration;
    try {
      await this.applyView(this.activeModeId, ageMa, generation);
      if (generation !== this.requestGeneration) {
        throw new AgentActionBusyError("Superseded by a newer time request.");
      }
      this.commitSuccess(this.activeModeId);
    } catch (error) {
      if (generation !== this.requestGeneration) {
        throw new AgentActionBusyError("Superseded by a newer time request.");
      }
      // A real rectangle time failure keeps the last committed picture; the
      // requested time falls back to what is actually shown.
      this.status = "error";
      this.requestedTimeMa = this.committedTimeMa;
      this.lastError = this.toError(error);
      this.publish();
      throw error;
    }
  }

  private async runRectangleTime(
    request: RectangleTimeRequest,
    generation: number,
  ): Promise<void> {
    try {
      await this.applyView("rectangle", request.ageMa, generation);
      if (generation !== this.requestGeneration) {
        throw new AgentActionBusyError("Superseded by a newer request.");
      }
      // Do not overwrite requestedTimeMa: it belongs to the newest input.
      this.commitSuccess("rectangle");
      request.resolve();
    } catch (error) {
      request.reject(error);
      if (generation !== this.requestGeneration) return;
      // A failed native frame invalidates queued work; a fresh input can retry.
      this.pendingTimeRequest?.reject(error);
      this.pendingTimeRequest = undefined;
      this.host.plateRenderer.cancelRectangleStaging();
      this.status = "error";
      this.requestedTimeMa = this.committedTimeMa;
      this.lastError = this.toError(error);
      this.publish();
    } finally {
      if (this.activeTimeRequest === request) {
        this.activeTimeRequest = undefined;
        const next = this.pendingTimeRequest;
        this.pendingTimeRequest = undefined;
        if (next) {
          this.activeTimeRequest = next;
          void this.runRectangleTime(next, generation);
        }
      }
    }
  }

  private cancelTimeRequests(): void {
    const error = new AgentActionBusyError("Superseded by a newer projection request.");
    this.activeTimeRequest?.reject(error);
    this.pendingTimeRequest?.reject(error);
    this.activeTimeRequest = undefined;
    this.pendingTimeRequest = undefined;
  }

  /** Mode-aware home: the full map when the scene is 2D, the globe view otherwise. */
  home(): void {
    if (this.morphedModeId === "rectangle") {
      this.setRectangleCamera();
    } else {
      this.host.globeHome();
    }
  }

  /**
   * Rejects a layer mutation that would make a rectangle-incompatible layer
   * effective-visible while rectangle is active or pending. The caller passes
   * the layers and groups *as they would be after the change*; effective
   * visibility is `layer.active && group.active`, so a child whose parent group
   * stays hidden is correctly not treated as shown. On throw nothing has been
   * applied yet, so runtime and persistence are unchanged. Turning a layer off
   * or keeping it under a hidden group is always allowed.
   */
  assertLayerMutationAllowed(
    layers: readonly ProjectionLayerRow[],
    groups: readonly ProjectionGroupRow[],
  ): void {
    if (this.activeModeId !== "rectangle") {
      return;
    }
    const groupActive = new Map(groups.map((group) => [group.id, group.active]));
    for (const layer of layers) {
      if (!this.host.incompatibleLayerIds.includes(layer.id)) {
        continue;
      }
      const effective = layer.active && (groupActive.get(layer.groupId) ?? true);
      if (effective) {
        throw new AgentActionValidationError(
          `Layer ${this.host.describeLayer(
            layer.id,
          )} cannot be shown while the Rectangle projection is active. Switch back to Globe first.`,
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
      this.activeModeId === "rectangle" && this.status === "preparing" &&
      this.blockingLayers().length > 0
    ) {
      this.destroy();
      this.status = "error";
      this.requestedTimeMa = this.committedTimeMa;
      this.lastError = this.toError(new AgentActionUnsupportedError(
        "Rectangle projection has incompatible visible layers.",
      ));
    }
    this.publish();
  }

  /** Cancels any in-flight work; called when the renderer is torn down. */
  destroy(): void {
    this.requestGeneration += 1;
    this.cancelTimeRequests();
    this.host.plateRenderer.cancelRectanglePreparation();
    this.cancelRenderWaiter();
    this.host.plateRenderer.cancelRectangleStaging();
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
  ): Promise<void> {
    // A newer request supersedes any render we were still waiting to confirm;
    // reject it now instead of leaving it parked on a frame that may never come.
    this.cancelRenderWaiter();
    const needsMorph = this.morphedModeId !== mode;

    if (mode === "rectangle") {
      this.host.plateRenderer.cancelRectangleStaging();
      if (needsMorph) {
        if (this.morphedModeId === "globe") {
          this.host.captureGlobeCamera();
        }
        this.host.setGlobeInertiaEnabled(false);
      }
      const handle = await this.host.plateRenderer.prepareRectangleFrame(
        ageMa,
        this.host.rotationModel,
      );
      if (generation !== this.requestGeneration) {
        throw new AgentActionBusyError("Superseded by a newer request.");
      }
      await this.host.plateRenderer.stageRectangleFrame(handle, generation);
      if (generation !== this.requestGeneration) {
        // The new epoch already cancelled this staging. Do not cancel a
        // replacement frame that may now occupy the renderer's staging slot.
        throw new AgentActionBusyError("Superseded by a newer request.");
      }
      // Final capability recheck on the *effective* visible layers, right before
      // the irreversible commit: a layer turned on while this frame warmed up
      // must abort the switch, not silently ship a mis-projected view.
      this.assertRectangleCapability();
      this.host.plateRenderer.commitRectangleFrame(generation);
      if (needsMorph) {
        this.host.viewer.scene.morphTo2D(0);
        this.morphedModeId = "rectangle";
        this.setRectangleCamera();
      }
      // Hold the committed time/counts and the host notification until a real
      // render confirms the frame, so a failed confirmation never reports a time
      // that did not actually render (and never rolls back a newer request).
      await this.awaitNextRender(generation);
      if (generation !== this.requestGeneration) {
        throw new AgentActionBusyError("Superseded before the view rendered.");
      }
      this.committedTimeMa = ageMa;
      this.committedTimeState = handle.timeState;
      this.host.onCommittedTimeChange(ageMa);
      return;
    }

    // globe
    if (needsMorph) {
      this.host.plateRenderer.cancelRectangleStaging();
      this.host.plateRenderer.restoreGlobeFrame();
      const globeCounts = this.host.applyGlobeFrame(ageMa);
      this.host.setGlobeInertiaEnabled(true);
      this.host.viewer.scene.morphTo3D(0);
      this.morphedModeId = "globe";
      this.host.restoreGlobeCamera();
      await this.awaitNextRender(generation);
      if (generation !== this.requestGeneration) {
        throw new AgentActionBusyError("Superseded before the view rendered.");
      }
      this.committedTimeMa = ageMa;
      this.committedTimeState = globeCounts;
      this.host.onCommittedTimeChange(ageMa);
      return;
    }
    // Globe fast path: the synchronous updateTime already applied the frame, so
    // there is nothing to confirm with a render.
    this.host.plateRenderer.cancelRectangleStaging();
    this.committedTimeState = this.host.applyGlobeFrame(ageMa);
    this.committedTimeMa = ageMa;
    this.host.onCommittedTimeChange(ageMa);
  }

  /** Publishes a committed view: bumps revision only when the mode changed. */
  private commitSuccess(mode: ProjectionModeId): void {
    if (this.committedId !== mode) {
      this.revision += 1;
      this.committedId = mode;
    }
    this.status = this.pendingTimeRequest ? "preparing" : "ready";
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
  private cancelRenderWaiter(): void {
    const waiter = this.renderWaiter;
    if (!waiter) {
      return;
    }
    this.renderWaiter = undefined;
    waiter.remove();
    waiter.reject(new AgentActionBusyError("Superseded before the view rendered."));
  }

  /**
   * Resolves after the next real render, or rejects if superseded, destroyed or
   * a render error fires. The waiter is stored so a new request or destroy can
   * reject it without waiting for that frame.
   */
  private awaitNextRender(generation: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const scene = this.host.viewer.scene;
      const token = {};
      let settled = false;
      let removePostRender: () => void = () => {};
      let removeRenderError: () => void = () => {};
      const settle = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
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
          reportsSceneDestroyed(scene)
        ) {
          settle(
            new AgentActionBusyError("Superseded before the view rendered."),
          );
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
          removePostRender();
          removeRenderError();
        },
      };
      scene.requestRender();
    });
  }

  private assertRectangleCapability(): void {
    const blocking = this.blockingLayers();
    if (blocking.length > 0) {
      throw new AgentActionUnsupportedError(
        `Rectangle projection cannot show: ${blocking
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
        available: false,
        projectionId: "mollweide",
        reason: "Mollweide projection is not implemented yet.",
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
