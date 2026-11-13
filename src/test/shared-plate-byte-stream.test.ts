import { describe, expect, it } from "vitest";

import {
  ByteStreamFormatError,
  ByteStreamReader,
  ByteStreamWriter,
  parseServerDateTime,
  safeIntegerFromInt64,
} from "../plate-model/byte-stream";

/**
 * Every expectation here is a hand-written byte literal traced back to the C#
 * serializers (`ViOStream.Append`, `ViIStream.ReadPacked`,
 * `ViIStream.Read(out string)`), so these are known-answer tests rather than
 * encoder/decoder round trips.
 */

function readerOf(bytes: readonly number[]): ByteStreamReader {
  return new ByteStreamReader(new Uint8Array(bytes));
}

function utf16Le(text: string): number[] {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    bytes.push(text.charCodeAt(index) & 0xff);
    bytes.push(text.charCodeAt(index) >>> 8);
  }
  return bytes;
}

describe("ByteStreamWriter packed lengths", () => {
  it("uses one byte below the 255 marker", () => {
    const writer = new ByteStreamWriter();
    writer.writePackedLength(254);
    expect([...writer.toUint8Array()]).toEqual([254]);
  });

  it("uses the 255 marker plus Int32LE at and above the threshold", () => {
    const atMarker = new ByteStreamWriter();
    atMarker.writePackedLength(255);
    expect([...atMarker.toUint8Array()]).toEqual([255, 255, 0, 0, 0]);

    const above = new ByteStreamWriter();
    above.writePackedLength(300);
    expect([...above.toUint8Array()]).toEqual([255, 44, 1, 0, 0]);
  });

  it("writes strings as a packed UTF-16 code unit count plus UTF-16LE bytes", () => {
    const writer = new ByteStreamWriter();
    writer.writeString("hello");
    expect([...writer.toUint8Array()]).toEqual([5, ...utf16Le("hello")]);
  });

  it("keeps surrogate pairs as two independent code units like C# char", () => {
    // U+1D54F is outside the BMP, so it is two UTF-16 code units.
    const text = "\u{1D54F}";
    expect(text.length).toBe(2);

    const writer = new ByteStreamWriter();
    writer.writeString(text);
    expect([...writer.toUint8Array()]).toEqual([2, 0x35, 0xd8, 0x4f, 0xdd]);
  });

  it("rejects a negative packed length", () => {
    const writer = new ByteStreamWriter();
    expect(() => writer.writePackedLength(-1)).toThrow(ByteStreamFormatError);
  });

  it("keeps the packed length inside the Int32 range", () => {
    // 0x7fffffff is the largest length ViIStream.ReadPacked can return.
    const maximum = new ByteStreamWriter();
    maximum.writePackedLength(0x7fffffff);
    expect([...maximum.toUint8Array()]).toEqual([
      255,
      0xff,
      0xff,
      0xff,
      0x7f,
    ]);
    // 0x80000000 would be written as -2147483648 and rejected on read.
    expect(() => new ByteStreamWriter().writePackedLength(0x80000000)).toThrow(
      /Packed length 2147483648 exceeds the Int32 maximum 2147483647/,
    );
    expect(() =>
      new ByteStreamWriter().writePackedLength(4294967297),
    ).toThrow(/exceeds the Int32 maximum/);
  });
});

describe("ByteStreamReader strings", () => {
  it("reads a short packed string", () => {
    expect(readerOf([5, ...utf16Le("hello")]).readString("value")).toBe("hello");
  });

  it("reads a packed length carried by the 255 marker", () => {
    // 255 code units, all 'a'.
    expect(
      readerOf([255, 255, 0, 0, 0, ...utf16Le("a".repeat(255))]).readString(
        "value",
      ),
    ).toBe("a".repeat(255));
  });

  it("reads BMP CJK and astral characters", () => {
    expect(readerOf([2, 0x21, 0x6a, 0x8b, 0x57]).readString("value")).toBe("模型");
    expect(readerOf([2, 0x35, 0xd8, 0x4f, 0xdd]).readString("value")).toBe(
      "\u{1D54F}",
    );
  });

  it("reads an empty packed string", () => {
    expect(readerOf([0]).readString("value")).toBe("");
  });

  it("rejects a negative packed length", () => {
    expect(() => readerOf([255, 255, 255, 255, 255]).readString("value")).toThrow(
      /negative packed length -1/,
    );
  });

  it("rejects a truncated string body", () => {
    expect(() => readerOf([5, 0x68, 0x00]).readString("value")).toThrow(
      /truncated at byte 1/,
    );
  });

  it("rejects a missing packed length byte", () => {
    expect(() => readerOf([]).readString("value")).toThrow(/truncated/);
  });
});

describe("ByteStreamReader primitives", () => {
  it("reads little-endian Int32, UInt32, Float32 and Int64", () => {
    const reader = readerOf([
      0x2a, 0x00, 0x00, 0x00, // Int32 = 42
      0x06, 0x00, 0x00, 0x00, // UInt32 = 6
      0x00, 0x00, 0xc8, 0x42, // Float32 = 100
      0x2a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // Int64 = 42
    ]);
    expect(reader.readInt32("a")).toBe(42);
    expect(reader.readUint32("b")).toBe(6);
    expect(reader.readFloat32("c")).toBe(100);
    expect(reader.readInt64("d")).toBe(42n);
    reader.expectEnd("frame");
  });

  it("reads a negative Int64 as a signed value", () => {
    // -5 as Int64LE.
    expect(
      readerOf([0xfb, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]).readInt64("v"),
    ).toBe(-5n);
  });

  it("rejects a truncated Int64", () => {
    expect(() => readerOf([1, 2, 3]).readInt64("v")).toThrow(/truncated/);
  });

  it("reports trailing bytes so frame drift is not silently ignored", () => {
    const reader = readerOf([1, 2, 3, 4]);
    reader.readUint8("v");
    expect(() => reader.expectEnd("frame")).toThrow(
      /frame: 3 trailing byte\(s\) after the frame/,
    );
  });
});

describe("ByteStreamReader list counts", () => {
  // A real frame always carries at least one byte per element, so the reader
  // rejects a count that cannot fit. Padding stands in for those elements.
  const padding = (count: number): number[] => new Array(count).fill(0);

  it("reads a short packed count", () => {
    expect(readerOf([3, ...padding(3)]).readListCount("list")).toBe(3);
  });

  it("reads a marker-carried count", () => {
    expect(
      readerOf([255, 255, 0, 0, 0, ...padding(255)]).readListCount("list"),
    ).toBe(255);
  });

  it("rejects a count larger than the remaining payload", () => {
    expect(() => readerOf([255, 0xff, 0xff, 0xff, 0x7f]).readListCount("list"))
      .toThrow(/packed count 2147483647 exceeds the 0 remaining/);
  });

  it("rejects a truncated element list", () => {
    expect(() => readerOf([3, 0, 0]).readListCount("list")).toThrow(
      /packed count 3 exceeds the 2 remaining/,
    );
  });
});

describe("safeIntegerFromInt64", () => {
  it("accepts the largest safe integer", () => {
    expect(safeIntegerFromInt64(9007199254740991n, "ID")).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });

  it("rejects an Int64 beyond the safe range instead of truncating", () => {
    expect(() => safeIntegerFromInt64(9007199254740992n, "ID")).toThrow(
      /ID: Int64 9007199254740992 is outside the safe integer range/,
    );
    expect(() => safeIntegerFromInt64(-9007199254740992n, "ID")).toThrow(
      ByteStreamFormatError,
    );
  });
});

describe("parseServerDateTime", () => {
  it("parses the PrintDate UTC form", () => {
    expect(
      parseServerDateTime("2020-01-02 03:04:05.000Z", "CreateTime").getTime(),
    ).toBe(Date.UTC(2020, 0, 2, 3, 4, 5, 0));
  });

  it("parses the unspecified-kind form as UTC", () => {
    expect(
      parseServerDateTime("2021-02-03 04:05:06.123", "UpdateTime").getTime(),
    ).toBe(Date.UTC(2021, 1, 3, 4, 5, 6, 123));
  });

  it("rejects an empty or malformed date string", () => {
    expect(() => parseServerDateTime("", "CreateTime")).toThrow(
      /CreateTime: empty date string/,
    );
    expect(() => parseServerDateTime("not-a-date", "CreateTime")).toThrow(
      /is not a server date string/,
    );
  });
});
