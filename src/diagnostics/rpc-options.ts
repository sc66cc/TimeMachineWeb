import type { RPCClientOptions, RPCTelemetryEvent } from "@timemachine/api-client";
import { agentActions } from "../agent-actions/registry";

/** Reused by both bootstrap and cloud reconfiguration; no remote log sink. */
export function withRpcDiagnostics<T extends RPCClientOptions>(options: T): T {
  return {
    ...options,
    defaultTimeoutMs: options.defaultTimeoutMs ?? 30_000,
    onTelemetry: (event: RPCTelemetryEvent) => {
      const success = event.transportOutcome === "success" && event.businessOutcome !== "failure";
      const headersOnly = success && event.completion === "headers-received";
      agentActions.diagnostics.record({
        level: success ? "info" : "warn", category: "rpc", event: headersOnly ? "rpc.headers-received" : "rpc.completed",
        durationMs: event.elapsedMs,
        outcome: headersOnly ? "accepted" : success ? "success" : event.transportOutcome === "timeout" || event.transportOutcome === "cancelled"
          ? event.transportOutcome : "failed",
        safeDetails: {
          transportOutcome: event.transportOutcome, businessOutcome: event.businessOutcome,
          httpStatus: event.status, rpcCode: event.rpcCode,
          rpcRoute: event.path,
        },
      }, {
        requestId: event.requestId, traceId: event.traceId, actionId: event.actionId,
        jobId: event.jobId, generation: event.generation, revision: event.revision,
      });
      return options.onTelemetry?.(event);
    },
  };
}
