import { RPCFile } from "./rpc-file";

export type RPCResponseType =
  | "arraybuffer"
  | "blob"
  | "document"
  | "json"
  | "text"
  | "stream";

export interface RPCRequestContext {
  traceId?: string;
  actionId?: string;
  jobId?: string;
  generation?: number;
  revision?: number;
}

/** Local transport controls. These fields never belong to an RPC header or payload. */
export interface RPCRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  context?: Readonly<RPCRequestContext>;
  /** Only the caller that knows this endpoint's envelope contract may supply this. */
  businessSuccessCode?: number;
  /** Suppresses diagnostics for a telemetry request; does not disable auth handling. */
  suppressTelemetry?: boolean;
}

function copyContext(input: RPCRequestContext | undefined): Readonly<RPCRequestContext> {
  const context: RPCRequestContext = {};
  for (const key of ["traceId", "actionId", "jobId"] as const) {
    const value = input && Object.getOwnPropertyDescriptor(input, key)?.value;
    if (typeof value === "string" && value.length <= 256 && /^[a-zA-Z0-9_.:-]+$/.test(value)) context[key] = value;
  }
  for (const key of ["generation", "revision"] as const) {
    const value = input && Object.getOwnPropertyDescriptor(input, key)?.value;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) context[key] = value;
  }
  return Object.freeze(context);
}

export class RPCUploadStream {
  readonly Header = new Map<string, string | undefined>();
  readonly JsonList = new Map<string, unknown>();
  readonly FileList = new Map<string, RPCFile>();
  readonly Options: Readonly<RPCRequestOptions>;
  ResponseType?: RPCResponseType;

  constructor(options: RPCRequestOptions = {}) {
    this.Options = Object.freeze({
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      context: copyContext(options.context),
      businessSuccessCode: options.businessSuccessCode,
      suppressTelemetry: options.suppressTelemetry === true,
    });
  }

  AddHeader(key: string, value: string | undefined): void {
    this.Header.set(key, value);
  }

  AddField(key: string, value?: unknown): void {
    if (value == null) {
      return;
    }
    if (value instanceof RPCFile) {
      this.FileList.set(key, value);
      return;
    }
    if (
      Array.isArray(value) &&
      value.every((item) => item instanceof RPCFile)
    ) {
      for (const item of value) {
        this.FileList.set(item.Name, item);
      }
      return;
    }
    this.JsonList.set(key, value);
  }

  static MapToRPCMap(
    list: ReadonlyMap<string, unknown>,
  ): Record<string, unknown> {
    return Object.fromEntries(
      [...list].map(([key, value]) => [key, normalizeRPCValue(value)]),
    );
  }

  static MapToURLParam(list: ReadonlyMap<string, unknown>): string {
    const parameters = new URLSearchParams();
    for (const [key, value] of list) {
      parameters.set(key, String(value));
    }
    return parameters.toString();
  }
}

function normalizeRPCValue(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value].map(([key, nested]) => [
        String(key),
        normalizeRPCValue(nested),
      ]),
    );
  }
  if (Array.isArray(value)) {
    return value.map(normalizeRPCValue);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    !(value instanceof Date) &&
    !(value instanceof Blob)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [
        key,
        normalizeRPCValue(nested),
      ]),
    );
  }
  return value;
}
