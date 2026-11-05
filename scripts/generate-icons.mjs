import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';

const size = 512;
const pixels = new Uint8Array(size * size * 4);
const background = [68, 102, 83];
const paper = [246, 243, 231];
const ink = [68, 102, 83];
const radius = size * 0.24;
const polygons = [
  [[114, 130], [256, 163], [256, 374], [114, 333]],
  [[256, 163], [397, 130], [397, 333], [256, 374]],
];
const lines = [
  [151, 188, 220, 204], [151, 226, 220, 242], [151, 264, 220, 280],
  [292, 203, 363, 186], [292, 241, 363, 224], [292, 279, 363, 262],
];

function insideRoundedSquare(x, y) {
  const cx = Math.max(radius, Math.min(size - radius, x));
  const cy = Math.max(radius, Math.min(size - radius, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function insidePolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function onSegment(x, y, [x1, y1, x2, y2], width) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const progress = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - x1 - progress * dx, y - y1 - progress * dy) <= width / 2;
}

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const px = x + 0.5;
    const py = y + 0.5;
    let color = insideRoundedSquare(px, py) ? background : null;
    if (polygons.some(points => insidePolygon(px, py, points))) color = paper;
    if ((px > 252 && px < 260 && py > 156 && py < 378)
      || lines.some(line => onSegment(px, py, line, 5))) color = ink;
    if (!color) continue;
    const offset = (y * size + x) * 4;
    pixels.set([...color, 255], offset);
  }
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(name, data) {
  const type = Buffer.from(name, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
}

function png(dimension) {
  const scanlines = Buffer.alloc(dimension * (dimension * 4 + 1));
  for (let y = 0; y < dimension; y += 1) {
    const rowOffset = y * (dimension * 4 + 1) + 1;
    for (let x = 0; x < dimension; x += 1) {
      const sourceX = Math.min(size - 1, Math.floor(x * size / dimension));
      const sourceY = Math.min(size - 1, Math.floor(y * size / dimension));
      const sourceOffset = (sourceY * size + sourceX) * 4;
      scanlines.set(pixels.subarray(sourceOffset, sourceOffset + 4), rowOffset + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(dimension, 0);
  header.writeUInt32BE(dimension, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(scanlines)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

await mkdir('public', { recursive: true });
await Promise.all([
  writeFile('public/apple-touch-icon.png', png(180)),
  writeFile('public/icon-192.png', png(192)),
  writeFile('public/icon-512.png', png(512)),
]);
console.log('Generated the iPhone home screen icon and install icons.');
