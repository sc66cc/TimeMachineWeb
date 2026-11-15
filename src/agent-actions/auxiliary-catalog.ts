import type { ApiContractDetails, ApiDescriptor, ApiInvocation, ApiSchema, ApiSummary } from "./contracts";
import { EVENT_LIMITS, EVENT_TYPES } from "./events";
import { JOB_LIMITS } from "./jobs";
import { DIAGNOSTIC_LIMITS } from "../diagnostics/logger";

const object = (properties: Record<string, ApiSchema> = {}, required: readonly string[] = []): ApiSchema =>
  ({ type: "object", properties, required, additionalProperties: false });
const string: ApiSchema = { type: "string" };
const number: ApiSchema = { type: "number" };
const count: ApiSchema = { type: "integer", minimum: 0 };
const boolean: ApiSchema = { type: "boolean" };
const terminalStatuses = ["completed", "failed", "unknown", "cancelled", "superseded"];
const result = (accepted = false): ApiSchema => object({
  ok: boolean, status: { type: "string", enum: accepted ? ["accepted", ...terminalStatuses] : terminalStatuses },
  traceId: string, jobId: string, revision: count, data: {}, dataTruncated: boolean,
  error: object({ kind: string, code: string, message: string, retryable: boolean }, ["kind", "code", "message", "retryable"]),
}, ["ok", "status", "traceId"]);
const jobSnapshot = (): ApiSchema => object({
  jobId: string, bootId: string, traceId: string, actionId: string,
  status: { type: "string", enum: ["running", ...terminalStatuses] },
  cancellationSupported: boolean, cancellationRequested: boolean,
  startedAt: string, finishedAt: string, result: result(),
}, ["jobId", "bootId", "traceId", "actionId", "status", "cancellationSupported", "cancellationRequested", "startedAt"]);
const logFilter = (): ApiSchema => object({
  traceId: string, level: { type: "string", enum: ["debug", "info", "warn", "error"] },
  category: { type: "string", enum: ["app", "action", "rpc", "asset", "worker", "render", "performance"] },
  afterSequence: { type: "number", description: "Exclusive lower sequence bound when finite; otherwise ignored." },
  limit: { type: "number", description: "Finite values are floored and clamped to 1..200; non-finite values use 100. Export without limit uses all retained matches." },
});
const logEvent = (): ApiSchema => object({
  timestamp: string, monotonicMs: number, sequence: count, bootId: string, appVersion: string,
  level: logFilter().properties!.level!, category: logFilter().properties!.category!, event: string,
  ...Object.fromEntries(["traceId", "parentId", "actionId", "requestId", "jobId", "viewportId"].map(key => [key, string])),
  projectId: { type: ["string", "number"] }, layerId: { type: ["string", "number"] },
  generation: number, revision: number, durationMs: number, outcome: string, errorCode: string,
  safeDetails: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] }, description: "Bounded allowlisted diagnostic fields; not arbitrary input/result bodies." },
  error: object({ name: string, message: string, stack: string }, ["name", "message"]),
}, ["timestamp", "monotonicMs", "sequence", "bootId", "appVersion", "level", "category", "event"]);
const logPage = (): ApiSchema => object({
  entries: { type: "array", items: logEvent() }, totalMatched: count, retainedCount: count, retainedBytes: count,
  dropCount: count, sinkErrorCount: count, sinkSkippedCount: count, nextAfterSequence: count,
}, ["entries", "totalMatched", "retainedCount", "retainedBytes", "dropCount", "sinkErrorCount", "sinkSkippedCount"]);
const catalogFilter = (): ApiSchema => object({
  idPrefix: string, kind: { type: "string", enum: ["command", "query", "event", "service"] },
  scope: { type: "string", enum: ["p0-p3", "existing", "future", "excluded"] },
  availability: { type: "string", enum: ["ready", "not-implemented", "unavailable", "out-of-scope"] },
});
// Describe the schema objects as data, without recursively embedding this catalog in itself.
const catalogEntry = (details = false): ApiSchema => object({
  id: string, title: string, version: { type: "string", enum: ["2.0.0"] }, schemaRef: string,
  kind: catalogFilter().properties!.kind!, scope: catalogFilter().properties!.scope!, availability: catalogFilter().properties!.availability!,
  effect: { type: "string", enum: ["read", "ui-local", "project-local", "remote-write"] },
  completion: { type: "string", enum: ["state-committed", "frame-committed", "page-reload", "unverified"] },
  completionNote: string, execution: { type: "string", enum: ["inline", "job"] }, cancellationSupported: boolean,
  requirements: { type: "array", items: string }, reason: string,
  invocation: { type: "object", additionalProperties: true, description: "Direct facade method and native return metadata when present." },
  ...(details ? { description: string, inputSchema: { type: "object", additionalProperties: true } as ApiSchema,
    outputSchema: { type: "object", additionalProperties: true } as ApiSchema, examples: { type: "array" } as ApiSchema } : {}),
}, ["id", "title", "version", "schemaRef", "kind", "scope", "effect", "completion", "requirements", "availability",
  ...(details ? ["description", "inputSchema", "outputSchema", "examples"] : [])]);

interface HelperContract {
  title: string;
  kind: ApiSummary["kind"];
  effect: ApiSummary["effect"];
  invocation: Omit<ApiInvocation, "channel" | "method">;
  description: string;
  details(): ApiContractDetails;
}
const jsonArgument = (name: string, optional = false) => ({ name, kind: "json" as const, ...(optional ? { optional } : {}) });
const nativeOutput = (description: string): ApiSchema => ({ description: `${description} No JSON output schema applies; use invocation.returns.` });
const jobInput = () => object({ jobId: string }, ["jobId"]);
const helpers: Record<ApiInvocation["method"], HelperContract> = {
  "catalog.list": {
    title: "List available API contracts", kind: "query", effect: "read",
    invocation: { arguments: [jsonArgument("filter", true)], asynchronous: false, returns: "json" },
    description: "Returns independent lightweight summaries sorted by id. Optional filters combine by AND; availability is evaluated on every read. Does not load detailed action schemas.",
    details: () => ({ inputSchema: object({ filter: catalogFilter() }), outputSchema: { type: "array", items: catalogEntry() }, examples: [{ filter: { kind: "query" } }] }),
  },
  "catalog.describe": {
    title: "Read one API contract", kind: "query", effect: "read",
    invocation: { arguments: [jsonArgument("id")], asynchronous: true, returns: "json-or-undefined" },
    description: "Resolves an independent descriptor, or undefined for unknown ids. Detailed action schema loading is lazy and may reject with a redacted Error; later calls can retry. Does not execute the described operation.",
    details: () => ({ inputSchema: object({ id: string }, ["id"]), outputSchema: catalogEntry(true), examples: [{ id: "jobs.wait" }] }),
  },
  "jobs.get": {
    title: "Read an operation record", kind: "query", effect: "read",
    invocation: { arguments: [jsonArgument("jobId")], asynchronous: false, returns: "json-or-undefined" },
    description: `Returns a snapshot copy or undefined for unknown, expired or previous-document ids. Records are local to this boot: at most ${JOB_LIMITS.records} records and ${JOB_LIMITS.running} running jobs; terminal records expire after ${JOB_LIMITS.retentionMs} ms and may be evicted earlier under capacity pressure. No remote recovery or resubmission.`,
    details: () => ({ inputSchema: jobInput(), outputSchema: jobSnapshot(), examples: [{ jobId: "boot-example:job-1" }] }),
  },
  "jobs.wait": {
    title: "Wait for an existing operation", kind: "query", effect: "read",
    invocation: { arguments: [jsonArgument("jobId"), jsonArgument("options", true)], asynchronous: true, returns: "json" },
    description: `Resolves the authoritative retained terminal result; no event subscription is required. Default timeoutMs is ${JOB_LIMITS.defaultWaitTimeoutMs}; finite positive values up to 2147483647 are accepted. Timeout returns ok=false/status=unknown/code=TIMEOUT with the original jobId and does not cancel the job. At most ${JOB_LIMITS.waiters} concurrent waiters. Missing ids return EXPIRED_JOB without echoing the supplied id; invalid options return VALIDATION for an existing job. Disposal ends active waits as unknown/RUNTIME_DISPOSED. Never resubmit automatically.`,
    details: () => ({ inputSchema: object({ jobId: string, options: object({ timeoutMs: { type: "number", exclusiveMinimum: 0, maximum: 2_147_483_647 } }) }, ["jobId"]),
      outputSchema: result(), examples: [{ jobId: "boot-example:job-1", options: { timeoutMs: 1000 } }] }),
  },
  "jobs.cancel": {
    title: "Request cancellation of an operation", kind: "command", effect: "ui-local",
    invocation: { arguments: [jsonArgument("jobId")], asynchronous: true, returns: "json" },
    description: "Requests abort only when that job supports cancellation. accepted means cancellationRequested, not confirmed cleanup or cancelled terminal state; the owner must settle the job. Repeated requests do not abort twice. Unsupported jobs return UNSUPPORTED; missing ids return EXPIRED_JOB. Already-terminal jobs return their stored result, including completed. Does not guarantee stopping remote work or roll back committed effects.",
    details: () => ({ inputSchema: jobInput(), outputSchema: result(true), examples: [{ jobId: "boot-example:job-1" }] }),
  },
  "logs.query": {
    title: "Read bounded local diagnostics", kind: "query", effect: "read",
    invocation: { arguments: [jsonArgument("filter", true)], asynchronous: false, returns: "json" },
    description: `Returns copied records in ascending sequence order. traceId/level/category match exactly; finite afterSequence is exclusive. Finite limit uses floor then clamps to 1..${DIAGNOSTIC_LIMITS.MAX_QUERY_LIMIT}; omitted/non-finite limit uses ${DIAGNOSTIC_LIMITS.DEFAULT_QUERY_LIMIT}. totalMatched is before paging; nextAfterSequence exists only when more matches remain. Default retention is ${DIAGNOSTIC_LIMITS.DEFAULT_MAX_ENTRIES} records or ${DIAGNOSTIC_LIMITS.DEFAULT_MAX_BYTES} encoded bytes, whichever is reached first; counters expose drops and sink failures.`,
    details: () => ({ inputSchema: object({ filter: logFilter() }), outputSchema: logPage(), examples: [{ filter: { traceId: "trace-example", limit: 100 } }] }),
  },
  "logs.export": {
    title: "Create a local diagnostic Blob", kind: "query", effect: "read",
    invocation: { arguments: [jsonArgument("filter", true)], asynchronous: false, returns: "blob" },
    description: "Returns a Blob with type application/x-ndjson, a diagnostic-summary first line and safe log records. Without limit exports all retained matches; explicit limit uses the same floor/clamp rule as logs.query. It does not download a file, access the clipboard, send data, or activate a remote sink; any later download is the caller's browser-controlled action.",
    details: () => ({ inputSchema: object({ filter: logFilter() }), outputSchema: nativeOutput("Native Blob; read its text() asynchronously to obtain JSONL."), examples: [{ filter: { traceId: "trace-example" } }] }),
  },
  "logs.clear": {
    title: "Clear local diagnostic retention", kind: "command", effect: "ui-local",
    invocation: { arguments: [], asynchronous: false, returns: "void" },
    description: "Clears retained records and resets drop/sink counters synchronously. Sequence remains monotonic for this boot. Returns undefined (void); does not clear application state, jobs, or remotely sent telemetry. This local diagnostic deletion is not replayed automatically.",
    details: () => ({ inputSchema: object(), outputSchema: nativeOutput("JavaScript void/undefined, not an ApiResult."), examples: [{}] }),
  },
  "events.subscribe": {
    title: "Subscribe to advisory application events", kind: "service", effect: "ui-local",
    invocation: { arguments: [jsonArgument("filter"), { name: "listener", kind: "callback" }], asynchronous: false, returns: "unsubscribe" },
    description: `Pass a native listener(event) callback as the second argument; callback is not JSON input. Returns an idempotent unsubscribe function. Throws for an invalid filter/listener, a closed stream or more than ${EVENT_LIMITS.subscribers} subscriptions. Observer throws/rejections are isolated. No replay; the bounded ${EVENT_LIMITS.queuedOperations}-operation queue may drop notifications. Empty types matches nothing; sections matches only state.changed and excludes job/frame events. Use each event's catalog descriptor for payloads and authoritative queries/jobs after gaps.`,
    details: () => ({ inputSchema: object({ filter: object({
      types: { type: "array", items: { type: "string", enum: EVENT_TYPES }, description: `At most ${EVENT_TYPES.length} items.` },
      sections: { type: "array", items: string, description: `At most ${EVENT_LIMITS.sections} names, each at most 64 characters.` },
    }) }, ["filter"]), outputSchema: nativeOutput("Native () => void unsubscribe function; safe to call repeatedly."), examples: [{ filter: { types: ["job.changed"] } }] }),
  },
};

export const AUXILIARY_IDS = Object.freeze(Object.keys(helpers));

export function auxiliarySummary(id: string, eventStreamClosed: boolean): ApiSummary | undefined {
  if (!Object.hasOwn(helpers, id)) return;
  const helper = helpers[id as ApiInvocation["method"]];
  const closed = id === "events.subscribe" && eventStreamClosed;
  return structuredClone({
    id, title: helper.title, version: "2.0.0", schemaRef: `facade:${id}:v2`, kind: helper.kind,
    scope: "p0-p3", effect: helper.effect, completion: "state-committed",
    completionNote: "Direct method return has the documented native shape; no execute completion guarantee is implied. Job status must be read from its result.",
    requirements: ["same-document-facade"], availability: closed ? "unavailable" : "ready",
    ...(closed ? { reason: "This document's event stream is closed." } : {}),
    invocation: { channel: "direct", method: id, ...helper.invocation },
  } as ApiSummary);
}

export function describeAuxiliary(id: string, eventStreamClosed: boolean): ApiDescriptor | undefined {
  const summary = auxiliarySummary(id, eventStreamClosed);
  if (!summary) return;
  const helper = helpers[id as ApiInvocation["method"]];
  return {
    ...summary,
    description: "Call v2." + id + " directly using invocation.arguments order; do not pass this id to execute/query. " +
      "inputSchema describes supported named JSON arguments, not a new validation/dispatch wrapper. No additional login or service permission is required beyond access to this document's facade. " + helper.description,
    ...structuredClone(helper.details()),
  };
}
