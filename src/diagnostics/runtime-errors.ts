import type { DiagnosticsLogger, LogCategory } from "./logger";

/** The public Cesium Event surface; importing this helper does not load Cesium. */
export interface RenderErrorEvent {
  addEventListener(listener: (scene: unknown, error: unknown) => void): () => void;
}
export interface RuntimeErrorDiagnostics {
  observeRenderErrors(source: RenderErrorEvent | { renderError: RenderErrorEvent }, viewportId: string): () => void;
  dispose(): void;
}

/** Local diagnostics only. The caller owns page/BFCache and scene lifetimes. */
export function installRuntimeErrorDiagnostics(
  target: EventTarget,
  logger: Pick<DiagnosticsLogger, "record">,
): RuntimeErrorDiagnostics {
  const seen = new WeakSet<object>();
  const renderStops = new Set<() => void>();
  let disposed = false;

  const record = (event: string, category: LogCategory, errorCode: string, reason: unknown, viewportId?: string): void => {
    if (disposed) return;
    if ((typeof reason === "object" && reason !== null) || typeof reason === "function") {
      if (seen.has(reason)) return;
      // Mark before logging: an observer/sink can synchronously re-emit it.
      seen.add(reason);
    }
    let isError = false;
    try { isError = reason instanceof Error; }
    catch { /* An arbitrary rejection may be a hostile proxy. Do not inspect it. */ }
    try {
      logger.record({ level: "error", category, event, outcome: "failed", errorCode,
        // The existing logger reads/redacts only Error's allowed own data
        // fields. Non-Error strings/objects are never stringified or traversed.
        error: isError ? reason : { message: "A runtime error without an Error object was observed." },
      }, viewportId === undefined ? {} : { viewportId });
    } catch { /* Diagnostics must not raise a second application failure. */ }
  };

  const onError = (event: Event): void => {
    let reason: unknown;
    try { reason = (event as ErrorEvent).error; }
    catch { /* Keep a fixed summary if even the event payload is unreadable. */ }
    // Never read ErrorEvent.message, filename, line/column or its DOM target.
    record("app.error", "app", "UNCAUGHT_ERROR", reason);
  };
  const onUnhandledRejection = (event: Event): void => {
    let reason: unknown;
    try { reason = (event as PromiseRejectionEvent).reason; }
    catch { /* Do not serialize arbitrary event/rejection objects. */ }
    record("app.unhandled-rejection", "app", "UNHANDLED_REJECTION", reason);
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onUnhandledRejection);

  return {
    observeRenderErrors(source, viewportId) {
      if (disposed) throw new Error("Runtime error diagnostics are disposed.");
      const event = "renderError" in source ? source.renderError : source;
      let stopped = false;
      const remove = event.addEventListener((_scene, error) => {
        if (!stopped) record("render.error", "render", "RENDER_ERROR", error, viewportId);
      });
      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        renderStops.delete(stop);
        try { remove(); }
        catch { /* A broken native remover must not stop other cleanup or business code. */ }
      };
      renderStops.add(stop);
      return stop;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      target.removeEventListener("error", onError);
      target.removeEventListener("unhandledrejection", onUnhandledRejection);
      for (const stop of [...renderStops]) stop();
    },
  };
}
