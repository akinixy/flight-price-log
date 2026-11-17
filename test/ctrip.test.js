"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const CtripContent = require("../src/content/ctrip.js");

function fakeDoc(bodyText, hasList) {
  return {
    querySelector: function () {
      return hasList ? {} : null;
    },
    body: { textContent: bodyText },
  };
}

test("识别 whaleguard 拦截页", () => {
  assert.equal(CtripContent.isBlockedPage(fakeDoc("whaleguard block", false)), true);
});

test("有航班列表时不判定为拦截页", () => {
  assert.equal(CtripContent.isBlockedPage(fakeDoc("whaleguard block", true)), false);
});

test("正常长页面不判定为拦截页", () => {
  assert.equal(CtripContent.isBlockedPage(fakeDoc("携程航班".repeat(200), false)), false);
});

test("空页面不判定为拦截页", () => {
  assert.equal(CtripContent.isBlockedPage(fakeDoc("", false)), false);
  assert.equal(CtripContent.isBlockedPage(null), false);
});
