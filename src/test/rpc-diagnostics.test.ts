import { afterEach, describe, expect, it, vi } from "vitest";
import { RPCClient, RPCHttpError, RPCInvoker, RPCUploadStream, type RPCTelemetryEvent } from "@timemachine/api-client";
import { TimeMachinePlatformInvoker, TimeMachineClientType, ViEnum32 } from "@timemachine/generated-api";

const json = (Code = 200, status = 200) => new Response(JSON.stringify({ Code, Message: "", Data: { value: 1 } }), { status });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
afterEach(() => vi.useRealTimers());

describe("RPC diagnostics and request control", () => {
  it("does not send an already cancelled request", async () => {
    const controller = new AbortController(); controller.abort("SECRET_REASON");
    const events: RPCTelemetryEvent[] = [], fetchMock = vi.fn(async () => json());
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: fetchMock, onTelemetry: event => { events.push(event); } });
    const result = await client.request("POST", "Project", "Open", new RPCUploadStream({ signal: controller.signal })).catch(error => error);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ name: "RPCRequestError", kind: "cancelled" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ transportOutcome: "cancelled", businessOutcome: "not-checked" });
    expect(JSON.stringify(events)).not.toContain("SECRET_REASON");
  });

  it("aborts a pending fetch at the deadline, distinguishes timeout, and never retries a write", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const events: RPCTelemetryEvent[] = [];
    const fetchMock = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("SECRET_FETCH", "AbortError")), { once: true });
    }));
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: fetchMock, onTelemetry: event => { events.push(event); } });
    const result = client.request("POST", "Project", "Save", new RPCUploadStream({ timeoutMs: 20 })).catch(error => error);
    await vi.advanceTimersByTimeAsync(20);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ kind: "timeout" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "timeout", transportOutcome: "timeout", businessOutcome: "not-checked" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("forwards external cancellation during fetch and removes its listener", async () => {
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, "removeEventListener");
    let signal: AbortSignal | undefined;
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }) });
    const result = client.request("POST", "Project", "Open", new RPCUploadStream({ signal: controller.signal, timeoutMs: 100 })).catch(error => error);
    controller.abort();
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ kind: "cancelled" });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("keeps the deadline active while consuming the response body", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const bodyStarted = vi.fn();
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async (_url, init) => {
      signal = init?.signal ?? undefined;
      return { ok: true, status: 200, headers: new Headers(), text: () => {
        bodyStarted();
        return new Promise<string>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("body cancelled", "AbortError")), { once: true }));
      } } as Response;
    } });
    const result = client.request("POST", "Project", "Open", new RPCUploadStream({ timeoutMs: 30 })).catch(error => error);
    await Promise.resolve(); await Promise.resolve();
    expect(bodyStarted).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ kind: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans deadline/listener on success and lets per-request timeout override the client default", async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), remove = vi.spyOn(controller.signal, "removeEventListener");
    let signal: AbortSignal | undefined;
    const response = deferred<Response>();
    const client = new RPCClient({ baseUrl: "https://example.invalid", defaultTimeoutMs: 10, fetch: async (_url, init) => {
      signal = init?.signal ?? undefined; return response.promise;
    } });
    const result = client.request("POST", "Project", "Open", new RPCUploadStream({ timeoutMs: 50, signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(15);
    expect(signal?.aborted).toBe(false);
    response.resolve(json()); await result;
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    controller.abort();
    expect(signal?.aborted).toBe(false);
  });

  it("uses client default timeout when no per-request deadline is supplied", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const client = new RPCClient({ baseUrl: "https://example.invalid", defaultTimeoutMs: 15, fetch: (_url, init) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal ?? undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }) });
    const result = client.request("POST", "Project", "Open").catch(error => error);
    await vi.advanceTimersByTimeAsync(15);
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ kind: "timeout" });
  });

  it("bounds waiting even if an injected fetch ignores abort, and ignores its late response", async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>(), events: RPCTelemetryEvent[] = [];
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async () => pending.promise, onTelemetry: event => { events.push(event); } });
    const result = client.request("POST", "Project", "Save", new RPCUploadStream({ timeoutMs: 10 })).catch(error => error);
    await vi.advanceTimersByTimeAsync(10);
    const error = await result;
    expect(error).toMatchObject({ kind: "timeout", requestId: events[0]!.requestId });
    pending.resolve(json());
    await Promise.resolve(); await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]!.transportOutcome).toBe("timeout");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels response-body waiting using the external signal", async () => {
    const controller = new AbortController(), body = deferred<string>();
    const bodyStarted = deferred<void>();
    let signal: AbortSignal | undefined;
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async (_url, init) => {
      signal = init?.signal ?? undefined;
      return { ok: true, status: 200, headers: new Headers(), text: () => { bodyStarted.resolve(); return body.promise; } } as Response;
    } });
    const result = client.request("POST", "Project", "Open", new RPCUploadStream({ signal: controller.signal })).catch(error => error);
    await bodyStarted.promise;
    controller.abort();
    expect(signal?.aborted).toBe(true);
    expect(await result).toMatchObject({ kind: "cancelled" });
    body.resolve("{}");
  });

  it("distinguishes HTTP, network and decode failures without exporting error text or response bodies", async () => {
    vi.useFakeTimers();
    const cases = [
      { fetch: async () => json(503, 503), kind: "http-error", error: RPCHttpError },
      { fetch: async () => { throw new Error("SECRET_NETWORK"); }, kind: "network-error" },
      { fetch: async () => new Response("SECRET_BAD_JSON"), kind: "decode-error" },
    ];
    for (const scenario of cases) {
      const events: RPCTelemetryEvent[] = [];
      const controller = new AbortController(), remove = vi.spyOn(controller.signal, "removeEventListener");
      const stream = new RPCUploadStream({ signal: controller.signal, timeoutMs: 100 }); stream.ResponseType = "json";
      const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: scenario.fetch, onTelemetry: event => { events.push(event); } });
      const result = await client.request("POST", "Project", "Open", stream).catch(error => error);
      if (scenario.error) expect(result).toBeInstanceOf(scenario.error);
      else expect(result).toMatchObject({ kind: scenario.kind });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ transportOutcome: scenario.kind, businessOutcome: "not-checked" });
      expect(JSON.stringify(events)).not.toContain("SECRET_");
      expect(String(result)).not.toContain("SECRET_");
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("preserves HTTP failure status even when its error body cannot be decoded", async () => {
    const events: RPCTelemetryEvent[] = [], stream = new RPCUploadStream(); stream.ResponseType = "json";
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async () => new Response("invalid json", { status: 503 }), onTelemetry: event => { events.push(event); } });
    await expect(client.request("POST", "Project", "Open", stream)).rejects.toMatchObject({ name: "RPCHttpError", status: 503 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ transportOutcome: "http-error", status: 503 });
  });

  it("distinguishes a response-body connection failure from JSON syntax failure", async () => {
    const events: RPCTelemetryEvent[] = [];
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError("SECRET_CONNECTION_FAILURE")); },
    })), onTelemetry: event => { events.push(event); } });
    await expect(client.request("POST", "Project", "Open")).rejects.toMatchObject({ kind: "network-error" });
    expect(events[0]).toMatchObject({ transportOutcome: "network-error", status: 200 });
    expect(JSON.stringify(events)).not.toContain("SECRET_CONNECTION_FAILURE");
  });

  it("retains legacy non-JSON text decoding without claiming a business success", async () => {
    const events: RPCTelemetryEvent[] = [];
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async () => new Response("legacy plain text"), onTelemetry: event => { events.push(event); } });
    const response = await client.request("POST", "Project", "Open", new RPCUploadStream({ businessSuccessCode: 200 }));
    expect(response.data).toBe("legacy plain text");
    expect(events[0]).toMatchObject({ transportOutcome: "success", businessOutcome: "not-checked" });
  });

  it("does not infer a global business success code and can classify an explicitly supplied code", async () => {
    const events: RPCTelemetryEvent[] = [];
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async () => json(0), onTelemetry: event => { events.push(event); } });
    await client.request("POST", "Legacy", "Read");
    await client.request("POST", "Legacy", "Read", new RPCUploadStream({ businessSuccessCode: 0 }));
    await client.request("POST", "Platform", "Read", new RPCUploadStream({ businessSuccessCode: 200 }));
    expect(events.map(event => event.businessOutcome)).toEqual(["not-checked", "success", "failure"]);
    expect(events.every(event => event.transportOutcome === "success")).toBe(true);
  });

  it("preserves the generated optional requestStream and never serializes its local options", async () => {
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => json());
    const events: RPCTelemetryEvent[] = [];
    RPCInvoker.Configure({ baseUrl: "https://example.invalid", fetch: fetchMock, getLanguage: () => 2, getTimeZone: () => "8", onTelemetry: event => { events.push(event); } });
    await TimeMachinePlatformInvoker.GetCapabilities(new ViEnum32(TimeMachineClientType.Web), "test", new RPCUploadStream({ timeoutMs: 100, context: { traceId: "trace-generated", actionId: "capabilities.load" } }));
    const init = fetchMock.mock.calls[0]![1]!;
    expect(JSON.parse(String(init.body))).toEqual({ Client: { Value: TimeMachineClientType.Web }, ClientVersion: "test" });
    expect(JSON.parse((init.headers as Headers).get("Custom-Header")!)).toEqual({ TimeZone: "8", Language: "2" });
    expect(events[0]).toMatchObject({ traceId: "trace-generated", actionId: "capabilities.load" });
  });

  it("copies explicit concurrent contexts and generates distinct request IDs even for reused streams", async () => {
    const a = deferred<Response>(), b = deferred<Response>();
    const fetchMock = vi.fn().mockImplementationOnce(() => a.promise).mockImplementationOnce(() => b.promise).mockImplementationOnce(async () => json());
    const events: RPCTelemetryEvent[] = [], context = { traceId: "trace-a", actionId: "project.open", jobId: "job-a", generation: 2, revision: 4 };
    const stream = new RPCUploadStream({ context });
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: fetchMock, onTelemetry: event => { events.push(event); } });
    const first = client.request("POST", "Project", "Open", stream);
    const second = client.request("POST", "Project", "Open", new RPCUploadStream({ context: { traceId: "trace-b" } }));
    context.traceId = "changed";
    b.resolve(json()); await second; a.resolve(json()); await first;
    await client.request("POST", "Project", "Open", stream);
    expect(events[0]).toMatchObject({ traceId: "trace-b" });
    expect(events[1]).toMatchObject({ traceId: "trace-a", actionId: "project.open", jobId: "job-a", generation: 2, revision: 4 });
    expect(new Set(events.map(event => event.requestId)).size).toBe(3);
    expect(events.every(event => typeof event.requestId === "string" && event.requestId.length > 0)).toBe(true);
  });

  it("isolates synchronous observers and does not reclassify a successful response", async () => {
    const observer = vi.fn(() => { throw new Error("SECRET_OBSERVER"); });
    const authObserver = vi.fn(() => { throw new Error("SECRET_AUTH_OBSERVER"); });
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async () => json(401), loginExpiredCode: 401, onTelemetry: observer, onAuthEvent: authObserver });
    await expect(client.request("POST", "Account", "Display")).resolves.toMatchObject({ status: 200 });
    expect(observer).toHaveBeenCalledTimes(1);
    expect(authObserver).toHaveBeenCalledTimes(1);
  });

  it("isolates async observer rejection without waiting for observer completion", async () => {
    const observer = vi.fn(async () => { throw new Error("synthetic observer failure"); });
    const auth = vi.fn(async () => { throw new Error("synthetic auth observer failure"); });
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async () => json(401), loginExpiredCode: 401, onTelemetry: observer, onAuthEvent: auth });
    await expect(client.request("POST", "Project", "Open")).resolves.toMatchObject({ status: 200 });
    // Advance to the next turn so an unhandled rejection would be reported by Vitest.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(observer).toHaveBeenCalledTimes(1);
    expect(auth).toHaveBeenCalledTimes(1);
    const unresolved = deferred<void>();
    const nonBlocking = new RPCClient({ baseUrl: "https://example.invalid", fetch: async () => json(), onTelemetry: () => unresolved.promise });
    await expect(nonBlocking.request("POST", "Project", "Open")).resolves.toMatchObject({ status: 200 });
    unresolved.resolve();
  });

  it("keeps URL/query/headers/raw body and unknown context out of diagnostics", async () => {
    const events: RPCTelemetryEvent[] = [];
    const context = { traceId: "trace-safe", password: "SECRET_CONTEXT", attributes: { private: "SECRET_ATTRIBUTES" } };
    const stream = new RPCUploadStream({ context });
    stream.AddField("token", "SECRET_QUERY");
    const client = new RPCClient({ baseUrl: "https://SECRET_HOST.invalid", getAccessToken: () => "SECRET_HEADER", fetch: async () => new Response(JSON.stringify({ Code: 200, Message: "SECRET_RESPONSE", Data: "SECRET_BODY" })), onTelemetry: event => { events.push(event); } });
    await client.request("GET", "Project", "Open", stream);
    await client.request("GET", "Project", "Open?signature=SECRET_ROUTE");
    expect(events[0]).toMatchObject({ path: "/Project/Open", traceId: "trace-safe" });
    expect(events[1]!.path).toBe("[redacted-route]");
    expect(JSON.stringify(events)).not.toContain("SECRET_");
  });

  it("can suppress telemetry for the telemetry request itself while keeping auth handling", async () => {
    const observer = vi.fn(), auth = vi.fn();
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async () => json(401), loginExpiredCode: 401, onTelemetry: observer, onAuthEvent: auth });
    await client.request("POST", "Platform", "Telemetry", new RPCUploadStream({ suppressTelemetry: true }));
    expect(observer).not.toHaveBeenCalled();
    expect(auth).toHaveBeenCalledTimes(1);
  });

  it("marks stream responses as headers-only rather than claiming the body was consumed", async () => {
    const events: RPCTelemetryEvent[] = [], stream = new RPCUploadStream(); stream.ResponseType = "stream";
    const body = new ReadableStream<Uint8Array>();
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: async () => new Response(body), onTelemetry: event => { events.push(event); } });
    const response = await client.request("POST", "Project", "Download", stream);
    expect(response.data).toBe(body);
    expect(events[0]).toMatchObject({ completion: "headers-received", businessOutcome: "not-checked" });
  });

  it("rejects invalid deadline options before dispatch instead of overflowing a timer", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => json());
    const client = new RPCClient({ baseUrl: "https://example.invalid", fetch: fetchMock });
    for (const timeoutMs of [0, -1, NaN, Infinity, 0x80000000]) {
      await expect(client.request("POST", "Project", "Open", new RPCUploadStream({ timeoutMs }))).rejects.toBeInstanceOf(TypeError);
      expect(() => new RPCClient({ baseUrl: "https://example.invalid", defaultTimeoutMs: timeoutMs })).toThrow(TypeError);
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
