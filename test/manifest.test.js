"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const manifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")
);

test("manifest 是 MV3 且只申请 storage 权限", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["storage"]);
  assert.equal(manifest.host_permissions, undefined);
});

test("manifest 声明的脚本和图标文件都存在", () => {
  const files = [];
  files.push(manifest.background.service_worker);
  files.push(manifest.action.default_popup);
  (manifest.content_scripts || []).forEach((entry) => {
    (entry.js || []).forEach((file) => files.push(file));
  });
  Object.values(manifest.icons || {}).forEach((file) => files.push(file));

  files.forEach((file) => {
    assert.ok(
      fs.existsSync(path.join(ROOT, file)),
      "缺少文件：" + file
    );
  });
});

test("内容脚本只匹配携程单程列表页", () => {
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://flights.ctrip.com/online/list/*",
  ]);
});

test("声明最低 Chrome 版本", () => {
  assert.ok(Number(manifest.minimum_chrome_version) >= 99);
});
