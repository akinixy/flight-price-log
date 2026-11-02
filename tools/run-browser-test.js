#!/usr/bin/env node
"use strict";

// 用 Edge / Chrome headless 运行浏览器内测试页。
// 测试页把结果写入 <div id="result" data-result="pass|fail">；
// 本脚本据 data-result 决定退出码：0 = 通过，1 = 失败，2 = 环境或用法错误。
// 用法：node tools/run-browser-test.js <html-path>

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const BROWSER_CANDIDATES = [
  process.env.EDGE_PATH,
  process.env.CHROME_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

function findBrowser() {
  for (const candidate of BROWSER_CANDIDATES) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function extractResultTag(dom) {
  const openTag = /<div[^>]*\bid="result"[^>]*>/i.exec(dom);
  return openTag ? openTag[0] : "";
}

// 只检查 #result 元素自身，避免页面里的 CSS 或脚本文本误命中。
function isPass(dom) {
  return /\bdata-result="pass"/i.test(extractResultTag(dom));
}

function extractResultText(dom) {
  const openTag = /<div[^>]*\bid="result"[^>]*>/i.exec(dom);
  if (!openTag) return "";

  const start = openTag.index + openTag[0].length;
  const end = dom.indexOf("</div>", start);
  if (end === -1) return "";

  return decodeEntities(dom.slice(start, end)).trim();
}

function reportFailure(dom, detail) {
  console.error("FAIL: " + (detail || "页面未输出 data-result=\"pass\""));

  const resultText = dom ? extractResultText(dom) : "";
  if (resultText) {
    console.error("页面结果: " + resultText);
  }

  if (dom) {
    const resultTag = /<div[^>]*\bid="result"[^>]*>/i.exec(dom);
    const markerAt = resultTag
      ? resultTag.index
      : dom.indexOf('data-result="fail"');
    const start = Math.max(0, markerAt - 200);
    const fragment = dom.slice(start, start + 1200);
    if (fragment) {
      console.error("--- DOM 片段 ---");
      console.error(fragment);
    }
  }
}

function run() {
  const target = process.argv[2];
  if (!target) {
    console.error("用法: node tools/run-browser-test.js <html-path>");
    return 2;
  }

  const htmlPath = path.resolve(target);
  if (!fs.existsSync(htmlPath)) {
    console.error("[browser-test] 找不到测试页面: " + htmlPath);
    return 2;
  }

  const browser = findBrowser();
  if (!browser) {
    console.error(
      "[browser-test] 找不到 Edge 或 Chrome。请安装浏览器，或用 EDGE_PATH 指定可执行文件路径。"
    );
    return 2;
  }

  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "ctrip-browser-test-")
  );
  const pageUrl = pathToFileURL(htmlPath).href;
  // 测试页可用 <meta name="virtual-time-budget" content="15000"> 声明自己需要的虚拟时间。
  let virtualTime = process.env.BROWSER_VIRTUAL_TIME || "";
  if (!virtualTime) {
    try {
      const page = fs.readFileSync(htmlPath, "utf8");
      const match = /<meta\s+name="virtual-time-budget"\s+content="(\d+)"/i.exec(page);
      if (match) virtualTime = match[1];
    } catch (error) {
      // 读不到就用默认值。
    }
  }
  if (!virtualTime) virtualTime = "3000";

  let dom = "";
  let runError = null;

  try {
    dom = execFileSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--no-first-run",
        "--allow-file-access-from-files",
        "--user-data-dir=" + userDataDir,
        "--virtual-time-budget=" + virtualTime,
        "--dump-dom",
        pageUrl,
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 32 * 1024 * 1024,
      }
    );
  } catch (error) {
    runError = error;
    dom = error.stdout ? String(error.stdout) : "";
  }

  try {
    if (isPass(dom)) {
      const resultText = extractResultText(dom);
      console.log(resultText || "PASS: " + pageUrl);
      return 0;
    }

    if (runError) {
      const stderr = runError.stderr ? String(runError.stderr).trim() : "";
      console.error("[browser-test] 浏览器执行失败: " + runError.message);
      if (stderr) console.error(stderr.slice(0, 2000));
    }

    reportFailure(dom, runError ? "浏览器执行失败或页面未通过" : "");
    return 1;
  } finally {
    try {
      fs.rmSync(userDataDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch (cleanupError) {
      console.error(
        "[browser-test] 清理临时目录失败: " + cleanupError.message
      );
    }
  }
}

process.exit(run());
