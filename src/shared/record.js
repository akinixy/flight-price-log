(function (root, factory) {
  "use strict";

  var api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CtripRecord = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var store = root.CtripStore;
  if (!store && typeof require === "function") {
    store = require("./merge.js");
  }

  // 后台记录一条快照的纯逻辑：处理删除/清空墓碑、合并、清理本航线的墓碑。
  function applySnapshot(input) {
    var snapshot = input && input.snapshot;
    if (!snapshot || typeof snapshot !== "object") {
      return { ok: false, error: "invalid snapshot" };
    }

    var routes = input.routes;
    var deleted = input.deleted || {};
    var now = typeof input.now === "number" ? input.now : Date.now();
    var key = store.routeKey(snapshot);

    if (
      store.shouldIgnoreSnapshot(
        input.pageStartedAt,
        key,
        input.clearedAt,
        deleted[key]
      )
    ) {
      return { ok: true, result: "ignored", routes: routes, deleted: deleted };
    }

    var merged = store.mergeSnapshot(routes, snapshot, now);
    if (!merged.ok) {
      return { ok: false, error: merged.error };
    }

    var nextDeleted = {};
    Object.keys(deleted).forEach(function (routeKey) {
      if (routeKey !== key) nextDeleted[routeKey] = deleted[routeKey];
    });

    return {
      ok: true,
      result: merged.result,
      routes: merged.routes,
      deleted: nextDeleted,
    };
  }

  return { applySnapshot: applySnapshot };
});
