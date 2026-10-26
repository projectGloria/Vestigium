import { crc32, deflateSync } from 'node:zlib';

// The tray icon (plan §6), drawn in code so the app needs no image asset: the "V" mark in the accent colour on a dark
// rounded square, RGBA, encoded as a minimal PNG (IHDR, one IDAT, IEND). Drawn on a 32-unit grid and scaled, so the
// same mark also becomes the 256 px application and installer icon (scripts/make-icon.ts → build/icon.png).

const BACKGROUND = [0x11, 0x19, 0x16, 0xff];
const MARK = [0xa7, 0xcf, 0x8a, 0xff];

function pixel(px: number, py: number, size: number): number[] {
  // Sample the 32-unit design at this pixel's centre.
  const x = ((px + 0.5) * 32) / size - 0.5;
  const y = ((py + 0.5) * 32) / size - 0.5;
  const SIZE = 32;
  // Rounded corners: transparent outside a radius-6 rounding.
  const corner = 6;
  const cx = x < corner ? corner : x > SIZE - 1 - corner ? SIZE - 1 - corner : x;
  const cy = y < corner ? corner : y > SIZE - 1 - corner ? SIZE - 1 - corner : y;
  if ((x - cx) ** 2 + (y - cy) ** 2 > corner ** 2) return [0, 0, 0, 0];
  // A "V": two strokes from the top corners meeting at the bottom centre, about 4 px wide.
  const top = 7;
  const bottom = 25;
  if (y >= top && y <= bottom) {
    const progress = (y - top) / (bottom - top);
    const left = 7 + progress * (16 - 7);
    const right = 25 - progress * (25 - 16);
    if (Math.abs(x - left) <= 2 || Math.abs(x - right) <= 2) return MARK;
  }
  return BACKGROUND;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([length, body, crc]);
}

export function trayIconPng(size = 32): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.writeUInt8(8, 8); // bit depth
  header.writeUInt8(6, 9); // RGBA
  // Each row starts with filter type 0 (none).
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) {
    const start = y * (1 + size * 4);
    for (let x = 0; x < size; x++) Buffer.from(pixel(x, y, size)).copy(rows, start + 1 + x * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
