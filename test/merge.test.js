"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const CtripStore = require("../src/shared/merge.js");

const t0 = 1761540000000;
const KEY = "oneway:YIH-CGQ:2026-11-12:y_s_c_f";
const SNAPSHOT_URL =
  "https://flights.ctrip.com/online/list/oneway-yih-cgq?depdate=2026-11-12&cabin=y_s_c_f&adult=1&child=0&infant=0";

function makeSnapshot(overrides) {
  return Object.assign(
    {
      flightWay: "oneway",
      originCode: "YIH",
      originName: "宜昌",
      destCode: "CGQ",
      destName: "长春",
      departDate: "2026-11-12",
      cabin: "y_s_c_f",
      currency: "CNY",
      url: SNAPSHOT_URL,
      t: t0,
      minPrice: 520,
      minFlightNo: "FM9366",
      flights: [
        {
          no: "FM9366/FM9071",
          airline: "上海航空",
          departTime: "20:25",
          arriveTime: "10:35+1",
          transfers: 1,
          price: 520,
        },
      ],
    },
    overrides || {}
  );
}

function makeFlight(overrides) {
  return Object.assign(
    {
      no: "MU5100",
      airline: "东方航空",
      departTime: "08:00",
      arriveTime: "12:30",
      transfers: 0,
      price: 480,
    },
    overrides || {}
  );
}

function assertRejected(result) {
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
  assert.ok(result.error.length > 0);
}

test("validateSnapshot: 接受合法快照", () => {
  assert.deepEqual(CtripStore.validateSnapshot(makeSnapshot()), { ok: true });
});

test("validateSnapshot: 拒绝空对象", () => {
  assertRejected(CtripStore.validateSnapshot({}));
});

test("validateSnapshot: 拒绝错误日期格式", () => {
  assertRejected(
    CtripStore.validateSnapshot(makeSnapshot({ departDate: "2026/11/12" }))
  );
});

test("validateSnapshot: 拒绝航班价格为 0", () => {
  assertRejected(
    CtripStore.validateSnapshot(
      makeSnapshot({
        minPrice: 0,
        flights: [makeFlight({ price: 0 })],
      })
    )
  );
});

test("validateSnapshot: 拒绝空航班数组", () => {
  assertRejected(CtripStore.validateSnapshot(makeSnapshot({ flights: [] })));
});

test("validateSnapshot: 拒绝超过 200 条航班", () => {
  const flights = [];
  for (let i = 0; i < 201; i += 1) {
    flights.push(makeFlight({ no: "MU" + (5000 + i), price: 500 + i }));
  }
  assertRejected(
    CtripStore.validateSnapshot(makeSnapshot({ flights, minPrice: 500 }))
  );
});

test("validateSnapshot: 拒绝 minPrice 与航班最低价不一致", () => {
  assertRejected(
    CtripStore.validateSnapshot(makeSnapshot({ minPrice: 100 }))
  );
});

test("mergeSnapshot: 首次合并返回 created", () => {
  const routes = {};
  const result = CtripStore.mergeSnapshot(routes, makeSnapshot(), t0);

  assert.equal(result.ok, true);
  assert.equal(result.result, "created");
  assert.deepEqual(Object.keys(result.routes), [KEY]);
  assert.deepEqual(routes, {}, "不得修改传入的 routes");

  const entry = result.routes[KEY];
  assert.equal(entry.key, KEY);
  assert.equal(entry.originName, "宜昌");
  assert.equal(entry.destName, "长春");
  assert.equal(entry.departDate, "2026-11-12");
  assert.equal(entry.cabin, "y_s_c_f");
  assert.equal(entry.currency, "CNY");
  assert.equal(entry.url, SNAPSHOT_URL);
  assert.equal(entry.createdAt, t0);
  assert.equal(entry.updatedAt, t0);
  assert.equal(entry.history.length, 1);
  assert.deepEqual(entry.history[0], {
    t: t0,
    minPrice: 520,
    minFlightNo: "FM9366",
  });
  assert.deepEqual(entry.latest, {
    t: t0,
    minPrice: 520,
    minFlightNo: "FM9366",
    flights: makeSnapshot().flights,
  });
});

test("mergeSnapshot: routes 为 null 时视为空对象", () => {
  const result = CtripStore.mergeSnapshot(null, makeSnapshot(), t0);
  assert.equal(result.ok, true);
  assert.equal(result.result, "created");
  assert.deepEqual(Object.keys(result.routes), [KEY]);
});

test("mergeSnapshot: 10 分钟窗口内替换最后一点，返回 updated", () => {
  const created = CtripStore.mergeSnapshot({}, makeSnapshot(), t0);
  const now = t0 + 10 * 60 * 1000;
  const next = makeSnapshot({
    t: now,
    minPrice: 480,
    minFlightNo: "MU5100",
    flights: [makeFlight({ price: 480 })],
  });

  const result = CtripStore.mergeSnapshot(created.routes, next, now);

  assert.equal(result.ok, true);
  assert.equal(result.result, "updated");

  const entry = result.routes[KEY];
  assert.equal(entry.history.length, 1);
  assert.deepEqual(entry.history[0], {
    t: now,
    minPrice: 480,
    minFlightNo: "MU5100",
  });
  assert.equal(entry.latest.t, now);
  assert.equal(entry.latest.minPrice, 480);
  assert.equal(entry.latest.minFlightNo, "MU5100");
  assert.deepEqual(entry.latest.flights, [makeFlight({ price: 480 })]);
});

test("mergeSnapshot: 超过 30 分钟追加历史点，返回 appended", () => {
  const created = CtripStore.mergeSnapshot({}, makeSnapshot(), t0);
  const now = t0 + 31 * 60 * 1000;
  const next = makeSnapshot({
    t: now,
    minPrice: 465,
    minFlightNo: "MU5101",
    flights: [makeFlight({ no: "MU5101", price: 465 })],
  });

  const result = CtripStore.mergeSnapshot(created.routes, next, now);

  assert.equal(result.result, "appended");
  const entry = result.routes[KEY];
  assert.equal(entry.history.length, 2);
  assert.deepEqual(entry.history[0], {
    t: t0,
    minPrice: 520,
    minFlightNo: "FM9366",
  });
  assert.deepEqual(entry.history[1], {
    t: now,
    minPrice: 465,
    minFlightNo: "MU5101",
  });
  assert.equal(entry.latest.minPrice, 465);
});

test("mergeSnapshot: 不同 cabin 生成不同键且互不影响", () => {
  const first = CtripStore.mergeSnapshot({}, makeSnapshot(), t0);
  const now = t0 + 10 * 60 * 1000;
  const economy = makeSnapshot({
    cabin: "y",
    url: "https://flights.ctrip.com/online/list/oneway-yih-cgq?depdate=2026-11-12&cabin=y&adult=1&child=0&infant=0",
    t: now,
    minPrice: 500,
    flights: [makeFlight({ price: 500 })],
  });

  const result = CtripStore.mergeSnapshot(first.routes, economy, now);

  assert.equal(result.result, "created");
  assert.deepEqual(Object.keys(result.routes).sort(), [
    "oneway:YIH-CGQ:2026-11-12:y",
    KEY,
  ]);
  assert.equal(result.routes[KEY].history.length, 1);
  assert.equal(result.routes[KEY].latest.minPrice, 520);
  assert.equal(result.routes["oneway:YIH-CGQ:2026-11-12:y"].history.length, 1);
  assert.equal(
    result.routes["oneway:YIH-CGQ:2026-11-12:y"].latest.minPrice,
    500
  );
});

test("mergeSnapshot: 历史点超过 1000 时丢弃最旧的点", () => {
  const created = CtripStore.mergeSnapshot({}, makeSnapshot(), t0);
  const history = [];
  for (let i = 0; i < 1000; i += 1) {
    history.push({
      t: t0 + i * 1000,
      minPrice: 400 + (i % 10),
      minFlightNo: "MU2000",
    });
  }
  const routes = Object.assign({}, created.routes);
  routes[KEY] = Object.assign({}, routes[KEY], {
    history,
    latest: {
      t: history[999].t,
      minPrice: history[999].minPrice,
      minFlightNo: history[999].minFlightNo,
      flights: [makeFlight()],
    },
  });

  const lastT = history[999].t;
  const now = lastT + CtripStore.THROTTLE_MS + 1;
  const next = makeSnapshot({
    t: now,
    minPrice: 430,
    minFlightNo: "MU2100",
    flights: [makeFlight({ no: "MU2100", price: 430 })],
  });

  const result = CtripStore.mergeSnapshot(routes, next, now);

  assert.equal(result.result, "appended");
  const merged = result.routes[KEY];
  assert.equal(merged.history.length, CtripStore.MAX_HISTORY);
  assert.equal(merged.history[0].t, history[1].t, "最旧的点被丢弃");
  assert.deepEqual(merged.history[999], {
    t: now,
    minPrice: 430,
    minFlightNo: "MU2100",
  });
  assert.equal(routes[KEY].history.length, 1000, "不得修改传入的 routes");
  assert.deepEqual(routes[KEY].history, history, "传入的 routes 内容保持不变");
});

test("mergeSnapshot: 更新时保留 createdAt 并刷新 updatedAt", () => {
  const created = CtripStore.mergeSnapshot({}, makeSnapshot(), t0);
  const now = t0 + 10 * 60 * 1000;

  const updated = CtripStore.mergeSnapshot(
    created.routes,
    makeSnapshot({ t: now, originName: "宜昌市" }),
    now
  );

  const entry = updated.routes[KEY];
  assert.equal(entry.createdAt, t0);
  assert.equal(entry.updatedAt, now);
  assert.equal(entry.originName, "宜昌市", "刷新快照字段");
});

test("routeKey 生成存储键", () => {
  assert.equal(CtripStore.routeKey(makeSnapshot()), KEY);
});

test("shouldIgnoreSnapshot 只忽略删除/清空之前打开的页面", () => {
  assert.equal(
    CtripStore.shouldIgnoreSnapshot(1000, KEY, undefined, undefined),
    false
  );
  assert.equal(CtripStore.shouldIgnoreSnapshot(1000, KEY, 2000, undefined), true);
  assert.equal(
    CtripStore.shouldIgnoreSnapshot(3000, KEY, 2000, undefined),
    false
  );
  assert.equal(CtripStore.shouldIgnoreSnapshot(1000, KEY, undefined, 2000), true);
  assert.equal(
    CtripStore.shouldIgnoreSnapshot(3000, KEY, undefined, 2000),
    false
  );
  assert.equal(
    CtripStore.shouldIgnoreSnapshot(undefined, KEY, 2000, 2000),
    false
  );
});

test("mergeSnapshot 限制路线总数并淘汰最久未更新", () => {
  const routes = {};
  for (let i = 0; i < CtripStore.MAX_ROUTES; i += 1) {
    routes["oneway:OLD" + i] = { updatedAt: i };
  }

  const now = t0 + 100000;
  const result = CtripStore.mergeSnapshot(
    routes,
    makeSnapshot({ t: now }),
    now
  );

  assert.equal(result.ok, true);
  assert.equal(Object.keys(result.routes).length, CtripStore.MAX_ROUTES);
  assert.ok(result.routes[KEY], "当前航线保留");
  assert.ok(!result.routes["oneway:OLD0"], "最久未更新的被淘汰");
});

test("mergeSnapshot 为每个航班建立序列并按价格变化追加", () => {
  const first = CtripStore.mergeSnapshot({}, makeSnapshot(), t0);
  assert.equal(first.ok, true);
  const route = first.routes[KEY];
  const id = "FM9071+FM9366|20:25|10:35+1";
  assert.ok(route.flightHistory[id]);
  assert.deepEqual(route.flightHistory[id].samples, [[t0, 520]]);

  const changed = makeSnapshot({
    t: t0 + 60000,
    minPrice: 500,
    minFlightNo: "FM9366",
    flights: [makeFlight({ no: "FM9366/FM9071", price: 500, departTime: "20:25", arriveTime: "10:35+1" })],
  });
  const second = CtripStore.mergeSnapshot(first.routes, changed, t0 + 60000);
  assert.equal(second.result, "updated");
  assert.deepEqual(second.routes[KEY].flightHistory[id].samples, [
    [t0, 520],
    [t0 + 60000, 500],
  ]);

  const same = makeSnapshot({
    t: t0 + 120000,
    minPrice: 500,
    minFlightNo: "FM9366",
    flights: [makeFlight({ no: "FM9366/FM9071", price: 500, departTime: "20:25", arriveTime: "10:35+1" })],
  });
  const third = CtripStore.mergeSnapshot(second.routes, same, t0 + 120000);
  assert.equal(third.routes[KEY].flightHistory[id].samples.length, 2);
});

test("mergeSnapshot 不修改传入的 routes", () => {
  const first = CtripStore.mergeSnapshot({}, makeSnapshot(), t0);
  const before = JSON.stringify(first.routes);
  CtripStore.mergeSnapshot(
    first.routes,
    makeSnapshot({
      t: t0 + 60000,
      minPrice: 500,
      flights: [makeFlight({ no: "MU5101", price: 500 })],
    }),
    t0 + 60000
  );
  assert.equal(JSON.stringify(first.routes), before);
});
