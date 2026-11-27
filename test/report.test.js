"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const report = require("../src/shared/report.js");

const NOW = 1764200000000;

function series(no, departTime, arriveTime, samples) {
  return {
    no: no,
    airline: "东方航空",
    departTime: departTime,
    arriveTime: arriveTime,
    transfers: 0,
    firstSeenAt: samples[0][0],
    lastSeenAt: samples[samples.length - 1][0],
    latestPrice: samples[samples.length - 1][1],
    samples: samples,
  };
}

function route(date, cabin, price, flights, history, flightHistory, overrides) {
  return Object.assign(
    {
      key: "x",
      originCode: "SHA",
      originName: "上海",
      destCode: "PEK",
      destName: "北京",
      departDate: date,
      cabin: cabin,
      currency: "CNY",
      url:
        "https://flights.ctrip.com/online/list/oneway-sha-pek?depdate=" +
        date +
        "&cabin=" +
        cabin,
      createdAt: 800,
      updatedAt: history[history.length - 1].t,
      latest: {
        t: history[history.length - 1].t,
        minPrice: price,
        minFlightNo: flights[0] ? flights[0].no : "",
        flights: flights,
      },
      history: history,
      flightHistory: flightHistory || {},
    },
    overrides || {}
  );
}

function makeRoutes() {
  return {
    "oneway:SHA-PEK:2026-11-18:y_s_c_f": route(
      "2026-11-18",
      "y_s_c_f",
      650,
      [
        { no: "MU5101", airline: "东方航空", departTime: "07:00", arriveTime: "09:15", transfers: 0, price: 680 },
        { no: "CA1832", airline: "中国国航", departTime: "08:00", arriveTime: "10:20", transfers: 0, price: 650 },
      ],
      [
        { t: 800, minPrice: 760, minFlightNo: "MU5101" },
        { t: 1000, minPrice: 650, minFlightNo: "CA1832" },
      ],
      {
        "MU5101|07:00|09:15": series("MU5101", "07:00", "09:15", [[800, 760], [1000, 680]]),
        "CA1832|08:00|10:20": series("CA1832", "08:00", "10:20", [[1000, 650]]),
      }
    ),
    "oneway:SHA-PEK:2026-11-19:y_s_c_f": route(
      "2026-11-19",
      "y_s_c_f",
      640,
      [
        { no: "MU5101", airline: "东方航空", departTime: "07:00", arriveTime: "09:15", transfers: 0, price: 640 },
      ],
      [{ t: 1200, minPrice: 640, minFlightNo: "MU5101" }],
      {
        "MU5101|07:00|09:15": series("MU5101", "07:00", "09:15", [[1200, 640]]),
      }
    ),
    "oneway:SHA-CAN:2026-11-20:y_s_c_f": route(
      "2026-11-20",
      "y_s_c_f",
      500,
      [
        {
          no: "<script>alert(3)</script>",
          airline: '"><img src=x>',
          departTime: "10:00",
          arriveTime: "12:30",
          transfers: 0,
          price: 500,
        },
      ],
      [{ t: 1300, minPrice: 500, minFlightNo: "X" }],
      {},
      {
        originCode: "SHA",
        originName: "<img src=x onerror=alert(1)>",
        destCode: "CAN",
        destName: "广州<script>alert(2)</script>",
        url: "javascript:alert(1)",
      }
    ),
  };
}

test("生成完整的 HTML 报告", function () {
  const html = report.buildReport(makeRoutes(), { now: NOW });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes("<style>"));
  assert.ok(html.includes("航班价格报告"));
  assert.ok(html.includes("上海 → 北京"));
  assert.ok(html.includes("全部舱位"));
  assert.ok(html.includes("日期对比"));
  assert.ok(html.includes("航班 × 日期"));
  assert.ok(html.includes("当前航班"));
  assert.ok(html.includes("单航班价格趋势"));
  assert.ok(html.includes("¥650"));
  assert.ok(html.includes("¥640"));
  assert.ok(html.includes('class="badge">最低'));
  assert.ok(html.includes("<svg"));
  assert.ok(html.includes("非官方工具"));
  assert.ok(html.includes("报告包含航线与日期信息"));
});

test("报告对页面数据做 HTML 转义并过滤危险链接", function () {
  const html = report.buildReport(makeRoutes(), { now: NOW });
  assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("广州&lt;script&gt;alert(2)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>alert(2)"));
  assert.ok(!html.includes("<script>alert(3)"));
  assert.ok(!html.includes("javascript:alert"));
  assert.ok(html.includes('href="https://flights.ctrip.com/'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
});

test("空数据也能生成可读的报告", function () {
  const html = report.buildReport({}, { now: NOW });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes("本机还没有航班价格记录"));
  assert.ok(html.includes("非官方工具"));
});

test("非法航线数据被跳过且不抛错", function () {
  const routes = makeRoutes();
  routes.broken = "not a route";
  routes.nullish = null;
  const html = report.buildReport(routes, { now: NOW });
  assert.ok(html.includes("上海 → 北京"));
  assert.ok(html.includes("¥650"));
});

test("同一时间戳生成结果稳定", function () {
  const routes = makeRoutes();
  assert.equal(
    report.buildReport(routes, { now: NOW }),
    report.buildReport(routes, { now: NOW })
  );
});

test("sparkline 处理单点、持平与非法数据", function () {
  const single = report.sparkline([{ t: 1, minPrice: 100 }]);
  assert.match(single, /^<svg/);
  assert.ok(single.includes("<circle"));
  assert.ok(!single.includes("NaN"));

  const flat = report.sparkline([
    { t: 1, minPrice: 100 },
    { t: 2, minPrice: 100 },
    { t: 3, minPrice: 100 },
  ]);
  assert.ok(flat.includes("<path"));
  assert.ok(!flat.includes("NaN"));

  const messy = report.sparkline([
    null,
    { t: 1, minPrice: 100 },
    { t: "bad", minPrice: 200 },
    { t: 3, minPrice: null },
  ]);
  assert.match(messy, /^<svg/);
  assert.ok(!messy.includes("NaN"));
  assert.equal(report.sparkline([]), "");
});

test("矩阵行数受 maxMatrixRows 限制", function () {
  const routes = {};
  const base = makeRoutes();
  // 生成 3 个日期、每班都不同的航线，确保矩阵有 3 行。
  for (let i = 0; i < 3; i += 1) {
    const date = "2026-11-" + String(10 + i);
    routes["oneway:SHA-PEK:" + date + ":y_s_c_f"] = route(
      date,
      "y_s_c_f",
      600 + i,
      [
        {
          no: "MU" + (100 + i),
          airline: "东方航空",
          departTime: "07:00",
          arriveTime: "09:15",
          transfers: 0,
          price: 600 + i,
        },
      ],
      [{ t: 2000 + i, minPrice: 600 + i, minFlightNo: "MU" + (100 + i) }],
      {}
    );
  }
  const html = report.buildReport(routes, { now: NOW, maxMatrixRows: 1 });
  assert.ok(html.includes("航班 × 日期"));
  assert.ok(html.includes("仅显示覆盖日期最多的 1 行，共 3 行"));
  // 不传 maxMatrixRows 时默认 30 行，不应出现隐藏提示。
  const full = report.buildReport(base, { now: NOW });
  assert.ok(!full.includes("仅显示覆盖日期最多"));
});
