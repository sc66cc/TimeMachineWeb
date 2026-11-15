import { RPCUploadStream, type RPCRequestContext } from "./rpc-upload-stream";

export type RPCMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface RPCTransportResponse<T = unknown> {
  data: T;
  headers: Record<string, string>;
  status: number;
}

export type RPCTransportOutcome = "success" | "http-error" | "network-error" | "timeout" | "cancelled" | "decode-error";

export interface RPCTelemetryEvent extends RPCRequestContext {
  elapsedMs: number;
  method: RPCMethod;
  /** Compatibility alias of transportOutcome. */
  outcome: RPCTransportOutcome;
  transportOutcome: RPCTransportOutcome;
  businessOutcome: "success" | "failure" | "not-checked";
  requestId: string;
  completion?: "response-read" | "headers-received";
  /** Route identifiers only; never a base URL, query, fragment or dynamic resource URL. */
  path: string;
  rpcCode?: number;
  status?: number;
}

export interface RPCAuthEvent extends RPCRequestContext {
  code: number;
  kind: "login-expired" | "token-empty";
  path: string;
  requestId?: string;
}

export interface RPCClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  getAccessToken?: () => string | null | undefined;
  getRequestToken?: (path: string) => string | null | undefined;
  getLanguage?: () => number | string;
  getTimeZone?: () => string;
  loginExpiredCode?: number;
  tokenEmptyCode?: number;
  /** No implicit deadline for legacy callers; app configuration can supply a finite default. */
  defaultTimeoutMs?: number;
  // unknown preserves existing callbacks that return Array.push's count as well as async callbacks.
  onAuthEvent?: (event: RPCAuthEvent) => unknown;
  onTelemetry?: (event: RPCTelemetryEvent) => unknown;
}

export class RPCRequestError extends Error {
  constructor(
    readonly kind: "network-error" | "timeout" | "cancelled" | "decode-error",
    readonly requestId: string,
    readonly path: string,
  ) {
    super(`RPC ${path}: ${kind}.`);
    this.name = "RPCRequestError";
  }
}

export class RPCHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly response: RPCTransportResponse,
    readonly requestId?: string,
  ) {
    super(`RPC ${path} returned HTTP ${status}.`);
    this.name = "RPCHttpError";
  }
}

let requestSequence = 0;
const requestPrefix = `rpc-${Math.random().toString(36).slice(2, 10)}`;

function safeRoute(path: string): string {
  return path.length <= 256 && /^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+$/.test(path) ? path : "[redacted-route]";
}

function validateTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff)) {
    throw new TypeError("RPC timeout must be positive and within the timer range.");
  }
}

/** Observers are optional side effects and may neither fail nor delay the request. */
function notify<T>(observer: ((event: T) => unknown) | undefined, event: T): void {
  if (!observer) return;
  try { void Promise.resolve(observer(event)).catch(() => {}); }
  catch { /* Do not recursively report an observer's own failure. */ }
}

function defaultTimeZone(): string {
  const offsetMinutes = new Date().getTimezoneOffset();
  const eastwardHours = -offsetMinutes / 60;
  return Number.isInteger(eastwardHours)
    ? String(eastwardHours)
    : eastwardHours.toFixed(2);
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function rpcCode(data: unknown): number | undefined {
  if (
    typeof data === "object" &&
    data !== null &&
    "Code" in data &&
    typeof data.Code === "number" && Number.isFinite(data.Code)
  ) {
    return data.Code;
  }
  return undefined;
}

async function readResponse(
  response: Response,
  responseType: RPCUploadStream["ResponseType"],
): Promise<unknown> {
  switch (responseType) {
    case "arraybuffer":
      return response.arrayBuffer();
    case "blob":
      return response.blob();
    case "stream":
      return response.body;
    case "text":
    case "document":
      return response.text();
    case "json":
      return response.json();
    default: {
      if (response.status === 204) {
        return undefined;
      }
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as unknown;
        if (typeof parsed === "string") {
          try {
            return JSON.parse(parsed);
          } catch {
            return parsed;
          }
        }
        return parsed;
      } catch {
        return text;
      }
    }
  }
}

export function rpcPath(moduleUrl: string, functionUrl: string): string {
  const modulePart = moduleUrl.replace(/^\/+|\/+$/g, "");
  const functionPart = functionUrl.replace(/^\/+|\/+$/g, "");
  return `/${modulePart}/${functionPart}`;
}

export class RPCClient {
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: RPCClientOptions) {
    validateTimeout(options.defaultTimeoutMs);
    this.fetchImplementation =
      options.fetch ??
      ((input, init) => globalThis.fetch(input, init));
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
  }

  async request<T = unknown>(
    method: RPCMethod,
    moduleUrl: string,
    functionUrl: string,
    input = new RPCUploadStream(),
  ): Promise<RPCTransportResponse<T>> {
    const path = rpcPath(moduleUrl, functionUrl);
    const diagnosticPath = safeRoute(path);
    const started = performance.now();
    const requestId = `${requestPrefix}-${++requestSequence}`;
    const local = input.Options;
    const context = { ...local.context };
    const timeoutMs = local.timeoutMs ?? this.options.defaultTimeoutMs;
    validateTimeout(timeoutMs);
    if (local.businessSuccessCode !== undefined && !Number.isFinite(local.businessSuccessCode)) {
      throw new TypeError("RPC business success code must be finite.");
    }
    const emit = (outcome: RPCTransportOutcome, extra: Partial<RPCTelemetryEvent> = {}): void => {
      if (local.suppressTelemetry) return;
      notify(this.options.onTelemetry, {
        ...context, elapsedMs: performance.now() - started, method, path: diagnosticPath,
        requestId, outcome, transportOutcome: outcome, businessOutcome: "not-checked", ...extra,
      });
    };
    if (local.signal?.aborted) {
      emit("cancelled");
      throw new RPCRequestError("cancelled", requestId, diagnosticPath);
    }

    // Keep the wire representation unchanged. Local options are not part of any Map.
    const requestToken = this.options.getRequestToken?.(path);
    if (requestToken) {
      input.AddHeader("RequestTokenKey", path);
      input.AddHeader(path, requestToken);
    }
    input.AddHeader(
      "TimeZone",
      this.options.getTimeZone?.() ?? defaultTimeZone(),
    );
    input.AddHeader(
      "Language",
      String(this.options.getLanguage?.() ?? 0),
    );

    const headers = new Headers({
      Accept: "application/json, application/octet-stream",
      "Custom-Header": JSON.stringify(
        RPCUploadStream.MapToRPCMap(input.Header),
      ),
    });
    const accessToken = this.options.getAccessToken?.();
    if (accessToken) {
      headers.set("Authorization", accessToken);
    }

    let url = `${this.baseUrl}${path}`;
    let body: BodyInit | undefined;
    if (input.FileList.size > 0) {
      const query = RPCUploadStream.MapToURLParam(input.JsonList);
      if (query) {
        url += `?${query}`;
      }
      body = input.FileList.values().next().value?.Content;
    } else if (method !== "GET" && method !== "DELETE") {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(RPCUploadStream.MapToRPCMap(input.JsonList));
    } else {
      const query = RPCUploadStream.MapToURLParam(input.JsonList);
      if (query) {
        url += `?${query}`;
      }
    }

    const controller = new AbortController();
    let abortKind: "timeout" | "cancelled" | undefined;
    let rejectAbort!: (error: RPCRequestError) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    // A signal can abort synchronously while listeners are being attached.
    void aborted.catch(() => {});
    const abort = (kind: "timeout" | "cancelled"): void => {
      if (abortKind) return;
      abortKind = kind;
      controller.abort();
      rejectAbort(new RPCRequestError(kind, requestId, diagnosticPath));
    };
    const onAbort = (): void => abort("cancelled");
    local.signal?.addEventListener("abort", onAbort, { once: true });
    if (local.signal?.aborted) onAbort();
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => abort("timeout"), timeoutMs);
    let response: Response | undefined;
    let readingBody = false;
    const perform = async (): Promise<unknown> => {
      if (abortKind) throw new RPCRequestError(abortKind, requestId, diagnosticPath);
      response = await this.fetchImplementation(url, { body, headers, method, signal: controller.signal });
      if (abortKind) throw new RPCRequestError(abortKind, requestId, diagnosticPath);
      readingBody = true;
      return readResponse(response, input.ResponseType);
    };
    try {
      const data = await Promise.race([perform(), aborted]);
      if (abortKind) throw new RPCRequestError(abortKind, requestId, diagnosticPath);
      const received = response!;
      const result: RPCTransportResponse<T> = {
        data: data as T,
        headers: headersToRecord(received.headers),
        status: received.status,
      };
      const code = rpcCode(data);
      this.notifyAuthEvent(diagnosticPath, code, requestId, context);
      if (!received.ok) {
        throw new RPCHttpError(received.status, diagnosticPath, result, requestId);
      }
      emit("success", {
        rpcCode: code, status: received.status,
        businessOutcome: code !== undefined && local.businessSuccessCode !== undefined
          ? code === local.businessSuccessCode ? "success" : "failure" : "not-checked",
        completion: input.ResponseType === "stream" ? "headers-received" : "response-read",
      });
      return result;
    } catch (error) {
      if (abortKind) {
        emit(abortKind, { status: response?.status });
        throw new RPCRequestError(abortKind, requestId, diagnosticPath);
      }
      if (error instanceof RPCHttpError || (response && !response.ok)) {
        const httpError = error instanceof RPCHttpError ? error : new RPCHttpError(response!.status, diagnosticPath, {
          data: undefined, headers: headersToRecord(response!.headers), status: response!.status,
        }, requestId);
        emit("http-error", { status: httpError.status, rpcCode: rpcCode(httpError.response.data) });
        throw httpError;
      }
      // Body I/O can fail after HTTP headers arrive; only a parser syntax error
      // is a decode failure. Do not mislabel a disconnected body as invalid JSON.
      const kind = readingBody && error instanceof SyntaxError ? "decode-error" : "network-error";
      emit(kind, { status: response?.status });
      throw new RPCRequestError(kind, requestId, diagnosticPath);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      local.signal?.removeEventListener("abort", onAbort);
    }
  }

  private notifyAuthEvent(path: string, code: number | undefined, requestId: string, context: RPCRequestContext): void {
    if (code === undefined) {
      return;
    }
    if (code === this.options.loginExpiredCode) {
      notify(this.options.onAuthEvent, {
        ...context, requestId,
        code,
        kind: "login-expired",
        path,
      });
    } else if (code === this.options.tokenEmptyCode) {
      notify(this.options.onAuthEvent, {
        ...context, requestId,
        code,
        kind: "token-empty",
        path,
      });
    }
  }
}

export class RPCInvoker {
  private static client: RPCClient | undefined;

  static Configure(options: RPCClientOptions): void {
    this.client = new RPCClient(options);
  }

  static Path(moduleUrl: string, functionUrl: string): string {
    return rpcPath(moduleUrl, functionUrl);
  }

  static Request<T = unknown>(
    method: string,
    moduleUrl: string,
    functionUrl: string,
    input: RPCUploadStream,
  ): Promise<RPCTransportResponse<T>> {
    if (!this.client) {
      throw new Error(
        "RPCInvoker is not configured. Call RPCInvoker.Configure first.",
      );
    }
    return this.client.request(
      method.toUpperCase() as RPCMethod,
      moduleUrl,
      functionUrl,
      input,
    );
  }

  static GetTimeZone(): string {
    return defaultTimeZone();
  }
}
