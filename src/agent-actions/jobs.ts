import type { ApiResult, ApiTerminalResult, JobSnapshot, WaitOptions } from "./contracts";
import type { OperationContext } from "./operation";

export const JOB_LIMITS = Object.freeze({ records: 128, running: 8, waiters: 128, retentionMs: 300_000, resultBytes: 65_536, defaultWaitTimeoutMs: 30_000 });
interface JobRecord {
  snapshot: JobSnapshot;
  controller?: AbortController;
  finishedAt?: number;
  waiters: Set<(result: ApiTerminalResult) => void>;
}

/** Small bounded records for existing asynchronous owners, not a work scheduler. */
export class OperationJobs {
  private readonly records = new Map<string, JobRecord>();
  private sequence = 0;
  private waiting = 0;
  private closed = false;
  constructor(private readonly bootId: string) {}

  start(
    actionId: string, traceId: string, cancellationSupported: boolean,
    run: (context: OperationContext) => Promise<ApiTerminalResult>,
    onTerminal: (result: ApiTerminalResult) => void,
  ): ApiResult {
    this.prune();
    if (this.closed) return this.failure(traceId, "runtime-disposed", "This document's job table is closed.");
    if ([...this.records.values()].filter(row => row.snapshot.status === "running").length >= JOB_LIMITS.running) {
      return this.failure(traceId, "busy", "Too many running operations. Wait for an existing job.");
    }
    if (this.records.size >= JOB_LIMITS.records) {
      const completed = [...this.records.values()].filter(row => row.finishedAt !== undefined)
        .sort((a, b) => a.finishedAt! - b.finishedAt!)[0];
      if (completed) this.records.delete(completed.snapshot.jobId);
    }
    if (this.records.size >= JOB_LIMITS.records) return this.failure(traceId, "busy", "The operation record limit has been reached.");
    const jobId = `${this.bootId}:job-${++this.sequence}`;
    const controller = cancellationSupported ? new AbortController() : undefined;
    const row: JobRecord = { controller, waiters: new Set(), snapshot: {
      jobId, bootId: this.bootId, traceId, actionId, status: "running",
      cancellationSupported, cancellationRequested: false, startedAt: new Date().toISOString(),
    } };
    this.records.set(jobId, row);
    const settle = (result: ApiTerminalResult): void => {
      if (this.closed || row.snapshot.status !== "running") return;
      const stored = this.boundResult({ ...result, jobId });
      row.snapshot = { ...row.snapshot, status: stored.status, finishedAt: new Date().toISOString(), result: stored };
      row.finishedAt = Date.now();
      row.controller = undefined;
      // Terminal observers receive copies and cannot prevent waiters settling.
      try { void Promise.resolve(onTerminal(structuredClone(stored))).catch(() => {}); }
      catch { /* Diagnostics are secondary. */ }
      for (const done of [...row.waiters]) done(structuredClone(stored));
    };
    // Register first, then execute the one authoritative business operation.
    void Promise.resolve().then(() => this.closed
      ? this.failure(traceId, "runtime-disposed", "This document's job table is closed.", jobId)
      : run(Object.freeze({ traceId, jobId, signal: controller?.signal })))
      .then(settle, () => settle(this.failure(traceId, "internal", "Operation failed before producing a safe result.", jobId)));
    return { ok: true, status: "accepted", traceId, jobId };
  }

  get(jobId: string): JobSnapshot | undefined {
    this.prune();
    const row = this.records.get(jobId);
    return row ? structuredClone(row.snapshot) : undefined;
  }

  async wait(jobId: string, options: WaitOptions = {}): Promise<ApiTerminalResult> {
    this.prune();
    const row = this.records.get(jobId);
    if (!row) return this.missing(jobId);
    const { traceId } = row.snapshot;
    if (!options || typeof options !== "object" || Array.isArray(options) ||
        Object.keys(options).some(key => key !== "timeoutMs") ||
        (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > 2_147_483_647))) {
      return this.failure(traceId, "validation", "timeoutMs must be finite and in (0, 2147483647].", jobId);
    }
    if (row.snapshot.result) return structuredClone(row.snapshot.result);
    if (this.waiting >= JOB_LIMITS.waiters) return this.failure(traceId, "busy", "Too many operation waiters.", jobId);
    return new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = (result: ApiTerminalResult): void => {
        if (!row.waiters.delete(done)) return;
        this.waiting--;
        clearTimeout(timer);
        resolve(result);
      };
      this.waiting++;
      row.waiters.add(done);
      timer = setTimeout(() => done({
        ...this.failure(traceId, "timeout", "Only this wait timed out. Query or wait for the same job; do not resubmit the operation.", jobId),
        ok: false, status: "unknown",
      }), options.timeoutMs ?? JOB_LIMITS.defaultWaitTimeoutMs);
    });
  }

  async cancel(jobId: string): Promise<ApiResult> {
    this.prune();
    const row = this.records.get(jobId);
    if (!row) return this.missing(jobId);
    if (row.snapshot.result) return structuredClone(row.snapshot.result);
    if (!row.snapshot.cancellationSupported) return this.failure(row.snapshot.traceId, "unsupported", "This operation does not support cancellation.", jobId);
    if (!row.snapshot.cancellationRequested) {
      row.snapshot.cancellationRequested = true;
      row.controller!.abort();
    }
    // An abort request is not proof of cleanup. The owner must settle run().
    return { ok: true, status: "accepted", traceId: row.snapshot.traceId, jobId };
  }

  close(): void {
    this.closed = true;
    for (const [jobId, row] of this.records) {
      row.controller?.abort();
      for (const done of [...row.waiters]) done({
        ...this.failure(row.snapshot.traceId, "runtime-disposed", "The document was disposed; this local operation identity is no longer queryable.", jobId),
        ok: false, status: "unknown",
      });
    }
    this.records.clear();
  }

  private prune(): void {
    const cutoff = Date.now() - JOB_LIMITS.retentionMs;
    for (const [id, row] of this.records) if (row.finishedAt !== undefined && row.finishedAt <= cutoff) this.records.delete(id);
  }

  private missing(jobId: string): ApiTerminalResult {
    // Caller-controlled ids never enter error text or operation identity fields.
    return this.failure(`${this.bootId}:job-query`, "expired-job", "Unknown, expired or previous-document job. Do not automatically repeat the operation.");
  }

  private failure(traceId: string, kind: string, message: string, jobId?: string): Extract<ApiTerminalResult, { ok: false }> {
    return { ok: false, status: "failed", traceId, ...(jobId ? { jobId } : {}),
      error: { kind, code: kind.toUpperCase().replaceAll("-", "_"), message, retryable: false } };
  }

  private boundResult(result: ApiTerminalResult): ApiTerminalResult {
    try {
      const json = JSON.stringify(result);
      if (new TextEncoder().encode(json).byteLength <= JOB_LIMITS.resultBytes) return JSON.parse(json) as ApiTerminalResult;
    } catch { /* Do not retain non-JSON values from a broken owner. */ }
    // A diagnostic limit cannot undo a real commit or change cancellation into failure.
    if (result.ok) return { ok: true, status: "completed", traceId: result.traceId, jobId: result.jobId, revision: result.revision, dataTruncated: true };
    return { ok: false, status: result.status, traceId: result.traceId, jobId: result.jobId,
      error: { kind: result.error.kind, code: result.error.code, retryable: result.error.retryable,
        message: "Diagnostic error detail was omitted because it exceeded retention limits." } };
  }
}
