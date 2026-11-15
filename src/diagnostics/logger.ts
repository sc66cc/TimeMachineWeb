import { REDACTED, redactErrorMessage } from "../agent-actions/types";

export const DIAGNOSTIC_LIMITS = Object.freeze({
  DEFAULT_MAX_ENTRIES: 2000,
  DEFAULT_MAX_BYTES: 2 * 1024 * 1024,
  MAX_ENTRY_BYTES: 8 * 1024,
  MAX_STRING_BYTES: 256,
  MAX_MESSAGE_BYTES: 512,
  MAX_STACK_BYTES: 1536,
  DEFAULT_QUERY_LIMIT: 100,
  MAX_QUERY_LIMIT: 200,
});

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogCategory = "app" | "action" | "rpc" | "asset" | "worker" | "render" | "performance";
export interface LogContext {
  traceId?: string; parentId?: string; actionId?: string; requestId?: string; jobId?: string;
  projectId?: string | number; layerId?: string | number; featureId?: string; viewportId?: string;
  generation?: number; revision?: number;
}
export interface LogInput {
  level: LogLevel; category: LogCategory; event: string;
  durationMs?: number; outcome?: string; errorCode?: string;
  safeDetails?: Record<string, unknown>;
  error?: unknown;
}
export interface LogEvent extends LogContext {
  timestamp: string; monotonicMs: number; sequence: number;
  level: LogLevel; category: LogCategory; event: string;
  bootId: string; appVersion: string;
  durationMs?: number; outcome?: string; errorCode?: string;
  safeDetails?: Record<string, string | number | boolean>;
  error?: { name: string; message: string; stack?: string };
}
export interface LogFilter {
  traceId?: string; level?: LogLevel; category?: LogCategory;
  afterSequence?: number; limit?: number;
}
export interface LogPage {
  entries: LogEvent[]; totalMatched: number; retainedCount: number; retainedBytes: number;
  dropCount: number; sinkErrorCount: number; sinkSkippedCount: number;
  nextAfterSequence?: number;
}
export interface DiagnosticsLoggerOptions {
  bootId: string; appVersion: string;
  maxEntries?: number; maxBytes?: number; minLevel?: LogLevel;
  /** Explicit opt-in only; receives a safe copy. At most one async call is in flight. */
  sink?: (event: LogEvent) => void | Promise<void>;
}

const encoder = new TextEncoder();
const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];
const CATEGORIES: readonly LogCategory[] = ["app", "action", "rpc", "asset", "worker", "render", "performance"];
const CONTEXT_IDS = ["traceId", "parentId", "actionId", "requestId", "jobId", "projectId", "layerId", "featureId", "viewportId"] as const;
const NUMBER_DETAILS = ["count", "byteLength", "bytes", "featureCount", "pointCount", "frameCount", "workerCount", "primitiveCount", "imageryCount", "width", "height", "elapsedMs", "retryCount", "httpStatus", "rpcCode", "modelId", "anchorPlateId", "ageMa", "requestedAgeMa", "committedAgeMa", "frameAgeMa"] as const;
const BOOLEAN_DETAILS = ["cacheHit", "aborted", "remoteWrite", "clamped", "retryable"] as const;
const ENUM_DETAILS: Readonly<Record<string, readonly string[]>> = {
  status: ["idle", "loading", "ready", "pending", "accepted", "completed", "failed", "error", "cancelled", "superseded", "unknown", "missing", "hidden", "unavailable", "unsupported"],
  transportOutcome: ["success", "http-error", "network-error", "timeout", "cancelled", "decode-error", "unknown"],
  businessOutcome: ["success", "failure", "error", "unknown", "not-checked"],
  projectionId: ["globe", "rectangle", "mercator", "mollweide", "robinson"],
  sourceKind: ["local", "shared", "v2", "fixture", "none"],
  phase: ["started", "preparing", "loading", "committing", "completed", "failed", "cancelled"],
};
const OUTCOMES = ["started", "success", "failure", "failed", "completed", "cancelled", "superseded", "timeout", "unknown", "not-available", "unsupported", "accepted", "pending"];

/** Read only explicitly named data properties: never enumerate input bodies or invoke getters. */
function own(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function identifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= DIAGNOSTIC_LIMITS.MAX_STRING_BYTES && /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : undefined;
}
function boundedText(value: string, maxBytes: number): string {
  let bytes = 0, result = "";
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxBytes) break;
    result += character; bytes += size;
  }
  return result;
}
function safeText(value: string, maxBytes: number): string {
  // Bound inspection work before matching. All accepted strings are then redacted before storage.
  const inspected = value.slice(0, 16 * 1024);
  const stripped = inspected
    .replace(/\b(?:https?|wss?|file|ftp):\/\/[^\s<>"']+/gi, REDACTED)
    .replace(/\b(?:data|blob):[^\s<>"']+/gi, REDACTED)
    .replace(/(?:\/|\.{1,2}\/)[^\s"'<>?]*\?[^\s"'<>]+/g, REDACTED)
    .replace(/\?[a-zA-Z0-9_.%~-]+=[^\s"'<>]+/g, REDACTED)
    .replace(/["'](?:authorization|proxy-authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|password|passwd|pwd|secret|token|digest)["']\s*:\s*(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*')/gi, REDACTED)
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;)}\]"']+/gi, REDACTED)
    .replace(/\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g, REDACTED)
    .replace(/\{[^\r\n]*\}/g, REDACTED);
  return boundedText(redactErrorMessage(stripped), maxBytes);
}
function safeDetails(input: unknown): LogEvent["safeDetails"] {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const result: NonNullable<LogEvent["safeDetails"]> = {};
  const route = own(input, "rpcRoute");
  if (typeof route === "string" && route.length <= 256 && /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/.test(route)) result.rpcRoute = route;
  for (const key of NUMBER_DETAILS) { const value = own(input, key); if (finite(value)) result[key] = value; }
  for (const key of BOOLEAN_DETAILS) { const value = own(input, key); if (typeof value === "boolean") result[key] = value; }
  for (const [key, allowed] of Object.entries(ENUM_DETAILS)) {
    const value = own(input, key);
    if (typeof value === "string" && allowed.includes(value)) result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}
function safeError(input: unknown): LogEvent["error"] {
  const message = typeof input === "string" ? input : own(input, "message");
  if (typeof message !== "string") return undefined;
  const name = own(input, "name"), stack = own(input, "stack");
  return {
    name: typeof name === "string" && ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError"].includes(name) ? name : "Error",
    message: safeText(message, DIAGNOSTIC_LIMITS.MAX_MESSAGE_BYTES),
    ...(typeof stack === "string" ? { stack: safeText(stack, DIAGNOSTIC_LIMITS.MAX_STACK_BYTES) } : {}),
  };
}

interface StoredRecord { event: LogEvent; json: string; bytes: number }
const copy = (record: StoredRecord): LogEvent => JSON.parse(record.json) as LogEvent;

/** Local-only ring buffer. It owns no global handlers, storage, console output, downloads or network. */
export class DiagnosticsLogger {
  private readonly records: Array<StoredRecord | undefined>;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly minLevel: number;
  private readonly bootId: string;
  private readonly appVersion: string;
  private readonly sink: DiagnosticsLoggerOptions["sink"];
  private head = 0;
  private count = 0;
  private bytes = 0;
  private sequence = 0;
  private drops = 0;
  private sinkErrors = 0;
  private sinkSkipped = 0;
  private sinkBusy = false;
  private clearEpoch = 0;

  constructor(options: DiagnosticsLoggerOptions) {
    this.maxEntries = options.maxEntries ?? DIAGNOSTIC_LIMITS.DEFAULT_MAX_ENTRIES;
    this.maxBytes = options.maxBytes ?? DIAGNOSTIC_LIMITS.DEFAULT_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 || this.maxEntries > DIAGNOSTIC_LIMITS.DEFAULT_MAX_ENTRIES ||
        !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > DIAGNOSTIC_LIMITS.DEFAULT_MAX_BYTES) {
      throw new Error("Diagnostic capacity must be a positive integer within the supported limits.");
    }
    this.bootId = identifier(options.bootId) ?? "unknown-boot";
    this.appVersion = identifier(options.appVersion) ?? "unknown-version";
    this.minLevel = Math.max(0, LEVELS.indexOf(options.minLevel ?? "info"));
    this.sink = options.sink;
    this.records = new Array(this.maxEntries);
  }

  record(input: LogInput, context: LogContext = {}): LogEvent | undefined {
    try {
      const level = own(input, "level") as LogLevel, category = own(input, "category") as LogCategory;
      const eventName = identifier(own(input, "event"));
      if (!LEVELS.includes(level) || !CATEGORIES.includes(category) || !eventName) { this.drops++; return undefined; }
      if (LEVELS.indexOf(level) < this.minLevel) return undefined;
      const event: LogEvent = {
        timestamp: new Date().toISOString(), monotonicMs: performance.now(), sequence: ++this.sequence,
        bootId: this.bootId, appVersion: this.appVersion, level, category, event: eventName,
      };
      for (const key of CONTEXT_IDS) {
        const value = own(context, key);
        if (key === "featureId" && typeof value === "string" && value.length > 0) event.featureId = safeText(value, DIAGNOSTIC_LIMITS.MAX_STRING_BYTES);
        else if ((key === "layerId" || key === "projectId") && finite(value) && Number.isSafeInteger(value) && value >= 0) event[key] = value;
        else { const id = identifier(value); if (id) event[key] = id; }
      }
      for (const key of ["generation", "revision"] as const) {
        const value = own(context, key);
        if (finite(value) && Number.isSafeInteger(value) && value >= 0) event[key] = value;
      }
      const duration = own(input, "durationMs"), outcome = own(input, "outcome"), code = identifier(own(input, "errorCode"));
      if (finite(duration) && duration >= 0) event.durationMs = duration;
      if (typeof outcome === "string" && OUTCOMES.includes(outcome)) event.outcome = outcome;
      if (code) event.errorCode = code;
      const details = safeDetails(own(input, "safeDetails")), error = safeError(own(input, "error"));
      if (details) event.safeDetails = details;
      if (error) event.error = error;
      const json = JSON.stringify(event), bytes = encoder.encode(json + "\n").byteLength;
      if (bytes > DIAGNOSTIC_LIMITS.MAX_ENTRY_BYTES || bytes > this.maxBytes) { this.drops++; return undefined; }
      while (this.count >= this.maxEntries || this.bytes + bytes > this.maxBytes) this.evict();
      const stored = { event, json, bytes };
      this.records[(this.head + this.count) % this.maxEntries] = stored;
      this.count++; this.bytes += bytes;
      this.deliver(stored);
      return copy(stored);
    } catch {
      // Even hostile getters/proxies and serialization failures cannot break the caller's operation.
      this.drops++;
      return undefined;
    }
  }

  query(filter: LogFilter = {}): LogPage {
    const matched = this.matching(filter), limit = this.limit(filter.limit);
    const records = matched.slice(0, limit);
    return {
      entries: records.map(copy), totalMatched: matched.length, ...this.stats(),
      ...(matched.length > records.length ? { nextAfterSequence: records.at(-1)!.event.sequence } : {}),
    };
  }

  /** Default exports all retained matches; an explicit limit uses the same capped page size as query. */
  export(filter: LogFilter = {}): string {
    const records = this.matching(filter);
    const selected = filter.limit === undefined ? records : records.slice(0, this.limit(filter.limit));
    const summary = {
      type: "diagnostic-summary", schemaVersion: 1, bootId: this.bootId, appVersion: this.appVersion,
      ...this.stats(), exportedCount: selected.length, maxEntries: this.maxEntries, maxBytes: this.maxBytes,
    };
    return [JSON.stringify(summary), ...selected.map(record => record.json)].join("\n") + "\n";
  }

  /** Sequence stays monotonic for this boot; clear resets retention/drop/sink counters only. */
  clear(): void {
    this.records.fill(undefined); this.head = 0; this.count = 0; this.bytes = 0;
    this.drops = 0; this.sinkErrors = 0; this.sinkSkipped = 0; this.clearEpoch++;
  }

  private evict(): void {
    const first = this.records[this.head]!;
    this.bytes -= first.bytes; this.records[this.head] = undefined;
    this.head = (this.head + 1) % this.maxEntries; this.count--; this.drops++;
  }
  private stats() {
    return { retainedCount: this.count, retainedBytes: this.bytes, dropCount: this.drops, sinkErrorCount: this.sinkErrors, sinkSkippedCount: this.sinkSkipped };
  }
  private limit(value: number | undefined): number {
    return finite(value) ? Math.min(DIAGNOSTIC_LIMITS.MAX_QUERY_LIMIT, Math.max(1, Math.floor(value))) : DIAGNOSTIC_LIMITS.DEFAULT_QUERY_LIMIT;
  }
  private matching(filter: LogFilter): StoredRecord[] {
    const result: StoredRecord[] = [];
    for (let i = 0; i < this.count; i++) {
      const record = this.records[(this.head + i) % this.maxEntries]!;
      const event = record.event;
      if ((filter.traceId === undefined || event.traceId === filter.traceId) &&
          (filter.level === undefined || event.level === filter.level) &&
          (filter.category === undefined || event.category === filter.category) &&
          (!finite(filter.afterSequence) || event.sequence > filter.afterSequence)) result.push(record);
    }
    return result;
  }
  private deliver(record: StoredRecord): void {
    if (!this.sink) return;
    if (this.sinkBusy) { this.sinkSkipped++; return; }
    this.sinkBusy = true;
    const epoch = this.clearEpoch;
    try {
      const result = this.sink(copy(record));
      if (result && typeof result.then === "function") {
        void Promise.resolve(result).then(
          () => { this.sinkBusy = false; },
          () => { if (epoch === this.clearEpoch) this.sinkErrors++; this.sinkBusy = false; },
        );
      } else this.sinkBusy = false;
    } catch {
      if (epoch === this.clearEpoch) this.sinkErrors++;
      this.sinkBusy = false;
    }
  }
}
