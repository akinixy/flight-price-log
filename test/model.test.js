"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const model = require("../src/shared/model.js");

const KEY_A = "oneway:SHA-PEK:2026-11-18:y_s_c_f";
const KEY_B = "oneway:SHA-PEK:2026-11-19:y_s_c_f";
const KEY_C = "oneway:SHA-PEK:2026-11-18:c_f";

function series(no, depart, arrive, samples) {
  return {
    no,
    airline: "东方航空",
    departTime: depart,
    arriveTime: arrive,
    transfers: 0,
    firstSeenAt: samples[0][0],
    lastSeenAt: samples[samples.length - 1][0],
    latestPrice: samples[samples.length - 1][1],
    samples,
  };
}

function route(overrides) {
  return Object.assign(
    {
      originCode: "SHA",
      originName: "上海",
      destCode: "PEK",
      destName: "北京",
      departDate: "2026-11-18",
      cabin: "y_s_c_f",
      updatedAt: 1000,
      latest: {
        t: 1000,
        minPrice: 680,
        minFlightNo: "MU5101",
        flights: [
          {
            no: "MU5101",
            airline: "东方航空",
            departTime: "07:00",
            arriveTime: "09:15",
            transfers: 0,
            price: 680,
          },
          {
            no: "CA1832",
            airline: "中国国航",
            departTime: "08:00",
            arriveTime: "10:20",
            transfers: 0,
            price: 720,
          },
        ],
      },
      history: [
        { t: 800, minPrice: 760, minFlightNo: "MU5101" },
        { t: 1000, minPrice: 680, minFlightNo: "MU5101" },
      ],
      flightHistory: {
        "MU5101|07:00|09:15": series("MU5101", "07:00", "09:15", [
          [800, 760],
          [1000, 680],
        ]),
        "CA1832|08:00|10:20": series("CA1832", "08:00", "10:20", [
          [1000, 720],
        ]),
      },
    },
    overrides
  );
}

test("buildGroups 按城市对与舱位分组并按日期排序", () => {
  const routes = {
    [KEY_A]: route(),
    [KEY_B]: route({
      departDate: "2026-11-19",
      updatedAt: 1200,
      latest: {
        t: 1200,
        minPrice: 640,
        minFlightNo: "MU5101",
        flights: [
          {
            no: "MU5101",
            airline: "东方航空",
            departTime: "07:00",
            arriveTime: "09:15",
            transfers: 0,
            price: 640,
          },
        ],
      },
      history: [{ t: 1200, minPrice: 640, minFlightNo: "MU5101" }],
      flightHistory: {
        "MU5101|07:00|09:15": series("MU5101", "07:00", "09:15", [[1200, 640]]),
      },
    }),
    [KEY_C]: route({ cabin: "c_f", departDate: "2026-11-18" }),
  };

  const groups = model.buildGroups(routes);
  assert.equal(groups.length, 2);
  const economy = groups.find((group) => group.cabin === "y_s_c_f");
  assert.equal(economy.dates.length, 2);
  assert.deepEqual(
    economy.dates.map((entry) => entry.date),
    ["2026-11-18", "2026-11-19"]
  );
  assert.equal(economy.currentMin, 640);
  assert.equal(economy.lowestDate, "2026-11-19");
  assert.equal(economy.seriesCount, 3);

  const comparison = model.buildComparison(economy);
  assert.equal(comparison.bestDate, "2026-11-19");
  const first = comparison.rows.find((row) => row.date === "2026-11-18");
  assert.equal(first.fromBest, 40);
  assert.equal(first.delta, -80);
  assert.equal(first.historyMin, 680);
  assert.equal(first.isBest, false);
});

test("buildMatrix 合并跨日期航班并处理缺失日期", () => {
  const routes = {
    [KEY_A]: route(),
    [KEY_B]: route({
      departDate: "2026-11-19",
      latest: {
        t: 1200,
        minPrice: 640,
        minFlightNo: "MU5101",
        flights: [
          {
            no: "MU5101",
            airline: "东方航空",
            departTime: "07:00",
            arriveTime: "09:15",
            transfers: 0,
            price: 640,
          },
        ],
      },
    }),
  };
  const group = model.buildGroups(routes).find((item) => item.cabin === "y_s_c_f");
  const matrix = model.buildMatrix(group, { maxRows: 1 });

  assert.deepEqual(
    matrix.dates.map((item) => item.date),
    ["2026-11-18", "2026-11-19"]
  );
  assert.equal(matrix.rows.length, 1);
  assert.equal(matrix.totalRows, 2);
  assert.equal(matrix.hiddenCount, 1);

  const mu = matrix.rows[0];
  assert.equal(mu.no, "MU5101");
  assert.equal(mu.prices["2026-11-18"], 680);
  assert.equal(mu.prices["2026-11-19"], 640);
});

test("buildSeriesList 与 decodeSamples 输出趋势数据", () => {
  const routes = { [KEY_A]: route() };
  const group = model.buildGroups(routes).find((item) => item.cabin === "y_s_c_f");
  const list = model.buildSeriesList(group);

  assert.equal(list.length, 2);
  const mu = list.find((item) => item.no === "MU5101");
  assert.equal(mu.stats.current, 680);
  assert.equal(mu.stats.min, 680);
  assert.equal(mu.stats.max, 760);
  assert.equal(mu.stats.change, -80);
  assert.deepEqual(model.decodeSamples(mu.series), [
    { t: 800, minPrice: 760 },
    { t: 1000, minPrice: 680 },
  ]);
});

test("buildOverview 统计路线、航班、样本与估算字节", () => {
  const routes = { [KEY_A]: route(), [KEY_C]: route({ cabin: "c_f" }) };
  const overview = model.buildOverview(routes);
  assert.equal(overview.routeCount, 2);
  assert.equal(overview.groupCount, 2);
  assert.equal(overview.flightCount, 4);
  assert.equal(overview.sampleCount, 6);
  assert.ok(overview.estimatedBytes > 0);
});

test("空数据与缺失字段不会抛错", () => {
  assert.deepEqual(model.buildGroups({}), []);
  assert.deepEqual(model.buildGroups(null), []);
  assert.deepEqual(model.buildComparison(null), { rows: [], bestDate: null });
  assert.deepEqual(model.buildMatrix(null), {
    dates: [],
    rows: [],
    hiddenCount: 0,
    totalRows: 0,
  });
  assert.deepEqual(model.buildSeriesList(null), []);
  assert.deepEqual(model.decodeSamples(null), []);
  assert.equal(model.historyMin({}), null);
  assert.equal(model.historyDelta({}), null);
});
