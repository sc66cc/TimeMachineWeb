import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RPCClient, RPCUploadStream } from "@timemachine/api-client";
import { withRpcDiagnostics } from "../diagnostics/rpc-options";
import { agentActions } from "../agent-actions/registry";
import { Phase1BCloudClient } from "../phase1b/cloud-client";

beforeEach(() => { vi.useFakeTimers(); agentActions.diagnostics.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("production RPC diagnostic configuration", () => {
  it("correlates a real catalog call path across ByteStream and generated invokers", async () => {
    const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const fetch = vi.fn(async (url: RequestInfo | URL) => String(url).includes("user_plate_model/display")
      ? new Response(new Uint8Array([200, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
      : new Response(JSON.stringify({ Code: 200, Data: [], Message: "" })));
    const client = new Phase1BCloudClient({ storage, sessionStorage: storage, fetch, bootstrapPlatform: async () => {} });
    await client.initialize();
    agentActions.diagnostics.clear();
    const state = await client.refreshCatalogs({ context: { traceId: "catalog-trace", actionId: "catalog.refresh" } });
    expect(state.sharedPlateModelsStatus).toBe("ready");
    const entries = agentActions.diagnostics.query({ traceId: "catalog-trace" }).entries;
    expect(entries).toHaveLength(4);
    expect(new Set(entries.map(e => e.requestId)).size).toBe(4);
    expect(entries.every(e => e.actionId === "catalog.refresh" && e.safeDetails?.businessOutcome === "success")).toBe(true);
    expect(entries.some(e => e.safeDetails?.rpcRoute === "/d_planet/user_plate_model/display")).toBe(true);
  });

  it("does not print the raw business error from an optional catalog into console diagnostics", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
    const client = new Phase1BCloudClient({ storage, sessionStorage: storage, bootstrapPlatform: async () => {},
      fetch: async url => String(url).includes("user_plate_model/display")
        ? new Response(new Uint8Array([200, 0, 0, 0, 0, 0, 0, 0, 0, 0]))
        : new Response(JSON.stringify(String(url).includes("display_ingest_plate_models")
          ? { Code: 500, Message: "token=synthetic-private-error" } : { Code: 200, Data: [] })),
    });
    await client.initialize();
    await client.refreshCatalogs({ context: { traceId: "optional-catalog-trace" } });
    const messages = warn.mock.calls.flat().map(value => value instanceof Error ? value.message : String(value)).join(" ");
    expect(messages).not.toContain("synthetic-private-error");
    expect(agentActions.diagnostics.query({ traceId: "optional-catalog-trace" }).entries.some(
      entry => entry.safeDetails?.rpcCode === 500 && entry.safeDetails?.businessOutcome === "failure",
    )).toBe(true);
  });

  it("applies the finite default deadline and records only request identity and safe status", async () => {
    let signal!: AbortSignal;
    const client = new RPCClient(withRpcDiagnostics({
      baseUrl: "/fixture", fetch: (async (_url, init) => { signal = init!.signal as AbortSignal; return new Promise<Response>(() => {}); }) as typeof fetch,
      getAccessToken: () => "synthetic-private-token",
    }));
    const request = client.request("POST", "Fixture", "Read", new RPCUploadStream({ context: { traceId: "fixture-trace", actionId: "fixture.read" } })).catch(error => error);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal.aborted).toBe(false);
    expect(agentActions.diagnostics.query().entries).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect((await request).kind).toBe("timeout");
    expect(signal.aborted).toBe(true);
    const logs = agentActions.diagnostics.query({ traceId: "fixture-trace" });
    expect(logs.entries).toHaveLength(1);
    expect(logs.entries[0]).toMatchObject({ category: "rpc", event: "rpc.completed", outcome: "timeout", safeDetails: { transportOutcome: "timeout", businessOutcome: "not-checked", rpcRoute: "/Fixture/Read" } });
    expect(logs.entries[0]?.requestId).toEqual(expect.any(String));
    expect(JSON.stringify(logs)).not.toContain("synthetic-private-token");
  });

  it("does not log a streaming response's headers as a completed body transfer", async () => {
    const observer = vi.fn();
    const client = new RPCClient(withRpcDiagnostics({ baseUrl: "/fixture", onTelemetry: observer,
      fetch: (async () => new Response(new ReadableStream())) as typeof fetch }));
    const stream = new RPCUploadStream(); stream.ResponseType = "stream";
    await client.request("GET", "Fixture", "Stream", stream);
    expect(observer).toHaveBeenCalledOnce();
    expect(agentActions.diagnostics.query().entries[0]).toMatchObject({ event: "rpc.headers-received", outcome: "accepted" });
  });
});
