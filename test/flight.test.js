"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const flight = require("../src/shared/flight.js");

function series(id, lastSeenAt, samples) {
  return {
    no: "MU5101",
    airline: "东方航空",
    departTime: "07:00",
    arriveTime: "09:15",
    transfers: 0,
    firstSeenAt: samples && samples.length ? samples[0][0] : lastSeenAt,
    lastSeenAt,
    latestPrice: samples && samples.length ? samples[samples.length - 1][1] : 680,
    samples: samples || [],
  };
}

test("normalizeFlightNo 提取航段并保留顺序", () => {
  assert.equal(flight.normalizeFlightNo("南航 CZ3312"), "CZ3312");
  assert.equal(flight.normalizeFlightNo("FM9366 / FM9071"), "FM9366/FM9071");
  assert.equal(flight.normalizeFlightNo("FM9366+FM9071"), "FM9366/FM9071");
  assert.equal(flight.normalizeFlightNo("2026-11-18"), "");
});

test("多段航班号顺序不影响身份", () => {
  const a = { no: "FM9366/FM9071", departTime: "20:25", arriveTime: "10:35+1" };
  const b = { no: "FM9071/FM9366", departTime: "20:25", arriveTime: "10:35+1" };
  assert.equal(flight.flightIdentity(a), flight.flightIdentity(b));
});

test("到达时间跨天自动补 +1", () => {
  assert.equal(flight.normalizeArriveTime("23:50", "00:20"), "00:20+1");
  assert.equal(flight.normalizeArriveTime("08:10", "09:15"), "09:15");
  assert.equal(flight.normalizeArriveTime("20:25", "10:35+1"), "10:35+1");
});

test("身份包含到达时间", () => {
  const base = { no: "MU5101", departTime: "07:00" };
  assert.notEqual(
    flight.flightIdentity({ ...base, arriveTime: "09:15" }),
    flight.flightIdentity({ ...base, arriveTime: "09:30" })
  );
});

test("序列首次、变价、心跳与上限", () => {
  const t = 1762200000000;
  let history = flight.mergeFlightHistory(null, [
    { no: "MU5101", airline: "东方航空", departTime: "07:00", arriveTime: "09:15", transfers: 0, price: 680 },
  ], t);
  const id = flight.flightIdentity({ no: "MU5101", departTime: "07:00", arriveTime: "09:15" });
  assert.deepEqual(history[id].samples, [[t, 680]]);

  history = flight.mergeFlightHistory(history, [
    { no: "MU5101", airline: "东方航空", departTime: "07:00", arriveTime: "09:15", transfers: 0, price: 650 },
  ], t + 60000);
  assert.deepEqual(history[id].samples, [[t, 680], [t + 60000, 650]]);

  history = flight.mergeFlightHistory(history, [
    { no: "MU5101", airline: "东方航空", departTime: "07:00", arriveTime: "09:15", transfers: 0, price: 650 },
  ], t + 120000);
  assert.equal(history[id].samples.length, 2);

  history = flight.mergeFlightHistory(history, [
    { no: "MU5101", airline: "东方航空", departTime: "07:00", arriveTime: "09:15", transfers: 0, price: 650 },
  ], t + 60000 + flight.HEARTBEAT_MS);
  assert.equal(history[id].samples.length, 3);

  let many = history;
  for (let i = 1; i <= 300; i += 1) {
    many = flight.mergeFlightHistory(many, [
      { no: "MU5101", airline: "东方航空", departTime: "07:00", arriveTime: "09:15", transfers: 0, price: 600 + i },
    ], t + flight.HEARTBEAT_MS * i);
  }
  assert.equal(many[id].samples.length, flight.MAX_SAMPLES_PER_FLIGHT);
});

test("备份合并取样本并集并保留较新元数据", () => {
  const t = 1762200000000;
  const a = {
    x: series("x", t, [[t, 680], [t + 3600000, 650]]),
  };
  const b = {
    x: series("x", t + 7200000, [[t + 7200000, 620]]),
  };
  const merged = flight.mergeFlightHistoryMaps(a, b);
  assert.deepEqual(merged.x.samples, [
    [t, 680],
    [t + 3600000, 650],
    [t + 7200000, 620],
  ]);
  assert.equal(merged.x.latestPrice, 620);
});

test("enforceBudgets 不修改输入并清理过期序列", () => {
  const now = 1762200000000;
  const old = now - flight.RETENTION_MS - 1;
  const input = {
    "oneway:SHA-PEK:2026-11-18:y_s_c_f": {
      updatedAt: now,
      history: [{ t: old, minPrice: 680 }],
      flightHistory: {
        a: series("a", old, [[old, 680]]),
        b: series("b", now, [[now, 700]]),
      },
    },
  };
  const snapshot = JSON.stringify(input);
  const next = flight.enforceBudgets(input, now);
  assert.equal(JSON.stringify(input), snapshot);
  assert.equal(next["oneway:SHA-PEK:2026-11-18:y_s_c_f"].flightHistory.a, undefined);
  assert.ok(next["oneway:SHA-PEK:2026-11-18:y_s_c_f"].flightHistory.b);
});

test("enforceBudgets 控制全局序列、单路线序列与样本上限", () => {
  const now = 1762200000000;
  const routes = {};
  for (let r = 0; r < 5; r += 1) {
    const key = "route-" + r;
    routes[key] = { updatedAt: now + r, history: [], flightHistory: {} };
    for (let i = 0; i < 100; i += 1) {
      const id = "series-" + r + "-" + i;
      routes[key].flightHistory[id] = series(id, now + i, [
        [now, 500],
        [now + 3600000, 600],
        [now + 7200000, 700],
      ]);
    }
  }
  const next = flight.enforceBudgets(routes, now, {
    maxSeries: 300,
    maxSeriesPerRoute: 200,
    maxSamplesTotal: 1000,
  });
  let count = 0;
  let samples = 0;
  Object.values(next).forEach((route) => {
    const list = Object.values(route.flightHistory || {});
    count += list.length;
    list.forEach((item) => {
      samples += item.samples.length;
    });
  });
  assert.ok(count <= 300);
  assert.ok(samples <= 1000);
});

test("enforceBudgets 控制路线历史总点数", () => {
  const now = 1762200000000;
  const routes = {};
  for (let r = 0; r < 20; r += 1) {
    const history = [];
    for (let i = 0; i < 1000; i += 1) {
      history.push({ t: now - i * 1000, minPrice: 500 + i });
    }
    routes["route-" + r] = {
      updatedAt: now + r,
      history: history,
      flightHistory: {},
    };
  }
  const next = flight.enforceBudgets(routes, now, { maxHistoryTotal: 12000 });
  const total = Object.values(next).reduce(
    (sum, route) => sum + route.history.length,
    0
  );
  assert.ok(total <= 12000);
});

test("compactRoutes 进一步压缩", () => {
  const now = 1762200000000;
  const routes = {};
  for (let r = 0; r < 80; r += 1) {
    routes["route-" + r] = {
      updatedAt: now + r,
      history: Array.from({ length: 500 }, (_, i) => ({ t: now - i, minPrice: 500 })),
      flightHistory: {
        a: series("a", now, Array.from({ length: 200 }, (_, i) => [now - i, 500])),
      },
    };
  }
  const next = flight.compactRoutes(routes, now);
  assert.ok(Object.keys(next).length <= 50);
  Object.values(next).forEach((route) => {
    assert.ok(route.history.length <= 200);
    Object.values(route.flightHistory || {}).forEach((item) => {
      assert.ok(item.samples.length <= 20);
    });
  });
});
