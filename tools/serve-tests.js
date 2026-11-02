#!/usr/bin/env node
"use strict";

// 本地静态服务器，仅用于在浏览器预览面板里手动打开测试页。
// 只提供仓库根目录下的文件，并限制在 127.0.0.1。
// 用法：node tools/serve-tests.js [端口]

const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.argv[2] || process.env.TEST_PORT || 8420);
const HOST = "127.0.0.1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
};

const INDEX = [
  "test-autoscroll.html",
  "test-parser.html",
  "test-chart.html",
  "test-popup.html",
];

function listPage() {
  const items = INDEX.map(function (name) {
    return '<li><a href="/' + name + '">' + name + "</a></li>";
  }).join("");
  return (
    "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\">" +
    "<title>测试页</title>" +
    "<style>body{font-family:system-ui,\"Microsoft YaHei\",sans-serif;padding:24px;line-height:1.8}</style>" +
    "</head><body><h1>测试页</h1><p>点击运行；页面顶部会显示 PASS 或 FAIL。</p>" +
    "<ul>" + items + "</ul></body></html>"
  );
}

const server = http.createServer(function (req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch (error) {
    res.writeHead(400);
    res.end("bad request");
    return;
  }

  if (pathname === "/") {
    res.writeHead(200, { "content-type": TYPES[".html"] });
    res.end(listPage());
    return;
  }

  // 只允许访问仓库根目录内的文件，拒绝目录穿越。
  const target = path.resolve(ROOT, "." + pathname);
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  fs.readFile(target, function (error, data) {
    if (error) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const type = TYPES[path.extname(target).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
});

server.listen(PORT, HOST, function () {
  console.log("[serve-tests] http://" + HOST + ":" + PORT + "/");
});
