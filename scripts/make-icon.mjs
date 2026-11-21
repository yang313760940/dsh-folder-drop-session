#!/usr/bin/env node
/**
 * 零依赖生成 %！<%>：SVG 源 + 64px PNG（light/design 下用作市场图标）。
 * PNG 由纯 Node 手写编码（zlib + CRC），不引入绘图库。
 */
import { writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

const size = 64;
const bg = [31, 35, 47];
const accent = [124, 140, 255];
const paper = [236, 239, 255];

// 64x64 画布：圆角底 + 文件夹 + 下箭头（文件夹拖入）
const px = Array.from({ length: size }, () => Array.from({ length: size }, () => [...bg, 255]));
const rounded = (x, y, r) => {
  const corners = [[r, r], [size - 1 - r, r], [r, size - 1 - r], [size - 1 - r, size - 1 - r]];
  if (x >= r && x < size - r && y >= r && y < size - r) return true;
  return corners.some(([cx, cy]) => (x < r || x >= size - r) && (y < r || y >= size - r)
    && (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
};
const fill = (x0, y0, x1, y1, color) => {
  for (let y = Math.max(0, y0); y <= Math.min(size - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(size - 1, x1); x++) if (rounded(x, y, 14)) px[y][x] = [...color, 255];
};
fill(0, 0, 63, 63, bg);
// 文件夹主体
fill(18, 26, 45, 31, accent);
fill(18, 31, 45, 46, accent);
fill(22, 35, 41, 42, bg);
// 下箭头
fill(30, 34, 33, 44, paper);
fill(28, 42, 35, 44, paper);
for (let i = 0; i < 7; i++) {
  const y = 44 + i; const half = 7 - i;
  fill(32 - half, y, 31 + half, y, paper);
}
// 箭头柄
fill(30, 33, 33, 46, paper);

// PNG 编码
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = bytes => { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) {
  raw[y * (size * 4 + 1)] = 0;
  for (let x = 0; x < size; x++) Buffer.from(px[y][x]).copy(raw, y * (size * 4 + 1) + 1 + x * 4);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]);
await writeFile(new URL('../assets/icon.png', import.meta.url), png);
console.log(`icon.png ${png.length} bytes`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="dsh folder drop session">
  <rect width="64" height="64" rx="14" fill="#1f232f"/>
  <rect x="18" y="26" width="28" height="5" rx="2" fill="#7c8cff"/>
  <rect x="18" y="31" width="28" height="15" rx="3" fill="#7c8cff"/>
  <rect x="22" y="35" width="20" height="7" rx="1.5" fill="#1f232f"/>
  <path d="M32 33v13M26.5 41.5 32 47l5.5-5.5" fill="none" stroke="#ecefff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
await writeFile(new URL('../assets/icon.svg', import.meta.url), svg);
console.log('icon.svg written');
