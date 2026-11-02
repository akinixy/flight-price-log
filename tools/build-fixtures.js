#!/usr/bin/env node
"use strict";

// 从用户保存的真实携程航班列表页裁剪出测试夹具。
// 完整页面不提交仓库，只生成 test-fixtures.js。
// 用法：node tools/build-fixtures.js [源文件路径]

const fs = require("fs");
const path = require("path");

const DEFAULT_SOURCE =
  "E:/Downloads/宜昌到长春机票查询预订-宜昌飞长春特价机票价格-携程飞机票.html";
const OUTPUT_PATH = path.resolve(__dirname, "..", "test-fixtures.js");

const CRITERIA_MARKER = "window['GlobalSearchCriteria'] = ";
const CARD_MARKER = 'class="flight-item domestic"';
const CARD_REQUIRED_MARKERS = ["flight-price", "plane-No"];
const KEEP_CARD_COUNT = 2;

function fail(message) {
  console.error("[build-fixtures] " + message);
  process.exit(1);
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// 从 openIndex 处的 "{" 开始做括号配对，跳过 JSON 字符串中的花括号与转义字符。
function findBalancedBraceEnd(text, openIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }

  return -1;
}

function extractCriteriaScript(html) {
  const start = html.indexOf(CRITERIA_MARKER);
  if (start === -1) {
    fail("源文件中找不到 `" + CRITERIA_MARKER + "`");
  }

  const end = html.indexOf("</script>", start);
  if (end === -1) {
    fail("找不到 GlobalSearchCriteria 所在脚本的 `</script>`");
  }

  return html.slice(start, end);
}

function extractCriteriaJsonText(scriptText) {
  const markerAt = scriptText.indexOf(CRITERIA_MARKER);
  if (markerAt === -1) {
    fail("脚本文本中找不到 `" + CRITERIA_MARKER + "`");
  }

  const open = scriptText.indexOf("{", markerAt + CRITERIA_MARKER.length);
  if (open === -1) {
    fail("GlobalSearchCriteria 标记后没有 `{`");
  }

  const close = findBalancedBraceEnd(scriptText, open);
  if (close === -1) {
    fail("GlobalSearchCriteria JSON 花括号不配对");
  }

  return scriptText.slice(open, close + 1);
}

function findCardStartIndexes(html) {
  const starts = [];
  let from = 0;

  for (;;) {
    const markerAt = html.indexOf(CARD_MARKER, from);
    if (markerAt === -1) break;

    // 标记落在开标签内部，向前退到 "<div" 才是完整元素起点。
    const tagStart = html.lastIndexOf("<div", markerAt);
    if (tagStart === -1) {
      fail("航班卡片标记前找不到 `<div`");
    }

    starts.push(tagStart);
    from = markerAt + CARD_MARKER.length;
  }

  return starts;
}

// 通过 <div>/</div> 配对找到元素的结束位置，避免把父容器的闭合标签带进夹具。
function findElementEnd(html, tagStart) {
  const tagRe = /<div\b|<\/div>/g;
  tagRe.lastIndex = tagStart;

  let depth = 0;
  let match;
  while ((match = tagRe.exec(html))) {
    if (match[0] === "<div") {
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) return match.index + "</div>".length;
      if (depth < 0) return -1;
    }
  }

  return -1;
}

function extractCards(html) {
  const starts = findCardStartIndexes(html);
  if (starts.length === 0) {
    fail("源文件中找不到 `" + CARD_MARKER + "` 航班卡片");
  }

  const cards = [];
  for (const start of starts) {
    const end = findElementEnd(html, start);
    if (end === -1) {
      fail("航班卡片 <div> 配对失败（起点 " + start + "）");
    }

    const card = html.slice(start, end);
    const complete = CARD_REQUIRED_MARKERS.every(function (marker) {
      return card.includes(marker);
    });

    if (complete) {
      cards.push(card);
      if (cards.length === KEEP_CARD_COUNT) break;
    }
  }

  if (cards.length < KEEP_CARD_COUNT) {
    fail(
      "只找到 " +
        cards.length +
        " 张同时包含 " +
        CARD_REQUIRED_MARKERS.join(" 和 ") +
        " 的完整卡片，需要 " +
        KEEP_CARD_COUNT +
        " 张"
    );
  }

  return cards;
}

function extractCityName(html, className) {
  const re = new RegExp('<span class="' + className + '">([^<]*)</span>');
  const match = re.exec(html);
  if (!match) {
    fail("源文件中找不到 `.address ." + className + "` 城市名");
  }

  const name = match[1].trim();
  if (!name) {
    fail("`.address ." + className + "` 城市名为空");
  }

  return name;
}

function buildHeaderHtml(departName, arriveName) {
  return (
    '<div class="result-header"><div class="address">' +
    '<span class="depart">' + escapeHtml(departName) + "</span>" +
    '<i class="arrow-gray-oneway-b"></i>' +
    '<span class="arrive">' + escapeHtml(arriveName) + "</span>" +
    "</div></div>"
  );
}

function buildDomesticHtml(headerHtml, cards) {
  return [
    "<!DOCTYPE html>",
    '<html lang="zh-CN">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>携程航班列表测试夹具</title>",
    "</head>",
    "<body>",
    headerHtml,
    '<div class="flight-list root-flights">',
    cards.join("\n"),
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildCriteriaScript(criteria) {
  return CRITERIA_MARKER + JSON.stringify(criteria) + ";";
}

function main() {
  const sourcePath = process.argv[2] || DEFAULT_SOURCE;

  let html;
  try {
    html = fs.readFileSync(sourcePath, "utf8");
  } catch (error) {
    fail("读取源文件失败：" + sourcePath + "（" + error.message + "）");
  }

  const searchCriteriaScript = extractCriteriaScript(html);
  const criteriaJsonText = extractCriteriaJsonText(searchCriteriaScript);

  let criteria;
  try {
    criteria = JSON.parse(criteriaJsonText);
  } catch (error) {
    fail("GlobalSearchCriteria JSON 解析失败：" + error.message);
  }

  const segment = criteria.flightSegments && criteria.flightSegments[0];
  if (!segment) {
    fail("GlobalSearchCriteria 缺少 flightSegments[0]");
  }

  const cards = extractCards(html);
  const departName = extractCityName(html, "depart");
  const arriveName = extractCityName(html, "arrive");
  const domesticHtml = buildDomesticHtml(
    buildHeaderHtml(departName, arriveName),
    cards
  );

  const staleCriteria = cloneJson(criteria);
  staleCriteria.flightSegments[0].departureDate = "2026-11-01";

  const internationalCriteria = cloneJson(criteria);
  internationalCriteria.flightSegments[0].arrivalCountryId = 2;

  const fixtures = {
    domesticHtml: domesticHtml,
    searchCriteriaScript: searchCriteriaScript,
    staleScript: buildCriteriaScript(staleCriteria),
    internationalScript: buildCriteriaScript(internationalCriteria),
  };

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  const output = "globalThis.CTRIP_FIXTURES = " + JSON.stringify(fixtures) + ";\n";
  fs.writeFileSync(OUTPUT_PATH, output, "utf8");

  console.log(
    "[build-fixtures] wrote " +
      path.relative(process.cwd(), OUTPUT_PATH) +
      " (" +
      Buffer.byteLength(output, "utf8") +
      " bytes, " +
      cards.length +
      " cards, " +
      departName +
      " -> " +
      arriveName +
      ")"
  );
}

main();
