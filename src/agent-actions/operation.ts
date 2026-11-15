/** Explicit per-operation identity; never stored as a mutable global trace. */
export interface OperationContext {
  readonly traceId: string;
  readonly jobId?: string;
  readonly signal?: AbortSignal;
}

/** A business owner has stopped this operation from committing late results. */
export class OperationInterruptedError extends Error {
  constructor(readonly reason: "cancelled" | "superseded", message?: string) {
    super(message ?? (reason === "cancelled" ? "Operation cancelled." : "Operation superseded."));
    this.name = "OperationInterruptedError";
  }
}
