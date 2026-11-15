import { type Viewer } from "cesium";
import { AgentActionBusyError, AgentActionFailureError, AgentActionUnsupportedError, AgentActionValidationError } from "../agent-actions/registry";
import { OperationInterruptedError } from "../agent-actions/operation";
import { attachVectorLayer, VectorAttachmentError, type NativeVectorStyle, type VectorFeatureKey, type VectorLayerEffectiveState, type VectorLayerHandle, type VectorLayerKind, type VectorLayerSource } from "./vector-bindings";
import { defaultNativePointStyle, readNativePointStyle } from "./native-point-style";
import { readNativeLineStyle } from "./native-line-style";
import { readNativePolygonStyle } from "./native-polygon-style";
import { redactSensitive } from "../agent-actions/types";

export interface NativePointLayerSnapshot {
  layerId: number;
  runtimeStatus: "loading" | "ready" | "error" | "removing" | "unloaded";
  runtimeError?: string;
  cleanupPending: boolean;
}
export interface NativePointLayerRuntimeOptions {
  readEffectiveState(layerId: number): { visible: boolean; opacity: number; style?: NativeVectorStyle } | undefined;
  onStateChange(): void;
  onDiagnostic(error: unknown, context: { layerId: number; phase: string; featureId?: string }): void | Promise<void>;
  timeoutMs?: number;
}

type EffectiveState = VectorLayerEffectiveState;

function sameStyle(first: NativeVectorStyle, second: NativeVectorStyle): boolean {
  if ("singleColor" in first && "singleColor" in second) return first.singleColor === second.singleColor && first.pointSize === second.pointSize;
  if ("fillColor" in first && "fillColor" in second) return first.fillColor === second.fillColor && first.outlineColor === second.outlineColor && first.outlineWidth === second.outlineWidth;
  return "lineColor" in first && "lineColor" in second && first.lineColor === second.lineColor && first.lineWidth === second.lineWidth;
}

interface Entry {
  layerId: number;
  kind: VectorLayerKind;
  status: NativePointLayerSnapshot["runtimeStatus"];
  error?: string;
  handle?: VectorLayerHandle;
  cleanupHandle?: Pick<VectorLayerHandle, "dispose" | "isDetached">;
  isDetached?: () => boolean;
  cleanupPending: boolean;
  cleanupError?: unknown;
  activated: boolean;
  confirmed: boolean;
  recovered: boolean;
  controller: AbortController;
  addTask?: Promise<NativePointLayerSnapshot>;
  removeTask?: Promise<void>;
  stopFrame?: (error: unknown) => void;
  effective?: EffectiveState;
  revision: number;
}

/** Main-viewer ordinary vector ownership; business records and GPU points remain caller-owned. */
export class NativePointLayerRuntime {
  private readonly entries = new Map<number, Entry>();
  private readonly timeoutMs: number;
  private disposed = false;
  private disposal?: Promise<void>;

  constructor(private readonly viewer: Viewer, private readonly options: NativePointLayerRuntimeOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 30_000) {
      throw new AgentActionValidationError("Native vector frame timeout must be within (0, 30000] milliseconds.");
    }
  }

  async add(layerId: number, source: VectorLayerSource, signal?: AbortSignal): Promise<NativePointLayerSnapshot> {
    this.assertOpen();
    if (!Number.isSafeInteger(layerId) || layerId <= 0) throw new AgentActionValidationError("layerId must be a positive safe integer.");
    if (this.entries.has(layerId)) throw new AgentActionBusyError("Remove the existing native vector runtime before adding this layer again.");
    if (signal?.aborted) throw this.interruption(signal);
    const kind = source?.kind === undefined ? "point" : source.kind;
    if (kind !== "point" && kind !== "line" && kind !== "polygon") throw new AgentActionUnsupportedError("Unsupported native vector source kind.");
    const entry: Entry = { layerId, kind, status: "loading", cleanupPending: false, activated: false,
      confirmed: false, recovered: false, controller: new AbortController(), revision: 0 };
    this.readEffective(entry);
    this.entries.set(layerId, entry);
    // Install ownership before invoking callbacks, including reentrant remove/dispose.
    entry.addTask = Promise.resolve().then(() => this.install(entry, source, signal));
    this.publish(entry);
    return entry.addTask;
  }

  /** Applies business state only. A pending add still waits for a matching native frame. */
  apply(layerId: number): void {
    this.assertOpen();
    const entry = this.require(layerId);
    if (entry.cleanupPending || entry.status === "removing") throw new AgentActionBusyError("Native vector cleanup is still pending.");
    if (!entry.handle) return;
    try { this.applyEffective(entry); }
    catch (error) {
      entry.status = "error"; entry.error = "Native vector state could not be applied.";
      entry.stopFrame?.(error); this.diagnose(entry, error, "frame"); this.publish(entry); throw error;
    }
  }

  async remove(layerId: number): Promise<void> {
    const entry = this.require(layerId);
    if (entry.removeTask) return entry.removeTask;
    let resolve!: () => void, reject!: (error: unknown) => void;
    entry.removeTask = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const task = entry.removeTask;
    void this.removeEntry(entry).then(resolve, reject).then(() => { if (entry.removeTask === task) entry.removeTask = undefined; });
    return task;
  }

  /** Teardown needs no new rendered frame; failed cleanup owners survive for another dispose(). */
  async dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    // Native removal observers may synchronously call dispose again.
    const task = Promise.resolve().then(() => this.disposeEntries());
    this.disposal = task;
    try { await task; } finally { if (this.disposal === task) this.disposal = undefined; }
  }

  private async disposeEntries(): Promise<void> {
    const entries = [...this.entries.values()];
    const errors: unknown[] = [];
    for (const entry of entries) {
      const retryCleanup = entry.cleanupPending;
      entry.controller.abort(new OperationInterruptedError("cancelled", "The native vector runtime was disposed."));
      entry.stopFrame?.(new OperationInterruptedError("cancelled"));
      // An abort handler may already have attempted cleanup; do not silently retry its failure.
      // A failure retained from an earlier explicit dispose is eligible for this retry.
      if (!entry.cleanupPending || retryCleanup) {
        try { this.release(entry); } catch (error) { errors.push(error); }
      } else errors.push(entry.cleanupError);
      if (entry.cleanupPending) {
        entry.status = "error"; entry.error = "Native vector cleanup failed; retry disposal.";
        this.diagnose(entry, entry.cleanupError, "cleanup"); this.publish(entry);
      }
    }
    await Promise.allSettled(entries.flatMap(entry => [entry.addTask, entry.removeTask].filter((value): value is Promise<NativePointLayerSnapshot> | Promise<void> => value !== undefined)));
    for (const entry of entries) {
      if (entry.cleanupPending) {
        if (!errors.includes(entry.cleanupError)) errors.push(entry.cleanupError);
      } else if (this.entries.get(entry.layerId) === entry) this.entries.delete(entry.layerId);
    }
    if (errors.length) throw new AggregateError(errors, "Native vector runtime cleanup failed.");
  }

  get(layerId: number): NativePointLayerSnapshot | undefined {
    const entry = this.entries.get(layerId);
    return entry && { layerId, runtimeStatus: entry.status, cleanupPending: entry.cleanupPending,
      ...(entry.error ? { runtimeError: entry.error } : {}) };
  }
  getSnapshot(): NativePointLayerSnapshot[] { return [...this.entries.keys()].map(id => this.get(id)!); }
  getAttributes(layerId: number, featureId: string): Record<string, unknown> | null | undefined {
    const entry = this.require(layerId);
    if (entry.status !== "ready" || !entry.handle) throw new AgentActionBusyError("Native vector attributes are unavailable until the layer is ready.");
    return entry.handle.getAttributes(featureId);
  }
  resolvePick(picked: unknown): VectorFeatureKey | undefined {
    for (const entry of this.entries.values()) {
      if (entry.status !== "ready") continue;
      const key = entry.handle?.resolvePick(picked);
      if (key) return key;
    }
    return undefined;
  }

  private async install(entry: Entry, source: VectorLayerSource, signal?: AbortSignal): Promise<NativePointLayerSnapshot> {
    const cancel = () => { if (!entry.confirmed) entry.controller.abort(signal ? this.interruption(signal) : new OperationInterruptedError("cancelled")); };
    const releaseOnAbort = () => {
      if (entry.confirmed || entry.cleanupPending) return;
      try { this.release(entry); } catch (error) { this.diagnose(entry, error, "cleanup"); }
    };
    signal?.addEventListener("abort", cancel, { once: true });
    entry.controller.signal.addEventListener("abort", releaseOnAbort, { once: true });
    try {
      if (signal?.aborted) cancel();
      this.assertOwner(entry, true);
      entry.handle = await attachVectorLayer(this.viewer, entry.layerId, source, entry.controller.signal);
      entry.isDetached = entry.handle.isDetached.bind(entry.handle);
      entry.activated = true;
      this.assertOwner(entry, true);
      this.applyEffective(entry);
      await this.waitForFrame(entry, false);
      // Confirmation already owns the successful frame; later removal must not change its result.
      if (entry.status !== "removing" && !this.disposed) { entry.status = "ready"; entry.error = undefined; this.publish(entry); }
      return { layerId: entry.layerId, runtimeStatus: "ready", cleanupPending: false };
    } catch (failure) {
      let error = failure;
      if (failure instanceof VectorAttachmentError) {
        entry.cleanupHandle = failure.cleanupHandle; entry.cleanupPending = true; entry.cleanupError = failure;
        entry.isDetached = failure.cleanupHandle.isDetached.bind(failure.cleanupHandle);
      } else if (!entry.cleanupPending) {
        try { this.release(entry); } catch (cleanupError) { error = new AggregateError([error, cleanupError], "Native vector loading and cleanup failed."); }
      }
      if (entry.cleanupPending) {
        if (error !== entry.cleanupError) error = new AggregateError([error, entry.cleanupError], "Native vector loading and cleanup failed.");
        this.diagnose(entry, entry.cleanupError, "cleanup");
      } else if (entry.activated && !this.disposed && !this.viewer.scene.isDestroyed()) {
        try { await this.waitForFrame(entry, true); entry.recovered = true; }
        catch (recoveryError) {
          error = new AggregateError([error, recoveryError], "Native vector loading failed and its cleanup frame was not confirmed.");
          this.diagnose(entry, recoveryError, "recovery");
        }
      }
      if (entry.status !== "removing") {
        entry.status = "error";
        entry.error = entry.cleanupPending ? "Native vector cleanup failed; retry removal." : "Native vector loading did not complete.";
        this.publish(entry);
      }
      this.diagnose(entry, error, entry.activated ? "frame" : "attach");
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancel);
      entry.controller.signal.removeEventListener("abort", releaseOnAbort);
    }
  }

  private async removeEntry(entry: Entry): Promise<void> {
    const loading = entry.status === "loading" && !entry.confirmed;
    entry.status = "removing"; entry.error = undefined;
    try {
      if (loading) entry.controller.abort(new OperationInterruptedError("superseded", "The native vector layer was removed."));
      else this.release(entry);
      this.publish(entry);
      await entry.addTask?.catch(() => undefined);
      if (entry.cleanupPending) throw entry.cleanupError;
      if (!this.disposed && !this.viewer.scene.isDestroyed() && !(loading && entry.recovered)) await this.waitForFrame(entry, true);
      if (this.entries.get(entry.layerId) === entry) this.entries.delete(entry.layerId);
      this.publish(entry);
    } catch (error) {
      entry.status = "error";
      entry.error = entry.cleanupPending ? "Native vector cleanup failed; retry removal." : "Native vector removal frame was not confirmed; retry removal.";
      this.diagnose(entry, error, entry.cleanupPending ? "cleanup" : "recovery"); this.publish(entry); throw error;
    }
  }

  private release(entry: Entry): void {
    const handle = entry.cleanupHandle ?? entry.handle;
    if (!handle) return;
    entry.isDetached = handle.isDetached.bind(handle);
    try {
      handle.dispose();
      if (!handle.isDetached()) throw new Error("Native vector cleanup has not detached its owner.");
    }
    catch (error) { entry.cleanupPending = true; entry.cleanupError = error; throw error; }
    entry.handle = undefined; entry.cleanupHandle = undefined; entry.cleanupPending = false; entry.cleanupError = undefined;
  }

  private readEffective(entry: Entry): EffectiveState {
    const state = this.options.readEffectiveState(entry.layerId);
    if (!state) throw new OperationInterruptedError("superseded", "The native vector business record no longer exists.");
    if (typeof state.visible !== "boolean" || !Number.isFinite(state.opacity) || state.opacity < 0 || state.opacity > 1) {
      throw new AgentActionValidationError("Effective vector visibility/opacity is invalid.");
    }
    const style = entry.kind === "polygon" ? readNativePolygonStyle(state.style) : entry.kind === "line" ? readNativeLineStyle(state.style)
      : state.style === undefined ? readNativePointStyle(undefined) : readNativePointStyle({ ...defaultNativePointStyle(), ...state.style });
    return { visible: state.visible, opacity: state.opacity, style };
  }
  private applyEffective(entry: Entry): void {
    const state = this.readEffective(entry);
    if (!entry.handle) return;
    if (!entry.effective || entry.effective.visible !== state.visible || entry.effective.opacity !== state.opacity ||
      !sameStyle(entry.effective.style, state.style)) {
      // Native setters can mutate before an observer throws. The old cache then
      // no longer describes the renderer; a business rollback must rewrite it.
      entry.effective = undefined;
      entry.handle.setStyle(state.style); entry.handle.setOpacity(state.opacity); entry.handle.setVisible(state.visible);
      entry.effective = state; entry.revision++;
    }
  }
  private matches(entry: Entry): boolean {
    const state = this.readEffective(entry), time = this.viewer.clock.currentTime;
    return Boolean(entry.handle && entry.effective?.visible === state.visible && entry.effective.opacity === state.opacity &&
      sameStyle(entry.effective.style, state.style) && entry.handle.matches(state, time));
  }

  /** Fresh visualizer/fill readiness precedes the native frame. Direct Point/Line collections and polygon
   * boundaries update synchronously in Scene; postRender alone is never readiness. */
  private waitForFrame(entry: Entry, removed: boolean): Promise<void> {
    const scene = this.viewer.scene;
    return new Promise((resolve, reject) => {
      let settled = false, armed = false, ready = false, confirming = false, revision = -1;
      const removers: Array<() => void> = [];
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (entry.stopFrame === finish) entry.stopFrame = undefined;
        const errors: unknown[] = [];
        for (const remove of removers) { try { remove(); } catch (failure) { errors.push(failure); } }
        if (errors.length) reject(new AggregateError(error === undefined ? errors : [error, ...errors], "Native vector frame listener cleanup failed."));
        else if (error !== undefined) reject(error);
        else { if (!removed) entry.confirmed = true; resolve(); }
      };
      const check = () => {
        this.assertOwner(entry, !removed);
        if (!removed && !entry.handle?.isAttached()) {
          throw new OperationInterruptedError("superseded", "The native vector owner was detached before its frame.");
        }
        if (removed && (entry.cleanupPending || entry.handle || entry.cleanupHandle ||
          entry.isDetached?.() === false)) throw new Error("Native vector cleanup is incomplete.");
      };
      const abort = () => { try { check(); } catch (error) { finish(error); } };
      entry.stopFrame = finish;
      try {
        check();
        removers.push(scene.preRender.addEventListener(() => {
          if (settled || !armed) return;
          try {
            check(); ready = false;
            if (!removed) this.applyEffective(entry);
            if (!removed) entry.handle?.prepareFrame();
            // ready is latched by Cesium; the update return value is the current result.
            ready = this.viewer.dataSourceDisplay.update(this.viewer.clock.currentTime) && (removed || this.matches(entry));
            revision = entry.revision;
            if (!ready) scene.requestRender();
          } catch (error) { finish(error); }
        }));
        removers.push(scene.postRender.addEventListener(() => {
          if (settled || !armed || !ready || confirming) return;
          confirming = true;
          // renderError can still follow postRender in this same stack.
          void Promise.resolve().then(() => {
            if (settled) return;
            try {
              check();
              if (!removed && (revision !== entry.revision || !this.matches(entry))) {
                ready = false; confirming = false; scene.requestRender(); return;
              }
              finish();
            } catch (error) { finish(error); }
          });
        }));
        removers.push(scene.renderError.addEventListener((_scene, error) => finish(error instanceof Error ? error : new Error("Native vector rendering failed."))));
        if (!removed) {
          entry.controller.signal.addEventListener("abort", abort, { once: true });
          removers.push(() => entry.controller.signal.removeEventListener("abort", abort));
        }
        timer = setTimeout(() => finish(new Error("Native vector frame timed out.")), this.timeoutMs);
        // In recovery, the failed frame may still emit postRender and stop the loop.
        void Promise.resolve().then(() => {
          if (settled) return;
          try {
            check(); armed = true;
            if (this.viewer.useDefaultRenderLoop === false) this.viewer.useDefaultRenderLoop = true;
            scene.requestRender();
          } catch (error) { finish(error); }
        });
      } catch (error) { finish(error); }
    });
  }

  private require(layerId: number): Entry {
    const entry = this.entries.get(layerId);
    if (!entry) throw new AgentActionValidationError("Unknown native vector layer ID.");
    return entry;
  }
  private assertOpen(): void { if (this.disposed) throw new OperationInterruptedError("cancelled", "The native vector runtime was disposed."); }
  private assertOwner(entry: Entry, cancellable: boolean): void {
    this.assertOpen();
    if (this.viewer.scene.isDestroyed() || this.viewer.dataSources.isDestroyed()) throw new OperationInterruptedError("cancelled", "The native vector viewer was disposed.");
    if (this.entries.get(entry.layerId) !== entry) throw new OperationInterruptedError("superseded");
    if (cancellable && entry.controller.signal.aborted) throw this.interruption(entry.controller.signal);
  }
  private interruption(signal: AbortSignal): OperationInterruptedError {
    return signal.reason instanceof OperationInterruptedError ? signal.reason : new OperationInterruptedError("cancelled");
  }
  private diagnose(entry: Entry, error: unknown, phase: string): void {
    try {
      const raw = error instanceof AgentActionFailureError ? Object.getOwnPropertyDescriptor(error, "featureId")?.value : undefined;
      const safe = typeof raw === "string" ? redactSensitive(raw) : undefined;
      const featureId = typeof safe === "string" && new TextEncoder().encode(safe).length <= 256 ? safe : undefined;
      void Promise.resolve(this.options.onDiagnostic(error, { layerId: entry.layerId, phase, ...(featureId === undefined ? {} : { featureId }) })).catch(() => undefined);
    } catch { /* Diagnostics never alter layer ownership. */ }
  }
  private publish(entry: Entry): void {
    try { void Promise.resolve(this.options.onStateChange()).catch(error => this.diagnose(entry, error, "observer")); }
    catch (error) { this.diagnose(entry, error, "observer"); }
  }
}
