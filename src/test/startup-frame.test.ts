import { afterEach, describe, expect, it, vi } from "vitest";
import { confirmStartupView, type StartupViewState } from "../startup/confirm-startup-view";

class Event<T extends unknown[]> {
  listeners = new Set<(...args: T) => void>();
  addEventListener(listener: (...args: T) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(...args: T) { for (const listener of [...this.listeners]) listener(...args); }
}
function harness() {
  const scene = { postRender: new Event<[]>(), renderError: new Event<[unknown, unknown]>(), requestRender: vi.fn(), isDestroyed: () => false };
  let state: StartupViewState = { status: "ready", committedId: "globe", committedTimeMa: 100, revision: 0 };
  const prepare = vi.fn();
  const abort = new AbortController();
  const result: { status: string; error?: unknown } = { status: "pending" };
  const promise = confirmStartupView(scene, () => state, prepare, abort.signal);
  void promise.then(() => { result.status = "ready"; }, error => { result.status = "error"; result.error = error; });
  return { scene, prepare, abort, promise, result, update: (patch: Partial<StartupViewState>) => { state = { ...state, ...patch }; } };
}
async function tick() { await Promise.resolve(); await Promise.resolve(); }
afterEach(() => vi.useRealTimers());

describe("startup core view confirmation", () => {
  it("applies initial attributes after native update and requires the following rendered frame", async () => {
    const h = harness();
    await tick();
    expect(h.result.status).toBe("pending");
    h.scene.postRender.emit(); await tick();
    expect(h.prepare).toHaveBeenCalledWith(expect.objectContaining({ committedTimeMa: 100 }));
    expect(h.result.status).toBe("pending");
    h.scene.postRender.emit(); await h.promise;
    expect(h.result.status).toBe("ready");
    expect(h.scene.postRender.listeners.size).toBe(0);
    expect(h.scene.renderError.listeners.size).toBe(0);
  });

  it.each(["globe", "rectangle"] as const)("follows early replacement by %s without owning or resubmitting a time request", async mode => {
    const h = harness();
    h.scene.postRender.emit();
    h.update({ status: "preparing" }); h.scene.postRender.emit();
    await tick(); expect(h.result.status).toBe("pending");
    h.update({ status: "ready", committedId: mode, committedTimeMa: 200, revision: 1 });
    h.scene.postRender.emit(); await tick();
    expect(h.result.status).toBe("pending");
    h.scene.postRender.emit(); await h.promise;
    expect(h.prepare).toHaveBeenLastCalledWith(expect.objectContaining({ committedId: mode, committedTimeMa: 200 }));
  });

  it("does not confirm a frame when applying its attributes synchronously changes the view", async () => {
    const h = harness();
    h.prepare.mockImplementationOnce(() => h.update({ status: "preparing" }));
    h.scene.postRender.emit(); h.scene.postRender.emit(); await tick();
    expect(h.result.status).toBe("pending");
    h.update({ status: "ready", committedTimeMa: 300 });
    h.scene.postRender.emit(); h.scene.postRender.emit(); await h.promise;
    expect(h.result.status).toBe("ready");
  });

  it("does not continue confirmation after synchronous render failure during attribute preparation", async () => {
    const h = harness();
    h.prepare.mockImplementationOnce(() => h.scene.renderError.emit(h.scene, new Error("Synthetic preparation render failed")));
    h.scene.postRender.emit(); await tick();
    expect(h.result.status).toBe("error");
    expect(h.scene.requestRender).toHaveBeenCalledTimes(1);
    expect(h.scene.postRender.listeners.size).toBe(0);
    expect(h.scene.renderError.listeners.size).toBe(0);
  });

  it.each(["render", "projection", "abort", "timeout"])("settles and removes listeners on %s failure", async fault => {
    vi.useFakeTimers();
    const h = harness();
    if (fault === "render") h.scene.renderError.emit(h.scene, new Error("Synthetic render failed"));
    if (fault === "projection") { h.update({ status: "error", lastError: { message: "Synthetic view failed" } }); h.scene.postRender.emit(); }
    if (fault === "abort") h.abort.abort();
    if (fault === "timeout") await vi.advanceTimersByTimeAsync(30_000);
    await tick();
    expect(h.result.status).toBe("error");
    expect(h.scene.postRender.listeners.size).toBe(0);
    expect(h.scene.renderError.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
