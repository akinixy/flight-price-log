#!/usr/bin/env node
"use strict";

// 生成 Edge 商店使用的 300x300 Logo，复用扩展图标的绘制逻辑。

const fs = require("fs");
const path = require("path");
const { createPng } = require("./make-icons");

const OUT_DIR = path.resolve(__dirname, "..", "store");
const OUT_PATH = path.join(OUT_DIR, "logo-300.png");

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_PATH, createPng(300));
console.log(
  "[make-store-logo] wrote " +
    path.relative(process.cwd(), OUT_PATH) +
    " (300x300)"
);
