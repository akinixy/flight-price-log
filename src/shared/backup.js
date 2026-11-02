(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CtripBackup = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  // 校验导出文件的结构，只保留字段完整的航线。
  function validateBackup(data) {
    if (!isPlainObject(data)) {
      return { ok: false, error: "备份格式不正确" };
    }
    if (!isPlainObject(data.routes)) {
      return { ok: false, error: "备份缺少 routes" };
    }

    var routes = {};
    var skipped = 0;
    Object.keys(data.routes).forEach(function (key) {
      var route = data.routes[key];
      if (
        !isPlainObject(route) ||
        !isPlainObject(route.latest) ||
        !Array.isArray(route.history)
      ) {
        skipped += 1;
        return;
      }
      routes[key] = route;
    });

    if (!Object.keys(routes).length) {
      return { ok: false, error: "备份中没有有效航线" };
    }
    return { ok: true, routes: routes, skipped: skipped };
  }

  // 合并备份：同一航线保留 updatedAt 更新的那一条。
  function mergeRoutes(current, imported) {
    var next = Object.assign({}, isPlainObject(current) ? current : {});
    Object.keys(imported || {}).forEach(function (key) {
      var route = imported[key];
      if (!isPlainObject(route)) return;

      var existing = next[key];
      var existingAt =
        existing && typeof existing.updatedAt === "number"
          ? existing.updatedAt
          : -1;
      var incomingAt =
        typeof route.updatedAt === "number" ? route.updatedAt : -1;

      if (!existing || incomingAt > existingAt) {
        next[key] = route;
      }
    });
    return next;
  }

  return {
    validateBackup: validateBackup,
    mergeRoutes: mergeRoutes,
  };
});
