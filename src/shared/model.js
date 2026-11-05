(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CtripModel = api;
  }
})(typeof globalThis !== "undefined" && globalThis ? globalThis : this, function () {
  "use strict";

  var flight =
    typeof CtripFlight !== "undefined" && CtripFlight
      ? CtripFlight
      : typeof require === "function"
        ? require("./flight.js")
        : null;

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function numberOrNull(value) {
    return typeof value === "number" && isFinite(value) ? value : null;
  }

  function latestOf(route) {
    return route && isPlainObject(route.latest) ? route.latest : null;
  }

  function latestPrice(route) {
    var latest = latestOf(route);
    return latest ? numberOrNull(latest.minPrice) : null;
  }

  function historyMin(route) {
    var min = null;
    var history = route && Array.isArray(route.history) ? route.history : [];
    for (var i = 0; i < history.length; i += 1) {
      var price = history[i] && numberOrNull(history[i].minPrice);
      if (price === null) continue;
      if (min === null || price < min) min = price;
    }
    if (min === null) min = latestPrice(route);
    return min;
  }

  function historyDelta(route) {
    var history = route && Array.isArray(route.history) ? route.history : [];
    var points = history
      .filter(function (point) {
        return point && numberOrNull(point.t) !== null && numberOrNull(point.minPrice) !== null;
      })
      .slice()
      .sort(function (a, b) {
        return a.t - b.t;
      });
    if (points.length < 2) return null;
    return points[points.length - 1].minPrice - points[points.length - 2].minPrice;
  }

  function groupKey(route) {
    if (!route) return "";
    return (
      String(route.originCode || "") +
      "-" +
      String(route.destCode || "") +
      ":" +
      String(route.cabin || "")
    );
  }

  function seriesCount(route) {
    return route && isPlainObject(route.flightHistory)
      ? Object.keys(route.flightHistory).length
      : 0;
  }

  function seriesSamples(route) {
    if (!route || !isPlainObject(route.flightHistory)) return 0;
    var total = 0;
    Object.keys(route.flightHistory).forEach(function (id) {
      var series = route.flightHistory[id];
      if (series && Array.isArray(series.samples)) total += series.samples.length;
    });
    return total;
  }

  function seriesStats(series) {
    return flight ? flight.summarizeSeries(series) : null;
  }

  function dateEntry(routeKey, route) {
    var latest = latestOf(route);
    return {
      date: route.departDate,
      routeKey: routeKey,
      route: route,
      currentPrice: latestPrice(route),
      historyMin: historyMin(route),
      delta: historyDelta(route),
      cheapestFlight: latest && latest.minFlightNo ? latest.minFlightNo : "",
      flightCount: latest && Array.isArray(latest.flights) ? latest.flights.length : 0,
      seriesCount: seriesCount(route),
      sampleCount: seriesSamples(route),
      updatedAt: numberOrNull(route.updatedAt),
    };
  }

  function buildGroups(routes) {
    var groups = Object.create(null);
    Object.keys(routes || {}).forEach(function (key) {
      var route = routes[key];
      if (!isPlainObject(route) || !route.departDate) return;
      var groupId = groupKey(route);
      if (!groupId) return;

      if (!groups[groupId]) {
        groups[groupId] = {
          key: groupId,
          originCode: route.originCode,
          originName: route.originName,
          destCode: route.destCode,
          destName: route.destName,
          cabin: route.cabin,
          dates: [],
          currentMin: null,
          currentMax: null,
          historyMin: null,
          lowestDate: null,
          lowestPrice: null,
          routeCount: 0,
          seriesCount: 0,
          sampleCount: 0,
          updatedAt: 0,
        };
      }

      var group = groups[groupId];
      var entry = dateEntry(key, route);
      group.dates.push(entry);
      group.routeCount += 1;
      group.seriesCount += entry.seriesCount;
      group.sampleCount += entry.sampleCount;
      group.updatedAt = Math.max(group.updatedAt, entry.updatedAt || 0);

      if (entry.currentPrice !== null) {
        if (group.currentMin === null || entry.currentPrice < group.currentMin) {
          group.currentMin = entry.currentPrice;
        }
        if (group.currentMax === null || entry.currentPrice > group.currentMax) {
          group.currentMax = entry.currentPrice;
        }
        if (group.lowestPrice === null || entry.currentPrice < group.lowestPrice) {
          group.lowestPrice = entry.currentPrice;
          group.lowestDate = entry.date;
        }
      }
      if (entry.historyMin !== null) {
        if (group.historyMin === null || entry.historyMin < group.historyMin) {
          group.historyMin = entry.historyMin;
        }
      }
    });

    var list = Object.keys(groups).map(function (key) {
      var group = groups[key];
      group.dates.sort(function (a, b) {
        return String(a.date).localeCompare(String(b.date)) ||
          String(a.routeKey).localeCompare(String(b.routeKey));
      });
      return group;
    });

    list.sort(function (a, b) {
      return (b.updatedAt || 0) - (a.updatedAt || 0) ||
        String(a.originName || a.originCode).localeCompare(
          String(b.originName || b.originCode)
        );
    });
    return list;
  }

  function buildOverview(routes) {
    var groups = buildGroups(routes);
    var routeKeys = Object.keys(routes || {}).filter(function (key) {
      return isPlainObject(routes[key]);
    });
    var flights = 0;
    var samples = 0;
    var latestAt = 0;

    routeKeys.forEach(function (key) {
      var route = routes[key];
      flights += seriesCount(route);
      samples += seriesSamples(route);
      latestAt = Math.max(latestAt, numberOrNull(route.updatedAt) || 0);
    });

    return {
      routeCount: routeKeys.length,
      groupCount: groups.length,
      dateCount: routeKeys.length,
      flightCount: flights,
      sampleCount: samples,
      latestUpdatedAt: latestAt || null,
      estimatedBytes: estimateBytes(routes),
    };
  }

  function buildComparison(group) {
    if (!group) return { rows: [], bestDate: null };
    var bestPrice = group.currentMin;
    return {
      bestDate: group.lowestDate,
      rows: group.dates.map(function (entry) {
        return {
          date: entry.date,
          routeKey: entry.routeKey,
          currentPrice: entry.currentPrice,
          historyMin: entry.historyMin,
          delta: entry.delta,
          cheapestFlight: entry.cheapestFlight,
          flightCount: entry.flightCount,
          seriesCount: entry.seriesCount,
          updatedAt: entry.updatedAt,
          fromBest:
            entry.currentPrice !== null && bestPrice !== null
              ? entry.currentPrice - bestPrice
              : null,
          isBest: entry.date === group.lowestDate,
        };
      }),
    };
  }

  function identityOf(flightData) {
    if (flight) return flight.flightIdentity(flightData);
    return (
      String(flightData.no || "") +
      "|" +
      String(flightData.departTime || "") +
      "|" +
      String(flightData.arriveTime || "")
    );
  }

  function buildMatrix(group, options) {
    var maxRows =
      options && typeof options.maxRows === "number" ? options.maxRows : 30;
    if (!group) return { dates: [], rows: [], hiddenCount: 0, totalRows: 0 };

    var dates = group.dates.map(function (entry) {
      return {
        date: entry.date,
        routeKey: entry.routeKey,
        currentPrice: entry.currentPrice,
      };
    });
    var rowsByIdentity = Object.create(null);
    var order = [];

    group.dates.forEach(function (entry) {
      var latest = latestOf(entry.route);
      var list = latest && Array.isArray(latest.flights) ? latest.flights : [];
      list.forEach(function (flightData) {
        var identity = identityOf(flightData);
        if (!identity) return;
        var price = numberOrNull(flightData.price);
        if (price === null) return;

        var row = rowsByIdentity[identity];
        if (!row) {
          row = {
            identity: identity,
            no: flightData.no,
            airline: flightData.airline,
            departTime: flightData.departTime,
            arriveTime: flightData.arriveTime,
            transfers: flightData.transfers,
            prices: Object.create(null),
            coverage: 0,
            minPrice: null,
          };
          rowsByIdentity[identity] = row;
          order.push(identity);
        }
        var existing = row.prices[entry.date];
        if (existing === undefined || price < existing) {
          if (existing === undefined) row.coverage += 1;
          row.prices[entry.date] = price;
          row.minPrice =
            row.minPrice === null || price < row.minPrice ? price : row.minPrice;
        }
      });
    });

    var rows = order.map(function (identity) {
      var row = rowsByIdentity[identity];
      return {
        identity: identity,
        no: row.no,
        airline: row.airline,
        departTime: row.departTime,
        arriveTime: row.arriveTime,
        transfers: row.transfers,
        prices: row.prices,
        coverage: row.coverage,
        minPrice: row.minPrice,
      };
    });

    rows.sort(function (a, b) {
      if (b.coverage !== a.coverage) return b.coverage - a.coverage;
      if (a.minPrice !== b.minPrice) return (a.minPrice || 0) - (b.minPrice || 0);
      return String(a.departTime).localeCompare(String(b.departTime));
    });

    var totalRows = rows.length;
    if (maxRows > 0 && rows.length > maxRows) {
      rows = rows.slice(0, maxRows);
    }
    return {
      dates: dates,
      rows: rows,
      hiddenCount: Math.max(0, totalRows - rows.length),
      totalRows: totalRows,
    };
  }

  function buildSeriesList(group) {
    var list = [];
    if (!group) return list;

    group.dates.forEach(function (entry) {
      var history =
        entry.route && isPlainObject(entry.route.flightHistory)
          ? entry.route.flightHistory
          : {};
      Object.keys(history).forEach(function (identity) {
        var series = history[identity];
        if (!isPlainObject(series)) return;
        var stats = seriesStats(series) || {};
        list.push({
          identity: identity,
          routeKey: entry.routeKey,
          date: entry.date,
          no: series.no,
          airline: series.airline,
          departTime: series.departTime,
          arriveTime: series.arriveTime,
          transfers: series.transfers,
          series: series,
          stats: stats,
        });
      });
    });

    list.sort(function (a, b) {
      return String(a.date).localeCompare(String(b.date)) ||
        String(a.departTime).localeCompare(String(b.departTime)) ||
        String(a.no).localeCompare(String(b.no));
    });
    return list;
  }

  function decodeSamples(series) {
    var samples =
      series && Array.isArray(series.samples) ? series.samples : [];
    var points = [];
    for (var i = 0; i < samples.length; i += 1) {
      var sample = samples[i];
      if (!Array.isArray(sample) || sample.length < 2) continue;
      var t = numberOrNull(sample[0]);
      var price = numberOrNull(sample[1]);
      if (t === null || price === null || price <= 0) continue;
      points.push({ t: t, minPrice: price });
    }
    return points.sort(function (a, b) {
      return a.t - b.t;
    });
  }

  function estimateBytes(routes) {
    try {
      return JSON.stringify(routes || {}).length;
    } catch (error) {
      return 0;
    }
  }

  return {
    buildGroups: buildGroups,
    buildOverview: buildOverview,
    buildComparison: buildComparison,
    buildMatrix: buildMatrix,
    buildSeriesList: buildSeriesList,
    decodeSamples: decodeSamples,
    summarizeSeries: seriesStats,
    historyMin: historyMin,
    historyDelta: historyDelta,
    latestPrice: latestPrice,
    groupKey: groupKey,
    estimateBytes: estimateBytes,
  };
});
