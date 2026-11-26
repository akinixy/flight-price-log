(function (root, factory) {
  "use strict";

  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.CtripAutoScroll = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 单步最长等待时间：内容靠 MutationObserver / ResizeObserver 驱动，这里是兜底上限。
  var DEFAULT_STEP_TIMEOUT_MS = 2500;
  var DEFAULT_MAX_ROUNDS = 60;
  var DEFAULT_MAX_DURATION_MS = 45000;
  var DEFAULT_IDLE_ROUNDS = 2;
  var DEFAULT_STEP_RATIO = 0.9;
  // 两轮滚动之间的最小间隔，用于放慢节奏、减少短时间内触发的分批加载请求。
  var DEFAULT_ROUND_INTERVAL_MS = 0;
  var USER_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"];

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

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

  function scrollStep(target, ratio, options) {
    if (!target) return Promise.resolve();
    var step = Math.max(200, Math.round(target.clientHeight * ratio));
    var max = Math.max(0, target.scrollHeight - target.clientHeight);
    var next = Math.min(max, target.scrollTop + step);
    var durationMs =
      options && typeof options.durationMs === "number" ? options.durationMs : 0;
    var isAborted = options && options.isAborted;
    return animateScroll(target, next, durationMs, isAborted);
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
      var mutationObserver = null;
      var resizeObserver = null;

      function cleanup() {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
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

  // 反复逐步下滚，直到滚到底部且连续 idleRounds 轮没有新内容、达到 maxRounds、
  // 被 shouldStop 中断，或用户开始自己操作页面。
  // 每轮调用 onRound；发现新内容时调用 onBatch；结束时恢复原始滚动位置。
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
    var count = options.count;
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
    var stepRatio = options.stepRatio || DEFAULT_STEP_RATIO;
    var roundIntervalMs =
      options.roundIntervalMs === undefined
        ? DEFAULT_ROUND_INTERVAL_MS
        : options.roundIntervalMs;
    var respectUserInput = options.respectUserInput !== false;
    var now = typeof options.now === "function" ? options.now : Date.now;
    var shouldStop =
      options.shouldStop ||
      function () {
        return false;
      };
    var onRound = options.onRound || function () {};
    var onBatch = options.onBatch || function () {};
    var onBottomIdle =
      typeof options.onBottomIdle === "function" ? options.onBottomIdle : null;
    var midStepTimeoutMs =
      typeof options.midStepTimeoutMs === "number"
        ? options.midStepTimeoutMs
        : stepTimeoutMs;
    var stepDurationMs =
      typeof options.stepDurationMs === "number" ? options.stepDurationMs : 0;
    var restoreDurationMs =
      typeof options.restoreDurationMs === "number"
        ? options.restoreDurationMs
        : 0;

    var originalTops = targets.map(function (t) {
      return t.scrollTop;
    });
    var startedAt = now();
    var rounds = 0;
    var idle = 0;
    var userInterrupted = false;
    var lastCount = count();
    var lastStepAt = 0;
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

    // 只有滚到底部才把「本轮没有增长」计为空闲；否则列表较高或
    // 单批新增较多时，会在一两轮后就误判为没有更多内容。
    function isAtBottom() {
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
        if (now() - startedAt >= maxDurationMs) {
          result = { rounds: rounds, count: lastCount, stopped: "timeout" };
          break;
        }

        // 放慢节奏：两轮滚动之间至少间隔 roundIntervalMs，避免连续触发分批加载。
        if (roundIntervalMs > 0) {
          if (lastStepAt) {
            var currentTime = now();
            var budgetLeft = maxDurationMs - (currentTime - startedAt);
            if (budgetLeft <= 0) {
              result = { rounds: rounds, count: lastCount, stopped: "timeout" };
              break;
            }
            var waitMs = roundIntervalMs - (currentTime - lastStepAt);
            // 等待不能超过剩余预算，否则会在截止时间之后仍发出一次滚动。
            if (waitMs > budgetLeft) waitMs = budgetLeft;
            if (waitMs > 0) {
              await sleep(waitMs);
              if (userInterrupted) {
                result = {
                  rounds: rounds,
                  count: lastCount,
                  stopped: "user-interrupted",
                };
                break;
              }
              if (shouldStop()) {
                result = { rounds: rounds, count: lastCount, stopped: "interrupted" };
                break;
              }
              if (now() - startedAt >= maxDurationMs) {
                result = { rounds: rounds, count: lastCount, stopped: "timeout" };
                break;
              }
            }
          }
          lastStepAt = now();
        }

        rounds += 1;
        var baseline = measure();
        var stepTasks = [];
        for (var s = 0; s < targets.length; s += 1) {
          stepTasks.push(
            scrollStep(targets[s], stepRatio, {
              durationMs: stepDurationMs,
              isAborted: isAborted,
            })
          );
        }
        await Promise.all(stepTasks);

        var atBottomAfterScroll = isAtBottom();
        var outcome = await waitForGrowth({
          measure: measure,
          baseline: baseline,
          timeoutMs: atBottomAfterScroll ? stepTimeoutMs : midStepTimeoutMs,
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
        } else if (isAtBottom()) {
          var loadMore =
            onBottomIdle &&
            onBottomIdle({ round: rounds, count: nowCount }) === true;
          if (loadMore) {
            idle = 0;
          } else {
            idle += 1;
          }
        } else {
          // 还没滚到底，继续下一轮；不计空闲。
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
    scrollStep: scrollStep,
    waitForGrowth: waitForGrowth,
    watchUserInterruption: watchUserInterruption,
    collect: collect,
  };
});
