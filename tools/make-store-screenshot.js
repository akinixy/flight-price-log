#!/usr/bin/env node
"use strict";

// 用 Edge / Chrome headless 生成商店素材：
// 1. store/popup-shot.png（380x600，弹窗原图）
// 2. store/screenshot-1.png（1280x800，合成截图）

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { pathToFileURL } = require("url");

const ROOT = path.resolve(__dirname, "..");
const POPUP_PAGE_PATH = path.join(ROOT, "store", "popup-preview.html");
const POPUP_OUT_PATH = path.join(ROOT, "store", "popup-shot.png");
const PAGE_PATH = path.join(ROOT, "store", "screenshot.html");
const OUT_PATH = path.join(ROOT, "store", "screenshot-1.png");
const DASHBOARD_PAGE_PATH = path.join(ROOT, "store", "dashboard-preview.html");
const DASHBOARD_OUT_PATH = path.join(ROOT, "store", "dashboard-screenshot-1.png");
const PROMO_LARGE_PAGE_PATH = path.join(ROOT, "store", "promo-large.html");
const PROMO_LARGE_OUT_PATH = path.join(ROOT, "store", "promo-large-1400x560.png");
const PROMO_SMALL_PAGE_PATH = path.join(ROOT, "store", "promo-small.html");
const PROMO_SMALL_OUT_PATH = path.join(ROOT, "store", "promo-small-440x280.png");

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

function pngSize(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function capture(browser, pagePath, outPath, width, height) {
  const userDataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "flight-price-log-shot-")
  );

  try {
    execFileSync(
      browser,
      [
        "--headless=new",
        "--disable-gpu",
        "--hide-scrollbars",
        "--force-device-scale-factor=1",
        "--allow-file-access-from-files",
        "--user-data-dir=" + userDataDir,
        "--window-size=" + width + "," + height,
        "--virtual-time-budget=6000",
        "--screenshot=" + outPath,
        pathToFileURL(pagePath).href,
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const size = pngSize(fs.readFileSync(outPath));
  if (!size || size.width !== width || size.height !== height) {
    throw new Error(
      path.basename(outPath) +
        " 尺寸不正确: " +
        (size ? size.width + "x" + size.height : "unknown")
    );
  }
}

function main() {
  const browser = findBrowser();
  if (!browser) {
    console.error(
      "[make-store-screenshot] 找不到 Edge 或 Chrome，可用 EDGE_PATH 指定。"
    );
    process.exitCode = 1;
    return;
  }

  try {
    capture(browser, POPUP_PAGE_PATH, POPUP_OUT_PATH, 380, 600);
    console.log(
      "[make-store-screenshot] wrote " +
        path.relative(process.cwd(), POPUP_OUT_PATH) +
        " (380x600)"
    );

    capture(browser, PAGE_PATH, OUT_PATH, 1280, 800);
    console.log(
      "[make-store-screenshot] wrote " +
        path.relative(process.cwd(), OUT_PATH) +
        " (1280x800)"
    );

    capture(browser, DASHBOARD_PAGE_PATH, DASHBOARD_OUT_PATH, 1280, 800);
    console.log(
      "[make-store-screenshot] wrote " +
        path.relative(process.cwd(), DASHBOARD_OUT_PATH) +
        " (1280x800)"
    );

    capture(browser, PROMO_LARGE_PAGE_PATH, PROMO_LARGE_OUT_PATH, 1400, 560);
    console.log(
      "[make-store-screenshot] wrote " +
        path.relative(process.cwd(), PROMO_LARGE_OUT_PATH) +
        " (1400x560)"
    );

    capture(browser, PROMO_SMALL_PAGE_PATH, PROMO_SMALL_OUT_PATH, 440, 280);
    console.log(
      "[make-store-screenshot] wrote " +
        path.relative(process.cwd(), PROMO_SMALL_OUT_PATH) +
        " (440x280)"
    );
  } catch (error) {
    console.error("[make-store-screenshot] " + error.message);
    process.exitCode = 1;
  }
}

main();
