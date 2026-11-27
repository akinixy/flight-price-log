(function (root, factory) {
  "use strict";

  var api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CtripReport = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var model =
    root && root.CtripModel
      ? root.CtripModel
      : typeof require === "function"
        ? require("./model.js")
        : null;
  var format =
    root && root.CtripFormat
      ? root.CtripFormat
      : typeof require === "function"
        ? require("./format.js")
        : null;

  var ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  var WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  var MAX_MATRIX_ROWS = 30;
  var MAX_TREND_ROWS = 200;

  function escapeHtml(value) {
    return String(value === undefined || value === null ? "" : value).replace(
      /[&<>"']/g,
      function (ch) {
        return ESCAPES[ch];
      }
    );
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
  }

  function safeCtripUrl(url) {
    if (typeof url !== "string") return "";
    if (!/^https:\/\/flights\.ctrip\.com\//.test(url)) return "";
    return url;
  }

  function priceText(value) {
    return isFiniteNumber(value) ? format.formatPrice(value) : "—";
  }

  function dateText(value, nowDate) {
    if (typeof value !== "string" || !value) return "—";
    try {
      return format.formatDateLabel(value, nowDate);
    } catch (error) {
      return value;
    }
  }

  function weekdayText(value) {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) return "";
    var date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return WEEKDAYS[date.getDay()] || "";
  }

  function timeText(value, nowDate) {
    return isFiniteNumber(value) ? format.formatTimestamp(value, nowDate) : "—";
  }

  function deltaText(value) {
    return isFiniteNumber(value) ? format.formatDelta(value, 0) : "";
  }

  function deltaClass(value) {
    if (!isFiniteNumber(value)) return "";
    if (value > 0) return "delta-up";
    if (value < 0) return "delta-down";
    return "delta-flat";
  }

  function cabinText(value) {
    return value ? String(format.formatCabin(String(value))) : "";
  }

  // 与服务端/页面数据无关的纯字符串 SVG 折线图；所有坐标都在 0-1 之间归一化。
  function sparkline(points, options) {
    options = options || {};
    var width = isFiniteNumber(options.width) ? options.width : 640;
    var height = isFiniteNumber(options.height) ? options.height : 180;
    var compact = options.compact === true;
    var list = [];
    for (var i = 0; i < (points || []).length; i += 1) {
      var point = points[i];
      if (!point || !isFiniteNumber(point.t) || !isFiniteNumber(point.minPrice)) {
        continue;
      }
      list.push(point);
    }
    list.sort(function (a, b) {
      return a.t - b.t;
    });
    if (!list.length) return "";

    var padX = compact ? 2 : 8;
    var padY = compact ? 3 : 14;
    var minPrice = list[0].minPrice;
    var maxPrice = list[0].minPrice;
    for (var p = 1; p < list.length; p += 1) {
      if (list[p].minPrice < minPrice) minPrice = list[p].minPrice;
      if (list[p].minPrice > maxPrice) maxPrice = list[p].minPrice;
    }
    var firstT = list[0].t;
    var lastT = list[list.length - 1].t;
    var timeSpan = lastT - firstT;
    var priceSpan = maxPrice - minPrice;

    function xOf(t) {
      if (timeSpan <= 0) return width / 2;
      return padX + ((t - firstT) / timeSpan) * (width - padX * 2);
    }

    function yOf(price) {
      if (priceSpan <= 0) return height / 2;
      return padY + (1 - (price - minPrice) / priceSpan) * (height - padY * 2);
    }

    var coords = list.map(function (item) {
      return [xOf(item.t), yOf(item.minPrice)];
    });
    var line = "";
    for (var c = 0; c < coords.length; c += 1) {
      line +=
        (c === 0 ? "M" : " L") +
        coords[c][0].toFixed(1) +
        "," +
        coords[c][1].toFixed(1);
    }
    var bottom = height - padY;
    var area =
      line +
      " L" +
      coords[coords.length - 1][0].toFixed(1) +
      "," +
      bottom +
      " L" +
      coords[0][0].toFixed(1) +
      "," +
      bottom +
      " Z";

    var grid = "";
    if (!compact) {
      [0.25, 0.5, 0.75].forEach(function (ratio) {
        var gy = padY + ratio * (height - padY * 2);
        grid +=
          '<line class="grid" x1="' +
          padX +
          '" y1="' +
          gy.toFixed(1) +
          '" x2="' +
          (width - padX) +
          '" y2="' +
          gy.toFixed(1) +
          '"/>';
      });
    }

    var last = coords[coords.length - 1];
    var dot =
      '<circle class="dot" cx="' +
      last[0].toFixed(1) +
      '" cy="' +
      last[1].toFixed(1) +
      '" r="' +
      (compact ? 2 : 3.5) +
      '"/>';

    return (
      '<svg class="' +
      (compact ? "spark-mini" : "chart-svg") +
      '" viewBox="0 0 ' +
      width +
      " " +
      height +
      '" preserveAspectRatio="none" aria-hidden="true">' +
      grid +
      '<path class="area" d="' +
      area +
      '"/>' +
      '<path class="line" d="' +
      line +
      '"/>' +
      dot +
      "</svg>"
    );
  }

  function historyPoints(route) {
    var history = route && Array.isArray(route.history) ? route.history : [];
    var points = [];
    for (var i = 0; i < history.length; i += 1) {
      var point = history[i];
      if (!point || !isFiniteNumber(point.t) || !isFiniteNumber(point.minPrice)) {
        continue;
      }
      points.push({ t: point.t, minPrice: point.minPrice });
    }
    points.sort(function (a, b) {
      return a.t - b.t;
    });
    return points;
  }

  function renderHeader(overview, now, nowDate) {
    var generated = timeText(now, nowDate);
    return [
      '<header class="report-header">',
      '<div class="header-top">',
      "<div>",
      '<p class="eyebrow">航班价格记录簿</p>',
      "<h1>航班价格报告</h1>",
      "</div>",
      '<button type="button" class="print-button" onclick="window.print()">打印 / 另存为 PDF</button>',
      "</div>",
      '<p class="report-meta">生成时间：' +
        escapeHtml(generated) +
        " · 数据范围：" +
        overview.routeCount +
        " 条航线 · " +
        overview.groupCount +
        " 个城市对 · " +
        overview.flightCount +
        " 个航班序列 · " +
        overview.sampleCount +
        " 个价格样本</p>",
      '<p class="report-note">数据来自本机浏览器记录，仅为页面当时展示的价格；受登录状态、会员等级和舱位筛选影响，不是携程官方报价。</p>',
      "</header>",
    ].join("");
  }

  function renderStats(overview, nowDate) {
    var cards = [
      ["航线", String(overview.routeCount), "有价格记录的日期"],
      ["城市对", String(overview.groupCount), "按出发地/目的地/舱位分组"],
      ["追踪航班", String(overview.flightCount), "已形成价格序列的航班"],
      ["价格样本", String(overview.sampleCount), "每班最多 240 个点"],
      [
        "最近记录",
        overview.latestUpdatedAt ? timeText(overview.latestUpdatedAt, nowDate) : "—",
        "本机时间",
      ],
      [
        "存储估算",
        overview.estimatedBytes
          ? Math.max(1, Math.round(overview.estimatedBytes / 1024)) + " KB"
          : "0 KB",
        "大致占用，非精确值",
      ],
    ];
    var html = '<section class="summary-grid" aria-label="统计概览">';
    cards.forEach(function (card) {
      html +=
        '<div class="summary-card"><p class="label">' +
        escapeHtml(card[0]) +
        '</p><p class="value">' +
        escapeHtml(card[1]) +
        '</p><p class="note">' +
        escapeHtml(card[2]) +
        "</p></div>";
    });
    html += "</section>";
    return html;
  }

  function renderComparison(group, nowDate) {
    var comparison = model.buildComparison(group);
    if (!comparison.rows.length) return "";
    var html = [
      '<h3 class="section-title">日期对比</h3>',
      '<div class="table-wrap"><table>',
      "<thead><tr>",
      "<th>日期</th>",
      '<th class="numeric">当前最低</th>',
      '<th class="numeric">历史最低</th>',
      '<th class="numeric">较上次</th>',
      '<th class="numeric">比组内最低</th>',
      "<th>最低航班</th>",
      '<th class="numeric">航班数</th>',
      "<th>最近记录</th>",
      "</tr></thead><tbody>",
    ];
    comparison.rows.forEach(function (row) {
      var fromBest = row.isBest
        ? "最低"
        : isFiniteNumber(row.fromBest)
          ? "+" + priceText(row.fromBest)
          : "—";
      html.push(
        '<tr class="' +
          (row.isBest ? "best" : "") +
          '">' +
          "<td>" +
          escapeHtml(dateText(row.date, nowDate)) +
          "</td>" +
          '<td class="numeric">' +
          escapeHtml(priceText(row.currentPrice)) +
          "</td>" +
          '<td class="numeric">' +
          escapeHtml(priceText(row.historyMin)) +
          "</td>" +
          '<td class="numeric ' +
          deltaClass(row.delta) +
          '">' +
          escapeHtml(deltaText(row.delta) || "—") +
          "</td>" +
          '<td class="numeric">' +
          escapeHtml(fromBest) +
          "</td>" +
          "<td>" +
          escapeHtml(row.cheapestFlight || "—") +
          "</td>" +
          '<td class="numeric">' +
          row.flightCount +
          "</td>" +
          "<td>" +
          escapeHtml(timeText(row.updatedAt, nowDate)) +
          "</td>" +
          "</tr>"
      );
    });
    html.push("</tbody></table></div>");
    return html.join("");
  }

  function renderMatrix(group, nowDate, maxRows) {
    if (!group.dates || group.dates.length < 2) return "";
    var limit = isFiniteNumber(maxRows) && maxRows > 0 ? maxRows : MAX_MATRIX_ROWS;
    var matrix = model.buildMatrix(group, { maxRows: limit });
    if (!matrix.rows.length) return "";

    var html = [
      '<h3 class="section-title">航班 × 日期</h3>',
      '<p class="section-note">单元格为各日期最近一次记录中的当前价。</p>',
      '<div class="table-wrap"><table>',
      "<thead><tr><th>航班</th>",
    ];
    matrix.dates.forEach(function (entry) {
      html.push("<th>" + escapeHtml(dateText(entry.date, nowDate)) + "</th>");
    });
    html.push("</tr></thead><tbody>");
    matrix.rows.forEach(function (row) {
      html.push(
        "<tr><td><strong>" +
          escapeHtml(row.no || "—") +
          "</strong>" +
          (row.airline || row.departTime
            ? '<span class="sub">' +
              escapeHtml(
                (row.airline || "") +
                  (row.departTime
                    ? " · " + row.departTime + "→" + row.arriveTime
                    : "")
              ) +
              "</span>"
            : "") +
          "</td>"
      );
      matrix.dates.forEach(function (entry) {
        var value = row.prices[entry.date];
        html.push(
          '<td class="numeric">' +
            (value === undefined ? "—" : escapeHtml(priceText(value))) +
            "</td>"
        );
      });
      html.push("</tr>");
    });
    html.push("</tbody></table></div>");
    if (matrix.hiddenCount > 0) {
      html.push(
        '<p class="section-note">仅显示覆盖日期最多的 ' +
          matrix.rows.length +
          " 行，共 " +
          matrix.totalRows +
          " 行。</p>"
      );
    }
    return html.join("");
  }

  function sortedFlights(route) {
    var latest = isPlainObject(route.latest) ? route.latest : null;
    var list = latest && Array.isArray(latest.flights) ? latest.flights.slice() : [];
    list.sort(function (a, b) {
      var aPrice = a && isFiniteNumber(a.price) ? a.price : Infinity;
      var bPrice = b && isFiniteNumber(b.price) ? b.price : Infinity;
      if (aPrice !== bPrice) return aPrice - bPrice;
      return String((a && a.departTime) || "").localeCompare(
        String((b && b.departTime) || "")
      );
    });
    return list;
  }

  function renderFlights(route) {
    var list = sortedFlights(route);
    var html = ['<h4 class="section-title">当前航班</h4>'];
    if (!list.length) {
      html.push('<p class="empty-panel">暂无当前航班明细。</p>');
      return html.join("");
    }
    var minPrice = null;
    list.forEach(function (item) {
      if (item && isFiniteNumber(item.price)) {
        if (minPrice === null || item.price < minPrice) minPrice = item.price;
      }
    });

    html.push('<div class="table-wrap"><table>');
    html.push(
      "<thead><tr><th>航班</th><th>航司</th><th>起飞</th><th>到达</th>" +
        '<th class="numeric">用时</th><th class="numeric">价格</th></tr></thead><tbody>'
    );
    list.forEach(function (item) {
      if (!item) return;
      var isLowest = minPrice !== null && item.price === minPrice;
      html.push(
        '<tr class="' +
          (isLowest ? "best" : "") +
          '">' +
          "<td>" +
          escapeHtml(item.no || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(item.airline || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(item.departTime || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(item.arriveTime || "—") +
          "</td>" +
          '<td class="numeric">' +
          escapeHtml(
            format.formatDuration(item.departTime || "", item.arriveTime || "")
          ) +
          "</td>" +
          '<td class="numeric">' +
          escapeHtml(priceText(item.price)) +
          (isLowest ? '<span class="badge">最低</span>' : "") +
          "</td>" +
          "</tr>"
      );
    });
    html.push("</tbody></table></div>");
    return html.join("");
  }

  function renderFlightTrends(route) {
    var history = isPlainObject(route.flightHistory) ? route.flightHistory : {};
    var rows = [];
    Object.keys(history).forEach(function (identity) {
      var series = history[identity];
      if (!isPlainObject(series)) return;
      var stats = model.summarizeSeries(series);
      if (!stats || !stats.count) return;
      rows.push({
        identity: identity,
        series: series,
        stats: stats,
        points: model.decodeSamples(series),
      });
    });
    if (!rows.length) return "";
    rows.sort(function (a, b) {
      return (
        String(a.series.departTime || "").localeCompare(
          String(b.series.departTime || "")
        ) || String(a.series.no || "").localeCompare(String(b.series.no || ""))
      );
    });

    var html = [
      '<h4 class="section-title">单航班价格趋势</h4>',
      '<p class="section-note">价格变化才会新增样本，价格不变时每小时最多一个点。</p>',
      '<div class="table-wrap"><table>',
      "<thead><tr><th>航班</th><th>航司</th><th>起降</th>" +
        '<th class="numeric">样本</th><th class="numeric">当前</th>' +
        '<th class="numeric">最低</th><th class="numeric">最高</th>' +
        '<th class="numeric">累计变化</th><th>走势</th></tr></thead><tbody>',
    ];
    rows.slice(0, MAX_TREND_ROWS).forEach(function (row) {
      var series = row.series;
      var stats = row.stats;
      var spark =
        row.points.length >= 2
          ? sparkline(row.points, { width: 120, height: 28, compact: true })
          : "—";
      html.push(
        "<tr>" +
          "<td>" +
          escapeHtml(series.no || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(series.airline || "—") +
          "</td>" +
          "<td>" +
          escapeHtml(
            (series.departTime || "—") + " → " + (series.arriveTime || "—")
          ) +
          "</td>" +
          '<td class="numeric">' +
          stats.count +
          "</td>" +
          '<td class="numeric">' +
          escapeHtml(priceText(stats.current)) +
          "</td>" +
          '<td class="numeric">' +
          escapeHtml(priceText(stats.min)) +
          "</td>" +
          '<td class="numeric">' +
          escapeHtml(priceText(stats.max)) +
          "</td>" +
          '<td class="numeric ' +
          deltaClass(stats.change) +
          '">' +
          escapeHtml(deltaText(stats.change) || "—") +
          "</td>" +
          "<td>" +
          spark +
          "</td>" +
          "</tr>"
      );
    });
    html.push("</tbody></table></div>");
    if (rows.length > MAX_TREND_ROWS) {
      html.push(
        '<p class="section-note">单航班趋势仅显示前 ' +
          MAX_TREND_ROWS +
          " 个航班，共 " +
          rows.length +
          " 个。</p>"
      );
    }
    return html.join("");
  }

  function renderRoute(entry, group, nowDate) {
    var route = entry.route;
    if (!isPlainObject(route)) return "";
    var isBest =
      isFiniteNumber(entry.currentPrice) &&
      isFiniteNumber(group.currentMin) &&
      entry.currentPrice === group.currentMin;
    var points = historyPoints(route);
    var chart = "";
    if (points.length >= 2) {
      var min = points[0].minPrice;
      var max = points[0].minPrice;
      for (var i = 1; i < points.length; i += 1) {
        if (points[i].minPrice < min) min = points[i].minPrice;
        if (points[i].minPrice > max) max = points[i].minPrice;
      }
      chart =
        '<div class="chart-box"><div class="chart-head"><span>航线最低价走势</span>' +
        "<span>最高 " +
        escapeHtml(priceText(max)) +
        " · 共 " +
        points.length +
        " 个样本</span></div>" +
        sparkline(points, { width: 640, height: 180 }) +
        "</div>";
    } else if (points.length === 1) {
      chart = '<p class="section-note">目前只有 1 个价格样本，再打开一次该页面后会形成走势。</p>';
    } else {
      chart = '<p class="section-note">还没有价格样本。</p>';
    }

    var url = safeCtripUrl(route.url);
    var link = url
      ? ' · <a href="' +
        escapeHtml(url) +
        '" target="_blank" rel="noopener noreferrer">在携程查看</a>'
      : "";
    var delta = model.historyDelta(route);
    var meta =
      "历史最低 " +
      escapeHtml(priceText(entry.historyMin)) +
      (isFiniteNumber(delta) ? " · 较上次 " + escapeHtml(deltaText(delta)) : "") +
      " · 最近记录 " +
      escapeHtml(timeText(entry.updatedAt, nowDate)) +
      (entry.flightCount ? " · " + entry.flightCount + " 班" : "") +
      link;

    return (
      '<section class="route-card">' +
      '<div class="route-head"><h3>' +
      escapeHtml(dateText(entry.date, nowDate)) +
      (weekdayText(entry.date) ? " " + weekdayText(entry.date) : "") +
      '</h3><span class="route-price">' +
      escapeHtml(priceText(entry.currentPrice)) +
      "</span>" +
      (isBest ? '<span class="badge">最低</span>' : "") +
      "</div>" +
      '<p class="route-meta">' +
      meta +
      "</p>" +
      chart +
      renderFlights(route) +
      renderFlightTrends(route) +
      "</section>"
    );
  }

  function renderGroup(group, nowDate, options) {
    var meta = [
      group.dates.length + " 个日期",
      "当前最低 " + priceText(group.currentMin),
      "历史最低 " + priceText(group.historyMin),
      group.lowestDate
        ? "最低日期 " + dateText(group.lowestDate, nowDate)
        : "",
      "最近记录 " + timeText(group.updatedAt, nowDate),
    ].filter(Boolean);

    var html = [
      '<section class="group-section">',
      "<h2>" +
        escapeHtml(group.originName || group.originCode || "") +
        " → " +
        escapeHtml(group.destName || group.destCode || "") +
        '<span class="cabin">' +
        escapeHtml(cabinText(group.cabin)) +
        "</span></h2>",
      '<p class="group-meta">' + escapeHtml(meta.join(" · ")) + "</p>",
      renderComparison(group, nowDate),
      renderMatrix(group, nowDate, options && options.maxMatrixRows),
    ];

    group.dates.forEach(function (entry) {
      html.push(renderRoute(entry, group, nowDate));
    });
    html.push("</section>");
    return html.join("");
  }

  function emptyState() {
    return (
      '<section class="empty-panel">' +
      "<p>本机还没有航班价格记录。</p>" +
      "<p>打开携程中国大陆国内单程航班列表页，等待自动采集完成后再导出报告。</p>" +
      "</section>"
    );
  }

  function buildReport(routesInput, options) {
    options = options || {};
    var routes =
      isPlainObject(routesInput) ? routesInput : {};
    var now = isFiniteNumber(options.now) ? options.now : Date.now();
    var nowDate = new Date(now);
    var groups = model.buildGroups(routes);
    var overview = model.buildOverview(routes);
    var maxMatrixRows =
      isFiniteNumber(options.maxMatrixRows) && options.maxMatrixRows > 0
        ? options.maxMatrixRows
        : MAX_MATRIX_ROWS;

    var content = groups.length
      ? groups
          .map(function (group) {
            return renderGroup(group, nowDate, { maxMatrixRows: maxMatrixRows });
          })
          .join("")
      : emptyState();

    return [
      "<!DOCTYPE html>",
      '<html lang="zh-CN">',
      "<head>",
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
      "<title>航班价格报告 · " +
        escapeHtml(format.formatTimestamp(now, nowDate)) +
        "</title>",
      "<style>" + STYLES + "</style>",
      "</head>",
      "<body>",
      '<div class="report">',
      renderHeader(overview, now, nowDate),
      "<main>",
      renderStats(overview, nowDate),
      content,
      "</main>",
      "<footer>",
      "由「航班价格记录簿」生成 · 非官方工具，与携程旅行网无隶属、合作或授权关系。",
      "<br>报告包含航线与日期信息，分享前请确认不涉及个人行程。",
      "</footer>",
      "</div>",
      "</body>",
      "</html>",
    ].join("\n");
  }

  var STYLES = [
    ":root{color-scheme:light}",
    "*{box-sizing:border-box}",
    'body{margin:0;background:#f4efe6;color:#23272a;font:14px/1.6 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}',
    ".report{max-width:1080px;margin:0 auto;padding:32px 24px 48px}",
    ".report-header{border-bottom:2px solid #d8cbb8;padding-bottom:18px;margin-bottom:24px}",
    ".header-top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}",
    ".eyebrow{margin:0 0 4px;color:#a9663f;font-size:12px;letter-spacing:.12em}",
    "h1{margin:0;font-size:30px;letter-spacing:.02em}",
    "h2{margin:0 0 6px;font-size:22px}",
    "h3{margin:22px 0 8px;font-size:16px}",
    "h4{margin:16px 0 6px;font-size:14px;color:#4b4f4a}",
    ".report-meta,.report-note{margin:8px 0 0;color:#5d615c;font-size:13px}",
    ".report-note{color:#7a6a58}",
    ".print-button{flex:none;border:1px solid #c9b79f;background:#fffaf2;color:#5b3a24;border-radius:8px;padding:7px 12px;font:inherit;font-size:13px;cursor:pointer}",
    ".print-button:hover{background:#f6ead9}",
    ".summary-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin:20px 0 28px}",
    ".summary-card{background:#fffaf2;border:1px solid #e3d8c8;border-radius:10px;padding:12px}",
    ".summary-card .label{margin:0;color:#7b7f79;font-size:12px}",
    ".summary-card .value{margin:2px 0 0;font-size:20px;font-weight:600}",
    ".summary-card .note{margin:2px 0 0;color:#8a8e88;font-size:11px}",
    ".group-section{background:#fffdf8;border:1px solid #e3d8c8;border-radius:14px;padding:20px 22px;margin-bottom:22px}",
    ".group-meta{margin:0;color:#5d615c;font-size:13px}",
    ".cabin{margin-left:8px;color:#a9663f;font-size:15px;font-weight:500}",
    ".section-title{margin-top:18px}",
    ".section-note{margin:4px 0 6px;color:#6b6f6a;font-size:12px}",
    ".table-wrap{overflow-x:auto;margin:6px 0 4px}",
    "table{width:100%;border-collapse:collapse;font-size:13px}",
    "th,td{padding:7px 9px;border-bottom:1px solid #eee4d6;text-align:left;white-space:nowrap}",
    "th{background:#f6efe4;color:#5d615c;font-size:12px;font-weight:600}",
    "tbody tr:nth-child(even){background:#fcf8f1}",
    "td.numeric,th.numeric{text-align:right;font-variant-numeric:tabular-nums}",
    "tr.best td{background:#fbf0df;font-weight:600}",
    ".badge{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:999px;background:#a9663f;color:#fff;font-size:11px;font-weight:600;vertical-align:middle}",
    ".sub{display:block;color:#8a8e88;font-size:11px;font-weight:400}",
    ".delta-up{color:#b54708}.delta-down{color:#067647}.delta-flat{color:#6b6f6a}",
    ".route-card{border-top:1px dashed #d8cbb8;margin-top:18px;padding-top:4px}",
    ".route-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}",
    ".route-head h3{margin:0}",
    ".route-price{font-size:22px;font-weight:700}",
    ".route-meta{margin:2px 0 8px;color:#5d615c;font-size:13px}",
    "a{color:#8a4b28}",
    ".chart-box{background:#fffaf2;border:1px solid #eee4d6;border-radius:10px;padding:10px 12px 6px;margin:8px 0 6px}",
    ".chart-head{display:flex;justify-content:space-between;gap:10px;color:#6b6f6a;font-size:12px}",
    ".chart-svg{display:block;width:100%;height:180px}",
    ".spark-mini{display:block;width:120px;height:28px}",
    ".chart-svg .grid{stroke:#e8ddcd;stroke-width:1}",
    ".chart-svg .area,.spark-mini .area{fill:rgba(169,102,63,.12);stroke:none}",
    ".chart-svg .line,.spark-mini .line{fill:none;stroke:#a9663f;stroke-width:2;vector-effect:non-scaling-stroke}",
    ".spark-mini .line{stroke-width:1.5}",
    ".chart-svg .dot,.spark-mini .dot{fill:#7a4a2b}",
    ".empty-panel{padding:18px;border:1px dashed #d8cbb8;border-radius:10px;background:#fffaf2;color:#6b6f6a}",
    ".empty-panel p{margin:4px 0}",
    "footer{margin-top:28px;padding-top:14px;border-top:1px solid #e3d8c8;color:#7b7f79;font-size:12px}",
    "@media(max-width:900px){.summary-grid{grid-template-columns:repeat(3,1fr)}}",
    "@media(max-width:560px){.summary-grid{grid-template-columns:repeat(2,1fr)}.report{padding:20px 14px 32px}.header-top{flex-direction:column}.print-button{align-self:flex-start}}",
    "@page{size:A4 landscape;margin:10mm}",
    "@media print{body{background:#fff;font-size:12px}.report{max-width:none;padding:0}.print-button{display:none}th,td{padding:5px 7px}.group-section{border:1px solid #ddd;box-shadow:none}.route-card,.chart-box,table{break-inside:avoid}.table-wrap{overflow:visible}a{color:inherit;text-decoration:none}.group-section+.group-section{break-before:page}}",
  ].join("");

  return {
    buildReport: buildReport,
    escapeHtml: escapeHtml,
    sparkline: sparkline,
    STYLES: STYLES,
  };
});
