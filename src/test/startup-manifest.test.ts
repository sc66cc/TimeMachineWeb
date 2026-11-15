import { afterEach, describe, expect, it, vi } from "vitest";
import { requestStartupManifest } from "../startup/request-startup-manifest";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("optional startup manifest requests", () => {
  it("contains an early HTTP failure until the core is ready to consume it", async () => {
    vi.stubGlobal("fetch", async () => new Response("private response", { status: 503 }));
    const result = await requestStartupManifest("/optional-manifest?token=synthetic-secret", new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("503");
      expect(result.error.message).not.toContain("synthetic-secret");
      expect(result.error.message).not.toContain("private response");
    }
  });

  it("returns parsed data and does not leave a deadline after success", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => new Response('{"datasets":[{"id":"point-a"}]}'));
    await expect(requestStartupManifest("/points", new AbortController().signal))
      .resolves.toEqual({ ok: true, value: { datasets: [{ id: "point-a" }] } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled response, aborts transport and ignores a late response", async () => {
    vi.useFakeTimers();
    const response = deferred<Response>();
    let transport: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => { transport = init.signal as AbortSignal; return response.promise; });
    const pending = requestStartupManifest("/stalled", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(transport?.aborted).toBe(true);
    response.resolve(new Response('{"late":true}'));
    await vi.runAllTimersAsync();
    expect(await pending).toBe(result);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("applies the same deadline while the response body is stalled", async () => {
    vi.useFakeTimers();
    const body = deferred<unknown>();
    vi.stubGlobal("fetch", async () => ({ ok: true, json: () => body.promise }));
    const pending = requestStartupManifest("/slow-body", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).ok).toBe(false);
    body.resolve({ late: true });
    await vi.runAllTimersAsync();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels a pending manifest on page disposal without waiting for fetch", async () => {
    vi.useFakeTimers();
    let transport: AbortSignal | undefined;
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => {
      transport = init.signal as AbortSignal;
      return new Promise(() => {});
    });
    const owner = new AbortController();
    const pending = requestStartupManifest("/pending", owner.signal);
    owner.abort();
    expect((await pending).ok).toBe(false);
    expect(transport?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not issue work after its page has already been disposed", async () => {
    const fetch = vi.fn(async () => new Response('{"unexpected":true}'));
    vi.stubGlobal("fetch", fetch);
    const owner = new AbortController();
    owner.abort();
    expect((await requestStartupManifest("/unused", owner.signal)).ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("contains invalid JSON without exposing raw response content", async () => {
    vi.stubGlobal("fetch", async () => new Response('private-invalid-json'));
    const result = await requestStartupManifest("/invalid", new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).not.toContain("private-invalid-json");
  });
});
