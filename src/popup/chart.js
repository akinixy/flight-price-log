(function (root, factory) {
  "use strict";

  var api = factory(root);

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CtripChart = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var SPARKLINE_LIMIT = 20;

  var COLORS = {
    line: "#e8590c",
    point: "#d9480f",
    axis: "#e5e7eb",
    label: "#6b7280",
  };

  function createSvg(width, height) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    svg.setAttribute("viewBox", "0 0 " + width + " " + height);
    return svg;
  }

  function createNode(name, attrs) {
    var node = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          node.setAttribute(key, String(attrs[key]));
        }
      }
    }
    return node;
  }

  function roundCoord(value) {
    return Math.round(value * 100) / 100;
  }

  function addLabel(svg, x, y, text, anchor) {
    var node = createNode("text", {
      x: roundCoord(x),
      y: roundCoord(y),
      "text-anchor": anchor || "start",
      "font-size": "10",
      fill: COLORS.label,
    });
    node.textContent = text;
    svg.appendChild(node);
    return node;
  }

  // 过滤非法历史记录；points 里的 minFlightNo 等额外字段直接忽略。
  function normalizePoints(points) {
    var list = [];
    if (!points || typeof points.length !== "number") return list;

    for (var i = 0; i < points.length; i += 1) {
      var point = points[i];
      if (!point) continue;
      if (typeof point.t !== "number" || !isFinite(point.t)) continue;
      if (typeof point.minPrice !== "number" || !isFinite(point.minPrice)) {
        continue;
      }
      list.push({ t: point.t, minPrice: point.minPrice });
    }
    return list;
  }

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function toIsoDate(epoch) {
    var date = new Date(epoch);
    return (
      date.getFullYear() + "-" +
      pad2(date.getMonth() + 1) + "-" +
      pad2(date.getDate())
    );
  }

  function formatDate(epoch) {
    var iso = toIsoDate(epoch);
    var format = root && root.CtripFormat;
    if (format && typeof format.formatDateLabel === "function") {
      return format.formatDateLabel(iso);
    }
    return iso;
  }

  function getPriceRange(list) {
    var min = list[0].minPrice;
    var max = list[0].minPrice;
    for (var i = 1; i < list.length; i += 1) {
      if (list[i].minPrice < min) min = list[i].minPrice;
      if (list[i].minPrice > max) max = list[i].minPrice;
    }
    return { min: min, max: max };
  }

  function getTimeRange(list) {
    var min = list[0].t;
    var max = list[0].t;
    for (var i = 1; i < list.length; i += 1) {
      if (list[i].t < min) min = list[i].t;
      if (list[i].t > max) max = list[i].t;
    }
    return { min: min, max: max };
  }

  function buildLineChart(points, width, height) {
    if (typeof width !== "number" || !isFinite(width) || width <= 0) {
      width = 340;
    }
    if (typeof height !== "number" || !isFinite(height) || height <= 0) {
      height = 160;
    }

    var list = normalizePoints(points);
    var svg = createSvg(width, height);
    svg.setAttribute("class", "ctrip-line-chart");

    var left = 36;
    var right = 12;
    var top = 16;
    var bottom = 24;
    var plotWidth = Math.max(0, width - left - right);
    var plotHeight = Math.max(0, height - top - bottom);

    if (list.length === 0) {
      var empty = createNode("text", {
        x: roundCoord(width / 2),
        y: roundCoord(height / 2),
        "text-anchor": "middle",
        "font-size": "11",
        fill: COLORS.label,
      });
      empty.textContent = "暂无历史数据";
      svg.appendChild(empty);
      return svg;
    }

    // 只有一个数据点画不出趋势：用一行紧凑提示代替空白图表和坐标轴。
    if (list.length === 1) {
      var single = createSvg(width, 40);
      single.setAttribute("class", "ctrip-line-chart");
      var singleHint = createNode("text", {
        x: roundCoord(width / 2),
        y: "24",
        "text-anchor": "middle",
        "font-size": "11",
        fill: COLORS.label,
      });
      singleHint.textContent = "仅 1 条记录，多打开几次页面后显示趋势";
      single.appendChild(singleHint);
      return single;
    }

    var prices = getPriceRange(list);
    var times = getTimeRange(list);
    var flat = prices.min === prices.max;

    var title = createNode("title");
    title.textContent =
      "最低价 ¥" + prices.min + "，最高价 ¥" + prices.max;
    svg.appendChild(title);

    // 上下各留 10% 余量；价格全相同则居中画水平线。
    var priceLow = flat
      ? prices.min
      : prices.min - (prices.max - prices.min) * 0.1;
    var priceHigh = flat
      ? prices.max
      : prices.max + (prices.max - prices.min) * 0.1;

    function priceY(value) {
      if (flat || priceHigh === priceLow) {
        return top + plotHeight / 2;
      }
      return top +
        ((priceHigh - value) / (priceHigh - priceLow)) * plotHeight;
    }

    // 只有一个时间点时居中。
    function timeX(value) {
      if (times.max === times.min) {
        return left + plotWidth / 2;
      }
      return left +
        ((value - times.min) / (times.max - times.min)) * plotWidth;
    }

    svg.appendChild(
      createNode("line", {
        x1: roundCoord(left),
        y1: roundCoord(top),
        x2: roundCoord(left),
        y2: roundCoord(top + plotHeight),
        stroke: COLORS.axis,
        "stroke-width": "1",
      })
    );
    svg.appendChild(
      createNode("line", {
        x1: roundCoord(left),
        y1: roundCoord(top + plotHeight),
        x2: roundCoord(left + plotWidth),
        y2: roundCoord(top + plotHeight),
        stroke: COLORS.axis,
        "stroke-width": "1",
      })
    );

    if (flat) {
      addLabel(svg, left - 4, top + plotHeight / 2 + 3, "¥" + prices.min, "end");
    } else {
      addLabel(svg, left - 4, top + 8, "¥" + prices.max, "end");
      addLabel(
        svg,
        left - 4,
        top + plotHeight - 2,
        "¥" + prices.min,
        "end"
      );
    }

    if (list.length > 1) {
      var coords = [];
      for (var i = 0; i < list.length; i += 1) {
        coords.push(
          roundCoord(timeX(list[i].t)) + "," +
            roundCoord(priceY(list[i].minPrice))
        );
      }
      svg.appendChild(
        createNode("polyline", {
          points: coords.join(" "),
          fill: "none",
          stroke: COLORS.line,
          "stroke-width": "2",
          "stroke-linejoin": "round",
          "stroke-linecap": "round",
        })
      );
    }

    for (var j = 0; j < list.length; j += 1) {
      svg.appendChild(
        createNode("circle", {
          cx: roundCoord(timeX(list[j].t)),
          cy: roundCoord(priceY(list[j].minPrice)),
          r: "2.5",
          fill: COLORS.point,
        })
      );
    }

    var firstLabel = formatDate(times.min);
    var lastLabel = formatDate(times.max);
    if (firstLabel === lastLabel) {
      addLabel(svg, left + plotWidth / 2, height - 6, firstLabel, "middle");
    } else {
      addLabel(svg, left, height - 6, firstLabel, "start");
      addLabel(svg, left + plotWidth, height - 6, lastLabel, "end");
    }

    return svg;
  }

  function buildSparkline(points, width, height) {
    if (typeof width !== "number" || !isFinite(width) || width <= 0) {
      width = 96;
    }
    if (typeof height !== "number" || !isFinite(height) || height <= 0) {
      height = 28;
    }

    // 只使用最近 20 个点。
    var list = normalizePoints(points).slice(-SPARKLINE_LIMIT);
    var svg = createSvg(width, height);
    svg.setAttribute("class", "ctrip-sparkline");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");

    if (list.length === 0) return svg;

    var padX = 2;
    var padY = 3;
    var plotWidth = Math.max(0, width - padX * 2);
    var plotHeight = Math.max(0, height - padY * 2);

    // 只有一个点时画一条短水平线。
    if (list.length === 1) {
      svg.appendChild(
        createNode("line", {
          x1: roundCoord(padX),
          y1: roundCoord(height / 2),
          x2: roundCoord(width - padX),
          y2: roundCoord(height / 2),
          stroke: COLORS.line,
          "stroke-width": "2",
          "stroke-linecap": "round",
        })
      );
      return svg;
    }

    var prices = getPriceRange(list);
    var times = getTimeRange(list);
    var flat = prices.min === prices.max;
    var coords = [];

    for (var i = 0; i < list.length; i += 1) {
      var x =
        times.max === times.min
          ? padX + plotWidth / 2
          : padX +
            ((list[i].t - times.min) / (times.max - times.min)) * plotWidth;
      var y = flat
        ? height / 2
        : padY +
          ((prices.max - list[i].minPrice) / (prices.max - prices.min)) *
            plotHeight;
      coords.push(roundCoord(x) + "," + roundCoord(y));
    }

    svg.appendChild(
      createNode("polyline", {
        points: coords.join(" "),
        fill: "none",
        stroke: COLORS.line,
        "stroke-width": "2",
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      })
    );

    return svg;
  }

  return {
    buildSparkline: buildSparkline,
    buildLineChart: buildLineChart,
  };
});
