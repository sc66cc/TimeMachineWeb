import type { AgentActionDefinition } from "./types";
import type { LogFilter, LogPage } from "../diagnostics/logger";

type SchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

/** The subset of JSON Schema consumed by the frontend contracts. */
export interface ApiSchema {
  /** Omitted for an unconstrained schema, including native non-JSON return documentation. */
  type?: SchemaType | readonly SchemaType[];
  description?: string;
  properties?: Record<string, ApiSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | ApiSchema;
  items?: ApiSchema;
  enum?: readonly (string | number | boolean | null)[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  minLength?: number;
  pattern?: string;
  minItems?: number;
  oneOf?: readonly ApiSchema[];
}

/** Direct helpers keep their existing positional facade signatures, not execute/query dispatch. */
export interface ApiInvocation {
  channel: "direct";
  method: "catalog.list" | "catalog.describe" | "jobs.get" | "jobs.wait" | "jobs.cancel" |
    "logs.query" | "logs.export" | "logs.clear" | "events.subscribe";
  arguments: readonly { name: string; kind: "json" | "callback"; optional?: boolean }[];
  asynchronous: boolean;
  returns: "json" | "json-or-undefined" | "blob" | "void" | "unsubscribe";
}

export interface ApiContractMetadata {
  kind: "command" | "query" | "event" | "service";
  scope: "p0-p3" | "existing" | "future" | "excluded";
  effect: "read" | "ui-local" | "project-local" | "remote-write";
  completion: "state-committed" | "frame-committed" | "page-reload" | "unverified";
  completionNote?: string;
  execution?: "inline" | "job";
  cancellationSupported?: boolean;
  invocation?: ApiInvocation;
  requirements: readonly string[];
}

export interface ApiContractDetails {
  inputSchema: ApiSchema;
  outputSchema: ApiSchema;
  examples: readonly unknown[];
}

export interface ApiSummary extends ApiContractMetadata {
  id: string;
  title: string;
  version: "2.0.0";
  availability: "ready" | "not-implemented" | "unavailable" | "out-of-scope";
  reason?: string;
  schemaRef: string;
}

export interface ApiDescriptor extends ApiSummary, ApiContractDetails {
  description: string;
}

export interface CatalogFilter {
  idPrefix?: string;
  kind?: ApiSummary["kind"];
  scope?: ApiSummary["scope"];
  availability?: ApiSummary["availability"];
}

export interface ExecuteOptions {
  completion?: "committed" | "accepted";
  timeoutMs?: number;
}

export type ApiTerminalResult =
  | { ok: true; status: "completed"; traceId: string; jobId?: string; revision?: number; data?: unknown; dataTruncated?: boolean }
  | { ok: false; status: "failed" | "unknown" | "cancelled" | "superseded"; traceId: string; jobId?: string;
      error: { kind: string; code: string; message: string; retryable: boolean } };

export type ApiResult = ApiTerminalResult |
  { ok: true; status: "accepted"; traceId: string; jobId: string; revision?: never; data?: never };

export interface WaitOptions { timeoutMs?: number }
export interface JobSnapshot {
  jobId: string;
  bootId: string;
  traceId: string;
  actionId: string;
  status: "running" | ApiTerminalResult["status"];
  cancellationSupported: boolean;
  cancellationRequested: boolean;
  startedAt: string;
  finishedAt?: string;
  result?: ApiTerminalResult;
}

interface EventIdentity {
  bootId: string;
  sequence: number;
  revision: number;
  /** Cumulative dropped queued notifications; query authoritative state/jobs after a gap. */
  droppedCount: number;
}

export interface StateChangedEvent extends EventIdentity {
  type: "state.changed";
  sections: string[];
}

export interface JobChangedEvent extends EventIdentity {
  type: "job.changed";
  traceId: string;
  actionId: string;
  jobId: string;
  phase: "accepted" | "terminal";
  status: JobSnapshot["status"];
}

export interface FrameCommittedEvent extends EventIdentity {
  type: "frame.committed";
  traceId: string;
  actionId: string;
  /** Inline/v1 UI operations have no asynchronous job. */
  jobId?: string;
}

export type AppEvent = StateChangedEvent | JobChangedEvent | FrameCommittedEvent;

export interface EventFilter {
  types?: readonly string[];
  sections?: readonly string[];
}

/** Additional surfaces are added when implemented, never empty-success stubs. */
export interface FrontendApiV2 {
  readonly version: "2.0.0";
  readonly catalog: {
    list(filter?: CatalogFilter): ApiSummary[];
    describe(id: string): Promise<ApiDescriptor | undefined>;
  };
  execute(id: string, input?: unknown, options?: ExecuteOptions): Promise<ApiResult>;
  query(id: string, input?: unknown): Promise<ApiResult>;
  readonly jobs: {
    get(jobId: string): JobSnapshot | undefined;
    wait(jobId: string, options?: WaitOptions): Promise<ApiTerminalResult>;
    cancel(jobId: string): Promise<ApiResult>;
  };
  readonly events: {
    subscribe(filter: EventFilter, listener: (event: AppEvent) => void): () => void;
  };
  readonly logs: {
    query(filter?: LogFilter): LogPage;
    export(filter?: LogFilter): Blob;
    clear(): void;
  };
}

export function basicContractDetails(definition: AgentActionDefinition): ApiContractDetails {
  return {
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(definition.params.map(param => [param.name, {
        type: param.type, description: param.description,
      }])),
      required: definition.params.filter(param => param.required).map(param => param.name),
      additionalProperties: false,
    },
    outputSchema: { type: "object", additionalProperties: true },
    examples: [],
  };
}

/** Validate before any handler runs; error text never echoes input values. */
export function validateApiInput(schema: ApiSchema, value: unknown): string | undefined {
  let visited = 0;
  const walk = (node: ApiSchema, input: unknown, path: string, depth: number): string | undefined => {
    if (++visited > 10000 || depth > 32) return `${path}: input exceeds validation limits.`;
    if (node.oneOf) {
      let matches = 0;
      for (const variant of node.oneOf) {
        if (walk(variant, input, path, depth + 1) === undefined) matches++;
      }
      if (matches !== 1) return `${path}: must match exactly one declared shape.`;
    }
    if (Array.isArray(node.type)) {
      for (const type of node.type) {
        if (walk({ ...node, type }, input, path, depth + 1) === undefined) return;
      }
      return `${path}: does not match the declared types or constraints.`;
    }
    if (node.enum && !node.enum.some(item => item === input)) return `${path}: value is outside the declared enum.`;
    if (node.type === undefined) return;
    if (node.type === "null") return input === null ? undefined : `${path}: expected null.`;
    if (node.type === "number" || node.type === "integer") {
      if (typeof input !== "number" || !Number.isFinite(input) || (node.type === "integer" && !Number.isInteger(input))) {
        return `${path}: expected a finite ${node.type}.`;
      }
      if ((node.minimum !== undefined && input < node.minimum) ||
          (node.maximum !== undefined && input > node.maximum) ||
          (node.exclusiveMinimum !== undefined && input <= node.exclusiveMinimum)) return `${path}: outside the declared range.`;
      return;
    }
    if (node.type === "array") {
      if (!Array.isArray(input)) return `${path}: expected an array.`;
      if (node.minItems !== undefined && input.length < node.minItems) return `${path}: too few items.`;
      if (node.items) for (let i = 0; i < input.length; i++) {
        const error = walk(node.items, input[i], `${path}[${i}]`, depth + 1);
        if (error) return error;
      }
      return;
    }
    if (node.type === "object") {
      if (typeof input !== "object" || input === null || Array.isArray(input) ||
          ![Object.prototype, null].includes(Object.getPrototypeOf(input))) return `${path}: expected a plain object.`;
      const record = input as Record<string, unknown>;
      for (const key of node.required ?? []) {
        if (!Object.hasOwn(record, key) || record[key] === undefined) return `${path}.${key}: required.`;
      }
      for (const key of Object.keys(record)) {
        const child = node.properties && Object.hasOwn(node.properties, key) ? node.properties[key] : undefined;
        if (!child && node.additionalProperties === false) return `${path}: contains an undeclared property.`;
        const rule = child ?? (typeof node.additionalProperties === "object" ? node.additionalProperties : undefined);
        if (rule) {
          // Dictionary keys are caller data, unlike names in our schema.
          const childPath = child ? `${path}.${key}` : `${path}[entry]`;
          const error = walk(rule, record[key], childPath, depth + 1);
          if (error) return error;
        }
      }
      return;
    }
    if (typeof input !== node.type) return `${path}: expected ${node.type}.`;
    if (node.type === "string" && node.minLength !== undefined && (input as string).length < node.minLength) return `${path}: too short.`;
    if (node.type === "string" && node.pattern !== undefined && !new RegExp(node.pattern).test(input as string)) return `${path}: does not match the declared format.`;
  };
  return walk(schema, value, "input", 0);
}
