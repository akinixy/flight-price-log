#!/usr/bin/env node
"use strict";

// 生成扩展图标：纯 Node（只用 fs、zlib），无第三方依赖。
// 设计：墨色圆角方块 + 象牙色纸飞机 + 铜色价格轨迹。
// 为改善小尺寸观感，按 4x 超采样渲染后取平均。
// 用法：node tools/make-icons.js

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUTPUT_DIR = path.resolve(__dirname, "..", "icons");
const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;
const BACKGROUND = [0x10, 0x1e, 0x2b];
const LINE_COLOR = [0xf4, 0xef, 0xe4];
const ACCENT_COLOR = [0xc9, 0x7b, 0x3c];
// 归一化坐标（相对图标边长）。
const TRAIL_POINTS = [
  [0.15, 0.84],
  [0.33, 0.67],
  [0.44, 0.73],
  [0.53, 0.57],
];
const PLANE_POLYGONS = [
  [
    [0.8, 0.2],
    [0.28, 0.5],
    [0.54, 0.55],
  ],
  [
    [0.8, 0.2],
    [0.54, 0.55],
    [0.48, 0.82],
  ],
];

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const CRC_TABLE = (function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

// PNG 规范的 CRC32 覆盖「类型 + 数据」，不包含长度字段。
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuffer, data]);
  const chunk = Buffer.alloc(4 + body.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 4 + body.length);
  return chunk;
}

// IHDR：宽、高、8 位深度、颜色类型 6（RGBA）、压缩/滤波/隔行均为 0。
function createIhdr(size) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(size, 0);
  data.writeUInt32BE(size, 4);
  data[8] = 8;
  data[9] = 6;
  data[10] = 0;
  data[11] = 0;
  data[12] = 0;
  return pngChunk("IHDR", data);
}

// IDAT：每行前置 filter 字节 0，其余为 RGBA 像素。
function createIdat(size, pixels) {
  const stride = size * 4;
  const raw = Buffer.alloc(size * (stride + 1));

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    pixels.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }

  return pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 }));
}

// 圆角方块内部判断：把点夹到内矩形上，再看是否落在圆角半径内。
function insideRoundedSquare(x, y, size, radius) {
  const nearestX = Math.min(Math.max(x, radius), size - radius);
  const nearestY = Math.min(Math.max(y, radius), size - radius);
  const dx = x - nearestX;
  const dy = y - nearestY;
  return dx * dx + dy * dy <= radius * radius;
}

function distanceToSegment(x, y, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;

  if (lengthSq === 0) {
    return Math.hypot(x - x1, y - y1);
  }

  let t = ((x - x1) * dx + (y - y1) * dy) / lengthSq;
  t = Math.min(Math.max(t, 0), 1);

  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function insidePolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];
    const intersects =
      yi > y !== yj > y &&
      x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function renderIcon(size) {
  const scale = SUPERSAMPLE;
  const canvasSize = size * scale;
  const cornerRadius = size * 0.24 * scale;
  const trailRadius = (Math.max(1, size / 16) / 2) * scale;
  const foldRadius = size * 0.006 * scale;

  const trail = TRAIL_POINTS.map(function (point) {
    return [point[0] * canvasSize, point[1] * canvasSize];
  });
  const plane = PLANE_POLYGONS.map(function (polygon) {
    return polygon.map(function (point) {
      return [point[0] * canvasSize, point[1] * canvasSize];
    });
  });
  const foldStart = plane[0][0];
  const foldEnd = plane[0][2];
  const showFold = size >= 48;

  function isOnTrail(x, y) {
    for (let i = 0; i < trail.length - 1; i += 1) {
      const start = trail[i];
      const end = trail[i + 1];
      if (
        distanceToSegment(x, y, start[0], start[1], end[0], end[1]) <=
        trailRadius
      ) {
        return true;
      }
    }
    return false;
  }

  function insidePlane(x, y) {
    for (let i = 0; i < plane.length; i += 1) {
      if (insidePolygon(x, y, plane[i])) return true;
    }
    return false;
  }

  function isOnFold(x, y) {
    return (
      distanceToSegment(
        x,
        y,
        foldStart[0],
        foldStart[1],
        foldEnd[0],
        foldEnd[1]
      ) <= foldRadius
    );
  }

  const pixels = Buffer.alloc(size * size * 4);
  const samplesPerPixel = scale * scale;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let covered = 0;

      for (let sy = 0; sy < scale; sy += 1) {
        for (let sx = 0; sx < scale; sx += 1) {
          const sampleX = x * scale + sx + 0.5;
          const sampleY = y * scale + sy + 0.5;

          let color = null;
          if (insidePlane(sampleX, sampleY)) {
            color =
              showFold && isOnFold(sampleX, sampleY)
                ? BACKGROUND
                : LINE_COLOR;
          } else if (isOnTrail(sampleX, sampleY)) {
            color = ACCENT_COLOR;
          } else if (
            insideRoundedSquare(sampleX, sampleY, canvasSize, cornerRadius)
          ) {
            color = BACKGROUND;
          }

          if (color) {
            red += color[0];
            green += color[1];
            blue += color[2];
            covered += 1;
          }
        }
      }

      const offset = (y * size + x) * 4;
      if (covered > 0) {
        pixels[offset] = Math.round(red / covered);
        pixels[offset + 1] = Math.round(green / covered);
        pixels[offset + 2] = Math.round(blue / covered);
        pixels[offset + 3] = Math.round((covered / samplesPerPixel) * 255);
      }
    }
  }

  return pixels;
}

function createPng(size) {
  return Buffer.concat([
    PNG_SIGNATURE,
    createIhdr(size),
    createIdat(size, renderIcon(size)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  for (const size of SIZES) {
    const filePath = path.join(OUTPUT_DIR, "icon" + size + ".png");
    fs.writeFileSync(filePath, createPng(size));
    console.log(
      "[make-icons] wrote " +
        path.relative(process.cwd(), filePath) +
        " (" +
        size +
        "x" +
        size +
        ")"
    );
  }
}

if (require.main === module) {
  main();
}

module.exports = { createPng };
