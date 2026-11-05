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

  var flight =
    typeof CtripFlight !== "undefined" && CtripFlight
      ? CtripFlight
      : typeof require === "function"
        ? require("./flight.js")
        : null;

  var MAX_HISTORY = 1000;

  function safeKey(key) {
    return (
      typeof key === "string" &&
      key !== "__proto__" &&
      key !== "constructor" &&
      key !== "prototype"
    );
  }

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function fail(error) {
    return { ok: false, error: error };
  }

  function sanitizeSamples(samples) {
    if (!Array.isArray(samples)) return [];
    var byTime = Object.create(null);
    for (var i = 0; i < samples.length; i += 1) {
      var sample = samples[i];
      if (!Array.isArray(sample) || sample.length < 2) continue;
      var t = Number(sample[0]);
      var price = flight ? flight.normalizePrice(sample[1]) : Number(sample[1]);
      if (!isFinite(t) || t <= 0 || !isFinite(price) || price <= 0) continue;
      byTime[t] = Math.round(price);
    }

    var result = Object.keys(byTime)
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      })
      .map(function (t) {
        return [t, byTime[t]];
      });

    if (result.length > 240) result = result.slice(result.length - 240);
    return result;
  }

  function sanitizeSeries(series) {
    if (!isPlainObject(series)) return null;

    var normalized = flight
      ? flight.normalizeFlight({
          no: series.no,
          airline: series.airline,
          departTime: series.departTime,
          arriveTime: series.arriveTime,
          transfers: series.transfers,
          price: series.latestPrice,
        })
      : null;

    var no = normalized ? normalized.no : series.no;
    var departTime = normalized ? normalized.departTime : series.departTime;
    var arriveTime = normalized ? normalized.arriveTime : series.arriveTime;
    if (!no || !departTime || !arriveTime) return null;

    var identity = flight
      ? flight.flightIdentity({
          no: no,
          departTime: departTime,
          arriveTime: arriveTime,
        })
      : no + "|" + departTime + "|" + arriveTime;
    if (!identity) return null;

    var samples = sanitizeSamples(series.samples);
    var latestPrice =
      normalized && normalized.price
        ? normalized.price
        : flight
          ? flight.normalizePrice(series.latestPrice)
          : Number(series.latestPrice);
    if (!samples.length && (!isFinite(latestPrice) || latestPrice <= 0)) {
      return null;
    }
    if (!samples.length) {
      var seedTime =
        typeof series.lastSeenAt === "number" && isFinite(series.lastSeenAt)
          ? series.lastSeenAt
          : Date.now();
      samples = [[seedTime, Math.round(latestPrice)]];
    }

    var firstSeenAt =
      typeof series.firstSeenAt === "number" && isFinite(series.firstSeenAt)
        ? series.firstSeenAt
        : samples[0][0];
    var lastSeenAt =
      typeof series.lastSeenAt === "number" && isFinite(series.lastSeenAt)
        ? series.lastSeenAt
        : samples[samples.length - 1][0];

    return {
      no: no,
      airline: typeof series.airline === "string" ? series.airline : "",
      departTime: departTime,
      arriveTime: arriveTime,
      transfers:
        typeof series.transfers === "number" &&
        isFinite(series.transfers) &&
        series.transfers >= 0
          ? Math.round(series.transfers)
          : 0,
      firstSeenAt: firstSeenAt,
      lastSeenAt: lastSeenAt,
      latestPrice:
        samples.length
          ? samples[samples.length - 1][1]
          : Math.round(latestPrice),
      samples: samples,
      __identity: identity,
    };
  }

  function sanitizeFlightHistory(input) {
    var source = isPlainObject(input) ? input : {};
    var result = {};
    var skipped = 0;

    Object.keys(source).forEach(function (id) {
      if (!safeKey(id)) {
        skipped += 1;
        return;
      }
      var series = sanitizeSeries(source[id]);
      if (!series) {
        skipped += 1;
        return;
      }
      var identity = series.__identity;
      delete series.__identity;
      if (result[identity] && flight) {
        result[identity] = flight.mergeFlightHistoryMaps(
          { [identity]: result[identity] },
          { [identity]: series }
        )[identity];
      } else {
        result[identity] = series;
      }
    });

    return { map: result, skipped: skipped };
  }

  function sanitizeRoute(key, route) {
    if (!safeKey(key) || !isPlainObject(route)) return null;
    if (!isPlainObject(route.latest) || !Array.isArray(route.history)) {
      return null;
    }

    var clean = Object.assign({}, route);
    var history = sanitizeFlightHistory(route.flightHistory);
    clean.flightHistory = history.map;
    return { route: clean, skippedSeries: history.skipped };
  }

  // 校验导出文件的结构，只保留字段完整的航线。
  function validateBackup(data) {
    if (!isPlainObject(data)) {
      return fail("备份格式不正确");
    }
    if (data.version !== undefined && data.version !== null) {
      var version = Number(data.version);
      if (!isFinite(version) || version > 2) {
        return fail("备份版本过新");
      }
    }
    if (!isPlainObject(data.routes)) {
      return fail("备份缺少 routes");
    }

    var routes = {};
    var skipped = 0;
    var skippedSeries = 0;
    Object.keys(data.routes).forEach(function (key) {
      var sanitized = sanitizeRoute(key, data.routes[key]);
      if (!sanitized) {
        skipped += 1;
        return;
      }
      skippedSeries += sanitized.skippedSeries;
      routes[key] = sanitized.route;
    });

    if (!Object.keys(routes).length) {
      return fail("备份中没有有效航线");
    }
    return {
      ok: true,
      routes: routes,
      skipped: skipped,
      skippedSeries: skippedSeries,
    };
  }

  function mergeHistory(current, incoming) {
    var byTime = Object.create(null);
    [current, incoming].forEach(function (list) {
      if (!Array.isArray(list)) return;
      list.forEach(function (point) {
        if (!isPlainObject(point)) return;
        var t = Number(point.t);
        if (!isFinite(t) || t <= 0) return;
        byTime[t] = Object.assign({}, point);
      });
    });

    var merged = Object.keys(byTime)
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      })
      .map(function (t) {
        return byTime[t];
      });

    if (merged.length > MAX_HISTORY) {
      merged = merged.slice(merged.length - MAX_HISTORY);
    }
    return merged;
  }

  function mergeRoutes(current, imported) {
    var next = Object.assign({}, isPlainObject(current) ? current : {});
    Object.keys(imported || {}).forEach(function (key) {
      if (!safeKey(key)) return;
      var route = imported[key];
      if (!isPlainObject(route)) return;

      var existing = next[key];
      if (!isPlainObject(existing)) {
        var copy = Object.assign({}, route);
        copy.history = mergeHistory([], route.history);
        copy.flightHistory = flight
          ? flight.mergeFlightHistoryMaps({}, route.flightHistory || {})
          : route.flightHistory || {};
        next[key] = copy;
        return;
      }

      var existingAt =
        typeof existing.updatedAt === "number" ? existing.updatedAt : -1;
      var incomingAt =
        typeof route.updatedAt === "number" ? route.updatedAt : -1;
      var base = incomingAt > existingAt ? route : existing;
      var merged = Object.assign({}, base);

      merged.history = mergeHistory(existing.history, route.history);
      merged.flightHistory = flight
        ? flight.mergeFlightHistoryMaps(
            existing.flightHistory || {},
            route.flightHistory || {}
          )
        : Object.assign(
            {},
            existing.flightHistory || {},
            route.flightHistory || {}
          );

      next[key] = merged;
    });
    return next;
  }

  return {
    validateBackup: validateBackup,
    mergeRoutes: mergeRoutes,
  };
});
