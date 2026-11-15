// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { Event as CesiumEvent } from "cesium";
import { DiagnosticsLogger } from "../diagnostics/logger";
import { installRuntimeErrorDiagnostics } from "../diagnostics/runtime-errors";

const disposals: Array<() => void> = [];
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); });
function setup(logger = new DiagnosticsLogger({ bootId: "boot-runtime-errors", appVersion: "test" })) {
  const target = new EventTarget();
  const diagnostics = installRuntimeErrorDiagnostics(target, logger);
  disposals.push(() => diagnostics.dispose());
  return { target, logger, diagnostics };
}
function rejection(reason: unknown): Event {
  // jsdom has no PromiseRejectionEvent constructor. Dispatch a real DOM Event
  // carrying only that browser event's reason field; no rejected Promise is run.
  return Object.defineProperty(new Event("unhandledrejection", { cancelable: true }), "reason", { value: reason });
}

describe("runtime error diagnostics", () => {
  it("records real DOM and Cesium events through the real logger without suppressing native behavior", () => {
    const { target, logger, diagnostics } = setup();
    const renderError = new CesiumEvent();
    diagnostics.observeRenderErrors({ renderError }, "main");
    const appError = new ErrorEvent("error", { error: new Error("script failure"), cancelable: true });
    const rejected = rejection(new Error("promise failure"));
    const otherListener = vi.fn();
    target.addEventListener("error", otherListener);
    expect(target.dispatchEvent(appError)).toBe(true);
    expect(target.dispatchEvent(rejected)).toBe(true);
    renderError.raiseEvent({ useDefaultRenderLoop: false }, new Error("render failure"));
    expect(appError.defaultPrevented).toBe(false);
    expect(rejected.defaultPrevented).toBe(false);
    expect(otherListener).toHaveBeenCalledOnce();
    expect(logger.query().entries.map(row => [row.event, row.category, row.viewportId])).toEqual([
      ["app.error", "app", undefined], ["app.unhandled-rejection", "app", undefined], ["render.error", "render", "main"],
    ]);
    expect(logger.query().entries.every(row => row.level === "error" && row.outcome === "failed")).toBe(true);
    expect(logger.query().entries[0]!.error?.message).toBe("script failure");
  });

  it.each(["render", "global"] as const)("deduplicates the same Error across channels with %s observed first", first => {
    const { target, logger, diagnostics } = setup();
    const renderError = new CesiumEvent();
    diagnostics.observeRenderErrors(renderError, "viewport-a");
    const error = new Error("same text, distinct identities matter");
    const global = () => target.dispatchEvent(new ErrorEvent("error", { error }));
    const render = () => renderError.raiseEvent(undefined, error);
    if (first === "render") { render(); global(); } else { global(); render(); }
    target.dispatchEvent(rejection(error));
    expect(logger.query().entries).toHaveLength(1);
    expect(logger.query().entries[0]!.event).toBe(first === "render" ? "render.error" : "app.error");
    target.dispatchEvent(new ErrorEvent("error", { error: new Error(error.message) }));
    expect(logger.query().entries).toHaveLength(2);
  });

  it("uses existing redaction for Error fields without copying URLs, params or arbitrary object bodies", () => {
    const { target, logger, diagnostics } = setup();
    const renderError = new CesiumEvent();
    diagnostics.observeRenderErrors(renderError, "main");
    const error = Object.assign(new Error('token=SYNTHETIC_TOKEN password=SYNTHETIC_PASSWORD https://example.invalid/private/SYNTHETIC_PATH?signature=SYNTHETIC_SIGNATURE {"body":"SYNTHETIC_JSON"}'), {
      params: { account: "SYNTHETIC_PARAMS" }, body: "SYNTHETIC_BODY",
    });
    error.stack = "at https://example.invalid/SYNTHETIC_SCRIPT?key=SYNTHETIC_QUERY";
    renderError.raiseEvent({}, error);
    target.dispatchEvent(new ErrorEvent("error", {
      error: null, message: "SYNTHETIC_EVENT_MESSAGE", filename: "https://example.invalid/SYNTHETIC_FILENAME?token=SYNTHETIC_FILENAME_TOKEN",
    }));
    target.dispatchEvent(rejection("SYNTHETIC_REJECT_STRING"));
    const getter = vi.fn(() => { throw new Error("SYNTHETIC_GETTER"); });
    const body = Object.defineProperty({ token: "SYNTHETIC_OBJECT", file: new Blob(["SYNTHETIC_FILE"]) }, "message", { get: getter });
    target.dispatchEvent(rejection(body));
    const exported = logger.export();
    expect(logger.query().entries).toHaveLength(4);
    expect(exported).not.toMatch(/SYNTHETIC_|https:\/\/|"params"|"body"/);
    expect(exported).toContain("[redacted]");
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not inspect rejection objects, getters, cycles or string conversion hooks", () => {
    const { target, logger } = setup();
    const inspect = vi.fn(() => { throw new Error("must not inspect"); });
    const reason: Record<string, unknown> = { toString: inspect, toJSON: inspect };
    reason.self = reason;
    Object.defineProperty(reason, "stack", { get: inspect });
    Object.defineProperty(reason, "message", { get: inspect });
    expect(() => target.dispatchEvent(rejection(reason))).not.toThrow();
    expect(inspect).not.toHaveBeenCalled();
    expect(logger.query().entries).toHaveLength(1);
    expect(logger.query().entries[0]!.error?.message).toContain("without an Error object");
  });

  it("unsubscribes real render listeners and disposes global listeners idempotently", () => {
    const { target, logger, diagnostics } = setup();
    const a = new CesiumEvent(); const b = new CesiumEvent();
    const stopA = diagnostics.observeRenderErrors({ renderError: a }, "a");
    diagnostics.observeRenderErrors(b, "b");
    expect(a.numberOfListeners).toBe(1);
    expect(b.numberOfListeners).toBe(1);
    stopA(); stopA();
    expect(a.numberOfListeners).toBe(0);
    a.raiseEvent({}, new Error("already unsubscribed"));
    b.raiseEvent({}, new Error("still active"));
    target.dispatchEvent(new ErrorEvent("error", { error: new Error("global active") }));
    expect(logger.query().entries).toHaveLength(2);
    diagnostics.dispose(); diagnostics.dispose(); stopA();
    expect(b.numberOfListeners).toBe(0);
    target.dispatchEvent(new ErrorEvent("error", { error: new Error("closed") }));
    target.dispatchEvent(rejection(new Error("closed")));
    b.raiseEvent({}, new Error("closed"));
    expect(logger.query().entries).toHaveLength(2);
    const late = new CesiumEvent();
    expect(() => diagnostics.observeRenderErrors(late, "late")).toThrow(/disposed/i);
    expect(late.numberOfListeners).toBe(0);
  });

  it("contains logger failures so later application listeners still run", () => {
    class FailingLogger extends DiagnosticsLogger {
      override record(): undefined { throw new Error("synthetic logger failure"); }
    }
    const { target, diagnostics } = setup(new FailingLogger({ bootId: "fault", appVersion: "test" }));
    const renderError = new CesiumEvent();
    diagnostics.observeRenderErrors(renderError, "main");
    const laterGlobal = vi.fn(); const laterRender = vi.fn();
    target.addEventListener("error", laterGlobal);
    renderError.addEventListener(laterRender);
    expect(() => target.dispatchEvent(new ErrorEvent("error", { error: new Error("source") }))).not.toThrow();
    expect(() => target.dispatchEvent(rejection(new Error("source")))).not.toThrow();
    expect(() => renderError.raiseEvent({}, new Error("source"))).not.toThrow();
    expect(laterGlobal).toHaveBeenCalledOnce();
    expect(laterRender).toHaveBeenCalledOnce();
  });

  it.each(["dispose", "unsubscribe"] as const)("isolates a failing native remover during %s and still cleans other listeners", mode => {
    const { target, logger, diagnostics } = setup();
    const a = new CesiumEvent(); const b = new CesiumEvent();
    let removals = 0;
    const stopA = diagnostics.observeRenderErrors({ addEventListener: listener => {
      const remove = a.addEventListener(listener);
      return () => { removals++; remove(); throw new Error("synthetic removal failure"); };
    } }, "a");
    diagnostics.observeRenderErrors(b, "b");
    expect([a.numberOfListeners, b.numberOfListeners]).toEqual([1, 1]);
    if (mode === "unsubscribe") {
      expect(() => stopA()).not.toThrow();
      expect(() => stopA()).not.toThrow();
      expect(b.numberOfListeners).toBe(1);
    }
    expect(() => diagnostics.dispose()).not.toThrow();
    expect(() => diagnostics.dispose()).not.toThrow();
    expect(removals).toBe(1);
    expect([a.numberOfListeners, b.numberOfListeners]).toEqual([0, 0]);
    target.dispatchEvent(new ErrorEvent("error", { error: new Error("closed") }));
    expect(logger.query().entries).toEqual([]);
  });

  it("silences an unsubscribed callback even if its native remover fails before detaching", () => {
    const { logger, diagnostics } = setup();
    const event = new CesiumEvent();
    let removeNative = () => {};
    const stop = diagnostics.observeRenderErrors({ addEventListener: listener => {
      removeNative = event.addEventListener(listener);
      return () => { throw new Error("synthetic pre-removal failure"); };
    } }, "main");
    try {
      expect(() => stop()).not.toThrow();
      event.raiseEvent({}, new Error("must no longer be observed"));
      expect(logger.query().entries).toEqual([]);
    } finally { removeNative(); }
  });

  it("deduplicates before recording even when a synchronous sink re-emits the Error", () => {
    const target = new EventTarget();
    const error = new Error("one cause");
    const logger = new DiagnosticsLogger({ bootId: "reentrant", appVersion: "test", sink: () => {
      target.dispatchEvent(new ErrorEvent("error", { error }));
    } });
    const diagnostics = installRuntimeErrorDiagnostics(target, logger);
    disposals.push(() => diagnostics.dispose());
    target.dispatchEvent(new ErrorEvent("error", { error }));
    expect(logger.query().entries).toHaveLength(1);
  });

  it("uses the logger's asynchronous sink isolation without creating another error stream", async () => {
    const { target, logger } = setup(new DiagnosticsLogger({ bootId: "async-sink", appVersion: "test", sink: async () => { throw new Error("synthetic sink failure"); } }));
    target.dispatchEvent(new ErrorEvent("error", { error: new Error("original") }));
    await Promise.resolve(); await Promise.resolve();
    expect(logger.query()).toMatchObject({ retainedCount: 1, sinkErrorCount: 1 });
    expect(logger.export()).not.toContain("synthetic sink failure");
  });
});
