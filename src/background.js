"use strict";

importScripts("shared/flight.js", "shared/merge.js", "shared/record.js");

var STORAGE_KEY = "ctripRoutes";
var DELETED_KEY = "ctripDeleted";
var CLEARED_KEY = "ctripClearedAt";
var CTRIP_URL_PREFIX = "https://flights.ctrip.com/";

var queue = Promise.resolve();

function isCtripUrl(url) {
  return typeof url === "string" && url.indexOf(CTRIP_URL_PREFIX) === 0;
}

function errorMessage(error) {
  if (error && typeof error.message === "string") return error.message;
  return String(error);
}

function respond(sendResponse, response) {
  try {
    sendResponse(response);
  } catch (error) {
    // 消息端口可能已关闭（如页面已跳转），忽略即可。
  }
}

async function record(snapshot, pageStartedAt) {
  try {
    const data = await chrome.storage.local.get([
      STORAGE_KEY,
      DELETED_KEY,
      CLEARED_KEY,
    ]);

    const applied = CtripRecord.applySnapshot({
      routes: data[STORAGE_KEY],
      deleted: data[DELETED_KEY] || {},
      clearedAt: data[CLEARED_KEY],
      snapshot: snapshot,
      pageStartedAt: pageStartedAt,
      now: Date.now(),
    });

    if (!applied.ok) {
      return { ok: false, error: applied.error };
    }

    if (applied.result === "ignored") {
      return { ok: true, result: "ignored" };
    }

    const payload = {
      [STORAGE_KEY]: applied.routes,
      [DELETED_KEY]: applied.deleted,
    };

    try {
      await chrome.storage.local.set(payload);
    } catch (error) {
      if (!/QUOTA_BYTES/i.test(errorMessage(error))) {
        return { ok: false, error: errorMessage(error) };
      }

      // 配额不足时做一次更激进的压缩再重试，避免一次写入失败后长期不再保存。
      const compacted = CtripStore.compactRoutes(applied.routes, Date.now());
      await chrome.storage.local.set({
        [STORAGE_KEY]: compacted,
        [DELETED_KEY]: applied.deleted,
      });
      return { ok: true, result: applied.result, compacted: true };
    }

    return { ok: true, result: applied.result };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || message.type !== "RECORD_SNAPSHOT") {
    return false;
  }

  // url 缺失时接受，避免因权限差异误拒。
  const tabUrl = sender.tab && sender.tab.url;
  if (tabUrl && !isCtripUrl(tabUrl)) {
    return false;
  }

  const run = function () {
    return record(message.payload, message.pageStartedAt);
  };

  // 用同一个任务作为成功/失败回调，保证一次失败不会卡死后续消息。
  const task = queue.then(run, run);
  queue = task;

  task.then(
    function (result) {
      respond(sendResponse, result);
    },
    function (error) {
      respond(sendResponse, { ok: false, error: errorMessage(error) });
    }
  );

  return true;
});
