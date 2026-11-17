"use strict";

importScripts(
  "shared/flight.js",
  "shared/merge.js",
  "shared/record.js",
  "shared/backup.js"
);

var STORAGE_KEY = "ctripRoutes";
var DELETED_KEY = "ctripDeleted";
var CLEARED_KEY = "ctripClearedAt";
var CTRIP_URL_PREFIX = "https://flights.ctrip.com/";
// 删除墓碑只需覆盖仍打开的旧页面，超过这个时间的墓碑可以清掉，避免无限增长。
var TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

var queue = Promise.resolve();

function isCtripUrl(url) {
  return typeof url === "string" && url.indexOf(CTRIP_URL_PREFIX) === 0;
}

function errorMessage(error) {
  if (error && typeof error.message === "string") return error.message;
  return String(error);
}

function pruneDeleted(deleted, now) {
  var source =
    deleted && typeof deleted === "object" && !Array.isArray(deleted)
      ? deleted
      : {};
  var next = {};
  Object.keys(source).forEach(function (key) {
    var at = source[key];
    if (typeof at === "number" && isFinite(at) && now - at < TOMBSTONE_TTL_MS) {
      next[key] = at;
    }
  });
  return next;
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
      deleted: pruneDeleted(data[DELETED_KEY], Date.now()),
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

// 删除、清空和导入也走同一个队列，避免与快照写入交错，
// 造成墓碑丢失、已删数据复活或导入结果被旧快照覆盖。
async function deleteRoute(key) {
  if (typeof key !== "string" || !key) {
    return { ok: false, error: "invalid key" };
  }

  const data = await chrome.storage.local.get([STORAGE_KEY, DELETED_KEY]);
  const routes =
    data[STORAGE_KEY] && typeof data[STORAGE_KEY] === "object"
      ? data[STORAGE_KEY]
      : {};
  const nextRoutes = {};
  Object.keys(routes).forEach(function (routeKey) {
    if (routeKey !== key) nextRoutes[routeKey] = routes[routeKey];
  });

  const now = Date.now();
  const deleted = pruneDeleted(data[DELETED_KEY], now);
  deleted[key] = now;

  await chrome.storage.local.set({
    [STORAGE_KEY]: nextRoutes,
    [DELETED_KEY]: deleted,
  });
  return { ok: true, routes: nextRoutes };
}

async function clearAll() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {},
    [DELETED_KEY]: {},
    [CLEARED_KEY]: Date.now(),
  });
  return { ok: true };
}

async function importRoutes(imported) {
  if (!imported || typeof imported !== "object" || Array.isArray(imported)) {
    return { ok: false, error: "invalid routes" };
  }

  // 弹窗已经校验过一次；这里再校验，避免任何直接发消息的调用方绕过白名单。
  const validated = CtripBackup.validateBackup({
    version: 2,
    routes: imported,
  });
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }

  const data = await chrome.storage.local.get([STORAGE_KEY]);
  const current =
    data[STORAGE_KEY] && typeof data[STORAGE_KEY] === "object"
      ? data[STORAGE_KEY]
      : {};
  const merged = CtripBackup.mergeRoutes(current, validated.routes);
  const next = CtripFlight.enforceBudgets(merged, Date.now(), {
    maxRoutes: CtripStore.MAX_ROUTES,
  });

  const importedKeys = Object.keys(validated.routes);
  function keptImported(routes) {
    return importedKeys.filter(function (key) {
      return routes[key] !== undefined;
    }).length;
  }

  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (error) {
    if (!/QUOTA_BYTES/i.test(errorMessage(error))) {
      return { ok: false, error: errorMessage(error) };
    }
    const compacted = CtripStore.compactRoutes(next, Date.now());
    await chrome.storage.local.set({ [STORAGE_KEY]: compacted });
    const kept = keptImported(compacted);
    return {
      ok: true,
      routes: compacted,
      imported: kept,
      dropped: importedKeys.length - kept,
      compacted: true,
    };
  }

  const kept = keptImported(next);
  return {
    ok: true,
    routes: next,
    imported: kept,
    dropped: importedKeys.length - kept,
    compacted: false,
  };
}

function enqueue(run, sendResponse) {
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
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message.type !== "string") {
    return false;
  }

  // url 缺失时接受，避免因权限差异误拒。
  const tabUrl = sender.tab && sender.tab.url;
  if (tabUrl && !isCtripUrl(tabUrl)) {
    return false;
  }

  if (message.type === "RECORD_SNAPSHOT") {
    enqueue(function () {
      return record(message.payload, message.pageStartedAt);
    }, sendResponse);
    return true;
  }

  if (message.type === "DELETE_ROUTE") {
    enqueue(function () {
      return deleteRoute(message.key);
    }, sendResponse);
    return true;
  }

  if (message.type === "CLEAR_ALL") {
    enqueue(clearAll, sendResponse);
    return true;
  }

  if (message.type === "IMPORT_ROUTES") {
    enqueue(function () {
      return importRoutes(message.routes);
    }, sendResponse);
    return true;
  }

  return false;
});
