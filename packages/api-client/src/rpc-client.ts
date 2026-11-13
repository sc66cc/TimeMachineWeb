import { RPCUploadStream } from "./rpc-upload-stream";

export type RPCMethod = "DELETE" | "GET" | "PATCH" | "POST" | "PUT";

export interface RPCTransportResponse<T = unknown> {
  data: T;
  headers: Record<string, string>;
  status: number;
}

export interface RPCTelemetryEvent {
  elapsedMs: number;
  method: RPCMethod;
  outcome: "success" | "http-error" | "network-error";
  path: string;
  rpcCode?: number;
  status?: number;
}

export interface RPCAuthEvent {
  code: number;
  kind: "login-expired" | "token-empty";
  path: string;
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
  onAuthEvent?: (event: RPCAuthEvent) => void;
  onTelemetry?: (event: RPCTelemetryEvent) => void;
}

export class RPCHttpError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    readonly response: RPCTransportResponse,
  ) {
    super(`RPC ${path} returned HTTP ${status}.`);
    this.name = "RPCHttpError";
  }
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
    typeof data.Code === "number"
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
    const started = performance.now();
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

    try {
      const response = await this.fetchImplementation(url, {
        body,
        headers,
        method,
      });
      const data = await readResponse(response, input.ResponseType);
      const result: RPCTransportResponse<T> = {
        data: data as T,
        headers: headersToRecord(response.headers),
        status: response.status,
      };
      const code = rpcCode(data);
      this.notifyAuthEvent(path, code);
      this.options.onTelemetry?.({
        elapsedMs: performance.now() - started,
        method,
        outcome: response.ok ? "success" : "http-error",
        path,
        rpcCode: code,
        status: response.status,
      });
      if (!response.ok) {
        throw new RPCHttpError(response.status, path, result);
      }
      return result;
    } catch (error) {
      if (!(error instanceof RPCHttpError)) {
        this.options.onTelemetry?.({
          elapsedMs: performance.now() - started,
          method,
          outcome: "network-error",
          path,
        });
      }
      throw error;
    }
  }

  private notifyAuthEvent(path: string, code: number | undefined): void {
    if (code === undefined) {
      return;
    }
    if (code === this.options.loginExpiredCode) {
      this.options.onAuthEvent?.({
        code,
        kind: "login-expired",
        path,
      });
    } else if (code === this.options.tokenEmptyCode) {
      this.options.onAuthEvent?.({
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
