/**
 * Wire codec for the DPlanet "ByteStream" RPC contract.
 *
 * The generated TypeScript invokers only speak JSON, but the Unity
 * `UserPlateModel` module and the ASP.NET controller behind it exchange a
 * packed binary frame instead. The layout below is taken from the C#
 * serializers, not from the generated TypeScript DTOs:
 *
 * - `ViRPCController.SendByteStreamAsync` writes `Int32 Code`, then the packed
 *   UTF-16 `Message` string, then the serialized `Data` when it is not null.
 *   `ViRPCResultInterface.Language` is an in-process field only and never
 *   reaches the wire, so there is no language byte in the frame.
 * - `ViOStream.Append(string)` writes a packed length (the UTF-16 code unit
 *   count) followed by `length * 2` little-endian UTF-16 bytes. Surrogate
 *   pairs are written as two independent code units, exactly like C# `char`.
 * - `ViIStream.ReadPacked` reads one byte when it is below 255, otherwise the
 *   marker 255 followed by a signed `Int32` length. It is not a general
 *   varint: every value at or above 255 always costs five bytes.
 * - `ViCombineSerializer` emits bound fields back to back with no length
 *   prefix, and `ViListSerializer` prefixes each list with a packed element
 *   count. Field order is the `BindField` order of the generated
 *   `Serializer` class.
 * - `DateTime` and `DateTime?` both go through a string: `ViDateTimeSerializer`
 *   / `ViDateTimePtrSerializer` call `ViStringAssistant.PrintDate`, and an
 *   empty string means null. There is no separate null flag.
 * - `ViFKey` is a plain `Int64`; `ViEnum32` and `ViMask32` are `Int32` /
 *   `UInt32`.
 *
 * This module moves bytes only and knows nothing about plate models.
 */

export class ByteStreamFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ByteStreamFormatError";
  }
}

/** `ViOStream.AppendPacked` marker; the trailing length is a signed Int32. */
const PACKED_MARKER = 255;

/** Largest value `ViIStream.ReadPacked` can return, because it reads an Int32. */
const MAX_PACKED_LENGTH = 0x7fffffff;

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

export class ByteStreamWriter {
  private readonly bytes: number[] = [];

  get length(): number {
    return this.bytes.length;
  }

  writeUint8(value: number): void {
    this.bytes.push(value & 0xff);
  }

  writeInt32(value: number): void {
    this.writeUint8(value);
    this.writeUint8(value >>> 8);
    this.writeUint8(value >>> 16);
    this.writeUint8(value >>> 24);
  }

  writeUint32(value: number): void {
    this.writeInt32(value >>> 0);
  }

  writeInt64(value: bigint): void {
    for (let index = 0; index < 8; index += 1) {
      this.writeUint8(Number((value >> BigInt(8 * index)) & 0xffn));
    }
  }

  writeFloat32(value: number): void {
    const view = new DataView(new ArrayBuffer(4));
    view.setFloat32(0, value, true);
    this.writeUint8(view.getUint8(0));
    this.writeUint8(view.getUint8(1));
    this.writeUint8(view.getUint8(2));
    this.writeUint8(view.getUint8(3));
  }

  /** `ViOStream.AppendPacked`. */
  writePackedLength(length: number): void {
    if (!Number.isInteger(length) || length < 0) {
      throw new ByteStreamFormatError(
        `Packed length must be a non-negative integer, received ${length}.`,
      );
    }
    if (length > MAX_PACKED_LENGTH) {
      // The trailing field is a signed Int32, so anything larger would be
      // written as a negative length and rejected on read.
      throw new ByteStreamFormatError(
        `Packed length ${length} exceeds the Int32 maximum ${MAX_PACKED_LENGTH}.`,
      );
    }
    if (length < PACKED_MARKER) {
      this.writeUint8(length);
      return;
    }
    this.writeUint8(PACKED_MARKER);
    this.writeInt32(length);
  }

  /** `ViOStream.Append(string)`: packed UTF-16 code unit count + UTF-16LE. */
  writeString(value: string): void {
    this.writePackedLength(value.length);
    for (let index = 0; index < value.length; index += 1) {
      this.writeUint8(value.charCodeAt(index));
      this.writeUint8(value.charCodeAt(index) >>> 8);
    }
  }

  toUint8Array(): Uint8Array<ArrayBuffer> {
    return new Uint8Array(this.bytes);
  }
}

export class ByteStreamReader {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private offset = 0;

  constructor(source: ArrayBuffer | Uint8Array) {
    this.bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    this.view = new DataView(
      this.bytes.buffer,
      this.bytes.byteOffset,
      this.bytes.byteLength,
    );
  }

  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }

  /** A well-formed frame must be consumed exactly; leftovers mean drift. */
  expectEnd(label: string): void {
    if (this.remaining !== 0) {
      throw new ByteStreamFormatError(
        `${label}: ${this.remaining} trailing byte(s) after the frame.`,
      );
    }
  }

  private require(count: number, label: string): void {
    if (this.offset + count > this.bytes.byteLength) {
      throw new ByteStreamFormatError(
        `${label}: truncated at byte ${this.offset}; needs ${count} more byte(s), only ${this.remaining} left.`,
      );
    }
  }

  readUint8(label: string): number {
    this.require(1, label);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  readInt32(label: string): number {
    this.require(4, label);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readUint32(label: string): number {
    this.require(4, label);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  readFloat32(label: string): number {
    this.require(4, label);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** `ViFKeySerializer.Read`: a plain little-endian Int64. */
  readInt64(label: string): bigint {
    this.require(8, label);
    const value = this.view.getBigInt64(this.offset, true);
    this.offset += 8;
    return value;
  }

  /** `ViIStream.ReadPacked`. */
  readPackedLength(label: string): number {
    const marker = this.readUint8(`${label}.length`);
    if (marker !== PACKED_MARKER) {
      return marker;
    }
    const length = this.readInt32(`${label}.length`);
    if (length < 0) {
      throw new ByteStreamFormatError(
        `${label}.length: negative packed length ${length}.`,
      );
    }
    return length;
  }

  readString(label: string): string {
    const length = this.readPackedLength(label);
    this.require(length * 2, label);
    let value = "";
    for (let index = 0; index < length; index += 1) {
      value += String.fromCharCode(this.view.getUint16(this.offset, true));
      this.offset += 2;
    }
    return value;
  }

  /**
   * `ViListSerializer.Read` element count. Every element consumes at least one
   * byte, so a count larger than the remaining payload is corrupt data rather
   * than something to loop over.
   */
  readListCount(label: string): number {
    const count = this.readPackedLength(label);
    if (count > this.remaining) {
      throw new ByteStreamFormatError(
        `${label}: packed count ${count} exceeds the ${this.remaining} remaining byte(s).`,
      );
    }
    return count;
  }
}

/**
 * `ViFKey.Value` is a JavaScript number, so an Int64 outside the safe range
 * cannot be represented. Fail loudly instead of silently truncating.
 */
export function safeIntegerFromInt64(value: bigint, label: string): number {
  if (value > BigInt(MAX_SAFE_INTEGER) || value < -BigInt(MAX_SAFE_INTEGER)) {
    throw new ByteStreamFormatError(
      `${label}: Int64 ${value} is outside the safe integer range.`,
    );
  }
  return Number(value);
}

/**
 * `ViStringAssistant.PrintDate` emits `yyyy-MM-dd HH:mm:ss.fff` with a `Z`
 * suffix for UTC and local kinds. Both are parsed as UTC so the decoded value
 * does not depend on the browser time zone.
 */
export function parseServerDateTime(value: string, label: string): Date {
  const normalized = value.trim().replace(" ", "T");
  if (!normalized) {
    throw new ByteStreamFormatError(`${label}: empty date string.`);
  }
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const parsed = new Date(hasZone ? normalized : `${normalized}Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new ByteStreamFormatError(
      `${label}: "${value}" is not a server date string.`,
    );
  }
  return parsed;
}
