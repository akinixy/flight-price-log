#!/usr/bin/env node
"use strict";

// 本地一键测试：Node 单元测试 + 浏览器测试 + 全部脚本语法检查。
// 用法：node tools/run-all-tests.js

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const failures = [];

function run(label, args) {
  console.log("\n=== " + label + " ===");
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    failures.push(label + "（退出码 " + result.status + "）");
  }
}

function collectJs(dir, list) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(function (entry) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJs(full, list);
    } else if (entry.name.endsWith(".js")) {
      list.push(path.relative(ROOT, full));
    }
  });
}

run("Node 单元测试", [
  "--test",
  "test/merge.test.js",
  "test/format.test.js",
  "test/record.test.js",
  "test/backup.test.js",
  "test/manifest.test.js",
]);

[
  "test-autoscroll.html",
  "test-parser.html",
  "test-chart.html",
  "test-popup.html",
].forEach(function (file) {
  run("浏览器测试 " + file, ["tools/run-browser-test.js", file]);
});

const jsFiles = [];
collectJs(path.join(ROOT, "src"), jsFiles);
collectJs(path.join(ROOT, "tools"), jsFiles);

console.log("\n=== 语法检查（" + jsFiles.length + " 个文件） ===");
let syntaxFailed = 0;
jsFiles.forEach(function (file) {
  const result = spawnSync(process.execPath, ["--check", file], {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    syntaxFailed += 1;
    console.error("语法错误：" + file);
  }
});
if (syntaxFailed) {
  failures.push("语法检查（" + syntaxFailed + " 个文件失败）");
}

if (failures.length) {
  console.error("\n失败项：\n- " + failures.join("\n- "));
  process.exit(1);
}

console.log("\n全部测试通过。");
