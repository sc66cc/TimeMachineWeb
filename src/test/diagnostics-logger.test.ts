import { describe, expect, it, vi } from "vitest";
import { DiagnosticsLogger, DIAGNOSTIC_LIMITS } from "../diagnostics/logger";

const createLogger = (options: Partial<ConstructorParameters<typeof DiagnosticsLogger>[0]> = {}) =>
  new DiagnosticsLogger({ bootId: "boot-test", appVersion: "test-v1", ...options });
const entry = { level: "info", category: "action", event: "action.completed" } as const;
const encodedBytes = (value: string) => new TextEncoder().encode(value).byteLength;

describe("bounded local diagnostics", () => {
  it("records bounded feature identity while excluding sensitive identifier text", () => {
    const logger = createLogger();
    expect(logger.record(entry, { layerId: 103, featureId: "seam-line" })).toMatchObject({ layerId: 103, featureId: "seam-line" });
    expect(logger.record(entry, { featureId: "fixture:lines-v1#feature:0" })?.featureId).toBe("fixture:lines-v1#feature:0");
    logger.record(entry, { featureId: "token=synthetic-feature-secret" });
    logger.record(entry, { featureId: "x".repeat(1000) });
    expect(logger.export()).not.toContain("synthetic-feature-secret");
    for (const event of logger.query().entries) expect(encodedBytes(event.featureId ?? "")).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.MAX_STRING_BYTES);
  });
  it("records explicit context, is silent by default, and filters debug", () => {
    const log = vi.spyOn(console, "log"), warn = vi.spyOn(console, "warn"), error = vi.spyOn(console, "error");
    try {
      const logger = createLogger();
      expect(logger.record({ ...entry, level: "debug" })).toBeUndefined();
      const recorded = logger.record(entry, { traceId: "trace-a", actionId: "time.set", jobId: "job-a", requestId: "request-a", generation: 2, revision: 3 });
      expect(recorded).toMatchObject({ bootId: "boot-test", appVersion: "test-v1", sequence: 1, traceId: "trace-a", actionId: "time.set", jobId: "job-a", requestId: "request-a", generation: 2, revision: 3 });
      expect(logger.query().dropCount).toBe(0);
      expect(log).not.toHaveBeenCalled(); expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); warn.mockRestore(); error.mockRestore(); }
  });

  it("enforces the default 2000-entry capacity and bounded query pages", () => {
    const logger = createLogger();
    for (let i = 0; i < 2005; i++) logger.record(entry);
    const page = logger.query({ limit: 100000 });
    expect(DIAGNOSTIC_LIMITS.DEFAULT_MAX_ENTRIES).toBe(2000);
    expect(DIAGNOSTIC_LIMITS.DEFAULT_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(page.retainedCount).toBe(2000);
    expect(page.entries).toHaveLength(200);
    expect(page.entries[0]!.sequence).toBe(6);
    expect(page.dropCount).toBe(5);
    expect(page.retainedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  });

  it("enforces encoded UTF-8 bytes independently of entry count and drops oversized entries", () => {
    const logger = createLogger({ maxEntries: 100, maxBytes: 1300 });
    for (let i = 0; i < 20; i++) logger.record({ ...entry, error: { message: "界".repeat(100) } });
    const page = logger.query();
    expect(page.retainedCount).toBeGreaterThan(0);
    expect(page.retainedCount).toBeLessThan(20);
    expect(page.dropCount).toBe(20 - page.retainedCount);
    expect(page.retainedBytes).toBeLessThanOrEqual(1300);
    expect(page.retainedBytes).toBe(page.entries.reduce((bytes, item) => bytes + encodedBytes(JSON.stringify(item) + "\n"), 0));
    const tiny = createLogger({ maxBytes: 1 });
    expect(tiny.record(entry)).toBeUndefined();
    expect(tiny.query()).toMatchObject({ retainedCount: 0, retainedBytes: 0, dropCount: 1 });
  });

  it("hits the default 2 MiB limit before the default entry limit for large sanitized errors", () => {
    const logger = createLogger();
    for (let i = 0; i < 1500; i++) logger.record({ ...entry, error: { message: "m".repeat(500), stack: "s".repeat(1500) } });
    const page = logger.query();
    const exported = logger.export().trim().split("\n").slice(1);
    expect(page.retainedCount).toBeGreaterThan(0);
    expect(page.retainedCount).toBeLessThan(1500);
    expect(page.dropCount).toBe(1500 - page.retainedCount);
    expect(page.retainedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(page.retainedBytes).toBe(exported.reduce((bytes, line) => bytes + encodedBytes(line + "\n"), 0));
    expect(JSON.parse(exported[0]!).sequence).toBe(page.dropCount + 1);
  });

  it("caps strings and individual entries after redaction", () => {
    const logger = createLogger();
    const error = new Error("界".repeat(5000) + " token=SECRET_TAIL");
    error.stack = "界".repeat(20000);
    const record = logger.record({ ...entry, error }, { traceId: "t".repeat(1000) })!;
    expect(encodedBytes(record.error!.message)).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.MAX_MESSAGE_BYTES);
    expect(encodedBytes(record.error!.stack ?? "")).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.MAX_STACK_BYTES);
    expect(encodedBytes(record.traceId ?? "")).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.MAX_STRING_BYTES);
    expect(encodedBytes(JSON.stringify(record) + "\n")).toBeLessThanOrEqual(DIAGNOSTIC_LIMITS.MAX_ENTRY_BYTES);
    expect(logger.export()).not.toContain("SECRET_TAIL");
  });

  it("keeps asynchronous operation contexts separate and copies them on record", async () => {
    const logger = createLogger();
    const a = { traceId: "trace-a", actionId: "time.set", generation: 1 };
    const b = { traceId: "trace-b", actionId: "projection.select", generation: 2 };
    logger.record({ ...entry, event: "action.started" }, a);
    await Promise.all([
      Promise.resolve().then(() => logger.record(entry, b)),
      Promise.resolve().then(() => logger.record(entry, a)),
    ]);
    a.traceId = "changed";
    expect(logger.query({ traceId: "trace-a" }).entries.map(value => value.generation)).toEqual([1, 1]);
    expect(logger.query({ traceId: "trace-b" }).entries.map(value => value.generation)).toEqual([2]);
  });

  it("drops unknown/nested fields and redacts credentials, URL queries and exception strings before any sink", () => {
    const sink = vi.fn();
    const logger = createLogger({ sink });
    const secretMessage = 'password="SECRET_PASSWORD" token=SECRET_TOKEN Authorization: Bearer SECRET_BEARER https://example.invalid/private/SECRET_PATH?X-Amz-Signature=SECRET_SIGNATURE#SECRET_FRAGMENT /path?signature=SECRET_QUERY data:text/plain,SECRET_FILE Bearer SECRET_LOOSE {"api_key":"SECRET_JSON"}';
    const cyclic: Record<string, unknown> = { token: "SECRET_NESTED" }; cyclic.self = cyclic;
    const raw = { ...entry, params: { password: "SECRET_PARAMS" }, error: new Error(secretMessage), safeDetails: { count: 2, cacheHit: false, httpStatus: 200, transportOutcome: "success", businessOutcome: "failure", body: "SECRET_BODY", attributes: cyclic, file: new Blob(["SECRET_BLOB"]), status: cyclic } };
    expect(() => logger.record(raw)).not.toThrow();
    const serialized = logger.export() + JSON.stringify(logger.query()) + JSON.stringify(sink.mock.calls);
    for (const secret of ["PASSWORD", "TOKEN", "BEARER", "PATH", "SIGNATURE", "FRAGMENT", "QUERY", "FILE", "LOOSE", "JSON", "NESTED", "PARAMS", "BODY", "BLOB"]) expect(serialized).not.toContain("SECRET_" + secret);
    expect(logger.query().entries[0]!.safeDetails).toEqual({ count: 2, cacheHit: false, httpStatus: 200, transportOutcome: "success", businessOutcome: "failure" });
  });

  it("never invokes unknown getters or traverses deep bodies", () => {
    const logger = createLogger();
    const getter = vi.fn(() => { throw new Error("SECRET_GETTER"); });
    const details = Object.defineProperty({ count: 3 }, "body", { enumerable: true, get: getter });
    expect(() => logger.record({ ...entry, safeDetails: details })).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(logger.query().entries[0]!.safeDetails).toEqual({ count: 3 });
  });

  it("uses stable redaction markers when URL and credential sanitizers compose", () => {
    const logger = createLogger();
    const once = logger.record({ ...entry, error: "Authorization: Bearer SECRET_BEARER token=https://example.invalid/?signature=SECRET_SIGNATURE" })!;
    expect(once.error!.message).toBe("Authorization: [redacted] token=[redacted]");
    const twice = logger.record({ ...entry, error: once.error!.message })!;
    expect(twice.error!.message).toBe(once.error!.message);
  });

  it("returns independent copies through record, query and the sink", () => {
    const logger = createLogger({ sink: value => { value.event = "sink.changed"; if (value.safeDetails) value.safeDetails.count = 999; } });
    const recorded = logger.record({ ...entry, safeDetails: { count: 1 } })!;
    recorded.event = "caller.changed"; recorded.safeDetails!.count = 888;
    const queried = logger.query(); queried.entries[0]!.event = "query.changed"; queried.entries[0]!.safeDetails!.count = 777;
    expect(logger.query().entries[0]).toMatchObject({ event: "action.completed", safeDetails: { count: 1 } });
  });

  it("isolates synchronous and asynchronous sink failures without recursive logs", async () => {
    const synchronous = createLogger({ sink: () => { throw new Error("SECRET_SINK"); } });
    expect(() => synchronous.record(entry)).not.toThrow();
    expect(synchronous.query()).toMatchObject({ retainedCount: 1, sinkErrorCount: 1 });
    const asynchronous = createLogger({ sink: async () => { throw new Error("SECRET_ASYNC"); } });
    expect(() => asynchronous.record(entry)).not.toThrow();
    await Promise.resolve(); await Promise.resolve();
    expect(asynchronous.query()).toMatchObject({ retainedCount: 1, sinkErrorCount: 1 });
    expect(synchronous.export() + asynchronous.export()).not.toContain("SECRET_");
  });

  it("bounds sink work and prevents synchronous sink recursion", async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const sink = vi.fn(() => pending);
    const logger = createLogger({ sink });
    for (let i = 0; i < 20; i++) logger.record(entry);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(logger.query()).toMatchObject({ retainedCount: 20, sinkSkippedCount: 19 });
    release(); await pending; await Promise.resolve();
    logger.record(entry); expect(sink).toHaveBeenCalledTimes(2);
    let recursive!: DiagnosticsLogger;
    recursive = createLogger({ sink: () => { recursive.record(entry); } });
    recursive.record(entry);
    expect(recursive.query()).toMatchObject({ retainedCount: 2, sinkSkippedCount: 1 });
  });

  it("filters and paginates ascending sequences, and exports all matching records as JSONL", () => {
    const logger = createLogger();
    for (let i = 0; i < 250; i++) logger.record({ ...entry, level: i % 2 ? "warn" : "info" }, { traceId: "trace-a" });
    const first = logger.query({ traceId: "trace-a", level: "warn", category: "action", limit: 2 });
    expect(first.entries.map(item => item.sequence)).toEqual([2, 4]);
    expect(first.totalMatched).toBe(125);
    const next = logger.query({ level: "warn", afterSequence: first.nextAfterSequence, limit: 2 });
    expect(next.entries.map(item => item.sequence)).toEqual([6, 8]);
    const lines = logger.export({ traceId: "trace-a" }).trim().split("\n").map(line => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "diagnostic-summary", bootId: "boot-test", appVersion: "test-v1", retainedCount: 250 });
    expect(lines).toHaveLength(251);
    expect(lines.at(-1).sequence).toBe(250);
  });

  it("clears records and counters without reusing sequence IDs", () => {
    const logger = createLogger({ maxEntries: 1 });
    logger.record(entry); logger.record(entry);
    expect(logger.query().dropCount).toBe(1);
    logger.clear();
    expect(logger.query()).toMatchObject({ entries: [], retainedBytes: 0, dropCount: 0, sinkErrorCount: 0, sinkSkippedCount: 0 });
    expect(logger.record(entry)!.sequence).toBe(3);
  });

  it("does not restore old sink errors after clear or create an unbounded second sink", async () => {
    let reject!: (reason: unknown) => void;
    const pending = new Promise<void>((_, fail) => { reject = fail; });
    const sink = vi.fn(() => pending);
    const logger = createLogger({ sink });
    logger.record(entry);
    logger.clear();
    logger.record(entry);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(logger.query()).toMatchObject({ retainedCount: 1, sinkSkippedCount: 1, sinkErrorCount: 0 });
    reject(new Error("SECRET_OLD_SINK"));
    await Promise.resolve(); await Promise.resolve();
    expect(logger.query()).toMatchObject({ retainedCount: 1, sinkErrorCount: 0 });
    expect(logger.export()).not.toContain("SECRET_OLD_SINK");
  });
});
