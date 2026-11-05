(function () {
  "use strict";

  var ROUTES_KEY = "ctripRoutes";
  var MAX_MATRIX_ROWS = 30;
  var MAX_HISTORY_ROWS = 80;

  var format = window.CtripFormat;
  var model = window.CtripModel;
  var chart = window.CtripChart;

  var refs = {
    summary: document.getElementById("summary"),
    groupSelect: document.getElementById("groupSelect"),
    dateChips: document.getElementById("dateChips"),
    dateHint: document.getElementById("dateHint"),
    dateOverview: document.getElementById("dateOverview"),
    trendBody: document.getElementById("trendBody"),
    matrix: document.getElementById("matrix"),
    comparison: document.getElementById("comparison"),
    refreshButton: document.getElementById("refreshButton"),
  };

  var routes = {};
  var groups = [];
  var currentGroupKey = null;
  var currentDate = null;
  var currentSeriesId = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function clear(node) {
    if (node) node.textContent = "";
  }

  function price(value) {
    return typeof value === "number" && isFinite(value)
      ? format.formatPrice(value)
      : "—";
  }

  function deltaText(value) {
    if (typeof value !== "number" || !isFinite(value)) return "";
    return format.formatDelta(value, 0);
  }

  function deltaClass(value) {
    if (typeof value !== "number" || !isFinite(value)) return "";
    if (value > 0) return "delta-up";
    if (value < 0) return "delta-down";
    return "delta-flat";
  }

  function dateText(value) {
    return value ? format.formatDateLabel(value) : "—";
  }

  function timeText(value) {
    return typeof value === "number" && isFinite(value)
      ? format.formatTimestamp(value)
      : "—";
  }

  function groupLabel(group) {
    return (
      (group.originName || group.originCode) +
      " → " +
      (group.destName || group.destCode) +
      " · " +
      format.formatCabin(group.cabin)
    );
  }

  function selectedGroup() {
    for (var i = 0; i < groups.length; i += 1) {
      if (groups[i].key === currentGroupKey) return groups[i];
    }
    return null;
  }

  function selectedDateEntry(group) {
    if (!group) return null;
    for (var i = 0; i < group.dates.length; i += 1) {
      if (group.dates[i].date === currentDate) return group.dates[i];
    }
    return group.dates[0] || null;
  }

  function renderSummary(overview) {
    clear(refs.summary);
    var cards = [
      { label: "航线", value: overview.routeCount, note: "有价格记录的日期" },
      { label: "城市对", value: overview.groupCount, note: "按出发地/目的地/舱位分组" },
      { label: "追踪航班", value: overview.flightCount, note: "已形成价格序列的航班" },
      { label: "价格样本", value: overview.sampleCount, note: "每班最近 240 个点" },
      {
        label: "最近记录",
        value: overview.latestUpdatedAt
          ? format.formatTimestamp(overview.latestUpdatedAt)
          : "—",
        note: "本机时间",
      },
      {
        label: "存储估算",
        value: overview.estimatedBytes
          ? Math.max(1, Math.round(overview.estimatedBytes / 1024)) + " KB"
          : "0 KB",
        note: "大致占用，非精确值",
      },
    ];

    cards.forEach(function (card) {
      var box = el("div", "summary-card");
      box.appendChild(el("p", "summary-label", card.label));
      box.appendChild(el("p", "summary-value", String(card.value)));
      box.appendChild(el("p", "summary-note", card.note));
      refs.summary.appendChild(box);
    });
  }

  function renderGroupSelect() {
    clear(refs.groupSelect);
    if (!groups.length) {
      refs.groupSelect.disabled = true;
      refs.groupSelect.appendChild(el("option", "", "暂无航线"));
      return;
    }
    refs.groupSelect.disabled = false;
    groups.forEach(function (group) {
      var option = document.createElement("option");
      option.value = group.key;
      option.textContent = groupLabel(group);
      refs.groupSelect.appendChild(option);
    });
    refs.groupSelect.value = currentGroupKey;
  }

  function renderDateChips(group) {
    clear(refs.dateChips);
    if (!group) return;
    group.dates.forEach(function (entry) {
      var button = el(
        "button",
        "date-chip" + (entry.date === currentDate ? " is-active" : ""),
        dateText(entry.date)
      );
      button.type = "button";
      button.addEventListener("click", function () {
        currentDate = entry.date;
        currentSeriesId = null;
        renderGroupViews();
      });
      refs.dateChips.appendChild(button);
    });
  }

  function renderDateOverview(group) {
    clear(refs.dateOverview);
    if (!group) {
      refs.dateOverview.appendChild(el("div", "empty-panel", "暂无航线数据"));
      return;
    }

    refs.dateHint.textContent =
      group.dates.length > 1
        ? "共 " + group.dates.length + " 个日期，最低价日期为 " + dateText(group.lowestDate)
        : "只有一个日期，再打开另一个日期后可以对比";

    var wrap = el("div", "date-overview");
    group.dates.forEach(function (entry) {
      var card = el(
        "button",
        "date-card" + (entry.date === currentDate ? " is-active" : "")
      );
      card.type = "button";
      if (entry.date === group.lowestDate) card.classList.add("is-best");

      var top = el("div", "date-card-top");
      var title = el("span", "date-card-date", dateText(entry.date));
      if (entry.date === group.lowestDate) {
        title.appendChild(el("span", "best-badge", "最低"));
      }
      top.appendChild(title);
      top.appendChild(el("span", "date-card-price", price(entry.currentPrice)));
      card.appendChild(top);

      var meta = el("div", "date-card-meta");
      meta.appendChild(el("span", "", "历史最低 " + price(entry.historyMin)));
      meta.appendChild(el("span", "", "记录 " + entry.flightCount + " 班"));
      if (entry.seriesCount) {
        meta.appendChild(el("span", "", entry.seriesCount + " 个航班序列"));
      }
      if (entry.delta !== null) {
        meta.appendChild(
          el("span", deltaClass(entry.delta), "较上次 " + deltaText(entry.delta))
        );
      }
      card.appendChild(meta);

      card.addEventListener("click", function () {
        currentDate = entry.date;
        currentSeriesId = null;
        renderGroupViews();
      });
      wrap.appendChild(card);
    });

    refs.dateOverview.appendChild(wrap);
  }

  function renderComparison(group) {
    clear(refs.comparison);
    if (!group || !group.dates.length) {
      refs.comparison.appendChild(el("div", "empty-panel", "暂无日期数据"));
      return;
    }

    var comparison = model.buildComparison(group);
    var wrap = el("div", "table-wrap");
    var table = el("table", "data-table");
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    ["日期", "当前最低", "历史最低", "较上次", "比组内最低", "最低航班", "航班数", "最近记录"].forEach(
      function (label, index) {
        var th = document.createElement("th");
        th.textContent = label;
        if (index >= 1 && index <= 4) th.className = "numeric";
        headRow.appendChild(th);
      }
    );
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    comparison.rows.forEach(function (row) {
      var tr = document.createElement("tr");
      if (row.isBest) tr.className = "is-best-row";
      var cells = [
        dateText(row.date),
        price(row.currentPrice),
        price(row.historyMin),
        deltaText(row.delta) || "—",
        row.isBest ? "最低" : row.fromBest === null ? "—" : "+" + price(row.fromBest),
        row.cheapestFlight || "—",
        String(row.flightCount),
        timeText(row.updatedAt),
      ];
      cells.forEach(function (text, index) {
        var td = document.createElement("td");
        td.textContent = text;
        if (index >= 1 && index <= 4) td.className = "numeric";
        if (index === 1 && row.isBest) td.classList.add("best-cell");
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    refs.comparison.appendChild(wrap);
  }

  function findSeries(list, date, identity) {
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].date === date && list[i].identity === identity) return list[i];
    }
    return null;
  }

  function selectFlight(date, identity) {
    currentDate = date;
    currentSeriesId = identity;
    renderGroupViews();
  }

  function renderMatrix(group) {
    clear(refs.matrix);
    if (!group) {
      refs.matrix.appendChild(el("div", "empty-panel", "暂无航班数据"));
      return;
    }

    var matrix = model.buildMatrix(group, { maxRows: MAX_MATRIX_ROWS });
    if (!matrix.rows.length) {
      refs.matrix.appendChild(el("div", "empty-panel", "暂无当前航班价格"));
      return;
    }

    var wrap = el("div", "matrix-wrap");
    var table = el("table", "matrix-table");
    var thead = document.createElement("thead");
    var headRow = document.createElement("tr");
    var flightHead = document.createElement("th");
    flightHead.textContent = "航班";
    headRow.appendChild(flightHead);
    matrix.dates.forEach(function (date) {
      var th = document.createElement("th");
      th.textContent = dateText(date.date);
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    matrix.rows.forEach(function (row) {
      var tr = document.createElement("tr");
      var flightCell = document.createElement("td");
      var flightBox = el("div", "matrix-flight");
      var name = document.createElement("strong");
      name.textContent = row.no || "—";
      flightBox.appendChild(name);
      flightBox.appendChild(
        el(
          "span",
          "",
          (row.airline || "") +
            (row.departTime ? " · " + row.departTime + "→" + row.arriveTime : "")
        )
      );
      flightCell.appendChild(flightBox);
      flightCell.addEventListener("click", function () {
        for (var i = 0; i < matrix.dates.length; i += 1) {
          if (row.prices[matrix.dates[i].date] !== undefined) {
            selectFlight(matrix.dates[i].date, row.identity);
            return;
          }
        }
      });
      tr.appendChild(flightCell);

      matrix.dates.forEach(function (date) {
        var td = document.createElement("td");
        var value = row.prices[date.date];
        if (value === undefined) {
          td.className = "matrix-missing";
          td.textContent = "—";
        } else {
          var button = el("button", "matrix-price matrix-price-button", price(value));
          button.type = "button";
          button.addEventListener("click", function () {
            selectFlight(date.date, row.identity);
          });
          td.appendChild(button);
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    refs.matrix.appendChild(wrap);

    if (matrix.hiddenCount > 0) {
      refs.matrix.appendChild(
        el(
          "p",
          "matrix-more",
          "仅显示覆盖日期最多的 " + matrix.rows.length + " 行，共 " + matrix.totalRows + " 行"
        )
      );
    }
  }

  function seriesLabel(entry) {
    return (
      dateText(entry.date) +
      " · " +
      (entry.no || "航班") +
      (entry.departTime ? " " + entry.departTime + "→" + entry.arriveTime : "") +
      (entry.airline ? " · " + entry.airline : "")
    );
  }

  function buildTrendStats(stats) {
    var wrap = el("div", "trend-stats");
    [
      ["当前", stats.current],
      ["最低", stats.min],
      ["最高", stats.max],
      ["累计变化", stats.change],
    ].forEach(function (item) {
      var box = el("div", "trend-stat");
      box.appendChild(el("span", "", item[0]));
      if (item[0] === "累计变化") {
        var strong = el("strong", deltaClass(item[1]), deltaText(item[1]) || "—");
        box.appendChild(strong);
      } else {
        box.appendChild(el("strong", "", price(item[1])));
      }
      wrap.appendChild(box);
    });
    return wrap;
  }

  function buildHistoryTable(points) {
    var wrap = el("div", "table-wrap");
    var table = el("table", "data-table");
    var thead = document.createElement("thead");
    var head = document.createElement("tr");
    ["时间", "价格", "较上次"].forEach(function (label, index) {
      var th = document.createElement("th");
      th.textContent = label;
      if (index > 0) th.className = "numeric";
      head.appendChild(th);
    });
    thead.appendChild(head);
    table.appendChild(thead);

    var tbody = document.createElement("tbody");
    var list = points.slice(-MAX_HISTORY_ROWS).reverse();
    list.forEach(function (point, index) {
      var previous =
        index + 1 < list.length ? list[index + 1].minPrice : null;
      var tr = document.createElement("tr");
      var time = document.createElement("td");
      time.textContent = format.formatTimestamp(point.t);
      tr.appendChild(time);
      var p = document.createElement("td");
      p.className = "numeric";
      p.textContent = price(point.minPrice);
      tr.appendChild(p);
      var change = document.createElement("td");
      change.className = "numeric " + deltaClass(
        previous === null ? null : point.minPrice - previous
      );
      change.textContent =
        previous === null ? "—" : deltaText(point.minPrice - previous);
      tr.appendChild(change);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  function renderTrend(group) {
    clear(refs.trendBody);
    if (!group) {
      refs.trendBody.appendChild(el("div", "empty-panel", "暂无航班数据"));
      return;
    }

    var seriesList = model.buildSeriesList(group);
    var seriesEntry = null;
    if (currentSeriesId) {
      for (var i = 0; i < seriesList.length; i += 1) {
        if (
          seriesList[i].identity === currentSeriesId &&
          seriesList[i].date === currentDate
        ) {
          seriesEntry = seriesList[i];
          break;
        }
      }
      if (!seriesEntry) currentSeriesId = null;
    }

    if (!seriesEntry) {
      // 默认选中当天当前价最低的航班；同价再按起飞时间排序。
      var dateSeries = seriesList.filter(function (entry) {
        return entry.date === currentDate;
      });
      dateSeries.sort(function (a, b) {
        var aPrice =
          a.stats && typeof a.stats.current === "number"
            ? a.stats.current
            : Infinity;
        var bPrice =
          b.stats && typeof b.stats.current === "number"
            ? b.stats.current
            : Infinity;
        if (aPrice !== bPrice) return aPrice - bPrice;
        return String(a.departTime).localeCompare(String(b.departTime));
      });
      seriesEntry = dateSeries[0] || null;
    }

    if (seriesList.length) {
      var controls = el("div", "trend-controls");
      var select = document.createElement("select");
      select.setAttribute("aria-label", "选择航班");
      var hasDateSeries = seriesList.some(function (entry) {
        return entry.date === currentDate;
      });
      if (!hasDateSeries) {
        var placeholder = document.createElement("option");
        placeholder.value = "";
        placeholder.textContent = "当前日期暂无每班历史";
        select.appendChild(placeholder);
      }
      seriesList.forEach(function (entry) {
        var option = document.createElement("option");
        option.value = entry.identity + "@@" + entry.date;
        option.textContent = seriesLabel(entry);
        select.appendChild(option);
      });
      select.value = seriesEntry
        ? seriesEntry.identity + "@@" + seriesEntry.date
        : "";
      select.addEventListener("change", function () {
        if (!select.value) return;
        var parts = select.value.split("@@");
        currentSeriesId = parts[0];
        currentDate = parts[1];
        renderGroupViews();
      });
      controls.appendChild(select);
      refs.trendBody.appendChild(controls);
    }

    var currentEntry = selectedDateEntry(group);
    var routeEntry = currentEntry;
    var points = [];
    var stats = null;
    var note = "";

    if (seriesEntry) {
      points = model.decodeSamples(seriesEntry.series);
      stats = seriesEntry.stats;
    } else if (routeEntry && routeEntry.route.history) {
      points = routeEntry.route.history
        .filter(function (point) {
          return point && typeof point.minPrice === "number";
        })
        .map(function (point) {
          return { t: point.t, minPrice: point.minPrice };
        });
      stats = {
        current: routeEntry.currentPrice,
        min: routeEntry.historyMin,
        max: points.length
          ? Math.max.apply(null, points.map(function (point) { return point.minPrice; }))
          : null,
        change: routeEntry.delta,
      };
      note =
        "这个日期还没有每班价格历史，当前显示航线最低价；再打开一次航班页后会开始记录每班价格。";
    }

    if (note) {
      refs.trendBody.appendChild(el("div", "empty-panel", note));
    }

    if (!points.length) {
      refs.trendBody.appendChild(
        el("div", "empty-panel", "还没有价格样本，打开携程航班列表页并等待采集即可。")
      );
      return;
    }

    if (!stats) {
      stats = { current: null, min: null, max: null, change: null };
    }
    refs.trendBody.appendChild(buildTrendStats(stats));
    var chartBox = el("div", "trend-chart");
    refs.trendBody.appendChild(chartBox);
    var width = Math.max(320, refs.trendBody.clientWidth || 720);
    chartBox.appendChild(chart.buildLineChart(points, width - 4, 220));
    refs.trendBody.appendChild(buildHistoryTable(points));
  }

  function renderGroupViews() {
    var group = selectedGroup();
    if (!group) {
      clear(refs.dateChips);
      refs.dateHint.textContent = "";
      clear(refs.dateOverview);
      refs.dateOverview.appendChild(el("div", "empty-panel", "暂无航线数据"));
      clear(refs.trendBody);
      refs.trendBody.appendChild(el("div", "empty-panel", "暂无航班数据"));
      clear(refs.matrix);
      refs.matrix.appendChild(el("div", "empty-panel", "暂无航班数据"));
      clear(refs.comparison);
      refs.comparison.appendChild(el("div", "empty-panel", "暂无日期数据"));
      return;
    }

    if (!currentDate) currentDate = group.dates[0] ? group.dates[0].date : null;
    var foundDate = false;
    for (var i = 0; i < group.dates.length; i += 1) {
      if (group.dates[i].date === currentDate) foundDate = true;
    }
    if (!foundDate) currentDate = group.dates[0] ? group.dates[0].date : null;

    renderDateChips(group);
    renderDateOverview(group);
    renderComparison(group);
    renderMatrix(group);
    renderTrend(group);
  }

  function renderAll() {
    groups = model.buildGroups(routes);
    if (!groups.length) {
      currentGroupKey = null;
      currentDate = null;
      currentSeriesId = null;
    } else {
      var found = false;
      for (var i = 0; i < groups.length; i += 1) {
        if (groups[i].key === currentGroupKey) found = true;
      }
      if (!found) {
        currentGroupKey = groups[0].key;
        currentDate = groups[0].dates[0] ? groups[0].dates[0].date : null;
        currentSeriesId = null;
      }
    }

    renderSummary(model.buildOverview(routes));
    renderGroupSelect();
    renderGroupViews();
  }

  function renderError(message) {
    clear(refs.summary);
    clear(refs.dateOverview);
    clear(refs.trendBody);
    clear(refs.matrix);
    clear(refs.comparison);
    var box = el("div", "empty-panel", "加载数据失败：" + message);
    refs.dateOverview.appendChild(box);
  }

  function load() {
    return chrome.storage.local.get([ROUTES_KEY]).then(function (data) {
      routes =
        data && data[ROUTES_KEY] && typeof data[ROUTES_KEY] === "object"
          ? data[ROUTES_KEY]
          : {};
      renderAll();
    });
  }

  refs.groupSelect.addEventListener("change", function () {
    currentGroupKey = refs.groupSelect.value;
    currentDate = null;
    currentSeriesId = null;
    renderGroupViews();
  });

  refs.refreshButton.addEventListener("click", function () {
    load().catch(function (error) {
      renderError(error && error.message ? error.message : String(error));
    });
  });

  if (chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName && areaName !== "local") return;
      if (changes && changes[ROUTES_KEY]) {
        routes = changes[ROUTES_KEY].newValue || {};
        renderAll();
      }
    });
  }

  globalThis.__dashboardReady = load().catch(function (error) {
    renderError(error && error.message ? error.message : String(error));
  });
})();
