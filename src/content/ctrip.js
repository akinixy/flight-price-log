(function () {
  "use strict";

  var HOSTNAME = "flights.ctrip.com";
  var LIST_PATH_PREFIX = "/online/list/";
  var SCRIPT_MARKER = "GlobalSearchCriteria";
  var SETTINGS_KEY = "ctripSettings";
  var LOG_PREFIX = "[航班价格记录]";

  var DEBOUNCE_MS = 2000;
  // 页面持续变化时最多等这么久就放行一次解析，避免防抖被无限重置。
  var DEBOUNCE_MAX_WAIT_MS = 5000;
  // 首次加载很慢时不要急着提示「没有列表」，宽限一段时间再提示。
  var NO_FLIGHTS_GRACE_MS = 45000;
  var URL_POLL_MS = 1000;
  // 单步最多等待：中段只等一小会儿，到底部后等下一批（3 秒 × 2 次空闲约 6 秒）。
  var AUTOSCROLL_MID_STEP_TIMEOUT_MS = 150;
  var AUTOSCROLL_STEP_TIMEOUT_MS = 3000;
  var AUTOSCROLL_STEP_DURATION_MS = 250;
  var AUTOSCROLL_RESTORE_DURATION_MS = 300;
  var AUTOSCROLL_MAX_ROUNDS = 80;
  var AUTOSCROLL_MAX_DURATION_MS = 60000;
  // 每轮空闲 2 次即结束；只有到达底部才计空闲。
  var AUTOSCROLL_IDLE_ROUNDS = 2;
  var AUTOSCROLL_ROUND_INTERVAL_MS = 400;
  var AUTO_TOTAL_BUDGET_MS = 60000;
  // 主动滚动结束后继续观察页面；如果列表又增长，补采一轮。
  var LATE_WATCH_MS = 20000;
  var LATE_RESUME_MAX_MS = 20000;
  // 携程风控拦截页只有一行提示、没有航班列表。
  var BLOCK_TEXT_RE = /whaleguard/i;

  var lastUrl = typeof location !== "undefined" ? location.href : "";
  // 本页面加载时间：后台用它判断快照是否来自删除/清空之前打开的页面。
  var pageStartedAt = Date.now();
  // 控制台排查提示：不改变采集行为，只帮助区分风控、广告拦截与页面结构变化。
  var BLOCKED_HINT =
    "若安装了广告拦截器，可尝试将 flights.ctrip.com 加入白名单；也请检查 VPN/代理出口与登录状态。";
  var NO_FLIGHTS_HINT =
    "未找到航班列表：如果页面已加载完成，可能是该航线/日期暂无航班、广告拦截器隐藏了列表，或携程页面结构已变化；扩展会继续观察。";
  // 页面停留期间已经见过的航班；滚动分批渲染时只增不减。
  var accumulated = null;
  // 最近一次成功保存的快照，用于判断是否有新数据。
  var lastSaved = null;
  var scriptTexts = null;
  var observer = null;
  var debounceTimer = null;
  var debounceStartedAt = 0;
  var noFlightsTimer = null;
  var urlTimer = null;
  var autoscrollRunning = false;
  var autoCollectStarted = false;
  var autoCollectStopped = false;
  var autoCollectStartedAt = 0;
  var lateWatchTimer = null;
  var lateWatchDispose = null;
  var lateWatchBaseline = 0;
  var lateResumeUsed = false;
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

  // 识别携程风控拦截页：没有航班列表，整页只有一行 whaleguard block。
  // 此时继续滚动或重试只会加重拦截，直接停止采集。
  function isBlockedPage(doc) {
    var scope = doc || (typeof document !== "undefined" ? document : null);
    if (!scope) return false;
    if (scope.querySelector(".flight-list.root-flights")) return false;

    var body = scope.body;
    if (!body) return false;

    var text = (body.textContent || "").trim();
    return text.length > 0 && text.length < 400 && BLOCK_TEXT_RE.test(text);
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
    debounceStartedAt = 0;
  }

  function clearNoFlightsTimer() {
    if (noFlightsTimer !== null) {
      clearTimeout(noFlightsTimer);
      noFlightsTimer = null;
    }
  }

  function startNoFlightsTimer() {
    clearNoFlightsTimer();
    noFlightsTimer = setTimeout(function () {
      noFlightsTimer = null;
      if (!accumulated && !isBlockedPage()) {
        logOnce("no-flights", NO_FLIGHTS_HINT);
      }
    }, NO_FLIGHTS_GRACE_MS);
  }

  // 每次 DOM 变化都重置 2 秒防抖，等页面渲染稳定后再解析；
  // 但页面持续变化时最多等 5 秒就放行一次，避免解析被无限推迟。
  function scheduleEvaluate() {
    if (!observer) return;

    var now = Date.now();
    if (debounceTimer === null) {
      debounceStartedAt = now;
    } else if (now - debounceStartedAt >= DEBOUNCE_MAX_WAIT_MS) {
      return;
    } else {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      debounceStartedAt = 0;
      evaluate()
        .catch(function () {})
        .then(function () {
          // 首批航班出现后主动滚动；后续轮次由 autoCollectAll 自己串联。
          if (
            autoCollectEnabled &&
            lastSaved &&
            !autoCollectStarted &&
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

    if (!result || !result.ok) {
      var reason = result && result.reason ? String(result.reason) : "parse-error";
      if (reason !== "no-flights") {
        logOnce(
          "parse:" + reason,
          "当前页面不在采集范围内（" + reason + "），已跳过。"
        );
      }
      return false;
    }

    clearNoFlightsTimer();

    evalGeneration += 1;
    var incoming = result.snapshot.flights || [];
    for (var i = 0; i < incoming.length; i += 1) {
      seenGeneration[CtripParser.flightIdentity(incoming[i])] = evalGeneration;
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
    checkLateWatchGrowth();
    return flush();
  }

  function clearLateWatch() {
    if (lateWatchTimer !== null) {
      clearTimeout(lateWatchTimer);
      lateWatchTimer = null;
    }
    if (lateWatchDispose) {
      lateWatchDispose();
      lateWatchDispose = null;
    }
  }

  // 主动滚动停止后，页面可能还在慢慢加载；保留一个非阻塞观察窗。
  function startLateWatch(token) {
    clearLateWatch();
    var list = document.querySelector(".flight-list.root-flights");
    if (!list) return;

    lateWatchBaseline =
      list.scrollHeight + list.querySelectorAll(".flight-item").length;
    lateWatchTimer = setTimeout(function () {
      clearLateWatch();
      autoCollectStopped = true;
    }, LATE_WATCH_MS);
    lateWatchDispose = CtripAutoScroll.watchUserInterruption(function () {
      clearLateWatch();
      autoCollectStopped = true;
    });
    console.log(LOG_PREFIX + " 自动采集结束，继续观察延迟加载 " + LATE_WATCH_MS / 1000 + " 秒。");
  }

  function checkLateWatchGrowth() {
    if (lateWatchTimer === null) return;
    var list = document.querySelector(".flight-list.root-flights");
    if (!list) return;

    var value =
      list.scrollHeight + list.querySelectorAll(".flight-item").length;
    if (value <= lateWatchBaseline) return;

    clearLateWatch();
    if (lateResumeUsed) {
      autoCollectStopped = true;
      return;
    }
    lateResumeUsed = true;
    console.log(LOG_PREFIX + " 检测到延迟加载，补采一轮。");
    autoCollectAll(true);
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

  // 连续滚动列表，触发携程的分批渲染；到底部后等待新批次，只采集一遍。
  function autoCollectAll(resume) {
    var isResume = resume === true;
    if (!autoCollectEnabled) return Promise.resolve();
    if (autoscrollRunning) return Promise.resolve();
    if (!isResume && (autoCollectStopped || autoCollectStarted)) {
      return Promise.resolve();
    }
    if (!window.CtripAutoScroll) return Promise.resolve();

    var list = document.querySelector(".flight-list.root-flights");
    if (!list) {
      if (isBlockedPage()) {
        autoCollectStopped = true;
        logOnce("blocked", "页面被携程风控拦截，已停止自动采集；" + BLOCKED_HINT);
      } else {
        logOnce("no-flights", NO_FLIGHTS_HINT);
      }
      return Promise.resolve();
    }

    if (!autoCollectStartedAt) autoCollectStartedAt = Date.now();
    var remaining = AUTO_TOTAL_BUDGET_MS - (Date.now() - autoCollectStartedAt);
    if (remaining <= 0) {
      autoCollectStopped = true;
      return Promise.resolve();
    }

    autoCollectStarted = true;
    autoCollectStopped = false;
    autoscrollRunning = true;
    var token = pageToken;
    var loadMoreClicked = false;
    var startCount = accumulated ? accumulated.flights.length : 0;
    var targets = CtripAutoScroll.findScrollTargets(list);
    console.log(
      LOG_PREFIX +
        (isResume ? " 延迟补采开始，容器：" : " 自动采集开始，容器：") +
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
      midStepTimeoutMs: AUTOSCROLL_MID_STEP_TIMEOUT_MS,
      stepDurationMs: AUTOSCROLL_STEP_DURATION_MS,
      restoreDurationMs: AUTOSCROLL_RESTORE_DURATION_MS,
      maxRounds: AUTOSCROLL_MAX_ROUNDS,
      maxDurationMs: isResume
        ? Math.min(LATE_RESUME_MAX_MS, remaining)
        : Math.min(AUTOSCROLL_MAX_DURATION_MS, remaining),
      idleRounds: AUTOSCROLL_IDLE_ROUNDS,
      roundIntervalMs: AUTOSCROLL_ROUND_INTERVAL_MS,
      shouldStop: function () {
        return (
          token !== pageToken ||
          location.href !== lastUrl ||
          !autoCollectEnabled
        );
      },
      onBatch: function () {
        // 只更新内存，避免每批都写一次存储；后台 30 分钟节流下这些写入本就会互相覆盖。
        if (mergeCurrent()) {
          console.log(
            LOG_PREFIX + " 已合并航班 " + accumulated.flights.length + " 条"
          );
        }
      },
      onBottomIdle: function () {
        if (loadMoreClicked) return false;
        loadMoreClicked = tryLoadMore();
        return loadMoreClicked;
      },
    })
      .then(function (summary) {
        autoscrollRunning = false;
        if (token !== pageToken) return null;

        mergeCurrent();
        var endCount = accumulated ? accumulated.flights.length : 0;
        console.log(
          LOG_PREFIX +
            " 自动采集结束：" +
            JSON.stringify(summary) +
            "，本次新增 " +
            (endCount - startCount) +
            " 条，累计 " +
            endCount +
            " 条"
        );

        return flush()
          .then(function () {
            if (
              summary.stopped === "user-interrupted" ||
              summary.stopped === "interrupted"
            ) {
              autoCollectStopped = true;
              clearLateWatch();
              return null;
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
            return null;
          })
          .then(function () {
            if (
              summary.stopped === "user-interrupted" ||
              summary.stopped === "interrupted"
            ) {
              return null;
            }
            if (!isResume && summary.stopped === "idle") {
              startLateWatch(token);
              return null;
            }
            autoCollectStopped = true;
            return null;
          });
      })
      .catch(function (error) {
        autoscrollRunning = false;
        autoCollectStopped = true;
        clearLateWatch();
        console.log(LOG_PREFIX + " 自动滚动采集中断：" + String(error));
        return flush();
      });
  }

  function reset() {
    accumulated = null;
    lastSaved = null;
    scriptTexts = null;
    clearLateWatch();
    autoCollectStarted = false;
    autoCollectStopped = false;
    autoCollectStartedAt = 0;
    lateResumeUsed = false;
    // 页内 SPA 切换日期/舱位算一次新的页面会话；否则清空数据后，
    // 这个标签页里的新查询会被 ctripClearedAt 一直挡住。
    pageStartedAt = Date.now();
    pageToken += 1;
    evalGeneration = 0;
    seenGeneration = Object.create(null);
    maxDomItems = 0;
    stopObservation();
    startObservation();
    startNoFlightsTimer();
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
    if (isBlockedPage()) {
      logOnce("blocked", "页面被携程风控拦截，已暂停采集；" + BLOCKED_HINT + "刷新或稍后再试。");
      return;
    }

    lastUrl = location.href;

    function start() {
      startObservation();
      watchUrl();
      startNoFlightsTimer();
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
      if (autoCollectEnabled) {
        if (lastSaved && !autoCollectStarted && !autoCollectStopped) {
          autoCollectAll();
        }
      } else {
        clearLateWatch();
        autoCollectStopped = true;
      }
    });
  }

  // 浏览器里直接启动；Node 测试环境只导出纯函数，不访问 location / chrome。
  if (typeof module === "object" && module.exports) {
    module.exports = { isBlockedPage: isBlockedPage };
  } else {
    init();
  }
})();
