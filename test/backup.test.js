"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const CtripBackup = require("../src/shared/backup.js");

const KEY = "oneway:YIH-CGQ:2026-11-12:y_s_c_f";

function makeRoute(updatedAt) {
  return {
    key: KEY,
    updatedAt: updatedAt,
    latest: { t: updatedAt, minPrice: 520, minFlightNo: "FM9366", flights: [] },
    history: [{ t: updatedAt, minPrice: 520, minFlightNo: "FM9366" }],
  };
}

test("validateBackup 接受合法备份并跳过残缺航线", () => {
  const result = CtripBackup.validateBackup({
    routes: {
      [KEY]: makeRoute(1),
      bad: { latest: {} },
      worse: null,
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.routes[KEY]);
  assert.equal(result.skipped, 2);
});

test("validateBackup 拒绝非对象或缺少 routes", () => {
  assert.equal(CtripBackup.validateBackup(null).ok, false);
  assert.equal(CtripBackup.validateBackup({}).ok, false);
  assert.equal(CtripBackup.validateBackup({ routes: [] }).ok, false);
  assert.equal(CtripBackup.validateBackup({ routes: {} }).ok, false);
});

test("mergeRoutes 同一航线保留较新的记录", () => {
  const current = { [KEY]: makeRoute(10) };
  const imported = { [KEY]: makeRoute(5) };

  const olderImport = CtripBackup.mergeRoutes(current, imported);
  assert.equal(olderImport[KEY].updatedAt, 10);

  const newerImport = CtripBackup.mergeRoutes(current, {
    [KEY]: makeRoute(20),
  });
  assert.equal(newerImport[KEY].updatedAt, 20);
});

test("mergeRoutes 保留当前独有的航线", () => {
  const otherKey = "oneway:YIH-CGQ:2026-11-13:y_s_c_f";
  const current = {
    [KEY]: makeRoute(10),
    [otherKey]: Object.assign({}, makeRoute(8), { key: otherKey }),
  };

  const merged = CtripBackup.mergeRoutes(current, { [KEY]: makeRoute(20) });
  assert.ok(merged[otherKey]);
  assert.equal(merged[KEY].updatedAt, 20);
});
