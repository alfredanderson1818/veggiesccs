// Quita el fondo (ajedrez/blanco) del logo y lo deja transparente.
// Conserva solo los pixeles verdes; los bordes anti-alias quedan con alpha gradual.
// PNG puro con zlib, sin dependencias externas.
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const SRC = process.argv[2];
const OUT = process.argv[3];

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readChunks(buf) {
  const chunks = [];
  let off = 8; // skip signature
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    chunks.push({ type, data });
    off += 12 + len;
  }
  return chunks;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

const png = readFileSync(SRC);
const chunks = readChunks(png);
const ihdr = chunks.find((c) => c.type === 'IHDR').data;
const width = ihdr.readUInt32BE(0);
const height = ihdr.readUInt32BE(4);
const bitDepth = ihdr[8];
const colorType = ihdr[9];
if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
  throw new Error(`Formato no soportado: bitDepth=${bitDepth} colorType=${colorType}`);
}
const srcChannels = colorType === 6 ? 4 : 3;

const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
const raw = inflateSync(idat);

// Unfilter -> RGB(A) pixel buffer
const stride = width * srcChannels;
const pixels = Buffer.alloc(height * stride);
let pos = 0;
for (let y = 0; y < height; y++) {
  const filter = raw[pos++];
  const rowStart = y * stride;
  for (let x = 0; x < stride; x++) {
    const rawByte = raw[pos++];
    const a = x >= srcChannels ? pixels[rowStart + x - srcChannels] : 0;
    const b = y > 0 ? pixels[rowStart - stride + x] : 0;
    const c = x >= srcChannels && y > 0 ? pixels[rowStart - stride + x - srcChannels] : 0;
    let val;
    switch (filter) {
      case 0: val = rawByte; break;
      case 1: val = rawByte + a; break;
      case 2: val = rawByte + b; break;
      case 3: val = rawByte + ((a + b) >> 1); break;
      case 4: val = rawByte + paeth(a, b, c); break;
      default: throw new Error(`Filtro desconocido ${filter}`);
    }
    pixels[rowStart + x] = val & 0xff;
  }
}

// Build RGBA, keying out non-green background
const out = Buffer.alloc(width * height * 4);
for (let i = 0, p = 0; i < width * height; i++) {
  const si = i * srcChannels;
  const r = pixels[si];
  const g = pixels[si + 1];
  const b = pixels[si + 2];
  const diff = g - Math.max(r, b);
  let alpha = Math.round((diff - 6) * 8);
  if (alpha < 0) alpha = 0;
  if (alpha > 255) alpha = 255;
  out[p++] = r;
  out[p++] = g;
  out[p++] = b;
  out[p++] = alpha;
}

// Re-encode as RGBA PNG (filter 0 each scanline)
const outStride = width * 4;
const rawOut = Buffer.alloc(height * (outStride + 1));
for (let y = 0; y < height; y++) {
  rawOut[y * (outStride + 1)] = 0;
  out.copy(rawOut, y * (outStride + 1) + 1, y * outStride, (y + 1) * outStride);
}
const compressed = deflateSync(rawOut, { level: 9 });

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

const newIhdr = Buffer.alloc(13);
newIhdr.writeUInt32BE(width, 0);
newIhdr.writeUInt32BE(height, 4);
newIhdr[8] = 8; // bit depth
newIhdr[9] = 6; // RGBA
newIhdr[10] = 0;
newIhdr[11] = 0;
newIhdr[12] = 0;

const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const result = Buffer.concat([
  signature,
  chunk('IHDR', newIhdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0))
]);

writeFileSync(OUT, result);
console.log(`OK -> ${OUT} (${width}x${height}, ${result.length} bytes)`);
