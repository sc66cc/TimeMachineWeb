import { describe, expect, it, vi } from "vitest";

import {
  TimeMachineFeature,
  TimeMachinePlatformRuntime,
} from "@timemachine/platform-runtime";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

describe("TimeMachinePlatformRuntime", () => {
  it("uses the generated capability invoker and normalizes feature gates", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({
        Code: 200,
        Message: "",
        Data: {
          Client: { Value: 0 },
          ClientVersion: "0.1.0-test",
          ContractVersion: "2.0.0-stage0",
          FeatureList: [
            {
              Enabled: true,
              Feature: {
                Value: TimeMachineFeature.ProjectRevisionV2,
              },
              ReadOnly: true,
              Reason: "stage0-contract-and-read-compatibility",
            },
          ],
          ServerTime: "2026-07-24T08:00:00Z",
        },
      }),
    );
    const runtime = new TimeMachinePlatformRuntime({
      baseUrl: "http://127.0.0.1:7291",
      clientVersion: "0.1.0-test",
      fetch: fetchMock,
    });

    const snapshot = await runtime.loadCapabilities();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    expect(requestUrl).toBe(
      "http://127.0.0.1:7291/d_planet/time_machine_platform/get_capabilities",
    );
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      Client: { Value: 0 },
      ClientVersion: "0.1.0-test",
    });
    expect(snapshot.contractVersion).toBe("2.0.0-stage0");
    expect(runtime.isEnabled(TimeMachineFeature.ProjectRevisionV2)).toBe(true);
    expect(runtime.isReadOnly(TimeMachineFeature.ProjectRevisionV2)).toBe(true);
    expect(runtime.isEnabled(TimeMachineFeature.DatasetVersionV2)).toBe(false);
  });

  it("sends generated telemetry DTOs through the shared RPC runtime", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      jsonResponse({ Code: 200, Message: "" }),
    );
    const runtime = new TimeMachinePlatformRuntime({
      baseUrl: "http://127.0.0.1:7291",
      clientVersion: "0.1.0-test",
      fetch: fetchMock,
    });

    await runtime.recordTelemetry({
      correlationId: "fixture-1",
      durationMs: 12.5,
      eventName: "project-v1-open",
      feature: TimeMachineFeature.ProjectRevisionV2,
      itemCount: 3,
      success: true,
    });

    const [requestUrl, requestInit] = fetchMock.mock.calls[0]!;
    expect(requestUrl).toBe(
      "http://127.0.0.1:7291/d_planet/time_machine_platform/record_telemetry",
    );
    expect(JSON.parse(String(requestInit?.body))).toMatchObject({
      Property: {
        Client: { Value: 0 },
        ClientVersion: "0.1.0-test",
        CorrelationID: "fixture-1",
        DurationMs: 12.5,
        EventName: "project-v1-open",
        Feature: { Value: TimeMachineFeature.ProjectRevisionV2 },
        ItemCount: 3,
        Success: true,
      },
    });
  });
});
