import {
  PageRO,
  PlateModelRO,
  PlateModelSimpleRO,
  PlateModelTO,
  PlateGeoTO,
  PlateRotationTO,
  GeoPolygonTO,
  GeoLineTO,
  GeoSpherePointTO,
  Geo3DMeshTO,
  Geo3DPointTO,
  RangeAgeTO,
  StringStringTO,
  FileLinkTO,
  UserPlateModelInvoker,
  ViFKey,
} from "@timemachine/generated-api";
import {
  RPCHttpError,
  RPCInvoker,
  RPCRequestError,
  RPCUploadStream,
  rpcPath,
  type RPCRequestOptions,
  type RPCTelemetryEvent,
  type RPCTransportOutcome,
} from "@timemachine/api-client";

import {
  ByteStreamFormatError,
  ByteStreamReader,
  ByteStreamWriter,
  parseServerDateTime,
  safeIntegerFromInt64,
} from "./byte-stream";

/**
 * Transport and wire decoding for the shared Unity `UserPlateModel` module.
 *
 * The generated `UserPlateModelInvoker` posts JSON, but the ASP.NET controller
 * binds `IFormFile _stream` and answers with a packed `ByteStream` frame, so
 * the generated invoker cannot be called directly. This client reuses the
 * generated route constants and the existing `RPCClient` header conventions
 * (`Authorization`, `Custom-Header` with `TimeZone` / `Language`) and adds only
 * the multipart body plus the frame decoder that this module needs.
 */

/** `UserPlateModel_*_InputByteStruct._stream`; matches Unity's
 *  `RPCUploadStream.FormatByteSerialize` file name. */
const BYTE_STREAM_FIELD = "_stream";

const RPC_SUCCESS_CODE = 200;

/** `PageIndex.Size` contract `@range: [1, 100]`. */
const MAX_PAGE_SIZE = 100;

/** `PageIndex.Index` is written as a signed Int32, so it cannot exceed this. */
const MAX_PAGE_INDEX = 0x7fffffff;

let requestSequence = 0;
const requestPrefix = `shared-rpc-${Math.random().toString(36).slice(2, 10)}`;

/** Local controls only; ByteStream's success code remains fixed by its protocol. */
export type SharedPlateRequestOptions = Pick<RPCRequestOptions,
  "signal" | "timeoutMs" | "context" | "suppressTelemetry">;

export interface SharedPlateClientOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  getAccessToken?: () => string | null | undefined;
  getLanguage?: () => number | string;
  getTimeZone?: () => string;
  getRequestToken?: (path: string) => string | null | undefined;
  /** Defaults to 30 seconds, matching the application's ordinary RPC configuration. */
  defaultTimeoutMs?: number;
  onTelemetry?: (event: RPCTelemetryEvent) => unknown;
}

export interface SharedPlateDisplayQuery {
  /** `PlateModelDisplayConditionVO.Name`. */
  name?: string;
  /** `PlateModelDisplayConditionVO.AccessRange`, a `ResourceAccessRange` mask. */
  accessRangeMask?: number;
  /** `PageIndex.Index`, 1-based. */
  pageIndex?: number;
  /** `PageIndex.Size`, at most 100. */
  pageSize?: number;
}

/** A frame whose `Code` is not 200 carries no `Data`. */
export class SharedPlateRpcError extends Error {
  readonly code: number;
  readonly path: string;

  constructor(code: number, message: string, path: string, readonly requestId?: string) {
    super(
      message || `Shared plate model RPC ${path} failed with code ${code}.`,
    );
    this.name = "SharedPlateRpcError";
    this.code = code;
    this.path = path;
  }
}

/** Preserves the existing format-error contract while identifying this request. */
export class SharedPlateDecodeError extends ByteStreamFormatError {
  readonly kind = "decode-error";

  constructor(message: string, readonly requestId: string, readonly path: string) {
    super(message);
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 0x7fffffff) {
    throw new TypeError("Shared plate request timeout must be positive and within the timer range.");
  }
}

/**
 * The generated `BaseEntityRO.UpdateTime? = null` carries no type annotation,
 * so TypeScript widens it to `null | undefined` and rejects the decoded
 * `DateTime?`. The C# field is `DateTime?`, so write it through this view.
 */
type WithNullableUpdateTime = { UpdateTime?: Date | null };

export class SharedPlateModelClient {
  private readonly baseUrl: string;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly options: SharedPlateClientOptions;

  constructor(options: SharedPlateClientOptions) {
    validateTimeout(options.defaultTimeoutMs ?? 30_000);
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImplementation =
      options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Public, paginated catalog. Works without an access token. */
  async display(
    query: SharedPlateDisplayQuery = {},
    options: SharedPlateRequestOptions = {},
  ): Promise<PageRO<PlateModelSimpleRO>> {
    const path = rpcPath(UserPlateModelInvoker.URL, UserPlateModelInvoker.URL_Display);
    return this.sendByteStream(path, encodeDisplayRequest(query), options, reader => {
      const page = new PageRO<PlateModelSimpleRO>();
      readPageROInto(reader, `${path}.Data`, page);
      return page;
    });
  }

  /** The signed-in user's own models; an empty `_stream` is sent. */
  async displayMine(options: SharedPlateRequestOptions = {}): Promise<PlateModelSimpleRO[]> {
    const path = rpcPath(
      UserPlateModelInvoker.URL,
      UserPlateModelInvoker.URL_DisplayMine,
    );
    return this.sendByteStream(path, new ByteStreamWriter().toUint8Array(), options,
      reader => readPlateModelSimpleList(reader, `${path}.Data`));
  }

  async getDetail(id: number, options: SharedPlateRequestOptions = {}): Promise<PlateModelRO> {
    const path = rpcPath(
      UserPlateModelInvoker.URL,
      UserPlateModelInvoker.URL_GetDetail,
    );
    return this.sendByteStream(path, encodeGetDetailRequest(id), options, reader => {
      const model = new PlateModelRO();
      readPlateModelROInto(reader, `${path}.Data`, model);
      return model;
    });
  }

  private async sendByteStream<T>(
    path: string,
    payload: Uint8Array<ArrayBuffer>,
    options: SharedPlateRequestOptions,
    decode: (reader: ByteStreamReader) => T,
  ): Promise<T> {
    // Reuse ordinary RPC's whitelist/copy rules, not its JSON/file wire encoder.
    const local = new RPCUploadStream(options).Options;
    const timeoutMs = local.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    validateTimeout(timeoutMs);
    const requestId = `${requestPrefix}-${++requestSequence}`;
    const started = performance.now();
    // path is private and comes only from the three generated route constants.
    const emit = (outcome: RPCTransportOutcome, extra: Partial<RPCTelemetryEvent> = {}): void => {
      if (local.suppressTelemetry || !this.options.onTelemetry) return;
      const event: RPCTelemetryEvent = {
        ...local.context, requestId, path, method: "POST", elapsedMs: performance.now() - started,
        outcome, transportOutcome: outcome, businessOutcome: "not-checked", ...extra,
      };
      try { void Promise.resolve(this.options.onTelemetry(event)).catch(() => {}); }
      catch { /* Diagnostics cannot affect requests or recursively report themselves. */ }
    };
    if (local.signal?.aborted) {
      emit("cancelled");
      throw new RPCRequestError("cancelled", requestId, path);
    }
    const form = new FormData();
    form.append(
      BYTE_STREAM_FIELD,
      new Blob([payload], { type: "application/octet-stream" }),
      BYTE_STREAM_FIELD,
    );

    const headers = new Headers({ Accept: "application/octet-stream" });
    const customHeader: Record<string, string> = {
      TimeZone: this.options.getTimeZone?.() ?? RPCInvoker.GetTimeZone(),
      Language: String(this.options.getLanguage?.() ?? 0),
    };
    const requestToken = this.options.getRequestToken?.(path);
    if (requestToken) {
      customHeader.RequestTokenKey = path;
      customHeader[path] = requestToken;
    }
    headers.set("Custom-Header", JSON.stringify(customHeader));
    const accessToken = this.options.getAccessToken?.();
    if (accessToken) {
      headers.set("Authorization", accessToken);
    }

    const controller = new AbortController();
    let abortKind: "timeout" | "cancelled" | undefined;
    let bodyReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let rejectAbort!: (error: RPCRequestError) => void;
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    void aborted.catch(() => {});
    const abort = (kind: "timeout" | "cancelled"): void => {
      if (abortKind) return;
      abortKind = kind;
      // Own the reader so even an injected fetch that ignores its signal releases the body.
      void bodyReader?.cancel().catch(() => {});
      controller.abort();
      rejectAbort(new RPCRequestError(kind, requestId, path));
    };
    const onAbort = (): void => abort("cancelled");
    local.signal?.addEventListener("abort", onAbort, { once: true });
    if (local.signal?.aborted) onAbort();
    const timer = setTimeout(() => abort("timeout"), timeoutMs);
    let response: Response | undefined;
    let decoding = false;
    const perform = async (): Promise<T> => {
      if (abortKind) throw new RPCRequestError(abortKind, requestId, path);
      response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
        body: form, headers, method: "POST", signal: controller.signal,
      });
      if (abortKind || !response.ok) {
        void response.body?.cancel().catch(() => {});
        if (abortKind) throw new RPCRequestError(abortKind, requestId, path);
        throw new RPCHttpError(response.status, path, { data: undefined, headers: {}, status: response.status }, requestId);
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      bodyReader = response.body?.getReader();
      try {
        if (bodyReader) for (;;) {
          const { done, value } = await bodyReader.read();
          if (abortKind) throw new RPCRequestError(abortKind, requestId, path);
          if (done) break;
          chunks.push(value);
          size += value.byteLength;
        }
      } finally {
        bodyReader?.releaseLock();
        bodyReader = undefined;
      }
      const frame = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { frame.set(chunk, offset); offset += chunk.byteLength; }
      decoding = true;
      const reader = openSuccessFrame(path, frame.buffer, requestId);
      const result = decode(reader);
      reader.expectEnd(path);
      return result;
    };
    try {
      const result = await Promise.race([perform(), aborted]);
      if (abortKind) throw new RPCRequestError(abortKind, requestId, path);
      emit("success", { status: response!.status, rpcCode: RPC_SUCCESS_CODE, businessOutcome: "success", completion: "response-read" });
      return result;
    } catch (error) {
      if (abortKind) {
        emit(abortKind, { status: response?.status });
        throw new RPCRequestError(abortKind, requestId, path);
      }
      if (error instanceof SharedPlateRpcError) {
        emit("success", { status: response?.status, rpcCode: error.code, businessOutcome: "failure", completion: "response-read" });
        throw error;
      }
      if (error instanceof RPCHttpError) {
        emit("http-error", { status: error.status });
        throw error;
      }
      const kind = decoding ? "decode-error" : "network-error";
      emit(kind, { status: response?.status });
      if (decoding) throw new SharedPlateDecodeError(
        error instanceof ByteStreamFormatError ? error.message : "Shared plate model frame could not be decoded.", requestId, path,
      );
      throw new RPCRequestError(kind, requestId, path);
    } finally {
      clearTimeout(timer);
      local.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** `UserPlateModel_GetDetail_InputByteStruct.Convert`: one `ViFKey`. */
export function encodeGetDetailRequest(id: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(id)) {
    throw new ByteStreamFormatError(
      `GetDetail ID must be a safe integer, received ${id}.`,
    );
  }
  const writer = new ByteStreamWriter();
  writer.writeInt64(BigInt(id));
  return writer.toUint8Array();
}

/**
 * `UserPlateModel_Display_InputByteStruct.Convert`: `Condition` (`Name` string
 * then `AccessRange` UInt32) followed by `Page` (`Index`, `Size`).
 */
export function encodeDisplayRequest(
  query: SharedPlateDisplayQuery = {},
): Uint8Array<ArrayBuffer> {
  const name = query.name ?? "";
  const accessRangeMask = query.accessRangeMask ?? 0;
  const pageIndex = query.pageIndex ?? 1;
  const pageSize = query.pageSize ?? MAX_PAGE_SIZE;

  if (
    !Number.isInteger(accessRangeMask) ||
    accessRangeMask < 0 ||
    accessRangeMask > 0xffffffff
  ) {
    throw new ByteStreamFormatError(
      `Display AccessRangeMask must be a uint32, received ${accessRangeMask}.`,
    );
  }
  if (
    !Number.isInteger(pageIndex) ||
    pageIndex < 1 ||
    pageIndex > MAX_PAGE_INDEX
  ) {
    throw new ByteStreamFormatError(
      `Display Page.Index must be an integer in [1, ${MAX_PAGE_INDEX}], received ${pageIndex}.`,
    );
  }
  if (
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new ByteStreamFormatError(
      `Display Page.Size must be an integer in [1, ${MAX_PAGE_SIZE}], received ${pageSize}.`,
    );
  }

  const writer = new ByteStreamWriter();
  writer.writeString(name);
  writer.writeUint32(accessRangeMask);
  writer.writeInt32(pageIndex);
  writer.writeInt32(pageSize);
  return writer.toUint8Array();
}

/**
 * Reads `Code` and `Message` and leaves the reader on `Data`. A non-success
 * frame throws, because the server omits `Data` for those.
 */
function openSuccessFrame(path: string, frame: ArrayBuffer, requestId: string): ByteStreamReader {
  const reader = new ByteStreamReader(frame);
  const code = reader.readInt32(`${path}.Code`);
  const message = reader.readString(`${path}.Message`);
  if (code !== RPC_SUCCESS_CODE) {
    throw new SharedPlateRpcError(code, message, path, requestId);
  }
  if (reader.remaining === 0) {
    throw new ByteStreamFormatError(
      `${path}: success frame carries no Data.`,
    );
  }
  return reader;
}

function readPlateModelSimpleList(
  reader: ByteStreamReader,
  label: string,
): PlateModelSimpleRO[] {
  const count = reader.readListCount(label);
  const list: PlateModelSimpleRO[] = [];
  for (let index = 0; index < count; index += 1) {
    const item = new PlateModelSimpleRO();
    readPlateModelSimpleROInto(reader, `${label}[${index}]`, item);
    list.push(item);
  }
  return list;
}

function readPageROInto(
  reader: ByteStreamReader,
  label: string,
  target: PageRO<PlateModelSimpleRO>,
): void {
  target.Total = reader.readInt32(`${label}.Total`);
  const count = reader.readListCount(`${label}.List`);
  for (let index = 0; index < count; index += 1) {
    const item = new PlateModelSimpleRO();
    readPlateModelSimpleROInto(reader, `${label}.List[${index}]`, item);
    target.List.push(item);
  }
}

/** `BaseEntityRO` + `PlateModelSimpleRO` BindField order. */
function readPlateModelSimpleROInto(
  reader: ByteStreamReader,
  label: string,
  target: PlateModelSimpleRO,
): void {
  target.ID.Value = safeIntegerFromInt64(
    reader.readInt64(`${label}.ID`),
    `${label}.ID`,
  );
  target.State.Value = reader.readInt32(`${label}.State`);
  target.Name = reader.readString(`${label}.Name`);
  target.Description = reader.readString(`${label}.Description`);
  target.CreateTime = parseServerDateTime(
    reader.readString(`${label}.CreateTime`),
    `${label}.CreateTime`,
  );
  readNullableDateTimeInto(
    reader,
    `${label}.UpdateTime`,
    (value) => ((target as WithNullableUpdateTime).UpdateTime = value),
  );
  target.Author = reader.readString(`${label}.Author`);
  target.Reference = reader.readString(`${label}.Reference`);
  target.AgeStart = reader.readInt32(`${label}.AgeStart`);
  target.AgeEnd = reader.readInt32(`${label}.AgeEnd`);
  readFileLinkTOInto(reader, `${label}.AuthorPhoto`, target.AuthorPhoto);
  target.Creator.Value = safeIntegerFromInt64(
    reader.readInt64(`${label}.Creator`),
    `${label}.Creator`,
  );
  target.AccessRange.Value = reader.readInt32(`${label}.AccessRange`);
  readFKeyListInto(reader, `${label}.RecommandList`, target.RecommandList);
}

/** `PlateModelRO` inserts `Content` before `AccessRange`. */
function readPlateModelROInto(
  reader: ByteStreamReader,
  label: string,
  target: PlateModelRO,
): void {
  target.ID.Value = safeIntegerFromInt64(
    reader.readInt64(`${label}.ID`),
    `${label}.ID`,
  );
  target.State.Value = reader.readInt32(`${label}.State`);
  target.Name = reader.readString(`${label}.Name`);
  target.Description = reader.readString(`${label}.Description`);
  target.CreateTime = parseServerDateTime(
    reader.readString(`${label}.CreateTime`),
    `${label}.CreateTime`,
  );
  readNullableDateTimeInto(
    reader,
    `${label}.UpdateTime`,
    (value) => ((target as WithNullableUpdateTime).UpdateTime = value),
  );
  target.Author = reader.readString(`${label}.Author`);
  target.Reference = reader.readString(`${label}.Reference`);
  target.AgeStart = reader.readInt32(`${label}.AgeStart`);
  target.AgeEnd = reader.readInt32(`${label}.AgeEnd`);
  readFileLinkTOInto(reader, `${label}.AuthorPhoto`, target.AuthorPhoto);
  target.Creator.Value = safeIntegerFromInt64(
    reader.readInt64(`${label}.Creator`),
    `${label}.Creator`,
  );
  readPlateModelTOInto(reader, `${label}.Content`, target.Content);
  target.AccessRange.Value = reader.readInt32(`${label}.AccessRange`);
  readFKeyListInto(reader, `${label}.RecommandList`, target.RecommandList);
}

/**
 * `ViDateTimePtrSerializer` writes an empty string for null instead of a flag,
 * so both branches are decided by the packed length alone.
 */
function readNullableDateTimeInto(
  reader: ByteStreamReader,
  label: string,
  assign: (value: Date | null) => void,
): void {
  const value = reader.readString(label);
  assign(value === "" ? null : parseServerDateTime(value, label));
}

function readFKeyListInto(
  reader: ByteStreamReader,
  label: string,
  target: ViFKey[],
): void {
  const count = reader.readListCount(label);
  for (let index = 0; index < count; index += 1) {
    const item = `${label}[${index}]`;
    target.push(
      new ViFKey(safeIntegerFromInt64(reader.readInt64(item), item)),
    );
  }
}

function readPlateModelTOInto(
  reader: ByteStreamReader,
  label: string,
  target: PlateModelTO,
): void {
  target.GeoFileName = reader.readString(`${label}.GeoFileName`);
  const geoCount = reader.readListCount(`${label}.GeoList`);
  for (let index = 0; index < geoCount; index += 1) {
    const geo = new PlateGeoTO();
    readPlateGeoTOInto(reader, `${label}.GeoList[${index}]`, geo);
    target.GeoList.push(geo);
  }
  target.RotationFileName = reader.readString(`${label}.RotationFileName`);
  const rotationCount = reader.readListCount(`${label}.RotationList`);
  for (let index = 0; index < rotationCount; index += 1) {
    const rotation = new PlateRotationTO();
    readPlateRotationTOInto(reader, `${label}.RotationList[${index}]`, rotation);
    target.RotationList.push(rotation);
  }
}

function readPlateGeoTOInto(
  reader: ByteStreamReader,
  label: string,
  target: PlateGeoTO,
): void {
  target.FeatureType = reader.readString(`${label}.FeatureType`);
  target.FeatureName = reader.readString(`${label}.FeatureName`);
  target.PlateID = reader.readInt32(`${label}.PlateID`);
  target.FeatureID = reader.readString(`${label}.FeatureID`);
  target.RevisionID = reader.readString(`${label}.RevisionID`);
  readRangeAgeTOInto(reader, `${label}.ValidTime`, target.ValidTime);
  readListInto(
    reader,
    `${label}.Position`,
    target.Position,
    (itemLabel) => {
      const point = new GeoSpherePointTO();
      readGeoSpherePointTOInto(reader, itemLabel, point);
      return point;
    },
  );
  readListInto(
    reader,
    `${label}.Line`,
    target.Line,
    (itemLabel) => {
      const line = new GeoLineTO();
      readGeoLineTOInto(reader, itemLabel, line);
      return line;
    },
  );
  readListInto(
    reader,
    `${label}.Polygon`,
    target.Polygon,
    (itemLabel) => {
      const polygon = new GeoPolygonTO();
      readGeoPolygonTOInto(reader, itemLabel, polygon);
      return polygon;
    },
  );
  readListInto(
    reader,
    `${label}.Attribute`,
    target.Attribute,
    (itemLabel) => {
      const attribute = new StringStringTO();
      readStringStringTOInto(reader, itemLabel, attribute);
      return attribute;
    },
  );
}

function readPlateRotationTOInto(
  reader: ByteStreamReader,
  label: string,
  target: PlateRotationTO,
): void {
  target.ID = reader.readInt32(`${label}.ID`);
  target.ParentID = reader.readInt32(`${label}.ParentID`);
  target.Age = reader.readFloat32(`${label}.Age`);
  target.PoleLongitude = reader.readFloat32(`${label}.PoleLongitude`);
  target.PoleLatitude = reader.readFloat32(`${label}.PoleLatitude`);
  target.PoleAngle = reader.readFloat32(`${label}.PoleAngle`);
  target.Comment = reader.readString(`${label}.Comment`);
}

function readRangeAgeTOInto(
  reader: ByteStreamReader,
  label: string,
  target: RangeAgeTO,
): void {
  target.Begin = reader.readFloat32(`${label}.Begin`);
  target.End = reader.readFloat32(`${label}.End`);
}

function readStringStringTOInto(
  reader: ByteStreamReader,
  label: string,
  target: StringStringTO,
): void {
  target.First = reader.readString(`${label}.First`);
  target.Second = reader.readString(`${label}.Second`);
}

function readFileLinkTOInto(
  reader: ByteStreamReader,
  label: string,
  target: FileLinkTO,
): void {
  target.Path = reader.readString(`${label}.Path`);
  target.Name = reader.readString(`${label}.Name`);
  target.Extention = reader.readString(`${label}.Extention`);
  target.MD5 = reader.readString(`${label}.MD5`);
}

function readGeoSpherePointTOInto(
  reader: ByteStreamReader,
  label: string,
  target: GeoSpherePointTO,
): void {
  target.Longitude = reader.readFloat32(`${label}.Longitude`);
  target.Latitude = reader.readFloat32(`${label}.Latitude`);
}

function readGeoLineTOInto(
  reader: ByteStreamReader,
  label: string,
  target: GeoLineTO,
): void {
  readListInto(reader, `${label}.PosList`, target.PosList, (itemLabel) => {
    const point = new GeoSpherePointTO();
    readGeoSpherePointTOInto(reader, itemLabel, point);
    return point;
  });
}

function readGeoPolygonTOInto(
  reader: ByteStreamReader,
  label: string,
  target: GeoPolygonTO,
): void {
  readListInto(reader, `${label}.PosList`, target.PosList, (itemLabel) => {
    const point = new GeoSpherePointTO();
    readGeoSpherePointTOInto(reader, itemLabel, point);
    return point;
  });
  readGeo3DMeshTOInto(reader, `${label}.Mesh`, target.Mesh);
}

function readGeo3DMeshTOInto(
  reader: ByteStreamReader,
  label: string,
  target: Geo3DMeshTO,
): void {
  readListInto(reader, `${label}.IndexList`, target.IndexList, (itemLabel) =>
    reader.readInt32(itemLabel),
  );
  readListInto(
    reader,
    `${label}.PointList`,
    target.PointList,
    (itemLabel) => {
      const point = new Geo3DPointTO();
      point.X = reader.readFloat32(`${itemLabel}.X`);
      point.Y = reader.readFloat32(`${itemLabel}.Y`);
      point.Z = reader.readFloat32(`${itemLabel}.Z`);
      return point;
    },
  );
}

/** `ViListSerializer.Read`: packed count, then elements back to back. */
function readListInto<T>(
  reader: ByteStreamReader,
  label: string,
  target: T[],
  readItem: (itemLabel: string) => T,
): void {
  const count = reader.readListCount(label);
  for (let index = 0; index < count; index += 1) {
    target.push(readItem(`${label}[${index}]`));
  }
}
