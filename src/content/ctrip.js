(function () {
  "use strict";

  var HOSTNAME = "flights.ctrip.com";
  var LIST_PATH_PREFIX = "/online/list/";
  var SCRIPT_MARKER = "GlobalSearchCriteria";
  var SETTINGS_KEY = "ctripSettings";
  var LOG_PREFIX = "[航班价格记录]";

  var DEBOUNCE_MS = 2000;
  var URL_POLL_MS = 1000;
  // 单步最长等待；正常情况下由内容变化事件提前结束。
  var AUTOSCROLL_STEP_TIMEOUT_MS = 3000;
  var AUTOSCROLL_MAX_ROUNDS = 60;
  var AUTOSCROLL_MAX_DURATION_MS = 30000;
  // 每轮空闲 2 次即结束；若本轮有新增，会从顶部再滚一轮。
  var AUTOSCROLL_IDLE_ROUNDS = 2;
  var AUTO_MAX_PASSES = 8;
  var AUTO_TOTAL_BUDGET_MS = 90000;
  var AUTO_PASS_DELAY_MS = 1200;

  var lastUrl = typeof location !== "undefined" ? location.href : "";
  // 本页面加载时间：后台用它判断快照是否来自删除/清空之前打开的页面。
  var pageStartedAt = Date.now();
  // 页面停留期间已经见过的航班；滚动分批渲染时只增不减。
  var accumulated = null;
  // 最近一次成功保存的快照，用于判断是否有新数据。
  var lastSaved = null;
  var scriptTexts = null;
  var observer = null;
  var debounceTimer = null;
  var urlTimer = null;
  var autoscrollRunning = false;
  var autoCollectPasses = 0;
  var autoCollectStartedAt = 0;
  var autoCollectStopped = false;
  var autoCollectEnabled = true;
  var pageToken = 0;
  // 记录每个航班最后一次出现在页面里的轮次，用于清理已售罄/下架的航班。
  var evalGeneration = 0;
  var seenGeneration = Object.create(null);
  var maxDomItems = 0;
  var loggedReasons = Object.create(null);

  // 控制台同一种原因只提示一次，避免 DOM 频繁变化时刷屏。
  function logOnce(reason, message) {
    if (loggedReasons[reason]) return;
    loggedReasons[reason] = true;
    console.log(LOG_PREFIX + " " + message);
  }

  // 内容脚本处于隔离世界，读不到页面 window 变量，只能读取 <script> 文本。
  function scanScriptTexts() {
    var nodes = document.querySelectorAll("script");
    var texts = [];

    for (var i = 0; i < nodes.length; i += 1) {
      var text = nodes[i].textContent || "";
      if (text.indexOf(SCRIPT_MARKER) !== -1) texts.push(text);
    }

    return texts;
  }

  function getScriptTexts() {
    if (scriptTexts === null) {
      scriptTexts = scanScriptTexts();
    }
    return scriptTexts;
  }

  // 返回 chrome.runtime.sendMessage 的结果 Promise；传输失败时解析为 null。
  function send(snapshot) {
    var result;
    try {
      result = chrome.runtime.sendMessage({
        type: "RECORD_SNAPSHOT",
        payload: snapshot,
        pageStartedAt: pageStartedAt,
      });
    } catch (error) {
      // 扩展被重载后内容脚本上下文失效，忽略即可。
      return Promise.resolve(null);
    }

    return Promise.resolve(result).catch(function () {
      return null;
    });
  }

  function stopObservation() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  // 每次 DOM 变化都重置 2 秒防抖，等页面渲染稳定后再解析。
  function scheduleEvaluate() {
    if (!observer) return;

    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      evaluate()
        .catch(function () {})
        .then(function () {
          // 首批航班出现后主动滚动；后续轮次由 autoCollectAll 自己串联。
          if (
            autoCollectEnabled &&
            lastSaved &&
            autoCollectPasses === 0 &&
            !autoCollectStopped
          ) {
            return autoCollectAll();
          }
          return null;
        })
        .catch(function () {});
    }, DEBOUNCE_MS);
  }

  function startObservation() {
    if (observer) return;
    if (!document.documentElement) return;

    observer = new MutationObserver(scheduleEvaluate);
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // 把当前 DOM 与已见航班合并；不发送，只更新内存并返回是否有变化。
  function mergeCurrent() {
    var result;
    try {
      result = window.CtripParser.extractSnapshot({
        doc: document,
        url: location.href,
        scriptTexts: getScriptTexts(),
      });
    } catch (error) {
      return false;
    }

    if (!result || !result.ok) return false;

    evalGeneration += 1;
    var incoming = result.snapshot.flights || [];
    for (var i = 0; i < incoming.length; i += 1) {
      seenGeneration[incoming[i].no + "|" + incoming[i].departTime] =
        evalGeneration;
    }
    if (incoming.length > maxDomItems) maxDomItems = incoming.length;

    var merged = CtripParser.mergeSnapshots(accumulated, result.snapshot);
    if (CtripParser.isSameSnapshot(accumulated, merged)) return false;

    accumulated = merged;
    return true;
  }

  // 采集结束后，用最后一轮页面数据清理已经不在页面上的航班（售罄/下架）。
  // 如果最终 DOM 条目远少于曾见过的最大条目数，可能是虚拟列表，放弃清理。
  function pruneStaleFlights() {
    if (!accumulated) return 0;

    var domItems = document.querySelectorAll(
      ".flight-list.root-flights .flight-item"
    ).length;
    if (maxDomItems > 0 && domItems < Math.max(1, Math.floor(maxDomItems * 0.8))) {
      return 0;
    }

    var before = accumulated.flights.length;
    var kept = CtripParser.pruneFlights(
      accumulated.flights,
      seenGeneration,
      evalGeneration
    );
    if (!kept.length || kept.length === before) return 0;

    var rebuilt = CtripParser.rebuildSnapshot(accumulated, kept);
    if (!rebuilt) return 0;

    accumulated = rebuilt;
    return before - kept.length;
  }

  // 把已合并的结果发给后台；只有确实变化且保存成功才更新 lastSaved。
  function flush() {
    if (!accumulated) return Promise.resolve();
    if (lastSaved && CtripParser.isSameSnapshot(lastSaved, accumulated)) {
      return Promise.resolve();
    }

    var snapshot = accumulated;
    return send(snapshot).then(function (response) {
      if (response && response.ok === true) {
        lastSaved = snapshot;
        return;
      }

      var detail =
        response && response.error ? String(response.error) : "消息发送失败";
      logOnce(
        "send:" + detail,
        "保存失败（" + detail + "），等待页面更新后重试。"
      );
    });
  }

  // 解析当前页面；必要时立即保存（用户主动浏览时用）。
  function evaluate() {
    var changed = mergeCurrent();
    if (!changed) return Promise.resolve();
    return flush();
  }

  function wait(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // 尝试点击“查看更多/加载更多”一类按钮；找不到就返回 false。
  function tryLoadMore() {
    var scope = document.querySelector(".result-wrapper") || document;
    if (!scope || !scope.querySelectorAll) return false;

    var nodes = scope.querySelectorAll(
      "button, a, [role='button'], [class*='more'], [class*='More']"
    );
    for (var i = 0; i < nodes.length; i += 1) {
      var node = nodes[i];
      var text = (node.textContent || "").replace(/\s+/g, "");
      if (!text || text.length > 20) continue;
      if (!/查看更多|加载更多|更多航班|显示更多|点击加载|加载剩余/.test(text)) {
        continue;
      }
      var rect = node.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      try {
        node.click();
        console.log(LOG_PREFIX + " 点击加载更多：" + text);
        return true;
      } catch (error) {
        // 忽略点击失败。
      }
    }
    return false;
  }

  // 主动滚动列表，触发携程的分批渲染；一轮没滚完时从顶部再来一轮。
  function autoCollectAll() {
    if (!autoCollectEnabled) return Promise.resolve();
    if (autoscrollRunning || autoCollectStopped) return Promise.resolve();
    if (autoCollectPasses >= AUTO_MAX_PASSES) return Promise.resolve();
    if (!window.CtripAutoScroll) return Promise.resolve();

    var list = document.querySelector(".flight-list.root-flights");
    if (!list) return Promise.resolve();

    if (!autoCollectStartedAt) autoCollectStartedAt = Date.now();
    var remaining = AUTO_TOTAL_BUDGET_MS - (Date.now() - autoCollectStartedAt);
    if (remaining <= 0) {
      autoCollectStopped = true;
      return Promise.resolve();
    }

    autoscrollRunning = true;
    autoCollectPasses += 1;
    var pass = autoCollectPasses;
    var startCount = accumulated ? accumulated.flights.length : 0;
    var token = pageToken;
    var targets = CtripAutoScroll.findScrollTargets(list);
    console.log(
      LOG_PREFIX +
        " 第 " +
        pass +
        " 轮自动采集开始，容器：" +
        targets
          .map(function (target) {
            return CtripAutoScroll.describeTarget(target);
          })
          .join(" | ")
    );

    return CtripAutoScroll.collect({
      target: targets[0] || null,
      targets: targets,
      listNode: list,
      count: function () {
        return document.querySelectorAll(".flight-list.root-flights .flight-item")
          .length;
      },
      stepTimeoutMs: AUTOSCROLL_STEP_TIMEOUT_MS,
      maxRounds: AUTOSCROLL_MAX_ROUNDS,
      maxDurationMs: Math.min(AUTOSCROLL_MAX_DURATION_MS, remaining),
      idleRounds: AUTOSCROLL_IDLE_ROUNDS,
      shouldStop: function () {
        return token !== pageToken || location.href !== lastUrl;
      },
      onBatch: function () {
        // 只更新内存，避免每批都写一次存储；后台 30 分钟节流下这些写入本就会互相覆盖。
        if (mergeCurrent()) {
          console.log(
            LOG_PREFIX + " 已合并航班 " + accumulated.flights.length + " 条"
          );
        }
      },
    })
      .then(function (summary) {
        autoscrollRunning = false;
        if (token !== pageToken) return null;

        // 让最后一轮 DOM 进入累积并标记 seen。
        mergeCurrent();
        var endCount = accumulated ? accumulated.flights.length : 0;
        var grew = endCount > startCount;
        console.log(
          LOG_PREFIX +
            " 第 " +
            pass +
            " 轮结束：" +
            JSON.stringify(summary) +
            "，本轮新增 " +
            (endCount - startCount) +
            " 条，累计 " +
            endCount +
            " 条"
        );

        return flush().then(function () {
          if (
            summary.stopped === "user-interrupted" ||
            summary.stopped === "interrupted"
          ) {
            autoCollectStopped = true;
            return null;
          }

          // 本轮有新增但已到空闲：从顶部再滚一轮，触发需要重新进入视口的懒加载。
          if (summary.stopped === "idle" && grew && pass < AUTO_MAX_PASSES) {
            tryLoadMore();
            return wait(AUTO_PASS_DELAY_MS).then(function () {
              if (token !== pageToken) return null;
              return autoCollectAll();
            });
          }

          if (summary.stopped === "idle") {
            var pruned = pruneStaleFlights();
            if (pruned) {
              console.log(
                LOG_PREFIX + " 清理 " + pruned + " 条已不在页面的航班"
              );
              return flush();
            }
          }

          autoCollectStopped = true;
          return null;
        });
      })
      .catch(function (error) {
        autoscrollRunning = false;
        console.log(LOG_PREFIX + " 自动滚动采集中断：" + String(error));
        return flush();
      });
  }

  function reset() {
    accumulated = null;
    lastSaved = null;
    scriptTexts = null;
    autoCollectPasses = 0;
    autoCollectStartedAt = 0;
    autoCollectStopped = false;
    pageToken += 1;
    evalGeneration = 0;
    seenGeneration = Object.create(null);
    maxDomItems = 0;
    stopObservation();
    startObservation();
  }

  // SPA 切换日期/舱位时 URL 会变，重新开始一轮采集；轮询本身始终保留。
  function watchUrl() {
    if (urlTimer !== null) clearInterval(urlTimer);

    urlTimer = setInterval(function () {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      reset();
    }, URL_POLL_MS);
  }

  function init() {
    if (location.hostname !== HOSTNAME) return;
    if (!location.pathname.startsWith(LIST_PATH_PREFIX)) return;

    lastUrl = location.href;

    function start() {
      startObservation();
      watchUrl();
    }

    try {
      chrome.storage.local.get(SETTINGS_KEY).then(
        function (data) {
          var settings =
            data && data[SETTINGS_KEY] ? data[SETTINGS_KEY] : {};
          autoCollectEnabled = settings.autoCollect !== false;
          start();
        },
        start
      );
    } catch (error) {
      start();
    }

    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName && areaName !== "local") return;
      if (!changes || !changes[SETTINGS_KEY]) return;

      var settings = changes[SETTINGS_KEY].newValue || {};
      autoCollectEnabled = settings.autoCollect !== false;
      if (
        autoCollectEnabled &&
        lastSaved &&
        autoCollectPasses === 0 &&
        !autoCollectStopped
      ) {
        autoCollectAll();
      }
    });
  }

  init();
})();
