import { describe, expect, it, vi } from "vitest";

import {
  RPCClient,
  RPCFile,
  RPCUploadStream,
  type RPCTelemetryEvent,
} from "@timemachine/api-client";

describe("MetaMaker RPC compatibility runtime", () => {
  it("preserves the generated invoker JSON and Custom-Header contract", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ Code: 0, Message: "ok", Data: { ID: 7 } }),
          {
            headers: { "content-type": "application/json" },
            status: 200,
          },
        ),
    );
    const input = new RPCUploadStream();
    input.AddField("ID", 7);

    const client = new RPCClient({
      baseUrl: "https://api.example.test/",
      fetch: fetchMock,
      getAccessToken: () => "token-value",
      getLanguage: () => 2,
      getRequestToken: () => "request-token",
      getTimeZone: () => "8",
    });
    const result = await client.request(
      "POST",
      "UserPlateModel",
      "Get",
      input,
    );

    expect(result.data).toEqual({
      Code: 0,
      Message: "ok",
      Data: { ID: 7 },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.example.test/UserPlateModel/Get",
    );
    expect(init?.body).toBe('{"ID":7}');
    const headers = init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("token-value");
    expect(JSON.parse(headers.get("Custom-Header") ?? "{}")).toEqual({
      RequestTokenKey: "/UserPlateModel/Get",
      "/UserPlateModel/Get": "request-token",
      TimeZone: "8",
      Language: "2",
    });
  });

  it("parses DPlanet JSON results returned as text/plain", async () => {
    const client = new RPCClient({
      baseUrl: "http://127.0.0.1:5130",
      fetch: async () =>
        new Response('{"Code":200,"Message":"","Data":{"ID":7}}', {
          headers: { "content-type": "text/plain; charset=utf-8" },
          status: 200,
        }),
    });

    const result = await client.request("POST", "user/login_mail", "login");

    expect(result.data).toEqual({
      Code: 200,
      Message: "",
      Data: { ID: 7 },
    });
  });

  it("unwraps DPlanet JSON strings serialized by the ASP.NET JSON formatter", async () => {
    const encodedResult = JSON.stringify(
      '{"Code":200,"Message":"","Data":{"ID":7}}',
    );
    const client = new RPCClient({
      baseUrl: "http://127.0.0.1:5130",
      fetch: async () =>
        new Response(encodedResult, {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    });

    const result = await client.request("POST", "user/login_mail", "login");

    expect(result.data).toEqual({
      Code: 200,
      Message: "",
      Data: { ID: 7 },
    });
  });

  it("keeps the existing raw-file upload shape and moves fields to the query", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ Code: 0, Message: "ok" }), {
          headers: { "content-type": "application/json" },
        }),
    );
    const input = new RPCUploadStream();
    input.AddField("modelID", 42);
    input.AddField(
      "file",
      new RPCFile("plate.rot", new Blob(["rotation"])),
    );
    const client = new RPCClient({
      baseUrl: "https://api.example.test",
      fetch: fetchMock,
    });

    await client.request("POST", "PlateModel", "Upload", input);

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      "https://api.example.test/PlateModel/Upload?modelID=42",
    );
    expect(init?.body).toBeInstanceOf(Blob);
    expect((init?.headers as Headers).has("Content-Type")).toBe(false);
  });

  it("serializes generated DTO dictionaries instead of dropping nested Maps", async () => {
    const input = new RPCUploadStream();
    input.AddField("Document", {
      LegacyExtensions: new Map([
        ["camera", "{\"position\":[1,2,3]}"],
        ["sourceRef:4", "resource:plate-model-version:91"],
      ]),
      Nested: {
        Values: new Map([["unit", "Ma"]]),
      },
    });

    expect(RPCUploadStream.MapToRPCMap(input.JsonList)).toEqual({
      Document: {
        LegacyExtensions: {
          camera: "{\"position\":[1,2,3]}",
          "sourceRef:4": "resource:plate-model-version:91",
        },
        Nested: {
          Values: { unit: "Ma" },
        },
      },
    });
  });

  it("emits transport telemetry without coupling the SDK to Vue UI", async () => {
    const events: RPCTelemetryEvent[] = [];
    const client = new RPCClient({
      baseUrl: "https://api.example.test",
      fetch: async () =>
        new Response(JSON.stringify({ Code: 0, Message: "ok" }), {
          headers: { "content-type": "application/json" },
        }),
      onTelemetry: (event) => events.push(event),
    });

    await client.request("POST", "Project", "Open");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      method: "POST",
      outcome: "success",
      path: "/Project/Open",
      rpcCode: 0,
      status: 200,
    });
  });
});
