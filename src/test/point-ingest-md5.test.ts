import { describe, expect, it } from "vitest";

import { md5HexOfBlob, md5HexOfBytes } from "../phase3/md5";

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

describe("md5 content addressing", () => {
  // RFC 1321 test suite; the server keys OSS objects by these digests.
  it("matches the RFC 1321 vectors", () => {
    expect(md5HexOfBytes(encode(""))).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(md5HexOfBytes(encode("a"))).toBe("0cc175b9c0f1b6a831c399e269772661");
    expect(md5HexOfBytes(encode("abc"))).toBe("900150983cd24fb0d6963f7d28e17f72");
    expect(md5HexOfBytes(encode("message digest"))).toBe(
      "f96b697d7cb7938d525a2f31aaf161d0",
    );
    expect(md5HexOfBytes(encode("abcdefghijklmnopqrstuvwxyz"))).toBe(
      "c3fcd3d76192e4007dfb496cca67e13b",
    );
    expect(
      md5HexOfBytes(
        encode(
          "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        ),
      ),
    ).toBe("d174ab98d277d9f5a5611c2c9f419d9f");
    expect(
      md5HexOfBytes(encode("12345678901234567890123456789012345678901234567890123456789012345678901234567890")),
    ).toBe("57edf4a22be3c955ac49da2e2107b67a");
  });

  it("produces 32 lowercase hex characters, as the upload contract requires", () => {
    const digest = md5HexOfBytes(encode("lng,lat\n1,2\n"));
    expect(digest).toMatch(/^[0-9a-f]{32}$/);
  });

  it("spans the 56-byte and 64-byte padding boundaries", () => {
    // Lengths 55-64 exercise every branch of the length-block padding.
    for (const length of [55, 56, 57, 63, 64, 65, 119, 120, 128]) {
      const bytes = new Uint8Array(length).fill(0x61);
      expect(md5HexOfBytes(bytes)).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(md5HexOfBytes(new Uint8Array(56).fill(0x61))).toBe(
      md5HexOfBytes(encode("a".repeat(56))),
    );
  });

  it("streams a blob to the same digest as a single buffer", async () => {
    const payload = "lng,lat,max_ma,min_ma\n" + "10,20,5,1\n".repeat(20000);
    const bytes = encode(payload);
    expect(bytes.length).toBeGreaterThan(64 * 1024);
    await expect(md5HexOfBlob(new Blob([payload]))).resolves.toBe(
      md5HexOfBytes(bytes),
    );
  });
});
