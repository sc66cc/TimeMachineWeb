// The upload contract keys OSS objects by a 32-character MD5, and the Web Crypto API
// deliberately omits MD5, so the digest is computed here. It is a content address for
// deduplication and integrity, never a security primitive.

const SHIFT_TABLE = new Int32Array([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
]);

const SINE_TABLE = new Int32Array(64);
for (let index = 0; index < 64; index += 1) {
  SINE_TABLE[index] = Math.floor(Math.abs(Math.sin(index + 1)) * 0x1_00_00_00_00);
}

function rotateLeft(value: number, count: number): number {
  return (value << count) | (value >>> (32 - count));
}

function toHexLittleEndian(value: number): string {
  let hex = "";
  for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
    hex += ((value >>> (byteIndex * 8)) & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

class Md5Digest {
  private a = 0x67452301;
  private b = 0xefcdab89;
  private c = 0x98badcfe;
  private d = 0x10325476;
  private byteLength = 0;
  private readonly tail = new Uint8Array(64);
  private tailLength = 0;
  private readonly block = new Int32Array(16);

  update(chunk: Uint8Array): void {
    this.byteLength += chunk.length;
    let offset = 0;
    if (this.tailLength > 0) {
      const needed = 64 - this.tailLength;
      if (chunk.length < needed) {
        this.tail.set(chunk, this.tailLength);
        this.tailLength += chunk.length;
        return;
      }
      this.tail.set(chunk.subarray(0, needed), this.tailLength);
      this.transform(this.tail, 0);
      this.tailLength = 0;
      offset = needed;
    }
    while (offset + 64 <= chunk.length) {
      this.transform(chunk, offset);
      offset += 64;
    }
    if (offset < chunk.length) {
      this.tail.set(chunk.subarray(offset), 0);
      this.tailLength = chunk.length - offset;
    }
  }

  digest(): string {
    const bitLength = this.byteLength * 8;
    const padded = new Uint8Array(this.tailLength < 56 ? 64 : 128);
    padded.set(this.tail.subarray(0, this.tailLength), 0);
    padded[this.tailLength] = 0x80;
    // MD5 stores the little-endian bit length; 2^53 covers every browser-readable file.
    const lengthView = new DataView(padded.buffer);
    lengthView.setUint32(padded.length - 8, bitLength >>> 0, true);
    lengthView.setUint32(padded.length - 4, Math.floor(bitLength / 0x1_00_00_00_00), true);
    for (let offset = 0; offset < padded.length; offset += 64) {
      this.transform(padded, offset);
    }
    return (
      toHexLittleEndian(this.a) +
      toHexLittleEndian(this.b) +
      toHexLittleEndian(this.c) +
      toHexLittleEndian(this.d)
    );
  }

  private transform(chunk: Uint8Array, offset: number): void {
    const block = this.block;
    const view = new DataView(chunk.buffer, chunk.byteOffset + offset, 64);
    for (let index = 0; index < 16; index += 1) {
      block[index] = view.getInt32(index * 4, true);
    }

    let a = this.a;
    let b = this.b;
    let c = this.c;
    let d = this.d;

    for (let step = 0; step < 64; step += 1) {
      let mixed: number;
      let blockIndex: number;
      if (step < 16) {
        mixed = (b & c) | (~b & d);
        blockIndex = step;
      } else if (step < 32) {
        mixed = (d & b) | (~d & c);
        blockIndex = (5 * step + 1) % 16;
      } else if (step < 48) {
        mixed = b ^ c ^ d;
        blockIndex = (3 * step + 5) % 16;
      } else {
        mixed = c ^ (b | ~d);
        blockIndex = (7 * step) % 16;
      }
      const rotated =
        a + mixed + (SINE_TABLE[step] ?? 0) + (block[blockIndex] ?? 0);
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(rotated | 0, SHIFT_TABLE[step] ?? 0)) | 0;
    }

    this.a = (this.a + a) | 0;
    this.b = (this.b + b) | 0;
    this.c = (this.c + c) | 0;
    this.d = (this.d + d) | 0;
  }
}

const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Streams the file through the digest so a 256 MB CSV never lands in memory twice.
 */
export async function md5HexOfBlob(blob: Blob): Promise<string> {
  const digest = new Md5Digest();
  for (let offset = 0; offset < blob.size; offset += HASH_CHUNK_BYTES) {
    const slice = blob.slice(offset, Math.min(offset + HASH_CHUNK_BYTES, blob.size));
    digest.update(new Uint8Array(await slice.arrayBuffer()));
  }
  return digest.digest();
}

export function md5HexOfBytes(bytes: Uint8Array): string {
  const digest = new Md5Digest();
  digest.update(bytes);
  return digest.digest();
}
