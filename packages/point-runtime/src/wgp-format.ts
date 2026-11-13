import type { PointBinaryHeader, PointRecord } from "./types";

export const WGP_MAGIC = "WGP1";
export const WGP_VERSION = 1;
export const WGP_HEADER_BYTES = 64;
export const WGP_RECORD_STRIDE_BYTES = 20;

function readMagic(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
}

export function parsePointBinaryHeader(buffer: ArrayBuffer): PointBinaryHeader {
  if (buffer.byteLength < WGP_HEADER_BYTES) {
    throw new Error(
      `WGP point file is ${buffer.byteLength} bytes; at least ${WGP_HEADER_BYTES} are required.`,
    );
  }

  const bytes = new Uint8Array(buffer, 0, 4);
  const magic = readMagic(bytes);
  if (magic !== WGP_MAGIC) {
    throw new Error(`Unsupported point file magic "${magic}".`);
  }

  const view = new DataView(buffer);
  const header: PointBinaryHeader = {
    magic: WGP_MAGIC,
    version: view.getUint32(4, true),
    headerBytes: view.getUint32(8, true),
    recordStrideBytes: view.getUint32(12, true),
    pointCount: view.getUint32(16, true),
    sourcePointCount: view.getUint32(20, true),
    maxPlateId: view.getUint32(24, true),
    maxTimeDeciMa: view.getUint32(28, true),
  };

  if (header.version !== WGP_VERSION) {
    throw new Error(`Unsupported WGP version ${header.version}.`);
  }
  if (header.headerBytes !== WGP_HEADER_BYTES) {
    throw new Error(`Unexpected WGP header size ${header.headerBytes}.`);
  }
  if (header.recordStrideBytes !== WGP_RECORD_STRIDE_BYTES) {
    throw new Error(
      `Unexpected WGP record stride ${header.recordStrideBytes}.`,
    );
  }

  const expectedBytes =
    header.headerBytes + header.pointCount * header.recordStrideBytes;
  if (buffer.byteLength !== expectedBytes) {
    throw new Error(
      `WGP payload has ${buffer.byteLength} bytes; expected ${expectedBytes}.`,
    );
  }

  return header;
}

export function readPointRecord(
  buffer: ArrayBuffer,
  rowId: number,
): PointRecord {
  const header = parsePointBinaryHeader(buffer);
  if (!Number.isInteger(rowId) || rowId < 0 || rowId >= header.pointCount) {
    throw new Error(`Point row ID ${rowId} is outside this WGP dataset.`);
  }
  const offset = header.headerBytes + rowId * header.recordStrideBytes;
  const view = new DataView(buffer, offset, header.recordStrideBytes);
  return {
    occurrenceCount: view.getUint16(18, true),
    plateId: view.getUint16(16, true),
    rowId,
    unitPosition: [
      view.getFloat32(0, true),
      view.getFloat32(4, true),
      view.getFloat32(8, true),
    ],
    validFromMa: view.getUint16(12, true) / 10,
    validToMa: view.getUint16(14, true) / 10,
  };
}
