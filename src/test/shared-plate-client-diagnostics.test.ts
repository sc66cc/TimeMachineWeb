import { afterEach, describe, expect, it, vi } from "vitest";
import type { RPCTelemetryEvent } from "@timemachine/api-client";
import { SharedPlateModelClient } from "../plate-model/shared-plate-client";

// Hand-written wire frames: Int32 Code, packed UTF-16 message, then Page or List.
const emptyPage = () => new Response(new Uint8Array([200, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
const emptyMine = () => new Response(new Uint8Array([200, 0, 0, 0, 0, 0]));
const baseUrl = "https://synthetic.example.test";
const route = "/d_planet/user_plate_model/display";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("shared ByteStream transport diagnostics", () => {
  it("bounds an unresponsive fetch with the default 30 second deadline", async () => {
    vi.useFakeTimers();
    const events: RPCTelemetryEvent[] = [];
    let signal: AbortSignal | null | undefined;
    let result: unknown;
    const client = new SharedPlateModelClient({
      baseUrl, onTelemetry: event => events.push(event),
      fetch: async (_url, init) => { signal = init?.signal; return new Promise(() => {}); },
    });
    void client.display().catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toMatchObject({ kind: "timeout", path: route });
    expect(signal?.aborted).toBe(true);
    expect(events).toEqual([expect.objectContaining({ transportOutcome: "timeout", businessOutcome: "not-checked" })]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["timeout", "cancelled"] as const)("%s cancels a stalled response body and releases its lock", async kind => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const events: RPCTelemetryEvent[] = [];
    let signal: AbortSignal | null | undefined;
    let result: unknown;
    const client = new SharedPlateModelClient({
      baseUrl, defaultTimeoutMs: 500, onTelemetry: event => events.push(event),
      fetch: async (_url, init) => { signal = init?.signal; return new Response(body); },
    });
    void client.display({}, { signal: controller.signal, timeoutMs: 10 }).catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(body.locked).toBe(true);
    expect(events).toEqual([]); // Headers alone are not a completed binary frame.
    if (kind === "cancelled") controller.abort("synthetic-secret-reason");
    await vi.advanceTimersByTimeAsync(10);
    expect(result).toMatchObject({ kind });
    expect(signal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(events).toEqual([expect.objectContaining({ transportOutcome: kind, status: 200 })]);
    expect(JSON.stringify(events)).not.toContain("synthetic-secret-reason");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send an already-cancelled request", async () => {
    const fetch = vi.fn(async () => emptyPage());
    const events: RPCTelemetryEvent[] = [];
    const client = new SharedPlateModelClient({ baseUrl, fetch, onTelemetry: event => events.push(event) });
    const controller = new AbortController();
    controller.abort();
    await expect(client.display({}, { signal: controller.signal })).rejects.toMatchObject({ kind: "cancelled" });
    expect(fetch).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
  });

  it("cancels fetch before headers without waiting for a noncooperative adapter", async () => {
    const controller = new AbortController();
    let signal: AbortSignal | null | undefined;
    const client = new SharedPlateModelClient({ baseUrl, fetch: async (_url, init) => {
      signal = init?.signal;
      return new Promise(() => {});
    } });
    const pending = client.displayMine({ signal: controller.signal });
    const rejected = expect(pending).rejects.toMatchObject({ kind: "cancelled" });
    controller.abort();
    await rejected;
    expect(signal?.aborted).toBe(true);
  });

  it("cancels a late response body without producing a second completion", async () => {
    vi.useFakeTimers();
    let resolve!: (response: Response) => void;
    const events: RPCTelemetryEvent[] = [];
    const client = new SharedPlateModelClient({ baseUrl, onTelemetry: event => events.push(event),
      fetch: async () => new Promise(done => { resolve = done; }),
    });
    let result: unknown;
    void client.display({}, { timeoutMs: 5 }).catch(error => { result = error; });
    await vi.advanceTimersByTimeAsync(5);
    expect(result).toMatchObject({ kind: "timeout" });
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
  });

  it("distinguishes HTTP failure and releases its unused body without decoding it", async () => {
    const cancel = vi.fn();
    const events: RPCTelemetryEvent[] = [];
    const client = new SharedPlateModelClient({ baseUrl, onTelemetry: event => events.push(event),
      fetch: async () => new Response(new ReadableStream({ cancel }), { status: 503 }),
    });
    await expect(client.display()).rejects.toMatchObject({ status: 503, requestId: expect.any(String), path: route });
    expect(cancel).toHaveBeenCalledOnce();
    expect(events).toEqual([expect.objectContaining({ transportOutcome: "http-error", status: 503, businessOutcome: "not-checked" })]);
  });

  it.each(["before-headers", "body"])("classifies a disconnected %s request as a network error", async phase => {
    const events: RPCTelemetryEvent[] = [];
    const client = new SharedPlateModelClient({ baseUrl, onTelemetry: event => events.push(event), fetch: async () => {
      if (phase === "before-headers") throw new TypeError("synthetic-secret-network");
      return new Response(new ReadableStream({ start(controller) { controller.error(new TypeError("synthetic-secret-body")); } }));
    } });
    await expect(client.display()).rejects.toMatchObject({ kind: "network-error", requestId: expect.any(String) });
    expect(events).toEqual([expect.objectContaining({ transportOutcome: "network-error" })]);
    expect(JSON.stringify(events)).not.toContain("synthetic-secret");
  });

  it("reports a malformed frame only as a decode failure", async () => {
    const events: RPCTelemetryEvent[] = [];
    const client = new SharedPlateModelClient({ baseUrl, onTelemetry: event => events.push(event),
      fetch: async () => new Response(new Uint8Array([200, 0, 0, 0, 0])),
    });
    await expect(client.display()).rejects.toMatchObject({ kind: "decode-error", requestId: expect.any(String) });
    expect(events).toEqual([expect.objectContaining({ transportOutcome: "decode-error", businessOutcome: "not-checked", status: 200 })]);
  });

  it("keeps HTTP 200 business failure distinct and omits the server message", async () => {
    const message = "synthetic-secret-business";
    const frame = new Uint8Array([73, 3, 0, 0, message.length, ...[...message].flatMap(c => [c.charCodeAt(0), 0])]);
    const events: RPCTelemetryEvent[] = [];
    const client = new SharedPlateModelClient({ baseUrl, onTelemetry: event => events.push(event), fetch: async () => new Response(frame) });
    await expect(client.getDetail(1, { context: { traceId: "trace-detail" } })).rejects.toMatchObject({ code: 841, message, requestId: expect.any(String) });
    expect(events).toEqual([expect.objectContaining({
      transportOutcome: "success", businessOutcome: "failure", rpcCode: 841, status: 200,
      traceId: "trace-detail", path: "/d_planet/user_plate_model/get_detail", completion: "response-read",
    })]);
    expect(JSON.stringify(events)).not.toContain(message);
  });

  it("keeps concurrent contexts isolated and never serializes them onto the wire", async () => {
    const pending: Array<(response: Response) => void> = [];
    const events: RPCTelemetryEvent[] = [];
    const requests: RequestInit[] = [];
    const client = new SharedPlateModelClient({ baseUrl, onTelemetry: event => events.push(event), fetch: async (_url, init) => {
      requests.push(init!);
      return new Promise(resolve => pending.push(resolve));
    } });
    const firstContext = { traceId: "trace-one", actionId: "action-one", jobId: "job-one", generation: 2, revision: 3 };
    const first = client.display({}, { context: firstContext });
    const second = client.displayMine({ context: { traceId: "trace-two" } });
    firstContext.traceId = "trace-mutated";
    pending[1]!(emptyMine());
    await second;
    pending[0]!(emptyPage());
    await first;
    expect(events.map(event => event.traceId)).toEqual(["trace-two", "trace-one"]);
    expect(events[1]).toMatchObject({ actionId: "action-one", jobId: "job-one", generation: 2, revision: 3 });
    expect(new Set(events.map(event => event.requestId)).size).toBe(2);
    for (const request of requests) {
      expect([...new Headers(request.headers).keys()].sort()).toEqual(["accept", "custom-header"]);
      expect([...(request.body as FormData).keys()]).toEqual(["_stream"]);
      expect(JSON.stringify([...new Headers(request.headers)])).not.toContain("trace-");
    }
  });

  it("emits only safe context and a known route, never URL, token, query or nested body", async () => {
    const events: RPCTelemetryEvent[] = [];
    const getter = vi.fn(() => "synthetic-secret-getter");
    const context = { traceId: "trace-safe", actionId: "token=synthetic-secret", jobId: "x".repeat(257), generation: -1 };
    Object.defineProperty(context, "revision", { get: getter });
    Object.defineProperty(context, "body", { get: getter });
    const client = new SharedPlateModelClient({ baseUrl: `${baseUrl}/?signature=synthetic-secret-url`,
      getAccessToken: () => "synthetic-secret-token", onTelemetry: event => events.push(event), fetch: async () => emptyPage(),
    });
    await client.display({ name: "synthetic-secret-query" }, { context });
    expect(events).toEqual([expect.objectContaining({ path: route, traceId: "trace-safe", transportOutcome: "success", rpcCode: 200 })]);
    expect(events[0]?.actionId).toBeUndefined();
    expect(events[0]?.jobId).toBeUndefined();
    expect(events[0]?.generation).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toMatch(/synthetic-secret|signature=|https:/);
  });

  it.each(["throw", "reject"])("isolates observers that %s and preserves the decoded result", async mode => {
    const client = new SharedPlateModelClient({ baseUrl, fetch: async () => emptyPage(), onTelemetry: () => {
      if (mode === "throw") throw new Error("observer-only");
      return Promise.reject(new Error("observer-only"));
    } });
    await expect(client.display()).resolves.toMatchObject({ Total: 0, List: [] });
    await new Promise(resolve => setTimeout(resolve, 0));
  });

  it("can suppress telemetry without suppressing the operation", async () => {
    const events: RPCTelemetryEvent[] = [];
    const client = new SharedPlateModelClient({ baseUrl, fetch: async () => emptyMine(), onTelemetry: event => events.push(event) });
    await expect(client.displayMine({ suppressTelemetry: true })).resolves.toEqual([]);
    expect(events).toEqual([]);
  });

  it("cleans its timeout and abort listener after success, so late cancellation has no effect", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const events: RPCTelemetryEvent[] = [];
    let signal: AbortSignal | null | undefined;
    const client = new SharedPlateModelClient({ baseUrl, onTelemetry: event => events.push(event), fetch: async (_url, init) => {
      signal = init?.signal;
      return emptyPage();
    } });
    await client.display({}, { signal: controller.signal, timeoutMs: 10 });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signal?.aborted).toBe(false);
    expect(events).toEqual([expect.objectContaining({ businessOutcome: "success", completion: "response-read" })]);
  });

  it.each([0, -1, Infinity, NaN, 2_147_483_648])("rejects invalid timeout %s before sending", async timeoutMs => {
    const fetch = vi.fn(async () => emptyPage());
    const client = new SharedPlateModelClient({ baseUrl, fetch });
    await expect(client.display({}, { timeoutMs })).rejects.toBeInstanceOf(TypeError);
    expect(fetch).not.toHaveBeenCalled();
    expect(() => new SharedPlateModelClient({ baseUrl, defaultTimeoutMs: timeoutMs })).toThrow(TypeError);
  });
});
