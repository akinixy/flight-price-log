"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

require("../src/shared/merge.js");
const CtripRecord = require("../src/shared/record.js");

const t0 = 1761540000000;
const KEY = "oneway:YIH-CGQ:2026-11-12:y_s_c_f";
const URL =
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
      url: URL,
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

test("applySnapshot 新快照写入并清理本航线墓碑", () => {
  const result = CtripRecord.applySnapshot({
    routes: {},
    deleted: { [KEY]: t0 - 1000, "oneway:OTHER": t0 },
    clearedAt: undefined,
    snapshot: makeSnapshot({ t: t0 }),
    pageStartedAt: t0 + 1000,
    now: t0 + 2000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, "created");
  assert.ok(result.routes[KEY]);
  assert.equal(result.deleted[KEY], undefined);
  assert.equal(result.deleted["oneway:OTHER"], t0);
});

test("applySnapshot 忽略清空之前打开的页面", () => {
  const result = CtripRecord.applySnapshot({
    routes: {},
    deleted: {},
    clearedAt: t0,
    snapshot: makeSnapshot({ t: t0 }),
    pageStartedAt: t0 - 1,
    now: t0 + 1000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, "ignored");
  assert.deepEqual(result.routes, {});
});

test("applySnapshot 忽略删除之前打开的页面", () => {
  const result = CtripRecord.applySnapshot({
    routes: {},
    deleted: { [KEY]: t0 + 1000 },
    clearedAt: undefined,
    snapshot: makeSnapshot({ t: t0 }),
    pageStartedAt: t0,
    now: t0 + 2000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, "ignored");
  assert.deepEqual(result.routes, {});
});

test("applySnapshot 丢失 pageStartedAt 时仍然接受", () => {
  const result = CtripRecord.applySnapshot({
    routes: {},
    deleted: { [KEY]: t0 + 1000 },
    clearedAt: t0 + 1000,
    snapshot: makeSnapshot({ t: t0 }),
    pageStartedAt: undefined,
    now: t0 + 2000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, "created");
});

test("applySnapshot 拒绝非法快照", () => {
  const result = CtripRecord.applySnapshot({
    routes: {},
    deleted: {},
    snapshot: null,
  });

  assert.equal(result.ok, false);
  assert.ok(result.error);
});
