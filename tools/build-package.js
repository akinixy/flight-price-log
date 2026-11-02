#!/usr/bin/env node
"use strict";

// 生成商店/Release 用的扩展压缩包。
// 只包含运行所需文件，条目路径统一使用正斜杠。

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const ROOT = path.resolve(__dirname, "..");
const MANIFEST_PATH = path.join(ROOT, "manifest.json");
const INCLUDE = [
  "manifest.json",
  "src",
  "icons",
  "README.md",
  "LICENSE",
  "CHANGELOG.md",
];

function collect(relPath) {
  const absPath = path.join(ROOT, relPath);
  const stat = fs.statSync(absPath);
  if (stat.isFile()) {
    return [relPath.split(path.sep).join("/")];
  }
  return fs
    .readdirSync(absPath)
    .sort()
    .reduce((files, name) => files.concat(collect(path.join(relPath, name))), []);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc ^= buffer[i];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

function localHeader(entry) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(entry.time, 10);
  header.writeUInt16LE(entry.day, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed.length, 18);
  header.writeUInt32LE(entry.data.length, 22);
  header.writeUInt16LE(entry.name.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(entry.time, 12);
  header.writeUInt16LE(entry.day, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  const files = INCLUDE.reduce((list, rel) => list.concat(collect(rel)), []);
  const { time, day } = dosDateTime(new Date());
  const entries = files.map((relPath) => {
    const data = fs.readFileSync(path.join(ROOT, relPath));
    return {
      name: Buffer.from(relPath, "utf8"),
      data,
      compressed: zlib.deflateRawSync(data, { level: 9 }),
      crc: crc32(data),
      time,
      day,
      offset: 0,
    };
  });

  let offset = 0;
  entries.forEach((entry) => {
    entry.offset = offset;
    offset += 30 + entry.name.length + entry.compressed.length;
  });

  const centralSize = entries.reduce(
    (size, entry) => size + 46 + entry.name.length,
    0
  );
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const parts = [];
  entries.forEach((entry) => {
    parts.push(localHeader(entry), entry.name, entry.compressed);
  });
  entries.forEach((entry) => {
    parts.push(centralHeader(entry), entry.name);
  });
  parts.push(end);

  const outDir = path.join(ROOT, "dist");
  const outPath = path.join(outDir, `flight-price-log-${manifest.version}.zip`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, Buffer.concat(parts));

  console.log(`已生成 ${path.relative(ROOT, outPath)}`);
  console.log(
    `版本 ${manifest.version}，${entries.length} 个文件，${fs.statSync(outPath).size} 字节`
  );
  entries.forEach((entry) => console.log(`  ${entry.name.toString("utf8")}`));
}

main();
