"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const KEY = "oneway:YIH-CGQ:2026-11-12:y_s_c_f";

let listener = null;

function freshStorage() {
  return {};
}

function loadBackground(storage, options) {
  var opts = options || {};
  global.importScripts = function () {};
  global.chrome = {
    storage: {
      local: {
        get: async function (keys) {
          if (opts.reads) {
            opts.reads.push(
              storage.ctripRoutes ? Object.keys(storage.ctripRoutes).length : 0
            );
          }
          const result = {};
          (Array.isArray(keys) ? keys : [keys]).forEach(function (key) {
            if (storage[key] !== undefined) result[key] = storage[key];
          });
          return result;
        },
        set: async function (payload) {
          if (opts.delayMs) {
            await new Promise(function (resolve) {
              setTimeout(resolve, opts.delayMs);
            });
          }
          Object.assign(storage, payload);
        },
      },
    },
    runtime: {
      onMessage: {
        addListener: function (fn) {
          listener = fn;
        },
      },
    },
  };

  global.CtripFlight = require(path.join(ROOT, "src/shared/flight.js"));
  global.CtripStore = require(path.join(ROOT, "src/shared/merge.js"));
  global.CtripRecord = require(path.join(ROOT, "src/shared/record.js"));
  global.CtripBackup = require(path.join(ROOT, "src/shared/backup.js"));

  const backgroundPath = path.join(ROOT, "src/background.js");
  delete require.cache[require.resolve(backgroundPath)];
  require(backgroundPath);

  assert.equal(typeof listener, "function");
  return listener;
}

function send(message, sender) {
  return new Promise(function (resolve) {
    const keep = listener(message, sender || {}, resolve);
    assert.equal(keep, true);
  });
}

function makeSnapshot(t) {
  return {
    flightWay: "oneway",
    originCode: "YIH",
    originName: "宜昌",
    destCode: "CGQ",
    destName: "长春",
    departDate: "2026-11-12",
    cabin: "y_s_c_f",
    currency: "CNY",
    url: "https://flights.ctrip.com/online/list/oneway-yih-cgq?depdate=2026-11-12&cabin=y_s_c_f",
    t: t,
    minPrice: 520,
    minFlightNo: "FM9366",
    flights: [
      {
        no: "FM9366",
        airline: "上海航空",
        departTime: "20:25",
        arriveTime: "10:35",
        transfers: 0,
        price: 520,
      },
    ],
  };
}

function makeImportedRoute(index) {
  const date = "2026-12-" + String((index % 27) + 1).padStart(2, "0");
  return {
    flightWay: "oneway",
    originCode: "YIH",
    originName: "宜昌",
    destCode: "CGQ",
    destName: "长春",
    departDate: date,
    cabin: "y" + index,
    currency: "CNY",
    url: "https://flights.ctrip.com/online/list/oneway-yih-cgq?depdate=" + date,
    createdAt: index,
    updatedAt: index,
    latest: {
      t: index + 1,
      minPrice: 500,
      minFlightNo: "MU1",
      flights: [
        {
          no: "MU1",
          airline: "东方航空",
          departTime: "08:00",
          arriveTime: "10:00",
          transfers: 0,
          price: 500,
        },
      ],
    },
    history: [{ t: index + 1, minPrice: 500, minFlightNo: "MU1" }],
  };
}

test("RECORD_SNAPSHOT 创建航线", async () => {
  const storage = freshStorage();
  loadBackground(storage);

  const result = await send({
    type: "RECORD_SNAPSHOT",
    payload: makeSnapshot(Date.now()),
    pageStartedAt: 1,
  });

  assert.equal(result.ok, true);
  assert.equal(result.result, "created");
  assert.ok(storage.ctripRoutes[KEY]);
});

test("非携程来源的消息被忽略", async () => {
  const storage = freshStorage();
  loadBackground(storage);

  const keep = listener(
    { type: "RECORD_SNAPSHOT", payload: makeSnapshot(Date.now()) },
    { tab: { url: "https://example.com/" } },
    function () {}
  );

  assert.equal(keep, false);
  assert.equal(storage.ctripRoutes, undefined);
});

test("DELETE_ROUTE 删除航线并写入墓碑", async () => {
  const storage = freshStorage();
  loadBackground(storage);

  await send({ type: "RECORD_SNAPSHOT", payload: makeSnapshot(Date.now()), pageStartedAt: 1 });
  const result = await send({ type: "DELETE_ROUTE", key: KEY });

  assert.equal(result.ok, true);
  assert.equal(result.routes[KEY], undefined);
  assert.equal(typeof storage.ctripDeleted[KEY], "number");
});

test("CLEAR_ALL 清空航线与墓碑并记录清空时间", async () => {
  const storage = freshStorage();
  loadBackground(storage);

  await send({ type: "RECORD_SNAPSHOT", payload: makeSnapshot(Date.now()), pageStartedAt: 1 });
  const result = await send({ type: "CLEAR_ALL" });

  assert.equal(result.ok, true);
  assert.deepEqual(storage.ctripRoutes, {});
  assert.deepEqual(storage.ctripDeleted, {});
  assert.equal(typeof storage.ctripClearedAt, "number");
});

test("IMPORT_ROUTES 合并并受 100 条航线上限约束", async () => {
  const storage = freshStorage();
  // 预置一条较新的现有航线，验证导入不会把它挤掉。
  const existing = makeImportedRoute(999);
  existing.updatedAt = Date.now() + 100000;
  const existingKey = "oneway:YIH-CGQ:2026-12-01:y999";
  storage.ctripRoutes = { [existingKey]: existing };
  loadBackground(storage);

  const routes = {};
  for (let i = 0; i < 150; i += 1) {
    routes["oneway:YIH-CGQ:2026-12-01:y" + i] = makeImportedRoute(i);
  }

  const result = await send({ type: "IMPORT_ROUTES", routes: routes });

  assert.equal(result.ok, true);
  assert.equal(Object.keys(result.routes).length, 100);
  assert.ok(result.routes[existingKey], "现有较新航线应保留");
  assert.equal(result.imported, 99);
  assert.equal(result.dropped, 51);
  assert.equal(Object.keys(storage.ctripRoutes).length, 100);
});

test("消息按顺序串行处理", async () => {
  const storage = freshStorage();
  const reads = [];
  loadBackground(storage, { reads, delayMs: 5 });

  const first = send({
    type: "RECORD_SNAPSHOT",
    payload: makeSnapshot(Date.now()),
    pageStartedAt: 1,
  });
  const second = send({ type: "DELETE_ROUTE", key: KEY });
  const results = await Promise.all([first, second]);

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
  assert.deepEqual(storage.ctripRoutes, {});
  // 删除读取时必须已能看到刚写入的航线；不串行的话这里会是 0。
  assert.equal(reads[1], 1);
});

test("写入时清理过期墓碑", async () => {
  const storage = freshStorage();
  storage.ctripDeleted = {
    "oneway:OLD-PAIR:2026-01-01:y_s_c_f": Date.now() - 40 * 24 * 60 * 60 * 1000,
  };
  loadBackground(storage);

  await send({ type: "RECORD_SNAPSHOT", payload: makeSnapshot(Date.now()), pageStartedAt: 1 });

  assert.equal(storage.ctripDeleted["oneway:OLD-PAIR:2026-01-01:y_s_c_f"], undefined);
});
