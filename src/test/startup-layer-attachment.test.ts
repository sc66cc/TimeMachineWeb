import { afterEach, describe, expect, it, vi } from "vitest";
import { attachOptionalLayer } from "../startup/attach-optional-layer";
import { confirmStartupView, type StartupViewState } from "../startup/confirm-startup-view";

class Event<T extends unknown[]> {
  listeners = new Set<(...args: T) => void>();
  addEventListener(listener: (...args: T) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  emit(...args: T) { for (const listener of [...this.listeners]) listener(...args); }
}
function boundary() {
  const settled = new Event<[]>();
  const abort = new AbortController();
  let preparing = true;
  return {
    settled, abort, setPreparing: (value: boolean) => { preparing = value; },
    options: { isPreparing: () => preparing, onSettled: (listener: () => void) => settled.addEventListener(listener), signal: abort.signal },
  };
}
async function tick() { await Promise.resolve(); await Promise.resolve(); }
afterEach(() => vi.useRealTimers());

describe("optional layer attachment at a settled view boundary", () => {
  it("keeps a late manifest from invalidating the frame needed by core startup", async () => {
    const b = boundary();
    const scene = { postRender: new Event<[]>(), renderError: new Event<[unknown, unknown]>(), requestRender() {}, isDestroyed: () => false };
    let state: StartupViewState = { status: "preparing", committedId: "globe", committedTimeMa: 0, revision: 0 };
    let installed = false;
    const startup = confirmStartupView(scene, () => state, () => {});
    void startup.catch(() => undefined);
    const attachment = attachOptionalLayer(b.options, () => {
      installed = true;
      // Adding a participant to the current frame invalidates its captured resources.
      if (state.status === "preparing") state = { ...state, status: "error", lastError: { message: "Participants changed" } };
    });
    await tick();
    expect(installed).toBe(false);
    scene.postRender.emit();
    state = { ...state, status: "ready", committedTimeMa: 100 };
    b.setPreparing(false); b.settled.emit();
    await attachment;
    scene.postRender.emit(); scene.postRender.emit();
    await startup;
    expect(installed).toBe(true);
    expect(state.status).toBe("ready");
    expect(state.committedTimeMa).toBe(100);
    expect(b.settled.listeners.size).toBe(0);
  });

  it("attaches between committed frames even when a later time is pending", async () => {
    const b = boundary();
    let committedAge = 0;
    const installedAges: number[] = [];
    const attachment = attachOptionalLayer(b.options, () => installedAges.push(committedAge));
    await tick(); expect(installedAges).toEqual([]);
    committedAge = 100;
    // The controller is still preparing because its next input is queued.
    b.settled.emit();
    await attachment;
    committedAge = 200; b.settled.emit();
    expect(installedAges).toEqual([100]);
  });

  it("cancels deferred installation on page disposal and removes its waiter", async () => {
    const b = boundary(); let installed = false;
    const attachment = attachOptionalLayer(b.options, () => { installed = true; });
    const result = attachment.then(() => undefined, error => error);
    await tick(); b.abort.abort();
    expect(await result).toBeInstanceOf(Error);
    expect((await result).message).toMatch(/cancelled/);
    b.setPreparing(false); b.settled.emit();
    expect(installed).toBe(false);
    expect(b.settled.listeners.size).toBe(0);
  });

  it("rejects an already disposed page without installing or subscribing", async () => {
    const b = boundary(); b.abort.abort(); let installed = false;
    await expect(attachOptionalLayer(b.options, () => { installed = true; })).rejects.toThrow(/cancelled/);
    expect(installed).toBe(false); expect(b.settled.listeners.size).toBe(0);
  });

  it("bounds the wait when no view ever settles", async () => {
    vi.useFakeTimers();
    const b = boundary(); let installed = false;
    const attachment = attachOptionalLayer(b.options, () => { installed = true; });
    const result = attachment.then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toBeInstanceOf(Error);
    expect((await result).message).toMatch(/30 seconds/);
    b.settled.emit(); expect(installed).toBe(false);
    expect(b.settled.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates one installation error from the other layer and the view commit", async () => {
    const b = boundary(); let secondInstalled = false;
    const first = attachOptionalLayer(b.options, () => { throw new Error("Synthetic provider failure"); });
    const rejected = expect(first).rejects.toThrow("Synthetic provider failure");
    const second = attachOptionalLayer(b.options, () => { secondInstalled = true; });
    expect(() => b.settled.emit()).not.toThrow();
    await rejected; await second;
    expect(secondInstalled).toBe(true); expect(b.settled.listeners.size).toBe(0);
  });

  it("installs immediately when the view is settled and ignores later disposal", async () => {
    const b = boundary(); b.setPreparing(false); let installs = 0;
    await attachOptionalLayer(b.options, () => { installs += 1; });
    b.abort.abort(); b.settled.emit();
    expect(installs).toBe(1); expect(b.settled.listeners.size).toBe(0);
  });
});
