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

const flight = require("../src/shared/flight.js");

function makeSeries(no, depart, arrive, samples) {
  return {
    no: no,
    airline: "东方航空",
    departTime: depart,
    arriveTime: arrive,
    transfers: 0,
    firstSeenAt: samples[0][0],
    lastSeenAt: samples[samples.length - 1][0],
    latestPrice: samples[samples.length - 1][1],
    samples: samples,
  };
}

test("validateBackup 接受 v2 并清理每班历史", () => {
  const route = makeRoute(10);
  route.flightHistory = {
    "MU5101|07:00|09:15": makeSeries("MU5101", "07:00", "09:15", [
      [900, 700],
      [1000, 680],
    ]),
  };
  const result = CtripBackup.validateBackup({ version: 2, routes: { [KEY]: route } });
  assert.equal(result.ok, true);
  assert.ok(result.routes[KEY].flightHistory["MU5101|07:00|09:15"]);
  assert.deepEqual(
    result.routes[KEY].flightHistory["MU5101|07:00|09:15"].samples,
    [[900, 700], [1000, 680]]
  );
  assert.equal(result.skippedSeries, 0);
});

test("validateBackup 拒绝过新版本并过滤危险键", () => {
  assert.equal(CtripBackup.validateBackup({ version: 3, routes: {} }).ok, false);

  const route = makeRoute(10);
  const history = {
    "MU5101|07:00|09:15": makeSeries("MU5101", "07:00", "09:15", [[1000, 680]]),
  };
  Object.defineProperty(history, "__proto__", {
    value: makeSeries("MU5101", "07:00", "09:15", [[1000, 680]]),
    enumerable: true,
    configurable: true,
    writable: true,
  });
  route.flightHistory = history;
  const result = CtripBackup.validateBackup({
    version: 2,
    routes: { [KEY]: route },
  });
  assert.equal(result.ok, true);
  assert.equal(result.skippedSeries, 1);
  assert.ok(result.routes[KEY].flightHistory["MU5101|07:00|09:15"]);
});

test("mergeRoutes 合并航线历史与同一航班样本", () => {
  const id = "MU5101|07:00|09:15";
  const current = { [KEY]: makeRoute(10) };
  current[KEY].flightHistory = {
    [id]: makeSeries("MU5101", "07:00", "09:15", [[900, 700], [1000, 680]]),
  };
  const imported = { [KEY]: makeRoute(20) };
  imported[KEY].flightHistory = {
    [id]: makeSeries("MU5101", "07:00", "09:15", [[1100, 650]]),
  };

  const merged = CtripBackup.mergeRoutes(current, imported);
  assert.equal(merged[KEY].updatedAt, 20);
  assert.deepEqual(merged[KEY].flightHistory[id].samples, [
    [900, 700],
    [1000, 680],
    [1100, 650],
  ]);
});

test("mergeRoutes 旧备份不丢当前每班历史", () => {
  const id = "MU5101|07:00|09:15";
  const current = { [KEY]: makeRoute(10) };
  current[KEY].flightHistory = {
    [id]: makeSeries("MU5101", "07:00", "09:15", [[900, 700]]),
  };
  const imported = { [KEY]: makeRoute(20) };

  const merged = CtripBackup.mergeRoutes(current, imported);
  assert.ok(merged[KEY].flightHistory[id]);
  assert.deepEqual(merged[KEY].flightHistory[id].samples, [[900, 700]]);
});
