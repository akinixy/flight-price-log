(function () {
  "use strict";

  var ROUTES_KEY = "ctripRoutes";
  var DELETED_KEY = "ctripDeleted";
  var CLEARED_KEY = "ctripClearedAt";
  var SETTINGS_KEY = "ctripSettings";
  var CONFIRM_RESET_MS = 3000;
  var FLIGHT_LIMIT = 10;
  var SORT_MODES = [
    { key: "price", label: "价格" },
    { key: "duration", label: "用时" },
    { key: "depart", label: "起飞" },
  ];
  var ROUTE_SORT_MODES = [
    { key: "updated", label: "最近更新" },
    { key: "price", label: "当前最低价" },
    { key: "date", label: "出发日期" },
  ];
  var EMPTY_TEXT = "打开携程航班列表页后，这里会自动出现价格记录";
  var CTRIP_URL = "https://flights.ctrip.com/";

  var app = document.getElementById("app");
  var currentRoutes = {};

  // 弹窗重渲染时保持用户的展开状态和排序选择。
  var expandedKeys = Object.create(null);
  var flightSortState = Object.create(null);
  var routeSort = "updated";
  var autoCollectEnabled = true;

  var pendingDeleteKey = null;
  var pendingDeleteButton = null;
  var deleteTimer = null;

  var pendingClear = false;
  var pendingClearButton = null;
  var clearTimer = null;

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function isFiniteNumber(value) {
    return typeof value === "number" && isFinite(value);
  }

  function formatPrice(value) {
    return isFiniteNumber(value) ? CtripFormat.formatPrice(value) : "—";
  }

  function formatDateLabel(value) {
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return CtripFormat.formatDateLabel(value);
    }
    return value || "—";
  }

  function formatTimestamp(value) {
    return isFiniteNumber(value) ? CtripFormat.formatTimestamp(value) : "—";
  }

  function getHistory(route) {
    return route && Array.isArray(route.history) ? route.history : [];
  }

  function historyMinPrice(route) {
    var history = getHistory(route);
    var min = null;
    for (var i = 0; i < history.length; i += 1) {
      var point = history[i];
      if (!point || !isFiniteNumber(point.minPrice)) continue;
      if (min === null || point.minPrice < min) min = point.minPrice;
    }
    if (min === null && route && route.latest && isFiniteNumber(route.latest.minPrice)) {
      min = route.latest.minPrice;
    }
    return min;
  }

  function getLatest(route) {
    return route && route.latest && typeof route.latest === "object"
      ? route.latest
      : {};
  }

  function routeTitle(route) {
    var origin = route.originName || route.originCode || "未知";
    var dest = route.destName || route.destCode || "未知";
    return origin + " → " + dest + " · " + formatDateLabel(route.departDate);
  }

  function deltaText(route, latest) {
    var history = getHistory(route);
    if (history.length < 2) return "首次记录";
    var previous = history[history.length - 2];
    if (
      !previous ||
      !isFiniteNumber(previous.minPrice) ||
      !isFiniteNumber(latest.minPrice)
    ) {
      return "";
    }
    return "较上次 " + CtripFormat.formatDelta(latest.minPrice, previous.minPrice);
  }

  function deltaClass(route, latest) {
    var history = getHistory(route);
    if (history.length < 2) return "delta-first";
    var previous = history[history.length - 2];
    if (
      !previous ||
      !isFiniteNumber(previous.minPrice) ||
      !isFiniteNumber(latest.minPrice)
    ) {
      return "delta-flat";
    }
    if (latest.minPrice > previous.minPrice) return "delta-up";
    if (latest.minPrice < previous.minPrice) return "delta-down";
    return "delta-flat";
  }

  function transfersLabel(transfers) {
    if (!isFiniteNumber(transfers)) return "—";
    return transfers === 0 ? "直飞" : transfers + "次中转";
  }

  function safeText(value) {
    return value === undefined || value === null || value === ""
      ? "—"
      : String(value);
  }

  function routePrice(route) {
    var latest = getLatest(route);
    return isFiniteNumber(latest.minPrice) ? latest.minPrice : Infinity;
  }

  function sortRoutes(routes) {
    var entries = [];
    Object.keys(routes).forEach(function (storageKey) {
      var route = routes[storageKey];
      if (route && typeof route === "object") {
        entries.push({ storageKey: storageKey, route: route });
      }
    });
    entries.sort(function (a, b) {
      if (routeSort === "price") {
        var pa = routePrice(a.route);
        var pb = routePrice(b.route);
        if (pa !== pb) return pa - pb;
      } else if (routeSort === "date") {
        var da = String(a.route.departDate || "");
        var db = String(b.route.departDate || "");
        if (da !== db) return da < db ? -1 : 1;
      }

      var aTime = isFiniteNumber(a.route.updatedAt) ? a.route.updatedAt : 0;
      var bTime = isFiniteNumber(b.route.updatedAt) ? b.route.updatedAt : 0;
      return bTime - aTime;
    });
    return entries;
  }

  function buildHeader() {
    var header = el("header", "popup-header");
    var title = el("h1", "popup-title", "航班价格记录簿");
    header.appendChild(title);
    // 通用入口放在头部常驻，有记录时不用滚到列表底部才能找到。
    header.appendChild(buildCtripLink("header-link"));
    return header;
  }

  function buildFooter() {
    return el("footer", "popup-footer", "数据仅保存在本机浏览器");
  }

  function buildRouteToolbar() {
    var bar = el("div", "route-toolbar");
    bar.appendChild(el("span", "route-toolbar-label", "航线排序"));

    var select = el("select", "route-sort-select");
    select.setAttribute("aria-label", "航线排序");
    ROUTE_SORT_MODES.forEach(function (mode) {
      var option = document.createElement("option");
      option.value = mode.key;
      option.textContent = mode.label;
      select.appendChild(option);
    });
    select.value = routeSort;
    select.addEventListener("change", function () {
      routeSort = select.value;
      render(currentRoutes);
    });
    bar.appendChild(select);
    return bar;
  }

  function buildSettings() {
    var row = el("div", "settings-row");
    var label = el("label", "setting-label");
    var input = document.createElement("input");
    input.type = "checkbox";
    input.className = "setting-checkbox";
    input.setAttribute("data-setting", "auto-collect");
    input.checked = autoCollectEnabled;
    input.addEventListener("change", function () {
      autoCollectEnabled = input.checked;
      saveSettings({ autoCollect: autoCollectEnabled });
    });
    label.appendChild(input);
    label.appendChild(document.createTextNode("自动采集全部航班"));
    row.appendChild(label);
    return row;
  }

  function exportData() {
    var payload = {
      app: "flight-price-log",
      version: 1,
      exportedAt: Date.now(),
      routes: currentRoutes,
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download =
      "flight-prices-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function handleImportFile(event) {
    var file = event.target.files && event.target.files[0];
    if (!file) return;

    var reader = new FileReader();
    reader.onload = function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (error) {
        showError(new Error("备份文件不是有效的 JSON"));
        return;
      }

      var validated = CtripBackup.validateBackup(parsed);
      if (!validated.ok) {
        showError(new Error(validated.error));
        return;
      }

      var next = CtripBackup.mergeRoutes(currentRoutes, validated.routes);
      chrome.storage.local.set({ ctripRoutes: next }).then(
        function () {
          render(next);
        },
        showError
      );
    };
    reader.onerror = function () {
      showError(new Error("读取备份文件失败"));
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  function buildDataActions() {
    var row = el("div", "data-actions");

    var exportButton = el("button", "button data-button", "导出数据");
    exportButton.type = "button";
    exportButton.setAttribute("data-action", "export");
    exportButton.addEventListener("click", exportData);
    row.appendChild(exportButton);

    var importButton = el("button", "button data-button", "导入数据");
    importButton.type = "button";
    importButton.setAttribute("data-action", "import");
    var fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "application/json,.json";
    fileInput.className = "import-input";
    fileInput.setAttribute("data-action", "import-file");
    fileInput.hidden = true;
    fileInput.addEventListener("change", handleImportFile);
    importButton.addEventListener("click", function () {
      fileInput.click();
    });
    row.appendChild(importButton);
    row.appendChild(fileInput);

    return row;
  }

  async function saveSettings(patch) {
    try {
      var data = await chrome.storage.local.get(SETTINGS_KEY);
      var current = data && data[SETTINGS_KEY] ? data[SETTINGS_KEY] : {};
      var payload = {};
      payload[SETTINGS_KEY] = Object.assign({}, current, patch);
      await chrome.storage.local.set(payload);
    } catch (error) {
      showError(error);
    }
  }

  // 空状态使用的携程入口链接。
  function buildCtripLink(className) {
    var link = el("a", className, "前往携程航班列表");
    link.setAttribute("href", CTRIP_URL);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    return link;
  }

  function buildEmptyView() {
    var view = el("div", "empty-view");
    view.appendChild(el("p", "empty-state", EMPTY_TEXT));
    return view;
  }

  function buildFlightRow(flight, isLowest) {
    var data = flight && typeof flight === "object" ? flight : {};
    var row = el("li", "flight-row");

    var main = el("div", "flight-main");
    main.appendChild(el("span", "flight-code", safeText(data.no)));
    if (isLowest) main.appendChild(el("span", "flight-badge", "最低"));
    main.appendChild(
      el(
        "span",
        "flight-time",
        safeText(data.departTime) + " → " + safeText(data.arriveTime)
      )
    );
    row.appendChild(main);

    var sub = el("div", "flight-sub");
    var subParts = [];
    var airline = safeText(data.airline);
    if (airline !== "—") subParts.push(airline);
    subParts.push(transfersLabel(data.transfers));
    sub.appendChild(el("span", "flight-meta", subParts.join(" · ")));

    var right = el("span", "flight-right");
    right.appendChild(
      el(
        "span",
        "flight-duration",
        CtripFormat.formatDuration(data.departTime, data.arriveTime)
      )
    );
    right.appendChild(el("span", "flight-price", formatPrice(data.price)));
    sub.appendChild(right);
    row.appendChild(sub);

    return row;
  }

  function buildFlightTable(latest, storageKey) {
    var wrap = el("div", "flight-list-wrap");
    var list = el("ul", "flight-list");

    var allFlights =
      latest && Array.isArray(latest.flights) ? latest.flights : [];
    var saved = flightSortState[storageKey] || {};
    var sortMode =
      saved.mode === "duration" || saved.mode === "depart" ? saved.mode : "price";
    var sortDirection = saved.direction === "desc" ? "desc" : "asc";
    var expanded = false;
    var toggle = null;
    var sortButtons = {};
    var directionButton = null;

    var lowestPrice = null;
    allFlights.forEach(function (flight) {
      if (!isFiniteNumber(flight.price) || flight.price <= 0) return;
      if (lowestPrice === null || flight.price < lowestPrice) {
        lowestPrice = flight.price;
      }
    });

    function compareFlights(a, b) {
      var primary = 0;
      if (sortMode === "duration") {
        primary =
          CtripFormat.durationMinutes(a.departTime, a.arriveTime) -
          CtripFormat.durationMinutes(b.departTime, b.arriveTime);
      } else if (sortMode === "depart") {
        primary =
          CtripFormat.clockMinutes(a.departTime) -
          CtripFormat.clockMinutes(b.departTime);
      } else {
        primary =
          (isFiniteNumber(a.price) ? a.price : Infinity) -
          (isFiniteNumber(b.price) ? b.price : Infinity);
      }
      if (primary !== 0) {
        return sortDirection === "desc" ? -primary : primary;
      }

      var pa = isFiniteNumber(a.price) ? a.price : Infinity;
      var pb = isFiniteNumber(b.price) ? b.price : Infinity;
      if (pa !== pb) return pa - pb;

      var xa = CtripFormat.clockMinutes(a.departTime);
      var xb = CtripFormat.clockMinutes(b.departTime);
      if (xa !== xb) return xa - xb;
      return String(a.no || "").localeCompare(String(b.no || ""));
    }

    function sortedFlights() {
      return allFlights.slice().sort(compareFlights);
    }

    function renderRows() {
      list.textContent = "";
      var sorted = sortedFlights();
      var visible = expanded ? sorted : sorted.slice(0, FLIGHT_LIMIT);

      if (visible.length === 0) {
        list.appendChild(el("li", "flight-empty", "暂无航班明细"));
        return;
      }

      visible.forEach(function (flight) {
        list.appendChild(
          buildFlightRow(
            flight,
            lowestPrice !== null && flight.price === lowestPrice
          )
        );
      });
    }

    function saveSortState() {
      flightSortState[storageKey] = {
        mode: sortMode,
        direction: sortDirection,
      };
    }

    function updateSortUI() {
      Object.keys(sortButtons).forEach(function (key) {
        var active = key === sortMode;
        sortButtons[key].classList.toggle("is-active", active);
        sortButtons[key].setAttribute("aria-pressed", active ? "true" : "false");
      });
      if (directionButton) {
        directionButton.textContent = sortDirection === "desc" ? "↓" : "↑";
        directionButton.setAttribute(
          "aria-label",
          sortDirection === "desc" ? "降序" : "升序"
        );
      }
    }

    function setSort(mode) {
      sortMode = mode;
      saveSortState();
      updateSortUI();
      renderRows();
    }

    function toggleDirection() {
      sortDirection = sortDirection === "desc" ? "asc" : "desc";
      saveSortState();
      updateSortUI();
      renderRows();
    }

    if (allFlights.length > 1) {
      var sortBar = el("div", "flight-sort");
      sortBar.appendChild(el("span", "flight-sort-label", "航班排序"));
      SORT_MODES.forEach(function (mode) {
        var button = el("button", "sort-button", mode.label);
        button.type = "button";
        button.setAttribute("data-sort", mode.key);
        button.setAttribute(
          "aria-pressed",
          mode.key === sortMode ? "true" : "false"
        );
        if (mode.key === sortMode) button.classList.add("is-active");
        button.addEventListener("click", function () {
          setSort(mode.key);
        });
        sortButtons[mode.key] = button;
        sortBar.appendChild(button);
      });

      directionButton = el(
        "button",
        "sort-direction",
        sortDirection === "desc" ? "↓" : "↑"
      );
      directionButton.type = "button";
      directionButton.setAttribute("data-action", "sort-direction");
      directionButton.setAttribute(
        "aria-label",
        sortDirection === "desc" ? "降序" : "升序"
      );
      directionButton.addEventListener("click", toggleDirection);
      sortBar.appendChild(directionButton);

      wrap.appendChild(sortBar);
    }

    if (allFlights.length > FLIGHT_LIMIT) {
      toggle = el("button", "flight-table-toggle");
      toggle.type = "button";
      toggle.setAttribute("data-action", "show-all-flights");
      toggle.textContent = "显示全部 " + allFlights.length + " 条";
      toggle.addEventListener("click", function () {
        expanded = !expanded;
        renderRows();
        toggle.textContent = expanded
          ? "收起"
          : "显示全部 " + allFlights.length + " 条";
      });
    }

    renderRows();
    wrap.appendChild(list);
    if (toggle) wrap.appendChild(toggle);
    return wrap;
  }

  function buildDetails(route, latest, detailsId, storageKey, isExpanded) {
    var details = el("div", "details");
    details.id = detailsId;
    details.hidden = !isExpanded;

    var linkRow = el("div", "link-row");
    var link = el("a", "ctrip-link", "打开本航线页面");
    link.setAttribute("href", typeof route.url === "string" ? route.url : CTRIP_URL);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    linkRow.appendChild(link);
    details.appendChild(linkRow);

    details.appendChild(el("div", "details-title", "航班明细"));
    details.appendChild(buildFlightTable(latest, storageKey));
    return details;
  }

  function buildRouteCard(storageKey, route, index) {
    var card = el("article", "route-card");
    if (typeof route.key === "string") card.setAttribute("data-key", route.key);

    var latest = getLatest(route);

    var head = el("div", "route-head");
    var titleRow = el("div", "route-title-row");
    titleRow.appendChild(el("h2", "route-title", routeTitle(route)));
    titleRow.appendChild(
      el("span", "cabin-tag", CtripFormat.formatCabin(route.cabin || ""))
    );
    head.appendChild(titleRow);

    var priceRow = el("div", "price-row");
    priceRow.appendChild(el("span", "current-price", formatPrice(latest.minPrice)));
    priceRow.appendChild(
      el("span", "delta " + deltaClass(route, latest), deltaText(route, latest))
    );
    head.appendChild(priceRow);
    card.appendChild(head);

    var meta = el("div", "meta-row");
    meta.appendChild(
      el("span", "last-seen", "最近记录 " + formatTimestamp(latest.t))
    );
    meta.appendChild(
      el(
        "span",
        "history-min",
        "历史最低 " + formatPrice(historyMinPrice(route))
      )
    );
    card.appendChild(meta);

    var actions = el("div", "card-actions");
    var sparkline = el("span", "sparkline");
    sparkline.appendChild(CtripChart.buildSparkline(getHistory(route)));
    actions.appendChild(sparkline);

    var detailsId = "route-details-" + index;
    var isExpanded = !!expandedKeys[storageKey];
    var expandButton = el(
      "button",
      "button button-expand",
      isExpanded ? "收起详情" : "展开详情"
    );
    expandButton.setAttribute("type", "button");
    expandButton.setAttribute("data-action", "expand");
    expandButton.setAttribute(
      "aria-expanded",
      isExpanded ? "true" : "false"
    );
    expandButton.setAttribute("aria-controls", detailsId);
    actions.appendChild(expandButton);

    var deleteButton = el("button", "button button-danger", "删除");
    deleteButton.setAttribute("type", "button");
    deleteButton.setAttribute("data-action", "delete");
    deleteButton.addEventListener("click", function () {
      handleDeleteClick(storageKey, deleteButton);
    });
    actions.appendChild(deleteButton);
    card.appendChild(actions);

    var details = buildDetails(
      route,
      latest,
      detailsId,
      storageKey,
      isExpanded
    );
    expandButton.addEventListener("click", function () {
      var willShow = details.hidden;
      details.hidden = !willShow;
      expandedKeys[storageKey] = willShow;
      expandButton.setAttribute("aria-expanded", willShow ? "true" : "false");
      expandButton.textContent = willShow ? "收起详情" : "展开详情";
    });
    card.appendChild(details);

    return card;
  }

  function buildClearButton() {
    var wrap = el("div", "bottom-actions");
    var button = el("button", "button button-clear", "清空全部数据");
    button.setAttribute("type", "button");
    button.setAttribute("data-action", "clear");
    button.addEventListener("click", function () {
      handleClearClick(button);
    });
    wrap.appendChild(button);
    return wrap;
  }

  function resetDeleteConfirm() {
    if (deleteTimer !== null) {
      clearTimeout(deleteTimer);
      deleteTimer = null;
    }
    if (pendingDeleteButton && pendingDeleteButton.isConnected) {
      pendingDeleteButton.textContent = "删除";
      pendingDeleteButton.classList.remove("is-confirming");
    }
    pendingDeleteKey = null;
    pendingDeleteButton = null;
  }

  function resetClearConfirm() {
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    if (pendingClearButton && pendingClearButton.isConnected) {
      pendingClearButton.textContent = "清空全部数据";
      pendingClearButton.classList.remove("is-confirming");
    }
    pendingClear = false;
    pendingClearButton = null;
  }

  function handleDeleteClick(key, button) {
    if (!key) return;

    if (pendingDeleteKey === key) {
      confirmDelete(key);
      return;
    }

    resetDeleteConfirm();
    pendingDeleteKey = key;
    pendingDeleteButton = button;
    button.textContent = "确认删除";
    button.classList.add("is-confirming");
    deleteTimer = setTimeout(resetDeleteConfirm, CONFIRM_RESET_MS);
  }

  async function confirmDelete(key) {
    resetDeleteConfirm();

    var next = {};
    Object.keys(currentRoutes).forEach(function (routeKey) {
      if (routeKey !== key) next[routeKey] = currentRoutes[routeKey];
    });

    try {
      // 记录删除时间，避免仍打开的携程页面把这条航线重新写回来。
      var stored = await chrome.storage.local.get(DELETED_KEY);
      var deleted =
        stored && stored[DELETED_KEY] ? stored[DELETED_KEY] : {};
      var nextDeleted = Object.assign({}, deleted);
      nextDeleted[key] = Date.now();

      var payload = {};
      payload[ROUTES_KEY] = next;
      payload[DELETED_KEY] = nextDeleted;
      await chrome.storage.local.set(payload);
    } catch (error) {
      showError(error);
      return;
    }

    render(next);
  }

  function handleClearClick(button) {
    if (pendingClear) {
      confirmClear();
      return;
    }

    resetClearConfirm();
    pendingClear = true;
    pendingClearButton = button;
    button.textContent = "确认清空";
    button.classList.add("is-confirming");
    clearTimer = setTimeout(resetClearConfirm, CONFIRM_RESET_MS);
  }

  async function confirmClear() {
    resetClearConfirm();

    try {
      // 清空时间之前的页面快照不再写入，避免已打开的页面把数据带回来。
      var payload = {};
      payload[ROUTES_KEY] = {};
      payload[DELETED_KEY] = {};
      payload[CLEARED_KEY] = Date.now();
      await chrome.storage.local.set(payload);
    } catch (error) {
      showError(error);
      return;
    }

    render({});
  }

  function render(routes) {
    var safeRoutes =
      routes && typeof routes === "object" ? routes : {};

    resetDeleteConfirm();
    resetClearConfirm();

    currentRoutes = safeRoutes;

    // 清理已删除航线的展开状态与排序选择，避免状态表无限增长。
    Object.keys(expandedKeys).forEach(function (key) {
      if (!safeRoutes[key]) delete expandedKeys[key];
    });
    Object.keys(flightSortState).forEach(function (key) {
      if (!safeRoutes[key]) delete flightSortState[key];
    });

    app.textContent = "";
    app.appendChild(buildHeader());

    var entries = sortRoutes(safeRoutes);

    if (entries.length === 0) {
      app.appendChild(buildEmptyView());
    } else {
      // 只有一条航线时排序没有意义，不占用顶部空间。
      if (entries.length > 1) {
        app.appendChild(buildRouteToolbar());
      }

      var list = el("main", "route-list");
      entries.forEach(function (entry, index) {
        list.appendChild(buildRouteCard(entry.storageKey, entry.route, index));
      });
      app.appendChild(list);
    }

    app.appendChild(buildSettings());
    app.appendChild(buildDataActions());
    if (entries.length !== 0) {
      app.appendChild(buildClearButton());
    }

    app.appendChild(buildFooter());
  }

  function showError(error) {
    var message =
      error && error.message ? String(error.message) : "请稍后重试。";

    resetDeleteConfirm();
    resetClearConfirm();

    app.textContent = "";
    app.appendChild(buildHeader());

    var panel = el("div", "error-state");
    panel.setAttribute("role", "alert");
    panel.appendChild(el("p", "error-title", "加载数据失败"));
    panel.appendChild(el("p", "error-message", message));
    app.appendChild(panel);

    app.appendChild(buildFooter());
  }

  async function init() {
    var data = await chrome.storage.local.get(ROUTES_KEY);
    var settingsData = await chrome.storage.local.get(SETTINGS_KEY);
    var settings =
      settingsData && settingsData[SETTINGS_KEY] ? settingsData[SETTINGS_KEY] : {};
    autoCollectEnabled = settings.autoCollect !== false;

    render(data && data[ROUTES_KEY] ? data[ROUTES_KEY] : {});

    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName && areaName !== "local") return;

      if (changes && changes[ROUTES_KEY]) {
        render(changes[ROUTES_KEY].newValue || {});
      }

      if (changes && changes[SETTINGS_KEY]) {
        var next = changes[SETTINGS_KEY].newValue || {};
        autoCollectEnabled = next.autoCollect !== false;
        render(currentRoutes);
      }
    });
  }

  globalThis.__popupReady = init().catch(showError);
})();
