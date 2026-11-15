import type { AppEvent, EventFilter, FrameCommittedEvent, JobChangedEvent } from "./contracts";

export const EVENT_TYPES = ["state.changed", "job.changed", "frame.committed"] as const;
export const EVENT_LIMITS = Object.freeze({ subscribers: 128, queuedOperations: 256, sections: 64, identifierLength: 128 });
type OperationIdentity = Pick<FrameCommittedEvent, "traceId" | "actionId" | "jobId">;
type PendingOperation = Omit<JobChangedEvent, "bootId" | "sequence" | "droppedCount"> |
  Omit<FrameCommittedEvent, "bootId" | "sequence" | "droppedCount">;

/** Bounded advisory notifications. State providers and jobs remain authoritative. */
export class StateEvents {
  private readonly listeners = new Set<{ filter: EventFilter; listener: (event: AppEvent) => void }>();
  private readonly pending = new Set<string>();
  private readonly operations: PendingOperation[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revision = 0;
  private sequence = 0;
  private droppedCount = 0;
  private closed = false;

  constructor(private readonly bootId: string) {}
  get isClosed(): boolean { return this.closed; }

  subscribe(filter: EventFilter, listener: (event: AppEvent) => void): () => void {
    if (this.closed) throw new Error("State event stream is closed.");
    if (!filter || typeof filter !== "object" || Array.isArray(filter) || typeof listener !== "function" ||
        Object.keys(filter).some(key => key !== "types" && key !== "sections") ||
        (filter.types !== undefined && (!Array.isArray(filter.types) || filter.types.length > EVENT_TYPES.length ||
          filter.types.some(type => !(EVENT_TYPES as readonly string[]).includes(type)))) ||
        (filter.sections !== undefined && (!Array.isArray(filter.sections) || filter.sections.length > EVENT_LIMITS.sections ||
          filter.sections.some(section => typeof section !== "string" || section.length > 64)))) {
      throw new Error("Invalid state event filter or listener.");
    }
    if (this.listeners.size >= EVENT_LIMITS.subscribers) throw new Error("State event subscriber limit reached.");
    const subscription = { filter: structuredClone(filter), listener };
    this.listeners.add(subscription);
    return () => { this.listeners.delete(subscription); };
  }

  publish(revision: number, sections: readonly string[]): void {
    if (this.closed || !this.listeners.size) return;
    this.revision = revision;
    for (const section of sections) {
      if (this.pending.has(section)) continue;
      // Providers are bounded too, but remove/re-add churn in one turn must not
      // grow a merged invalidation indefinitely. A gap requires a fresh query.
      if (this.pending.size >= EVENT_LIMITS.sections) { this.droppedCount++; continue; }
      this.pending.add(section.slice(0, 64));
    }
    this.schedule();
  }

  publishJob(revision: number, identity: OperationIdentity & { jobId: string }, phase: JobChangedEvent["phase"], status: JobChangedEvent["status"]): void {
    this.enqueue({ type: "job.changed", revision, ...this.identity(identity), jobId: identity.jobId.slice(0, EVENT_LIMITS.identifierLength), phase, status });
  }

  publishFrame(revision: number, identity: OperationIdentity): void {
    this.enqueue({ type: "frame.committed", revision, ...this.identity(identity) });
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
    this.operations.length = 0;
    this.listeners.clear();
  }

  private identity(identity: OperationIdentity): OperationIdentity {
    // Only trusted operation identifiers enter the stream, never params/results.
    return { traceId: identity.traceId.slice(0, EVENT_LIMITS.identifierLength), actionId: identity.actionId.slice(0, EVENT_LIMITS.identifierLength),
      ...(identity.jobId === undefined ? {} : { jobId: identity.jobId.slice(0, EVENT_LIMITS.identifierLength) }) };
  }

  private enqueue(event: PendingOperation): void {
    if (this.closed || !this.listeners.size) return;
    if (this.operations.length >= EVENT_LIMITS.queuedOperations) {
      this.operations.shift();
      this.droppedCount++;
    }
    this.operations.push(event);
    this.schedule();
  }

  private schedule(): void {
    // Reentrant observers yield to another turn instead of recursively
    // dispatching or starving rendering with an unbounded microtask chain.
    this.timer ??= setTimeout(() => this.flush(), 0);
  }

  private flush(): void {
    this.timer = undefined;
    const pending = this.operations.splice(0);
    const sections = [...this.pending].sort();
    const revision = this.revision;
    this.pending.clear();
    const deliver = (payload: PendingOperation | { type: "state.changed"; revision: number; sections: string[] }): void => {
      if (this.closed) return;
      const event: AppEvent = { ...payload, bootId: this.bootId, sequence: ++this.sequence, droppedCount: this.droppedCount };
      for (const subscription of [...this.listeners]) {
        if (!this.listeners.has(subscription)) continue;
        const { filter, listener } = subscription;
        if (filter.types && !filter.types.includes(event.type)) continue;
        if (filter.sections && (event.type !== "state.changed" || !filter.sections.some(section => event.sections.includes(section)))) continue;
        try { void Promise.resolve(listener(structuredClone(event))).catch(() => {}); }
        catch { /* Debug observers cannot break the app or other observers. */ }
      }
    };
    for (const event of pending) deliver(event);
    // A merged invalidation has no unique trace and may cover several jobs.
    if (sections.length) deliver({ type: "state.changed", revision, sections });
  }
}
