(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CtripAutoScroll = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 到达底部后等待新批次的最长时间；中段不停顿，也不按步等待。
  var DEFAULT_STEP_TIMEOUT_MS = 2500;
  var DEFAULT_MAX_ROUNDS = 60;
  var DEFAULT_MAX_DURATION_MS = 45000;
  var DEFAULT_IDLE_ROUNDS = 2;
  // 连续滚动速度：每秒滚过多少个可视高度，约 0.7 秒一屏。
  var DEFAULT_SPEED_SCREENS_PER_SEC = 1.5;
  var DEFAULT_MAX_SPEED_PX_PER_SEC = 1800;
  // 滚动过程中定期回调，便于边滚边合并快照。
  var DEFAULT_PROGRESS_INTERVAL_MS = 500;
  var USER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];

  function isScrollable(node) {
    return !!node && node.scrollHeight > node.clientHeight + 20;
  }

  // 收集列表相关的所有可滚动容器：祖先、列表内部的滚动容器、文档滚动元素。
  // 携程可能把航班列表放进固定高度的内层滚动区域，只滚动 <html> 不会触发后续加载。
  function findScrollTargets(node) {
    var doc =
      (node && node.ownerDocument) ||
      (typeof document !== "undefined" ? document : null);
    var found = [];

    function add(el) {
      if (!el || !isScrollable(el) || found.indexOf(el) !== -1) return;
      try {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
      } catch (error) {
        // 忽略无布局信息的节点。
      }
      found.push(el);
    }

    var current = node;
    while (current && current.nodeType === 1) {
      add(current);
      current = current.parentElement;
    }

    var scope = null;
    try {
      scope = node && node.closest ? node.closest(".result-wrapper") : null;
    } catch (error) {
      scope = null;
    }
    if (scope && scope.querySelectorAll) {
      var descendants = scope.querySelectorAll("*");
      for (var i = 0; i < descendants.length; i += 1) {
        var candidate = descendants[i];
        // 只收包含航班卡片的容器，避免把页面里的下拉框、广告位也算进去。
        if (candidate.querySelector && candidate.querySelector(".flight-item")) {
          add(candidate);
        }
      }
    }

    if (doc && doc.scrollingElement) add(doc.scrollingElement);

    // 没有任何可滚动容器时保留文档滚动元素，维持旧行为。
    if (!found.length) {
      var fallback = doc ? doc.scrollingElement || doc.documentElement : null;
      if (fallback) found.push(fallback);
    }
    return found;
  }

  function findScrollTarget(node) {
    return findScrollTargets(node)[0] || null;
  }

  function describeTarget(target) {
    if (!target) return "none";
    var name = target.tagName ? target.tagName.toLowerCase() : "unknown";
    var parts = [name];
    if (target.id) parts.push("#" + target.id);
    if (target.className && typeof target.className === "string") {
      parts.push("." + target.className.trim().split(/\s+/).join("."));
    }
    parts.push(
      "(scrollHeight=" +
        target.scrollHeight +
        ",clientHeight=" +
        target.clientHeight +
        ")"
    );
    return parts.join("");
  }

  // 逐步向下滚动，模拟用户翻页；直接跳到最底部时部分懒加载不会触发。
  // 不伪造 wheel 事件：合成输入的 isTrusted 为 false，容易被页面当成自动化特征，
  // 而携程列表是按滚动位置触发的，并不依赖 wheel。
  function applyScroll(target, top, notify) {
    try {
      target.scrollTop = top;
    } catch (error) {
      // 某些容器只读，忽略即可。
    }
    if (notify !== false && typeof Event === "function") {
      try {
        target.dispatchEvent(new Event("scroll"));
      } catch (error) {
        // 派发失败不影响后续轮次。
      }
    }
  }

  // 平滑滚动到目标位置；durationMs 为 0 时立即到位。
  function animateScroll(target, top, durationMs, isAborted) {
    var from = target.scrollTop;
    if (
      !durationMs ||
      durationMs <= 0 ||
      from === top ||
      typeof requestAnimationFrame !== "function"
    ) {
      applyScroll(target, top);
      return Promise.resolve();
    }

    return new Promise(function (resolve) {
      var startedAt = null;
      var done = false;
      var fallbackTimer = null;

      function finish() {
        if (done) return;
        done = true;
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        applyScroll(target, top);
        resolve();
      }

      function abort() {
        if (done) return;
        done = true;
        if (fallbackTimer !== null) clearTimeout(fallbackTimer);
        resolve();
      }

      // 无头/后台页可能不触发 requestAnimationFrame，用定时器兜底。
      fallbackTimer = setTimeout(finish, durationMs + 100);

      function frame(now) {
        if (done) return;
        if (isAborted && isAborted()) {
          abort();
          return;
        }
        if (startedAt === null) startedAt = now;
        var progress = Math.min(1, (now - startedAt) / durationMs);
        var eased =
          progress < 0.5
            ? 2 * progress * progress
            : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        applyScroll(target, from + (top - from) * eased, false);
        if (progress < 1) {
          requestAnimationFrame(frame);
        } else {
          finish();
        }
      }
      requestAnimationFrame(frame);
    });
  }

  // 所有滚动目标都在底部（不可滚动的目标视为已到底）。
  function allAtBottom(targets) {
    for (var i = 0; i < targets.length; i += 1) {
      var node = targets[i];
      if (!node) continue;
      if (
        node.scrollHeight > node.clientHeight + 2 &&
        node.scrollTop + node.clientHeight < node.scrollHeight - 2
      ) {
        return false;
      }
    }
    return true;
  }

  // 补发合成 scroll 事件，触发依赖滚动事件的懒加载。
  function notifyScroll(targets) {
    for (var i = 0; i < targets.length; i += 1) {
      if (targets[i]) applyScroll(targets[i], targets[i].scrollTop, true);
    }
  }

  // 连续匀速滚向底部：列表在滚动中增长时目标随之后移，中途不停顿。
  // 只有真正到达底部、用户接管页面、外部要求停止或预算耗尽时才返回。
  function glideToBottom(targets, options) {
    var speed = options.speedPxPerSec;
    if (!(speed > 0)) speed = 1200;
    var isAborted = options.isAborted || function () {
      return false;
    };
    var shouldStop = options.shouldStop || function () {
      return false;
    };
    var now = options.now || Date.now;
    var deadline =
      typeof options.deadline === "number" ? options.deadline : Infinity;
    var onProgress = options.onProgress || null;
    var progressIntervalMs =
      typeof options.progressIntervalMs === "number"
        ? options.progressIntervalMs
        : DEFAULT_PROGRESS_INTERVAL_MS;
    var rampMs = typeof options.rampMs === "number" ? options.rampMs : 200;
    var hasRaf = typeof requestAnimationFrame === "function";
    // 无头/后台环境里 rAF 可能不触发，用 32ms 定时器兜底（约 30fps）。
    var watchdogDelayMs = 32;
    // 合成 scroll 事件用于触发懒加载；原生事件在部分环境不派发，节流发送。
    var notifyIntervalMs = 150;

    return new Promise(function (resolve) {
      var done = false;
      var rafId = null;
      var watchdog = null;
      var lastTickAt = null;
      var lastProgressAt = 0;
      var lastNotifyAt = 0;
      var segmentStartedAt = null;

      function finish(reason) {
        if (done) return;
        done = true;
        if (rafId !== null && typeof cancelAnimationFrame === "function") {
          cancelAnimationFrame(rafId);
          rafId = null;
        }
        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
        resolve(reason);
      }

      function tick() {
        if (done) return;
        if (isAborted()) {
          finish("aborted");
          return;
        }
        if (shouldStop()) {
          finish("interrupted");
          return;
        }

        var current = now();
        if (current >= deadline) {
          finish("timeout");
          return;
        }

        var dt = lastTickAt === null ? 16 : current - lastTickAt;
        if (!(dt > 0)) dt = 16;
        // 后台标签页的定时器会被节流到约 1 秒一次；上限放宽到 1 秒，
        // 保证被节流时仍按真实时间前进，而不是每次只走 64ms。
        if (dt > 1000) dt = 1000;
        lastTickAt = current;
        if (segmentStartedAt === null) segmentStartedAt = current;

        // 起步用 200ms 轻微加速，避免从静止突然跳到最高速。
        var ramp =
          rampMs > 0 ? Math.min(1, (current - segmentStartedAt) / rampMs) : 1;
        var factor = 0.2 + 0.8 * ramp;
        var distance = (speed * factor * dt) / 1000;
        var moved = false;

        for (var i = 0; i < targets.length; i += 1) {
          var node = targets[i];
          if (!node) continue;
          var max = node.scrollHeight - node.clientHeight;
          if (max <= 2 || node.scrollTop >= max - 1) continue;
          var next = Math.min(max, node.scrollTop + distance);
          if (next > node.scrollTop) {
            applyScroll(node, next, false);
            moved = true;
          }
        }

        if (allAtBottom(targets)) {
          // 底部事件由 collect 在记录基线后补发，保证同步追加的内容算作增长。
          finish("bottom");
          return;
        }

        if (moved && current - lastNotifyAt >= notifyIntervalMs) {
          lastNotifyAt = current;
          notifyScroll(targets);
        }

        if (moved && onProgress && current - lastProgressAt >= progressIntervalMs) {
          lastProgressAt = current;
          try {
            onProgress();
          } catch (error) {
            // 合并失败不影响滚动。
          }
        }
        schedule();
      }

      function schedule() {
        if (done) return;
        if (hasRaf && rafId === null) {
          rafId = requestAnimationFrame(function () {
            rafId = null;
            tick();
          });
        }
        // 后台标签页或测试环境里 rAF 可能不触发，用定时器兜底推进。
        if (watchdog === null) {
          watchdog = setTimeout(function () {
            watchdog = null;
            if (done) return;
            if (
              lastTickAt === null ||
              now() - lastTickAt >= watchdogDelayMs
            ) {
              tick();
            } else {
              schedule();
            }
          }, watchdogDelayMs);
        }
      }

      schedule();
    });
  }

  // 事件驱动地等待新内容：列表新增节点或滚动高度变化时立即返回。
  // 没有变化时等满 timeoutMs 兜底，避免网络慢时误判为“没有更多”。
  function waitForGrowth(options) {
    var measure = options.measure;
    var baseline = options.baseline;
    var timeoutMs = options.timeoutMs || DEFAULT_STEP_TIMEOUT_MS;
    var listNode = options.listNode;
    var target = options.target;
    var isAborted = options.isAborted || function () {
      return false;
    };

    return new Promise(function (resolve) {
      var settled = false;
      var timer = null;
      var abortPoll = null;
      var mutationObserver = null;
      var resizeObserver = null;

      function cleanup() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        if (abortPoll !== null) {
          clearInterval(abortPoll);
          abortPoll = null;
        }
        if (mutationObserver) {
          mutationObserver.disconnect();
          mutationObserver = null;
        }
        if (resizeObserver) {
          resizeObserver.disconnect();
          resizeObserver = null;
        }
      }

      function finish(grew) {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({ value: measure(), grew: grew });
      }

      function check() {
        if (isAborted()) {
          finish(false);
          return;
        }
        if (measure() > baseline) finish(true);
      }

      timer = setTimeout(function () {
        // 超时兜底：没有新内容时直接判定为“本轮无增长”。
        finish(measure() > baseline);
      }, timeoutMs);

      // 用户操作或 URL 变化不会产生 DOM 变化，轮询保证等待期也能及时中断。
      if (typeof setInterval === "function") {
        abortPoll = setInterval(function () {
          if (isAborted()) finish(false);
        }, 100);
      }

      // 新批次通常表现为往列表里追加节点。
      if (typeof MutationObserver === "function" && listNode) {
        mutationObserver = new MutationObserver(check);
        mutationObserver.observe(listNode, { childList: true, subtree: true });
      }
      // 有些渲染只改变容器高度而不新增节点。
      var resizeTargets =
        Array.isArray(options.targets) && options.targets.length
          ? options.targets
          : target
          ? [target]
          : [];
      if (typeof ResizeObserver === "function" && resizeTargets.length) {
        resizeObserver = new ResizeObserver(check);
        for (var r = 0; r < resizeTargets.length; r += 1) {
          resizeObserver.observe(resizeTargets[r]);
        }
      }

      // 已经增长了就立即返回，不用等第一个事件。
      check();
    });
  }

  // 安装用户操作监听：用户自己滚动/点击/按键时立即中断自动采集。
  function watchUserInterruption(onInterrupt) {
    if (typeof window === "undefined" || !window.addEventListener) {
      return function () {};
    }

    function handler() {
      onInterrupt();
    }

    for (var i = 0; i < USER_EVENTS.length; i += 1) {
      window.addEventListener(USER_EVENTS[i], handler, {
        capture: true,
        passive: true,
      });
    }

    return function dispose() {
      for (var j = 0; j < USER_EVENTS.length; j += 1) {
        window.removeEventListener(USER_EVENTS[j], handler, { capture: true });
      }
    };
  }

  // 连续滚动到列表底部：中途不停顿，只在到达底部后等待新批次；
  // 连续 idleRounds 次到底都没有新内容、达到 maxRounds、被 shouldStop
  // 中断，或用户开始自己操作页面时结束。结束时恢复原始滚动位置。
  async function collect(options) {
    var targets =
      Array.isArray(options.targets) && options.targets.length
        ? options.targets.filter(function (t) {
            return !!t;
          })
        : options.target
        ? [options.target]
        : [];
    var target = targets[0] || null;
    var listNode = options.listNode || target;
    var count = options.count || function () {
      return 0;
    };
    var measure =
      options.measure ||
      function () {
        var height = 0;
        for (var i = 0; i < targets.length; i += 1) {
          height += targets[i].scrollHeight || 0;
        }
        return height + count();
      };
    var stepTimeoutMs = options.stepTimeoutMs || options.settleMs || DEFAULT_STEP_TIMEOUT_MS;
    var maxRounds = options.maxRounds || DEFAULT_MAX_ROUNDS;
    var maxDurationMs = options.maxDurationMs || DEFAULT_MAX_DURATION_MS;
    var idleRounds = options.idleRounds || DEFAULT_IDLE_ROUNDS;
    var restoreDurationMs =
      typeof options.restoreDurationMs === "number"
        ? options.restoreDurationMs
        : 0;
    var progressIntervalMs =
      typeof options.progressIntervalMs === "number"
        ? options.progressIntervalMs
        : DEFAULT_PROGRESS_INTERVAL_MS;
    var respectUserInput = options.respectUserInput !== false;
    var now = typeof options.now === "function" ? options.now : Date.now;
    var shouldStop =
      options.shouldStop ||
      function () {
        return false;
      };
    var onRound = options.onRound || function () {};
    var onBatch = options.onBatch || function () {};
    var onProgress =
      typeof options.onProgress === "function" ? options.onProgress : null;
    var onBottomIdle =
      typeof options.onBottomIdle === "function" ? options.onBottomIdle : null;

    var speedPxPerSec = options.speedPxPerSec;
    if (!(speedPxPerSec > 0)) {
      var viewHeight = 0;
      for (var v = 0; v < targets.length; v += 1) {
        if (targets[v] && targets[v].clientHeight > viewHeight) {
          viewHeight = targets[v].clientHeight;
        }
      }
      speedPxPerSec = Math.min(
        DEFAULT_MAX_SPEED_PX_PER_SEC,
        Math.max(
          400,
          Math.round(viewHeight * DEFAULT_SPEED_SCREENS_PER_SEC)
        )
      );
    }

    var originalTops = targets.map(function (t) {
      return t.scrollTop;
    });
    var startedAt = now();
    var deadline = startedAt + maxDurationMs;
    var rounds = 0;
    var idle = 0;
    var userInterrupted = false;
    var lastCount = count();
    var result = { rounds: 0, count: lastCount, stopped: "max-rounds" };

    function isAborted() {
      return userInterrupted || shouldStop();
    }

    function restore(durationMs) {
      var tasks = [];
      for (var i = 0; i < targets.length; i += 1) {
        tasks.push(animateScroll(targets[i], originalTops[i], durationMs, null));
      }
      return Promise.all(tasks);
    }

    function totalHeight() {
      var total = 0;
      for (var h = 0; h < targets.length; h += 1) {
        total += targets[h].scrollHeight || 0;
      }
      return total;
    }

    var disposeInteraction = respectUserInput
      ? watchUserInterruption(function () {
          userInterrupted = true;
        })
      : function () {};

    try {
      while (rounds < maxRounds) {
        if (userInterrupted) {
          result = { rounds: rounds, count: lastCount, stopped: "user-interrupted" };
          break;
        }
        if (shouldStop()) {
          result = { rounds: rounds, count: lastCount, stopped: "interrupted" };
          break;
        }
        if (now() >= deadline) {
          result = { rounds: rounds, count: lastCount, stopped: "timeout" };
          break;
        }

        var endReason = await glideToBottom(targets, {
          speedPxPerSec: speedPxPerSec,
          isAborted: isAborted,
          shouldStop: shouldStop,
          now: now,
          deadline: deadline,
          onProgress: onProgress,
          progressIntervalMs: progressIntervalMs,
        });

        if (userInterrupted) {
          result = { rounds: rounds, count: lastCount, stopped: "user-interrupted" };
          break;
        }
        if (shouldStop()) {
          result = { rounds: rounds, count: lastCount, stopped: "interrupted" };
          break;
        }
        if (endReason === "timeout") {
          result = { rounds: rounds, count: lastCount, stopped: "timeout" };
          break;
        }
        if (endReason === "aborted") {
          result = { rounds: rounds, count: lastCount, stopped: "user-interrupted" };
          break;
        }

        rounds += 1;
        // 已经到底：先记基线，再补发一次 scroll 事件触发懒加载，
        // 这样同步追加的内容也会被 waitForGrowth 立即识别为增长。
        var baseline = measure();
        notifyScroll(targets);
        var heightBefore = totalHeight();
        var budgetLeftMs = deadline - now();
        if (budgetLeftMs <= 0) {
          result = { rounds: rounds, count: lastCount, stopped: "timeout" };
          break;
        }
        var outcome = await waitForGrowth({
          measure: measure,
          baseline: baseline,
          timeoutMs: Math.min(stepTimeoutMs, budgetLeftMs),
          listNode: listNode,
          target: target,
          targets: targets,
          isAborted: isAborted,
        });

        if (userInterrupted) {
          result = { rounds: rounds, count: lastCount, stopped: "user-interrupted" };
          break;
        }
        if (shouldStop()) {
          result = { rounds: rounds, count: lastCount, stopped: "interrupted" };
          break;
        }

        var nowCount = count();
        var grew = outcome.grew || nowCount > lastCount;

        if (grew) {
          idle = 0;
          lastCount = nowCount;
          await onBatch({ round: rounds, count: nowCount });
          // 新批次只是填满了已有的底部空间（列表高度没变），已经没有更多可滚；
          // 直接结束，更晚的批次由 20 秒延迟观察窗直接合并。
          if (allAtBottom(targets) && totalHeight() <= heightBefore) {
            idle = idleRounds;
          }
        } else if (allAtBottom(targets)) {
          var loadMore =
            onBottomIdle &&
            onBottomIdle({ round: rounds, count: nowCount }) === true;
          if (loadMore) {
            idle = 0;
          } else {
            idle += 1;
          }
        } else {
          // 等待期间窗口尺寸变化等原因离开底部时，不计空闲，继续下一段滚动。
          idle = 0;
        }

        onRound({
          round: rounds,
          count: nowCount,
          height: target ? target.scrollHeight : 0,
          grew: grew,
        });

        if (idle >= idleRounds) {
          result = { rounds: rounds, count: lastCount, stopped: "idle" };
          break;
        }
      }
    } catch (error) {
      result = {
        rounds: rounds,
        count: lastCount,
        stopped: "error",
        error: String(error),
      };
    } finally {
      disposeInteraction();
    }

    // 用户操作或页面导航打断了采集时，滚动条已经被用户/新页面接管，不能再拉回去。
    if (result.stopped !== "user-interrupted" && result.stopped !== "interrupted") {
      await restore(restoreDurationMs);
    }
    return result;
  }

  return {
    findScrollTarget: findScrollTarget,
    findScrollTargets: findScrollTargets,
    describeTarget: describeTarget,
    glideToBottom: glideToBottom,
    waitForGrowth: waitForGrowth,
    watchUserInterruption: watchUserInterruption,
    collect: collect,
  };
});
