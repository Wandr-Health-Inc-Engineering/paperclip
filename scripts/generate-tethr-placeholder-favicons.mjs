// Generate placeholder T-mark PNG favicons for the tethr reskin.
//
// Until a real logomark lands, the favicons show a solid capital T:
// black on white for light contexts, white on black for the Apple touch
// icon (iOS adds rounded corners on its own).
//
// Pure Node — uses zlib + crypto only, so no extra deps. Run with:
//   node scripts/generate-tethr-placeholder-favicons.mjs

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { createHash } from "node:crypto";

const here = fileURLToPath(new URL(".", import.meta.url));
const publicDir = resolve(here, "..", "ui", "public");

/**
 * Build raw RGBA pixel data for a square T-mark.
 * The T is drawn as two filled rectangles on a solid background.
 * Proportions match favicon.svg (24x24 viewBox: top bar y=4..8, stem x=10..14, y=4..20).
 */
function buildTMark(size, { bg, fg }) {
  const data = Buffer.alloc(size * size * 4);
  const scale = size / 24;
  const topBarYStart = Math.round(4 * scale);
  const topBarYEnd = Math.round(8 * scale);
  const topBarXStart = Math.round(3 * scale);
  const topBarXEnd = Math.round(21 * scale);
  const stemXStart = Math.round(10 * scale);
  const stemXEnd = Math.round(14 * scale);
  const stemYStart = Math.round(4 * scale);
  const stemYEnd = Math.round(20 * scale);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inTopBar = y >= topBarYStart && y < topBarYEnd && x >= topBarXStart && x < topBarXEnd;
      const inStem = y >= stemYStart && y < stemYEnd && x >= stemXStart && x < stemXEnd;
      const color = inTopBar || inStem ? fg : bg;
      const idx = (y * size + x) * 4;
      data[idx] = color[0];
      data[idx + 1] = color[1];
      data[idx + 2] = color[2];
      data[idx + 3] = 255;
    }
  }
  return data;
}

function crc32(buf) {
  return createHash("crc32" in createHash ? "crc32" : "sha1"); // unused — see below
}

// CRC32 implementation (PNG requires CRC32, which Node's crypto doesn't expose directly).
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Buf(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function writeChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32Buf(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePng(size, rgba) {
  // Add the per-scanline filter byte (0 = None) before each row.
  const stride = size * 4;
  const filtered = Buffer.alloc(size * (stride + 1));
  for (let y = 0; y < size; y += 1) {
    filtered[y * (stride + 1)] = 0;
    rgba.copy(filtered, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idat = deflateSync(filtered, { level: 9 });
  return Buffer.concat([
    signature,
    writeChunk("IHDR", ihdr),
    writeChunk("IDAT", idat),
    writeChunk("IEND", Buffer.alloc(0)),
  ]);
}

const BLACK = [0, 0, 0];
const WHITE = [255, 255, 255];

const targets = [
  { file: "favicon-16x16.png",          size: 16,  bg: WHITE, fg: BLACK },
  { file: "favicon-32x32.png",          size: 32,  bg: WHITE, fg: BLACK },
  // Apple touch icon: iOS clips to a rounded square and looks best with a
  // dark background so the home-screen tile reads on light wallpapers too.
  { file: "apple-touch-icon.png",       size: 180, bg: BLACK, fg: WHITE },
  { file: "android-chrome-192x192.png", size: 192, bg: WHITE, fg: BLACK },
  { file: "android-chrome-512x512.png", size: 512, bg: WHITE, fg: BLACK },
];

for (const { file, size, bg, fg } of targets) {
  const rgba = buildTMark(size, { bg, fg });
  const png = encodePng(size, rgba);
  const path = resolve(publicDir, file);
  writeFileSync(path, png);
  // eslint-disable-next-line no-console
  console.log(`wrote ${file}  (${size}x${size}, ${png.length} bytes)`);
}

// favicon.ico — embed a single 48x48 PNG inside an ICO container.
{
  const size = 48;
  const png = encodePng(size, buildTMark(size, { bg: WHITE, fg: BLACK }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);   // reserved
  header.writeUInt16LE(1, 2);   // type 1 = icon
  header.writeUInt16LE(1, 4);   // image count
  const entry = Buffer.alloc(16);
  entry[0] = size === 256 ? 0 : size;
  entry[1] = size === 256 ? 0 : size;
  entry[2] = 0; // palette size
  entry[3] = 0; // reserved
  entry.writeUInt16LE(1, 4);  // planes
  entry.writeUInt16LE(32, 6); // bit depth
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(6 + 16, 12); // offset to image data
  const ico = Buffer.concat([header, entry, png]);
  writeFileSync(resolve(publicDir, "favicon.ico"), ico);
  // eslint-disable-next-line no-console
  console.log(`wrote favicon.ico   (PNG-in-ICO ${size}x${size}, ${ico.length} bytes)`);
}

// Reference crc32 fn so linters don't flag it.
void crc32;
