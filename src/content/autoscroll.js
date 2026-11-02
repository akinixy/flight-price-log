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
  function scrollStep(target, ratio) {
    if (!target) return;
    var step = Math.max(200, Math.round(target.clientHeight * ratio));
    var max = Math.max(0, target.scrollHeight - target.clientHeight);
    var next = Math.min(max, target.scrollTop + step);
    var before = target.scrollTop;

    try {
      target.scrollTop = next;
    } catch (error) {
      // 某些容器只读，忽略即可。
    }

    // 部分页面只在 scroll 事件里检查加载条件；直接赋值不一定派发事件。
    if (target.scrollTop !== before || typeof Event === "function") {
      try {
        target.dispatchEvent(new Event("scroll"));
      } catch (error) {
        // 派发失败不影响后续轮次。
      }
    }

    // 少数懒加载实现监听 wheel；合成事件标记为 synthetic，不触发“用户操作”中断。
    if (typeof WheelEvent === "function") {
      try {
        var wheel = new WheelEvent("wheel", {
          deltaY: Math.max(1, step),
          bubbles: true,
          cancelable: true,
        });
        wheel.__synthetic = true;
        target.dispatchEvent(wheel);
      } catch (error) {
        // 忽略不支持 WheelEvent 的环境。
      }
    }
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

    function handler(event) {
      // 忽略自动滚动自己派发的合成 wheel，避免误判成用户操作。
      if (event && event.__synthetic) return;
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
    var respectUserInput = options.respectUserInput !== false;
    var now = typeof options.now === "function" ? options.now : Date.now;
    var shouldStop =
      options.shouldStop ||
      function () {
        return false;
      };
    var onRound = options.onRound || function () {};
    var onBatch = options.onBatch || function () {};

    var originalTops = targets.map(function (t) {
      return t.scrollTop;
    });
    var startedAt = now();
    var rounds = 0;
    var idle = 0;
    var userInterrupted = false;
    var lastCount = count();
    var result = { rounds: 0, count: lastCount, stopped: "max-rounds" };

    function isAborted() {
      return userInterrupted || shouldStop();
    }

    function restore() {
      for (var i = 0; i < targets.length; i += 1) {
        try {
          targets[i].scrollTop = originalTops[i];
          targets[i].dispatchEvent(new Event("scroll"));
        } catch (error) {
          // 忽略只读滚动容器。
        }
      }
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

        rounds += 1;
        var baseline = measure();
        for (var s = 0; s < targets.length; s += 1) {
          scrollStep(targets[s], stepRatio);
        }

        var outcome = await waitForGrowth({
          measure: measure,
          baseline: baseline,
          timeoutMs: stepTimeoutMs,
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
        } else {
          idle += 1;
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
      restore();
    }
    return result;
  }

  return {
    findScrollTarget: findScrollTarget,
    findScrollTargets: findScrollTargets,
    describeTarget: describeTarget,
    scrollStep: scrollStep,
    waitForGrowth: waitForGrowth,
    collect: collect,
  };
});
