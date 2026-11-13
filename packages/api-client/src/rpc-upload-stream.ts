import { RPCFile } from "./rpc-file";

export type RPCResponseType =
  | "arraybuffer"
  | "blob"
  | "document"
  | "json"
  | "text"
  | "stream";

export class RPCUploadStream {
  readonly Header = new Map<string, string | undefined>();
  readonly JsonList = new Map<string, unknown>();
  readonly FileList = new Map<string, RPCFile>();
  ResponseType?: RPCResponseType;

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
