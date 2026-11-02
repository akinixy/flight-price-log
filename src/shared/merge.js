(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CtripStore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var THROTTLE_MS = 1800000;
  var MAX_HISTORY = 1000;
  var MAX_FLIGHTS = 200;
  var MAX_ROUTES = 100;

  var CODE_RE = /^[A-Z]{3}$/;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  var CABIN_RE = /^[a-z0-9_]+$/;
  var TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;
  var ARRIVE_TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d(?:\+\d+)?$/;
  var URL_PREFIX = "https://flights.ctrip.com/";

  function fail(error) {
    return { ok: false, error: error };
  }

  function isNonEmptyString(value) {
    return typeof value === "string" && value.trim() !== "";
  }

  function isPositiveInt(value) {
    return typeof value === "number" && Number.isInteger(value) && value > 0;
  }

  function isNonNegativeInt(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }

  function validateFlight(flight, index) {
    var prefix = "flights[" + index + "]";

    if (!flight || typeof flight !== "object" || Array.isArray(flight)) {
      return prefix + " 必须是对象";
    }
    if (!isNonEmptyString(flight.no)) return prefix + ".no 不能为空";
    if (typeof flight.airline !== "string") {
      return prefix + ".airline 必须是字符串";
    }
    if (typeof flight.departTime !== "string" || !TIME_RE.test(flight.departTime)) {
      return prefix + ".departTime 格式错误";
    }
    if (
      typeof flight.arriveTime !== "string" ||
      !ARRIVE_TIME_RE.test(flight.arriveTime)
    ) {
      return prefix + ".arriveTime 格式错误";
    }
    if (!isNonNegativeInt(flight.transfers)) {
      return prefix + ".transfers 必须是非负整数";
    }
    if (!isPositiveInt(flight.price)) {
      return prefix + ".price 必须是正整数";
    }

    return null;
  }

  function validateSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      return fail("快照必须是对象");
    }
    if (snapshot.flightWay !== "oneway") {
      return fail("flightWay 必须为 oneway");
    }
    if (typeof snapshot.originCode !== "string" || !CODE_RE.test(snapshot.originCode)) {
      return fail("originCode 必须是三个大写字母");
    }
    if (!isNonEmptyString(snapshot.originName)) {
      return fail("originName 不能为空");
    }
    if (typeof snapshot.destCode !== "string" || !CODE_RE.test(snapshot.destCode)) {
      return fail("destCode 必须是三个大写字母");
    }
    if (!isNonEmptyString(snapshot.destName)) {
      return fail("destName 不能为空");
    }
    if (typeof snapshot.departDate !== "string" || !DATE_RE.test(snapshot.departDate)) {
      return fail("departDate 必须是 YYYY-MM-DD 格式");
    }
    if (typeof snapshot.cabin !== "string" || !CABIN_RE.test(snapshot.cabin)) {
      return fail("cabin 必须是小写字母、数字或下划线");
    }
    if (snapshot.currency !== "CNY") {
      return fail("currency 必须为 CNY");
    }
    if (
      typeof snapshot.url !== "string" ||
      snapshot.url.indexOf(URL_PREFIX) !== 0
    ) {
      return fail("url 必须以 " + URL_PREFIX + " 开头");
    }
    if (!isPositiveInt(snapshot.t)) {
      return fail("t 必须是正整数");
    }
    if (!isPositiveInt(snapshot.minPrice)) {
      return fail("minPrice 必须是正整数");
    }
    if (!isNonEmptyString(snapshot.minFlightNo)) {
      return fail("minFlightNo 不能为空");
    }
    if (
      !Array.isArray(snapshot.flights) ||
      snapshot.flights.length < 1 ||
      snapshot.flights.length > MAX_FLIGHTS
    ) {
      return fail("flights 必须是 1-" + MAX_FLIGHTS + " 条的数组");
    }

    var lowest = Infinity;
    for (var i = 0; i < snapshot.flights.length; i += 1) {
      var flightError = validateFlight(snapshot.flights[i], i);
      if (flightError) return fail(flightError);
      if (snapshot.flights[i].price < lowest) {
        lowest = snapshot.flights[i].price;
      }
    }

    if (snapshot.minPrice !== lowest) {
      return fail("minPrice 与航班最低价不一致");
    }

    return { ok: true };
  }

  // 存储键格式：oneway:出发代码-到达代码:日期:舱位（设计文档 §7）。
  function routeKey(snapshot) {
    return (
      "oneway:" +
      snapshot.originCode +
      "-" +
      snapshot.destCode +
      ":" +
      snapshot.departDate +
      ":" +
      snapshot.cabin
    );
  }

  // 页面在删除/清空之前就打开了，它随后发来的快照不应把记录写回来。
  function shouldIgnoreSnapshot(pageStartedAt, key, clearedAt, deletedAt) {
    if (
      typeof pageStartedAt !== "number" ||
      !isFinite(pageStartedAt)
    ) {
      return false;
    }
    if (
      typeof clearedAt === "number" &&
      isFinite(clearedAt) &&
      pageStartedAt <= clearedAt
    ) {
      return true;
    }
    if (
      typeof deletedAt === "number" &&
      isFinite(deletedAt) &&
      pageStartedAt <= deletedAt
    ) {
      return true;
    }
    return false;
  }

  function copyFlights(flights) {    var copy = [];

    for (var i = 0; i < flights.length; i += 1) {
      var flight = flights[i];
      copy.push({
        no: flight.no,
        airline: flight.airline,
        departTime: flight.departTime,
        arriveTime: flight.arriveTime,
        transfers: flight.transfers,
        price: flight.price,
      });
    }

    return copy;
  }

  function buildRoute(snapshot, key, now) {
    return {
      key: key,
      flightWay: snapshot.flightWay,
      originCode: snapshot.originCode,
      originName: snapshot.originName,
      destCode: snapshot.destCode,
      destName: snapshot.destName,
      departDate: snapshot.departDate,
      cabin: snapshot.cabin,
      currency: snapshot.currency,
      url: snapshot.url,
      createdAt: now,
      updatedAt: now,
      latest: {
        t: snapshot.t,
        minPrice: snapshot.minPrice,
        minFlightNo: snapshot.minFlightNo,
        flights: copyFlights(snapshot.flights),
      },
      history: [
        {
          t: snapshot.t,
          minPrice: snapshot.minPrice,
          minFlightNo: snapshot.minFlightNo,
        },
      ],
    };
  }

  function mergeSnapshot(routes, snapshot, now) {
    if (now === undefined) now = Date.now();

    var validation = validateSnapshot(snapshot);
    if (!validation.ok) return validation;

    var base =
      routes && typeof routes === "object" && !Array.isArray(routes)
        ? routes
        : {};
    var key = routeKey(snapshot);
    var entry = buildRoute(snapshot, key, now);
    var result = "created";

    var existing = base[key];
    if (existing && typeof existing === "object" && !Array.isArray(existing)) {
      var point = entry.history[0];
      var history = Array.isArray(existing.history)
        ? existing.history.slice()
        : [];
      var last = history.length ? history[history.length - 1] : null;

      if (last && typeof last.t === "number" && now - last.t < THROTTLE_MS) {
        history[history.length - 1] = point;
        result = "updated";
      } else {
        history.push(point);
        result = "appended";
      }

      if (history.length > MAX_HISTORY) {
        history = history.slice(history.length - MAX_HISTORY);
      }

      entry.createdAt =
        typeof existing.createdAt === "number" ? existing.createdAt : now;
      entry.history = history;
    }

    var nextRoutes = {};
    var keys = Object.keys(base);
    for (var i = 0; i < keys.length; i += 1) {
      nextRoutes[keys[i]] = base[keys[i]];
    }
    nextRoutes[key] = entry;

    // 控制总路线数，超出时淘汰最久未更新的航线（保留当前这条）。
    while (Object.keys(nextRoutes).length > MAX_ROUTES) {
      var allKeys = Object.keys(nextRoutes);
      var oldestKey = null;
      var oldestAt = Infinity;
      for (var j = 0; j < allKeys.length; j += 1) {
        var candidate = allKeys[j];
        if (candidate === key) continue;
        var updatedAt =
          nextRoutes[candidate] && typeof nextRoutes[candidate].updatedAt === "number"
            ? nextRoutes[candidate].updatedAt
            : 0;
        if (updatedAt < oldestAt) {
          oldestAt = updatedAt;
          oldestKey = candidate;
        }
      }
      if (!oldestKey) break;
      delete nextRoutes[oldestKey];
    }

    return { ok: true, routes: nextRoutes, result: result };
  }

  return {
    THROTTLE_MS: THROTTLE_MS,
    MAX_HISTORY: MAX_HISTORY,
    MAX_ROUTES: MAX_ROUTES,
    routeKey: routeKey,
    validateSnapshot: validateSnapshot,
    shouldIgnoreSnapshot: shouldIgnoreSnapshot,
    mergeSnapshot: mergeSnapshot,
  };
});
