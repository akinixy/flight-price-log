"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const CtripFormat = require("../src/shared/format.js");

const NOW = new Date(2026, 9, 27, 18, 0);

test("formatPrice 输出人民币价格", () => {
  assert.equal(CtripFormat.formatPrice(520), "¥520");
  assert.equal(CtripFormat.formatPrice(0), "¥0");
  assert.equal(CtripFormat.formatPrice(1234), "¥1,234");
  assert.equal(CtripFormat.formatPrice(12345), "¥12,345");
});

test("formatDateLabel 同年只显示月日", () => {
  assert.equal(CtripFormat.formatDateLabel("2026-11-12", new Date(2026, 9, 27)), "11月12日");
});

test("formatDateLabel 跨年显示年份", () => {
  assert.equal(CtripFormat.formatDateLabel("2027-01-05", new Date(2026, 9, 27)), "2027年1月5日");
});

test("formatTimestamp 同年显示月日时分", () => {
  const epoch = new Date(2026, 9, 27, 14, 30).getTime();
  assert.equal(CtripFormat.formatTimestamp(epoch, NOW), "10月27日 14:30");
});

test("formatTimestamp 分钟补零", () => {
  const epoch = new Date(2026, 9, 5, 9, 5).getTime();
  assert.equal(CtripFormat.formatTimestamp(epoch, NOW), "10月5日 09:05");
});

test("formatTimestamp 跨年显示年份", () => {
  const epoch = new Date(2025, 11, 31, 23, 5).getTime();
  assert.equal(CtripFormat.formatTimestamp(epoch, NOW), "2025年12月31日 23:05");
});

test("formatCabin 映射舱位名称", () => {
  assert.equal(CtripFormat.formatCabin("y_s_c_f"), "全部舱位");
  assert.equal(CtripFormat.formatCabin("y"), "经济舱");
  assert.equal(CtripFormat.formatCabin("s"), "超级经济舱");
  assert.equal(CtripFormat.formatCabin("c"), "公务舱");
  assert.equal(CtripFormat.formatCabin("f"), "头等舱");
});

test("formatCabin 未知值原样返回", () => {
  assert.equal(CtripFormat.formatCabin("unknown"), "unknown");
});

test("formatDelta 涨跌与持平", () => {
  assert.equal(CtripFormat.formatDelta(520, 500), "+¥20");
  assert.equal(CtripFormat.formatDelta(480, 500), "-¥20");
  assert.equal(CtripFormat.formatDelta(500, 500), "持平");
  assert.equal(CtripFormat.formatDelta(1520, 500), "+¥1,020");
});

test("formatDelta 无历史价格返回空字符串", () => {
  assert.equal(CtripFormat.formatDelta(520, null), "");
  assert.equal(CtripFormat.formatDelta(520, undefined), "");
});

test("formatDuration 计算跨天与正常航班总用时", () => {
  assert.equal(CtripFormat.formatDuration("20:25", "10:35+1"), "14小时10分");
  assert.equal(CtripFormat.formatDuration("08:00", "10:30"), "2小时30分");
  assert.equal(CtripFormat.formatDuration("09:00", "10:00"), "1小时");
  assert.equal(CtripFormat.formatDuration("10:00", "10:45"), "45分");
});

test("formatDuration 处理未标注跨天和无效输入", () => {
  assert.equal(CtripFormat.formatDuration("23:30", "01:10"), "1小时40分");
  assert.equal(CtripFormat.formatDuration("10:00", "10:00"), "—");
  assert.equal(CtripFormat.formatDuration("—", "10:00"), "—");
  assert.equal(CtripFormat.formatDuration("25:00", "10:00"), "—");
  assert.equal(CtripFormat.formatDuration(undefined, null), "—");
});

test("clockMinutes 与 durationMinutes 用于排序", () => {
  assert.equal(CtripFormat.clockMinutes("06:00"), 360);
  assert.equal(CtripFormat.clockMinutes("20:25"), 1225);
  assert.equal(CtripFormat.clockMinutes("—"), Infinity);

  assert.equal(CtripFormat.durationMinutes("20:25", "10:35+1"), 850);
  assert.equal(CtripFormat.durationMinutes("08:00", "10:30"), 150);
  assert.equal(CtripFormat.durationMinutes("23:30", "01:10"), 100);
  assert.equal(CtripFormat.durationMinutes("10:00", "10:00"), Infinity);
  assert.equal(CtripFormat.durationMinutes("—", "10:00"), Infinity);
});
