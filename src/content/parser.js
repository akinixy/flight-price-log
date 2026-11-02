(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CtripParser = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var LIST_PATH_RE = /^\/online\/list\/oneway-([a-z]{3})-([a-z]{3})\/?$/i;
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  // 与 merge.validateSnapshot 的舱位约束保持一致。
  var CABIN_RE = /^[a-z0-9_]+$/;
  var CANONICAL_ORIGIN = "https://flights.ctrip.com";
  var SEARCH_CRITERIA_MARKER = "GlobalSearchCriteria";
  var MAX_FLIGHTS = 200;

  var SELECTORS = {
    list: ".flight-list.root-flights",
    item: ".flight-item",
    price: ".flight-price .price",
    flightNo: ".plane-No",
    airline: ".airline-name",
    departTime: ".depart-box .time",
    arriveTime: ".arrive-box .time",
    transfer: ".arrow-transfer span",
    transferFallback: ".transfer-duration, .transfer-info-group, .stop-text",
  };

  var FLIGHT_NO_RE = /^[A-Z0-9]{2}\d{3,4}$/i;
  var FLIGHT_NO_TOKEN_RE = /[A-Z0-9]{2}\d{3,4}/gi;
  // 只接受 24 小时制合法时间；前置边界避免把 24:30 误匹配成 4:30。
  var TIME_RE = /(?:^|[^\d])((?:[01]?\d|2[0-3]):[0-5]\d)(?!\d)/;
  var CROSS_DAY_RE = /\+\s*(\d+)\s*天/;
  var TRANSFER_RE = /转\s*(\d+)\s*次/;

  function readParam(searchParams, name, fallback) {
    var value = searchParams.get(name);
    return value === null || value === "" ? fallback : value;
  }

  function parseUrl(url) {
    var parsed;
    try {
      parsed = new URL(url);
    } catch (error) {
      return null;
    }

    var match = LIST_PATH_RE.exec(parsed.pathname);
    if (!match) return null;

    var departDate = parsed.searchParams.get("depdate");
    if (!departDate || !DATE_RE.test(departDate)) return null;

    var originCode = match[1].toUpperCase();
    var destCode = match[2].toUpperCase();
    var cabin = readParam(parsed.searchParams, "cabin", "unknown").toLowerCase();
    if (!CABIN_RE.test(cabin)) cabin = "unknown";
    var adult = readParam(parsed.searchParams, "adult", "1");
    var child = readParam(parsed.searchParams, "child", "0");
    var infant = readParam(parsed.searchParams, "infant", "0");

    var canonicalUrl =
      CANONICAL_ORIGIN +
      "/online/list/oneway-" +
      originCode.toLowerCase() +
      "-" +
      destCode.toLowerCase() +
      "?depdate=" +
      encodeURIComponent(departDate) +
      "&cabin=" +
      encodeURIComponent(cabin) +
      "&adult=" +
      encodeURIComponent(adult) +
      "&child=" +
      encodeURIComponent(child) +
      "&infant=" +
      encodeURIComponent(infant);

    return {
      flightWay: "oneway",
      originCode: originCode,
      destCode: destCode,
      departDate: departDate,
      cabin: cabin,
      canonicalUrl: canonicalUrl,
    };
  }

  // 从脚本文本中截取 "GlobalSearchCriteria" 之后第一个完整的 JSON 对象。
  // 用括号配对而不是 lastIndexOf("}")，因为脚本文本尾部还可能有 try/catch 等代码。
  function extractJsonObject(text, markerIndex) {
    var start = text.indexOf("{", markerIndex);
    if (start === -1) return null;

    var depth = 0;
    var inString = false;
    var escaped = false;

    for (var i = start; i < text.length; i += 1) {
      var ch = text.charAt(i);

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
      } else if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }

    return null;
  }

  function toUpperOrNull(value) {
    return typeof value === "string" && value ? value.toUpperCase() : null;
  }

  function normalizeName(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function textOf(node) {
    return node && typeof node.textContent === "string" ? node.textContent : "";
  }

  function queryAll(parent, selector) {
    if (!parent || typeof parent.querySelectorAll !== "function") return [];
    return Array.prototype.slice.call(parent.querySelectorAll(selector));
  }

  function readPrice(item) {
    var node = item.querySelector(SELECTORS.price);
    if (!node) return null;

    // 只取第一个数字串，避免把「¥520 返50」拼成 52050。
    var match = /\d[\d,]*/.exec(textOf(node));
    if (!match) return null;

    var price = parseInt(match[0].replace(/,/g, ""), 10);
    return Number.isInteger(price) && price > 0 ? price : null;
  }

  function collectFlightNumbers(text, seen, parts) {
    var matches = String(text || "").match(FLIGHT_NO_TOKEN_RE) || [];

    for (var i = 0; i < matches.length; i += 1) {
      var token = matches[i].toUpperCase();
      // 纯数字串可能来自时间戳或价格，航班号必须包含字母。
      if (!/[A-Z]/.test(token)) continue;
      if (!FLIGHT_NO_RE.test(token) || seen[token]) continue;
      seen[token] = true;
      parts.push(token);
    }
  }

  function readFlightNo(item) {
    var seen = {};
    var parts = [];
    var nodes = queryAll(item, SELECTORS.flightNo);

    for (var i = 0; i < nodes.length; i += 1) {
      collectFlightNumbers(textOf(nodes[i]), seen, parts);
    }

    // 部分多航司/中转卡片没有 .plane-No，航班号只出现在元素 id 中。
    if (!parts.length) {
      var idNodes = queryAll(item, "[id]");
      for (var j = 0; j < idNodes.length; j += 1) {
        collectFlightNumbers(idNodes[j].id, seen, parts);
      }
    }

    return parts.join("/");
  }

  // 只拼接 .airline-name 的直接文本节点，避免把机型等子节点文字算进航司名。
  function readAirlines(item) {
    var nodes = queryAll(item, SELECTORS.airline);
    var seen = {};
    var names = [];

    for (var i = 0; i < nodes.length; i += 1) {
      var children = nodes[i].childNodes || [];
      var name = "";

      for (var j = 0; j < children.length; j += 1) {
        if (children[j].nodeType === 3) {
          name += children[j].nodeValue || "";
        }
      }

      name = name.trim();
      if (!name || seen[name]) continue;
      seen[name] = true;
      names.push(name);
    }

    return names.join("/");
  }

  function readTime(item, selector) {
    var node = item.querySelector(selector);
    if (!node) return "";

    var match = TIME_RE.exec(textOf(node));
    return match ? match[1] : "";
  }

  function readArriveTime(item) {
    var node = item.querySelector(SELECTORS.arriveTime);
    if (!node) return "";

    var text = textOf(node);
    var time = TIME_RE.exec(text);
    if (!time) return "";

    var crossDay = CROSS_DAY_RE.exec(text);
    return crossDay ? time[1] + "+" + crossDay[1] : time[1];
  }

  function readTransfers(item) {
    var node = item.querySelector(SELECTORS.transfer);
    if (node) {
      var match = TRANSFER_RE.exec(textOf(node));
      if (match) return parseInt(match[1], 10);
    }

    // 通程/中转卡可能没有「转N次」文案，但有中转/经停标记。
    var fallback = item.querySelector(SELECTORS.transferFallback);
    return fallback && /转|通程|经停/.test(textOf(fallback)) ? 1 : 0;
  }

  function departMinutes(value) {
    var match = /^(\d{1,2}):(\d{2})/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : Infinity;
  }

  function compareFlights(a, b) {
    if (a.price !== b.price) return a.price - b.price;

    var aMinutes = departMinutes(a.departTime);
    var bMinutes = departMinutes(b.departTime);
    if (aMinutes !== bMinutes) return aMinutes - bMinutes;

    return 0;
  }

  function parseFlights(doc) {
    if (!doc || typeof doc.querySelector !== "function") return [];

    var root = doc.querySelector(SELECTORS.list) || doc;
    var items = queryAll(root, SELECTORS.item);
    var seen = {};
    var flights = [];

    for (var i = 0; i < items.length; i += 1) {
      var item = items[i];

      var price = readPrice(item);
      if (price === null) continue;

      var no = readFlightNo(item);
      if (!no) continue;

      var departTime = readTime(item, SELECTORS.departTime);
      if (!departTime) continue;

      var arriveTime = readArriveTime(item);
      if (!arriveTime) continue;

      var key = no + "|" + departTime;
      if (seen[key]) continue;
      seen[key] = true;

      flights.push({
        no: no,
        airline: readAirlines(item),
        departTime: departTime,
        arriveTime: arriveTime,
        transfers: readTransfers(item),
        price: price,
      });
    }

    flights.sort(compareFlights);
    return flights.slice(0, MAX_FLIGHTS);
  }

  function extractSnapshot(options) {
    var context = buildPageContext(options);
    if (!context.ok) return context;

    var flights = parseFlights(options && options.doc);
    if (!flights.length) return { ok: false, reason: "no-flights" };

    var cheapest = flights[0];
    var snapshot = Object.assign({}, context.context, {
      t: Date.now(),
      minPrice: cheapest.price,
      minFlightNo: cheapest.no.split("/")[0],
      flights: flights,
    });

    return { ok: true, snapshot: snapshot };
  }

  function flightKey(flight) {
    return flight.no + "|" + flight.departTime + "|" + flight.price;
  }

  function sortedFlightKeys(snapshot) {
    var flights =
      snapshot && Array.isArray(snapshot.flights) ? snapshot.flights : [];
    var keys = [];

    for (var i = 0; i < flights.length; i += 1) {
      keys.push(flightKey(flights[i]));
    }

    return keys.sort();
  }

  function isSameSnapshot(a, b) {
    if (!a || !b) return false;
    if (a.minPrice !== b.minPrice) return false;

    var aFlights = Array.isArray(a.flights) ? a.flights : [];
    var bFlights = Array.isArray(b.flights) ? b.flights : [];
    if (aFlights.length !== bFlights.length) return false;

    return sortedFlightKeys(a).join("\n") === sortedFlightKeys(b).join("\n");
  }

  function shouldUpdate(prev, next) {
    if (!prev) return true;
    return (
      next.minPrice < prev.minPrice ||
      next.flights.length > prev.flights.length
    );
  }

  // 携程列表按滚动分批渲染：把「已经见过的航班」和「本次可见航班」合并，
  // 避免后渲染的航班覆盖掉之前的记录。同一航班以最新观测到的价格为准。
  function mergeSnapshots(base, next) {
    if (!base) return next;
    if (!next) return base;

    var byIdentity = Object.create(null);
    var order = [];
    var sources = [base.flights, next.flights];

    for (var s = 0; s < sources.length; s += 1) {
      var list = Array.isArray(sources[s]) ? sources[s] : [];
      for (var i = 0; i < list.length; i += 1) {
        var flight = list[i];
        var identity = flight.no + "|" + flight.departTime;
        if (!byIdentity[identity]) order.push(identity);
        // 后处理的 next 覆盖 base：价格刷新时保留最新值。
        byIdentity[identity] = flight;
      }
    }

    var flights = [];
    for (var j = 0; j < order.length; j += 1) {
      flights.push(byIdentity[order[j]]);
    }
    flights.sort(compareFlights);
    flights = flights.slice(0, MAX_FLIGHTS);

    var cheapest = flights[0];
    return Object.assign({}, next, {
      minPrice: cheapest.price,
      minFlightNo: cheapest.no.split("/")[0],
      flights: flights,
    });
  }

  function flightIdentity(flight) {
    return flight.no + "|" + flight.departTime;
  }

  // 只保留在指定轮次仍然出现在页面里的航班，用于清理已售罄/下架的航班。
  function pruneFlights(flights, seenGeneration, generation) {
    var kept = [];
    var list = Array.isArray(flights) ? flights : [];

    for (var i = 0; i < list.length; i += 1) {
      var flight = list[i];
      var seen = seenGeneration && seenGeneration[flightIdentity(flight)];
      if (seen === generation) kept.push(flight);
    }

    return kept;
  }

  function rebuildSnapshot(snapshot, flights) {
    var list = Array.isArray(flights) ? flights.slice() : [];
    if (!snapshot || !list.length) return null;

    list.sort(compareFlights);
    list = list.slice(0, MAX_FLIGHTS);
    var cheapest = list[0];
    return Object.assign({}, snapshot, {
      minPrice: cheapest.price,
      minFlightNo: cheapest.no.split("/")[0],
      flights: list,
    });
  }

  function parseSearchCriteria(scriptTexts) {
    if (!Array.isArray(scriptTexts)) return null;

    for (var i = 0; i < scriptTexts.length; i += 1) {
      var text = scriptTexts[i];
      if (typeof text !== "string") continue;

      var markerIndex = text.indexOf(SEARCH_CRITERIA_MARKER);
      if (markerIndex === -1) continue;

      var jsonText = extractJsonObject(text, markerIndex);
      if (!jsonText) continue;

      var data;
      try {
        data = JSON.parse(jsonText);
      } catch (error) {
        continue;
      }

      var segment = data && data.flightSegments && data.flightSegments[0];
      if (!segment) continue;

      var flightWay = toUpperOrNull(data.flightWay);
      var originCode = toUpperOrNull(segment.departureCityCode);
      var destCode = toUpperOrNull(segment.arrivalCityCode);
      var departDate =
        typeof segment.departureDate === "string" ? segment.departureDate : null;

      if (!flightWay || !originCode || !destCode || !departDate) continue;

      return {
        flightWay: flightWay,
        originCode: originCode,
        destCode: destCode,
        originName: normalizeName(segment.departureCityName),
        destName: normalizeName(segment.arrivalCityName),
        departDate: departDate,
        departureCountryId: segment.departureCountryId,
        arrivalCountryId: segment.arrivalCountryId,
      };
    }

    return null;
  }

  function readDomName(doc, selector) {
    if (!doc || typeof doc.querySelector !== "function") return "";
    var node = doc.querySelector(selector);
    return node && typeof node.textContent === "string"
      ? node.textContent.trim()
      : "";
  }

  function hasForeignCountryId(id) {
    if (id === null || id === undefined || id === "") return false;
    return Number(id) !== 1;
  }

  function buildPageContext(options) {
    var url = options && options.url;
    var scriptTexts =
      options && Array.isArray(options.scriptTexts) ? options.scriptTexts : [];
    var doc = options && options.doc;

    var urlInfo = parseUrl(url);
    if (!urlInfo) return { ok: false, reason: "unsupported-url" };

    var criteria = parseSearchCriteria(scriptTexts);
    var consistent =
      !!criteria &&
      criteria.departDate === urlInfo.departDate &&
      criteria.originCode === urlInfo.originCode &&
      criteria.destCode === urlInfo.destCode;

    var originName;
    var destName;

    if (consistent) {
      if (criteria.flightWay !== "S") {
        return { ok: false, reason: "not-oneway" };
      }

      if (
        hasForeignCountryId(criteria.departureCountryId) ||
        hasForeignCountryId(criteria.arrivalCountryId)
      ) {
        return { ok: false, reason: "not-domestic" };
      }

      originName = criteria.originName || urlInfo.originCode;
      destName = criteria.destName || urlInfo.destCode;
    } else {
      // 脚本缺失或与 URL 不一致（陈旧页面）时，中文名回退 DOM，再兜底城市代码。
      originName =
        readDomName(doc, ".address .depart") || urlInfo.originCode;
      destName = readDomName(doc, ".address .arrive") || urlInfo.destCode;
    }

    return {
      ok: true,
      context: {
        flightWay: "oneway",
        originCode: urlInfo.originCode,
        originName: originName,
        destCode: urlInfo.destCode,
        destName: destName,
        departDate: urlInfo.departDate,
        cabin: urlInfo.cabin,
        currency: "CNY",
        url: urlInfo.canonicalUrl,
      },
    };
  }

  return {
    parseUrl: parseUrl,
    parseSearchCriteria: parseSearchCriteria,
    buildPageContext: buildPageContext,
    parseFlights: parseFlights,
    extractSnapshot: extractSnapshot,
    isSameSnapshot: isSameSnapshot,
    shouldUpdate: shouldUpdate,
    mergeSnapshots: mergeSnapshots,
    pruneFlights: pruneFlights,
    rebuildSnapshot: rebuildSnapshot,
  };
});
