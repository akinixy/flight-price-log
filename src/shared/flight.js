(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CtripFlight = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_SERIES = 300;
  var MAX_SERIES_PER_ROUTE = 200;
  var MAX_SAMPLES_PER_FLIGHT = 240;
  var MAX_SAMPLES_TOTAL = 72000;
  var MAX_HISTORY_TOTAL = 12000;
  var MAX_HISTORY_PER_ROUTE = 1000;
  var RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
  var HEARTBEAT_MS = 60 * 60 * 1000;
  var MIN_PRICE = 1;
  var MAX_PRICE = 50000;

  var TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)(\+\d+)?$/;
  var FLIGHT_TOKEN_RE = /[A-Z0-9]{2}\d{3,4}/g;

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeText(value) {
    return String(value === undefined || value === null ? "" : value)
      .replace(/ /g, " ")
      .trim()
      .toUpperCase();
  }

  function normalizeFlightNo(value) {
    var text = normalizeText(value);
    if (!text) return "";

    var tokens = text.match(FLIGHT_TOKEN_RE) || [];
    var seen = Object.create(null);
    var parts = [];
    for (var i = 0; i < tokens.length; i += 1) {
      var token = tokens[i];
      if (!/[A-Z]/.test(token) || seen[token]) continue;
      seen[token] = true;
      parts.push(token);
    }
    return parts.join("/");
  }

  function canonicalFlightNo(value) {
    var no = normalizeFlightNo(value);
    if (!no) return "";
    return no.split("/").sort().join("+");
  }

  function normalizeTime(value) {
    var match = TIME_RE.exec(normalizeText(value));
    if (!match) return "";
    var hour = match[1].length === 1 ? "0" + match[1] : match[1];
    return hour + ":" + match[2] + (match[3] || "");
  }

  function normalizeArriveTime(departTime, arriveTime) {
    var arrive = normalizeTime(arriveTime);
    if (!arrive) return "";
    if (/\+\d+$/.test(arrive)) return arrive;

    var depart = normalizeTime(departTime);
    if (!depart) return arrive;

    var departMinutes =
      parseInt(depart.slice(0, 2), 10) * 60 + parseInt(depart.slice(3, 5), 10);
    var arriveMinutes =
      parseInt(arrive.slice(0, 2), 10) * 60 + parseInt(arrive.slice(3, 5), 10);
    return arriveMinutes < departMinutes ? arrive + "+1" : arrive;
  }

  function normalizePrice(value) {
    var price = typeof value === "number" ? value : Number(value);
    if (!isFinite(price)) return null;
    price = Math.round(price);
    if (price < MIN_PRICE || price > MAX_PRICE) return null;
    return price;
  }

  function normalizeFlight(flight) {
    if (!flight || typeof flight !== "object") return null;
    var no = normalizeFlightNo(flight.no);
    var departTime = normalizeTime(flight.departTime);
    var arriveTime = normalizeArriveTime(departTime, flight.arriveTime);
    var price = normalizePrice(flight.price);
    if (!no || !departTime || !arriveTime || price === null) return null;

    var transfers =
      typeof flight.transfers === "number" &&
      isFinite(flight.transfers) &&
      flight.transfers >= 0
        ? Math.round(flight.transfers)
        : 0;

    return {
      no: no,
      airline: typeof flight.airline === "string" ? flight.airline : "",
      departTime: departTime,
      arriveTime: arriveTime,
      transfers: transfers,
      price: price,
    };
  }

  function flightIdentity(flight) {
    if (!flight || typeof flight !== "object") return "";
    var no = normalizeFlightNo(flight.no);
    var departTime = normalizeTime(flight.departTime);
    var arriveTime = normalizeArriveTime(departTime, flight.arriveTime);
    if (!no || !departTime || !arriveTime) return "";
    return canonicalFlightNo(no) + "|" + departTime + "|" + arriveTime;
  }

  function cloneSeries(series) {
    if (!isPlainObject(series)) return null;
    var samples = Array.isArray(series.samples)
      ? series.samples
          .filter(function (sample) {
            return Array.isArray(sample) && sample.length >= 2;
          })
          .map(function (sample) {
            return [sample[0], sample[1]];
          })
      : [];
    return {
      no: typeof series.no === "string" ? series.no : "",
      airline: typeof series.airline === "string" ? series.airline : "",
      departTime: typeof series.departTime === "string" ? series.departTime : "",
      arriveTime: typeof series.arriveTime === "string" ? series.arriveTime : "",
      transfers:
        typeof series.transfers === "number" && isFinite(series.transfers)
          ? Math.max(0, Math.round(series.transfers))
          : 0,
      firstSeenAt:
        typeof series.firstSeenAt === "number" && isFinite(series.firstSeenAt)
          ? series.firstSeenAt
          : 0,
      lastSeenAt:
        typeof series.lastSeenAt === "number" && isFinite(series.lastSeenAt)
          ? series.lastSeenAt
          : 0,
      latestPrice:
        typeof series.latestPrice === "number" && isFinite(series.latestPrice)
          ? series.latestPrice
          : null,
      samples: samples,
    };
  }

  function appendSample(samples, t, price) {
    var next = samples;
    if (!next.length) {
      next.push([t, price]);
      return next;
    }

    var last = next[next.length - 1];
    if (t < last[0]) t = last[0];

    if (price !== last[1]) {
      if (t === last[0]) {
        last[1] = price;
      } else {
        next.push([t, price]);
      }
    } else if (t - last[0] >= HEARTBEAT_MS) {
      next.push([t, price]);
    }

    if (next.length > MAX_SAMPLES_PER_FLIGHT) {
      next.splice(0, next.length - MAX_SAMPLES_PER_FLIGHT);
    }
    return next;
  }

  function mergeFlightHistory(existingHistory, flights, t) {
    var map = {};
    if (isPlainObject(existingHistory)) {
      Object.keys(existingHistory).forEach(function (id) {
        var series = cloneSeries(existingHistory[id]);
        if (series) map[id] = series;
      });
    }

    for (var i = 0; i < (flights || []).length; i += 1) {
      var flight = normalizeFlight(flights[i]);
      if (!flight) continue;

      var id = flightIdentity(flight);
      if (!id) continue;

      var current = map[id];
      if (!current) {
        current = {
          no: flight.no,
          airline: flight.airline,
          departTime: flight.departTime,
          arriveTime: flight.arriveTime,
          transfers: flight.transfers,
          firstSeenAt: t,
          lastSeenAt: t,
          latestPrice: flight.price,
          samples: [],
        };
        map[id] = current;
      }

      current.no = flight.no;
      current.airline = flight.airline;
      current.departTime = flight.departTime;
      current.arriveTime = flight.arriveTime;
      current.transfers = flight.transfers;
      current.latestPrice = flight.price;
      current.lastSeenAt = t;
      if (!current.firstSeenAt) current.firstSeenAt = t;
      current.samples = appendSample(current.samples, t, flight.price);
    }

    return map;
  }

  function mergeSampleLists(a, b) {
    var byTime = Object.create(null);
    var list = [];
    var source = (a || []).concat(b || []);
    for (var i = 0; i < source.length; i += 1) {
      var sample = source[i];
      if (!Array.isArray(sample) || sample.length < 2) continue;
      var t = Number(sample[0]);
      var price = normalizePrice(sample[1]);
      if (!isFinite(t) || t <= 0 || price === null) continue;
      byTime[t] = price;
    }
    Object.keys(byTime)
      .map(Number)
      .sort(function (x, y) {
        return x - y;
      })
      .forEach(function (t) {
        list.push([t, byTime[t]]);
      });
    if (list.length > MAX_SAMPLES_PER_FLIGHT) {
      list = list.slice(list.length - MAX_SAMPLES_PER_FLIGHT);
    }
    return list;
  }

  // 备份合并：同一航班取样本并集，元数据以较新的 lastSeenAt 为准。
  function mergeFlightHistoryMaps(current, incoming) {
    var map = {};
    if (isPlainObject(current)) {
      Object.keys(current).forEach(function (id) {
        var series = cloneSeries(current[id]);
        if (series) map[id] = series;
      });
    }

    Object.keys(incoming || {}).forEach(function (id) {
      var next = cloneSeries(incoming[id]);
      if (!next) return;
      var existing = map[id];
      if (!existing) {
        next.samples = mergeSampleLists(next.samples, []);
        map[id] = next;
        return;
      }

      var newer =
        next.lastSeenAt >= existing.lastSeenAt ? next : existing;
      var merged = cloneSeries(newer);
      merged.samples = mergeSampleLists(existing.samples, next.samples);
      merged.firstSeenAt = Math.min(
        existing.firstSeenAt || newer.firstSeenAt || 0,
        next.firstSeenAt || newer.firstSeenAt || 0
      ) || newer.firstSeenAt;
      map[id] = merged;
    });

    return map;
  }

  function summarizeSeries(series) {
    var samples = series && Array.isArray(series.samples) ? series.samples : [];
    var prices = [];
    for (var i = 0; i < samples.length; i += 1) {
      var sample = samples[i];
      if (!Array.isArray(sample) || sample.length < 2) continue;
      var price = normalizePrice(sample[1]);
      if (price !== null) prices.push(price);
    }
    if (!prices.length) {
      return {
        current: null,
        min: null,
        max: null,
        change: null,
        count: 0,
      };
    }
    return {
      current: prices[prices.length - 1],
      min: Math.min.apply(null, prices),
      max: Math.max.apply(null, prices),
      change: prices[prices.length - 1] - prices[0],
      count: prices.length,
    };
  }

  function ensureRouteCopy(routes, key, copied) {
    if (copied[key]) return routes[key];
    copied[key] = true;
    var route = routes[key];
    var copy = Object.assign({}, route);
    if (isPlainObject(route.flightHistory)) {
      copy.flightHistory = Object.assign({}, route.flightHistory);
    }
    routes[key] = copy;
    return copy;
  }

  function enforceBudgets(routesInput, nowInput, optionsInput) {
    var now = typeof nowInput === "number" ? nowInput : Date.now();
    var options = optionsInput || {};
    var maxRoutes =
      typeof options.maxRoutes === "number"
        ? options.maxRoutes
        : Infinity;
    var maxHistoryTotal =
      typeof options.maxHistoryTotal === "number"
        ? options.maxHistoryTotal
        : MAX_HISTORY_TOTAL;
    var maxHistoryPerRoute =
      typeof options.maxHistoryPerRoute === "number"
        ? options.maxHistoryPerRoute
        : MAX_HISTORY_PER_ROUTE;
    var maxSeries =
      typeof options.maxSeries === "number" ? options.maxSeries : MAX_SERIES;
    var maxSeriesPerRoute =
      typeof options.maxSeriesPerRoute === "number"
        ? options.maxSeriesPerRoute
        : MAX_SERIES_PER_ROUTE;
    var maxSamplesPerFlight =
      typeof options.maxSamplesPerFlight === "number"
        ? options.maxSamplesPerFlight
        : MAX_SAMPLES_PER_FLIGHT;
    var maxSamplesTotal =
      typeof options.maxSamplesTotal === "number"
        ? options.maxSamplesTotal
        : MAX_SAMPLES_TOTAL;
    var retentionMs =
      typeof options.retentionMs === "number" ? options.retentionMs : RETENTION_MS;

    var routes = {};
    Object.keys(routesInput || {}).forEach(function (key) {
      if (isPlainObject(routesInput[key])) routes[key] = routesInput[key];
    });

    if (isFinite(maxRoutes) && Object.keys(routes).length > maxRoutes) {
      Object.keys(routes)
        .sort(function (a, b) {
          return (routes[a].updatedAt || 0) - (routes[b].updatedAt || 0);
        })
        .slice(0, Object.keys(routes).length - maxRoutes)
        .forEach(function (key) {
          delete routes[key];
        });
    }

    var copied = Object.create(null);
    var routeKeys = Object.keys(routes);
    var historyTotal = 0;
    routeKeys.forEach(function (key) {
      var history = Array.isArray(routes[key].history)
        ? routes[key].history
        : [];
      historyTotal += history.length;
      if (history.length > maxHistoryPerRoute) {
        var route = ensureRouteCopy(routes, key, copied);
        route.history = history.slice(history.length - maxHistoryPerRoute);
        historyTotal -= history.length - route.history.length;
      }
    });

    // 路线历史全局预算：先裁最久未更新的航线，并尽量保留每线最后一点。
    routeKeys
      .slice()
      .sort(function (a, b) {
        return (routes[a].updatedAt || 0) - (routes[b].updatedAt || 0);
      })
      .forEach(function (key) {
        if (historyTotal <= maxHistoryTotal) return;
        var route = routes[key];
        var history = Array.isArray(route.history) ? route.history : [];
        var remove = Math.min(
          historyTotal - maxHistoryTotal,
          Math.max(0, history.length - 1)
        );
        if (!remove) return;
        route = ensureRouteCopy(routes, key, copied);
        route.history = history.slice(remove);
        historyTotal -= remove;
      });

    var cutoff = now - retentionMs;
    var seriesEntries = [];
    var totalSamples = 0;

    Object.keys(routes).forEach(function (routeKey) {
      var route = routes[routeKey];
      var history = isPlainObject(route.flightHistory)
        ? route.flightHistory
        : {};
      var ids = Object.keys(history);
      if (!ids.length) return;

      var kept = [];
      ids.forEach(function (id) {
        var series = cloneSeries(history[id]);
        if (!series) return;
        if (series.lastSeenAt && series.lastSeenAt < cutoff) return;

        var samples = [];
        for (var i = 0; i < series.samples.length; i += 1) {
          var sample = series.samples[i];
          if (!Array.isArray(sample) || sample.length < 2) continue;
          var t = Number(sample[0]);
          var price = normalizePrice(sample[1]);
          if (!isFinite(t) || t < cutoff || price === null) continue;
          samples.push([t, price]);
        }
        if (!samples.length) return;
        if (samples.length > maxSamplesPerFlight) {
          samples = samples.slice(samples.length - maxSamplesPerFlight);
        }
        series.samples = samples;
        totalSamples += samples.length;
        kept.push({ id: id, series: series });
      });

      if (kept.length > maxSeriesPerRoute) {
        kept.sort(function (a, b) {
          return (b.series.lastSeenAt || 0) - (a.series.lastSeenAt || 0);
        });
        kept = kept.slice(0, maxSeriesPerRoute);
      }

      if (kept.length !== ids.length) {
        var routeCopy = ensureRouteCopy(routes, routeKey, copied);
        routeCopy.flightHistory = {};
        kept.forEach(function (entry) {
          routeCopy.flightHistory[entry.id] = entry.series;
        });
      } else {
        var changed = false;
        for (var j = 0; j < kept.length; j += 1) {
          if (history[kept[j].id] !== kept[j].series) {
            changed = true;
            break;
          }
        }
        if (changed) {
          var copy = ensureRouteCopy(routes, routeKey, copied);
          copy.flightHistory = {};
          kept.forEach(function (entry) {
            copy.flightHistory[entry.id] = entry.series;
          });
        } else {
          kept.forEach(function (entry) {
            history[entry.id] = entry.series;
          });
        }
      }

      kept.forEach(function (entry) {
        seriesEntries.push({
          routeKey: routeKey,
          id: entry.id,
          series: entry.series,
          lastSeenAt: entry.series.lastSeenAt || 0,
        });
      });
    });

    if (seriesEntries.length > maxSeries) {
      seriesEntries
        .slice()
        .sort(function (a, b) {
          return a.lastSeenAt - b.lastSeenAt;
        })
        .slice(0, seriesEntries.length - maxSeries)
        .forEach(function (entry) {
          var route = ensureRouteCopy(routes, entry.routeKey, copied);
          if (route.flightHistory) delete route.flightHistory[entry.id];
          totalSamples -= entry.series.samples.length;
        });
    }

    if (totalSamples > maxSamplesTotal) {
      seriesEntries
        .slice()
        .sort(function (a, b) {
          return a.lastSeenAt - b.lastSeenAt;
        })
        .forEach(function (entry) {
          if (totalSamples <= maxSamplesTotal) return;
          var route = routes[entry.routeKey];
          var live =
            route && route.flightHistory && route.flightHistory[entry.id];
          if (!live || !Array.isArray(live.samples)) return;
          var remove = Math.min(
            totalSamples - maxSamplesTotal,
            Math.max(0, live.samples.length - 1)
          );
          if (!remove) return;
          var copy = ensureRouteCopy(routes, entry.routeKey, copied);
          copy.flightHistory[entry.id] = Object.assign({}, live, {
            samples: live.samples.slice(remove),
          });
          totalSamples -= remove;
        });
    }

    return routes;
  }

  function compactRoutes(routes, now) {
    return enforceBudgets(routes, now, {
      maxRoutes: 50,
      maxHistoryTotal: 5000,
      maxHistoryPerRoute: 200,
      maxSeries: 150,
      maxSeriesPerRoute: 100,
      maxSamplesPerFlight: 20,
      maxSamplesTotal: 30000,
      retentionMs: 30 * 24 * 60 * 60 * 1000,
    });
  }

  return {
    MAX_SERIES: MAX_SERIES,
    MAX_SERIES_PER_ROUTE: MAX_SERIES_PER_ROUTE,
    MAX_SAMPLES_PER_FLIGHT: MAX_SAMPLES_PER_FLIGHT,
    MAX_SAMPLES_TOTAL: MAX_SAMPLES_TOTAL,
    MAX_HISTORY_TOTAL: MAX_HISTORY_TOTAL,
    MAX_HISTORY_PER_ROUTE: MAX_HISTORY_PER_ROUTE,
    RETENTION_MS: RETENTION_MS,
    HEARTBEAT_MS: HEARTBEAT_MS,
    normalizeFlightNo: normalizeFlightNo,
    canonicalFlightNo: canonicalFlightNo,
    normalizeTime: normalizeTime,
    normalizeArriveTime: normalizeArriveTime,
    normalizePrice: normalizePrice,
    normalizeFlight: normalizeFlight,
    flightIdentity: flightIdentity,
    mergeFlightHistory: mergeFlightHistory,
    mergeFlightHistoryMaps: mergeFlightHistoryMaps,
    summarizeSeries: summarizeSeries,
    enforceBudgets: enforceBudgets,
    compactRoutes: compactRoutes,
  };
});
