import { createCipheriv, createHmac, pbkdf2Sync, timingSafeEqual } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';

// ZIP structure and decryption shared by verification and extraction. Reads through a FileHandle in bounded chunks,
// so archive size does not matter. Supports ZIP64, stored/deflated entries, traditional PKWARE encryption (ZipCrypto)
// and WinZip AES (AE-1/AE-2, 128/192/256-bit).

export interface ZipEntry {
  name: string; flags: number; method: number; crc: number; compressedSize: number; size: number; localOffset: number;
  modTime: number;
  // WinZip AES: key strength (1/2/3 = 128/192/256 bit), AE version, and the real compression method behind method 99.
  aes: { strength: 1 | 2 | 3; version: 1 | 2; method: number } | null;
}

export const isDirectory = (entry: ZipEntry) => entry.name.endsWith('/') || entry.name.endsWith('\\');
export const isEncrypted = (entry: ZipEntry) => (entry.flags & 1) === 1;

export async function readAt(file: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, position);
  return buffer.subarray(0, bytesRead);
}

async function centralDirectory(file: FileHandle, size: number): Promise<{ offset: number; count: number } | string> {
  const tailLength = Math.min(size, 22 + 0xffff);
  const tail = await readAt(file, size - tailLength, tailLength);
  let at = -1;
  for (let index = tail.length - 22; index >= 0; index--) {
    if (tail.readUInt32LE(index) === 0x06054b50) {
      at = index;
      break;
    }
  }
  if (at < 0) return 'The ZIP archive has no end record; it is truncated or not a ZIP file.';
  let count = tail.readUInt16LE(at + 10);
  let offset = tail.readUInt32LE(at + 16);
  if (count === 0xffff || offset === 0xffffffff) {
    const locatorAt = at - 20;
    if (locatorAt < 0 || tail.readUInt32LE(locatorAt) !== 0x07064b50) return 'The ZIP64 archive is missing its locator record.';
    const record = await readAt(file, Number(tail.readBigUInt64LE(locatorAt + 8)), 56);
    if (record.length < 56 || record.readUInt32LE(0) !== 0x06064b50) return 'The ZIP64 end record is damaged.';
    count = Number(record.readBigUInt64LE(32));
    offset = Number(record.readBigUInt64LE(48));
  }
  if (offset > size) return 'The ZIP directory points outside the file; the archive is truncated.';
  return { offset, count };
}

export async function zipEntries(file: FileHandle, size: number): Promise<ZipEntry[] | string> {
  const directory = await centralDirectory(file, size);
  if (typeof directory === 'string') return directory;
  const list: ZipEntry[] = [];
  let position = directory.offset;
  for (let index = 0; index < directory.count; index++) {
    const fixed = await readAt(file, position, 46);
    if (fixed.length < 46 || fixed.readUInt32LE(0) !== 0x02014b50) return `ZIP directory entry ${index + 1} is damaged.`;
    const nameLength = fixed.readUInt16LE(28);
    const extraLength = fixed.readUInt16LE(30);
    const commentLength = fixed.readUInt16LE(32);
    const variable = await readAt(file, position + 46, nameLength + extraLength);
    const flags = fixed.readUInt16LE(8);
    // Bit 11: the name is UTF-8. Otherwise it is in the creator's code page; latin1 keeps ASCII exact and never throws.
    const rawName = variable.subarray(0, nameLength);
    const entry: ZipEntry = {
      name: rawName.toString(flags & 0x800 ? 'utf8' : 'latin1'), flags, method: fixed.readUInt16LE(10),
      crc: fixed.readUInt32LE(16), compressedSize: fixed.readUInt32LE(20), size: fixed.readUInt32LE(24), localOffset: fixed.readUInt32LE(42),
      modTime: fixed.readUInt16LE(12), aes: null,
    };
    const extra = variable.subarray(nameLength);
    for (let at = 0; at + 4 <= extra.length;) {
      const id = extra.readUInt16LE(at);
      const length = extra.readUInt16LE(at + 2);
      if (id === 0x0001) {
        // ZIP64: 64-bit values for whichever 32-bit fields are saturated, in this order.
        let field = at + 4;
        const next = () => { const value = Number(extra.readBigUInt64LE(field)); field += 8; return value; };
        if (entry.size === 0xffffffff) entry.size = next();
        if (entry.compressedSize === 0xffffffff) entry.compressedSize = next();
        if (entry.localOffset === 0xffffffff) entry.localOffset = next();
      } else if (id === 0x9901 && length >= 7) {
        const strength = extra.readUInt8(at + 8);
        const version = extra.readUInt16LE(at + 4);
        if ((strength === 1 || strength === 2 || strength === 3) && (version === 1 || version === 2)) {
          entry.aes = { strength, version, method: extra.readUInt16LE(at + 9) };
        }
      }
      at += 4 + length;
    }
    list.push(entry);
    position += 46 + nameLength + extraLength + commentLength;
  }
  return list;
}

// Where the entry's (possibly encrypted) data starts: after the local header, whose name/extra lengths may differ from
// the central directory's.
export async function dataStart(file: FileHandle, entry: ZipEntry, fileSize: number): Promise<number | string> {
  const local = await readAt(file, entry.localOffset, 30);
  if (local.length < 30 || local.readUInt32LE(0) !== 0x04034b50) return `"${entry.name}": its local header is missing.`;
  const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  if (start + entry.compressedSize > fileSize) return `"${entry.name}": its data runs past the end of the file.`;
  return start;
}

// Streams `length` bytes of the archive from `start`, in chunks.
export async function* chunks(file: FileHandle, start: number, length: number, size = 1 << 20): AsyncGenerator<Buffer> {
  for (let read = 0; read < length;) {
    const chunk = await readAt(file, start + read, Math.min(size, length - read));
    if (chunk.length === 0) throw new Error('the file ended inside an entry');
    read += chunk.length;
    yield chunk;
  }
}

// ---------- traditional PKWARE encryption (ZipCrypto) ----------

// ZipCrypto updates a raw CRC-32 register one byte at a time (no pre/post inversion), so it needs the table itself.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();
const crcByte = (crc: number, byte: number) => (CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)) >>> 0;

export class ZipCryptoDecipher {
  private keys = [0x12345678, 0x23456789, 0x34567890];

  constructor(password: Buffer) {
    for (const byte of password) this.update(byte);
  }

  private update(byte: number) {
    this.keys[0] = crcByte(this.keys[0], byte);
    this.keys[1] = (Math.imul((this.keys[1] + (this.keys[0] & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    this.keys[2] = crcByte(this.keys[2], this.keys[1] >>> 24);
  }

  decrypt(data: Buffer): Buffer {
    const out = Buffer.alloc(data.length);
    for (let index = 0; index < data.length; index++) {
      const temp = (this.keys[2] | 2) & 0xffff;
      const plain = data[index] ^ ((Math.imul(temp, temp ^ 1) >>> 8) & 0xff);
      out[index] = plain;
      this.update(plain);
    }
    return out;
  }
}

// The 12-byte encryption header ends with a check byte: the CRC's high byte, or the DOS time's high byte when the
// sizes and CRC come after the data (flag bit 3). A wrong password fails this check 255 times in 256.
export function zipCryptoCheck(entry: ZipEntry): number {
  return entry.flags & 0x8 ? (entry.modTime >>> 8) & 0xff : (entry.crc >>> 24) & 0xff;
}

// ---------- WinZip AES ----------

export class AesDecipher {
  private cipher;
  private hmac;
  private counter = 1n;
  private keystream = Buffer.alloc(0);

  // `salt` and `verifier` come from the start of the entry data; returns null when the password is wrong.
  static open(password: Buffer, strength: 1 | 2 | 3, salt: Buffer, verifier: Buffer): AesDecipher | null {
    const keyLength = 8 + strength * 8; // 16, 24 or 32 bytes
    const material = pbkdf2Sync(password, salt, 1000, keyLength * 2 + 2, 'sha1');
    if (!timingSafeEqual(material.subarray(keyLength * 2), verifier)) return null;
    return new AesDecipher(material.subarray(0, keyLength), material.subarray(keyLength, keyLength * 2));
  }

  private constructor(key: Buffer, macKey: Buffer) {
    this.cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
    this.cipher.setAutoPadding(false);
    this.hmac = createHmac('sha1', macKey);
  }

  // WinZip's CTR mode: a 16-byte little-endian counter starting at 1, one block per 16 bytes of data.
  decrypt(data: Buffer): Buffer {
    this.hmac.update(data);
    while (this.keystream.length < data.length) {
      const blocks = Math.max(1, Math.ceil((data.length - this.keystream.length) / 16));
      const counters = Buffer.alloc(blocks * 16);
      for (let block = 0; block < blocks; block++) {
        let value = this.counter++;
        for (let byte = 0; byte < 16 && value > 0n; byte++) {
          counters[block * 16 + byte] = Number(value & 0xffn);
          value >>= 8n;
        }
      }
      this.keystream = Buffer.concat([this.keystream, this.cipher.update(counters)]);
    }
    const out = Buffer.alloc(data.length);
    for (let index = 0; index < data.length; index++) out[index] = data[index] ^ this.keystream[index];
    this.keystream = this.keystream.subarray(data.length);
    return out;
  }

  // The 10-byte authentication code after the data: proves the bytes were not damaged (AE-2 has no CRC).
  authentic(code: Buffer): boolean {
    const expected = this.hmac.digest().subarray(0, 10);
    return code.length === 10 && timingSafeEqual(expected, code);
  }
}

export const aesSaltLength = (strength: 1 | 2 | 3) => 4 + strength * 4; // 8, 12 or 16 bytes
