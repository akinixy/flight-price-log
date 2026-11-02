(function (root, factory) {
  "use strict";

  var api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.CtripFormat = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var CABIN_LABELS = {
    y_s_c_f: "全部舱位",
    y: "经济舱",
    s: "超级经济舱",
    c: "公务舱",
    f: "头等舱",
  };

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function formatAmount(n) {
    var text = String(n);
    var parts = text.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  }

  function formatPrice(n) {
    return "¥" + formatAmount(n);
  }

  function formatDateLabel(iso, now) {
    if (now === undefined) now = new Date();

    var parts = iso.split("-");
    // 用拆分后的数字构造本地 Date，避免 new Date(iso) 按 UTC 解析造成时区偏移。
    var date = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var label = date.getMonth() + 1 + "月" + date.getDate() + "日";

    if (date.getFullYear() !== now.getFullYear()) {
      return date.getFullYear() + "年" + label;
    }
    return label;
  }

  function formatTimestamp(epoch, now) {
    if (now === undefined) now = new Date();

    var date = new Date(epoch);
    var label =
      date.getMonth() + 1 + "月" + date.getDate() + "日 " +
      pad2(date.getHours()) + ":" + pad2(date.getMinutes());

    if (date.getFullYear() !== now.getFullYear()) {
      return date.getFullYear() + "年" + label;
    }
    return label;
  }

  function formatCabin(cabin) {
    return Object.prototype.hasOwnProperty.call(CABIN_LABELS, cabin)
      ? CABIN_LABELS[cabin]
      : cabin;
  }

  function formatDelta(current, previous) {
    if (previous === null || previous === undefined) return "";

    var diff = current - previous;
    if (diff > 0) return "+¥" + formatAmount(Math.abs(diff));
    if (diff < 0) return "-¥" + formatAmount(Math.abs(diff));
    return "持平";
  }

  // 把 "20:25" / "10:35+1" 解析成分钟数；+N 表示跨 N 天。
  function parseClock(value) {
    var match = /^(\d{1,2}):(\d{2})(?:\+(\d+))?$/.exec(
      String(value === undefined || value === null ? "" : value).trim()
    );
    if (!match) return null;

    var hours = Number(match[1]);
    var minutes = Number(match[2]);
    var days = match[3] ? Number(match[3]) : 0;
    if (hours > 23 || minutes > 59) return null;
    return hours * 60 + minutes + days * 1440;
  }

  // 总用时：起降时间差；跨天未标注 +N 时按次日计算。
  function formatDuration(departTime, arriveTime) {
    var depart = parseClock(departTime);
    var arrive = parseClock(arriveTime);
    if (depart === null || arrive === null) return "—";

    var diff = arrive - depart;
    if (diff === 0) return "—";
    if (diff < 0) diff += 1440;

    var hours = Math.floor(diff / 60);
    var minutes = diff % 60;
    if (hours === 0) return minutes + "分";
    if (minutes === 0) return hours + "小时";
    return hours + "小时" + minutes + "分";
  }

  // 排序用的分钟数；无法解析时返回 Infinity，保证排在最后。
  function clockMinutes(value) {
    var minutes = parseClock(value);
    return minutes === null ? Infinity : minutes;
  }

  function durationMinutes(departTime, arriveTime) {
    var depart = parseClock(departTime);
    var arrive = parseClock(arriveTime);
    if (depart === null || arrive === null) return Infinity;

    var diff = arrive - depart;
    if (diff === 0) return Infinity;
    if (diff < 0) diff += 1440;
    return diff;
  }

  return {
    formatPrice: formatPrice,
    formatDateLabel: formatDateLabel,
    formatTimestamp: formatTimestamp,
    formatCabin: formatCabin,
    formatDelta: formatDelta,
    formatDuration: formatDuration,
    clockMinutes: clockMinutes,
    durationMinutes: durationMinutes,
  };
});
