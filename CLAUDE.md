# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

「航班价格记录簿」是一个 Microsoft Edge（Manifest V3）扩展：在携程中国大陆国内单程航班列表页被动采集价格，按航线、日期、舱位记录在本机，弹窗与独立仪表盘展示历史。

无 package.json、无第三方依赖、无构建步骤；扩展源码目录可直接作为未打包扩展加载。

## 硬性约束

- 只申请 `storage` 权限，不声明 `host_permissions`；扩展本身不发起任何网络请求（无 fetch/XHR），不做后台轮询、通知或远程同步。新增权限或网络调用属于范围变更，需要先讨论。
- 内容脚本只匹配 `https://flights.ctrip.com/online/list/*`。
- 所有数据只写入 `chrome.storage.local`，键为 `ctripRoutes`、`ctripDeleted`、`ctripClearedAt`、`ctripSettings`。
- 商店文案（README 以外的提交资料）不得提及其他浏览器（如 Chrome），也不得暗示与携程存在官方关联；保持「非官方工具」声明。
- 无头浏览器访问真实携程页面会被风控拦截（`whaleguard block`），不要用它做自动化验证；用 `test-fixtures.js` 和合成 DOM。
- 真实页面偶发 `whaleguard block` 属于携程服务端风控，可能与广告拦截器（uBlock/AdGuard）、VPN 出口、未登录态有关；不是扩展的 bug，也不要在扩展里尝试绕过。

## 常用命令

```bash
node tools/run-all-tests.js                 # 全部测试：Node 单测 + 浏览器测试页 + 语法检查
node --test test/merge.test.js              # 单个 Node 测试文件
node tools/run-browser-test.js test-popup.html  # 单个浏览器测试页
node tools/serve-tests.js                   # 本地静态服务 http://127.0.0.1:8420，用于在浏览器里看测试页
node tools/build-package.js                 # 生成 dist/flight-price-log-<version>.zip
node tools/make-icons.js                    # 重新生成 icons/
node tools/make-store-logo.js               # 生成 store/logo-300.png
node tools/make-store-screenshot.js         # 生成商店截图与促销磁贴（会校验尺寸）
node tools/build-fixtures.js [页面.html]     # 从保存的真实页面裁剪 test-fixtures.js
```

浏览器测试默认查找 Edge/Chrome，可用 `EDGE_PATH` / `CHROME_PATH` 指定；虚拟时间由测试页里的 `<meta name="virtual-time-budget">` 控制。

## 架构与数据流

内容脚本按 manifest 顺序加载，彼此通过全局 `CtripFlight` / `CtripParser` / `CtripAutoScroll` 协作：

1. `src/content/ctrip.js` 监听 DOM，`parser.js` 从页面 DOM 和 `<script>` 文本解析快照（航司、航班号、起降时间、价格）。
2. 自动采集：`autoscroll.js` 以约 0.7 秒一屏的速度连续滚动触发分批渲染，中途不停顿；用户滚动/点击/按键时立即中断，只有正常结束才恢复原滚动位置；`ctrip.js` 控制节奏（连续匀速滚动、只在到达底部后等待新批次约 1 秒、总预算 60 秒、只在到达底部后计空闲，停滚后观察 20 秒延迟加载：新批次优先直接合并，必要时补采一轮），识别到 whaleguard 拦截页后停止。
3. 快照通过 `chrome.runtime.sendMessage`（`RECORD_SNAPSHOT` + `pageStartedAt`）发给 `src/background.js`，经 `shared/record.js` 的 `applySnapshot` 交给 `shared/merge.js` 合并后写入存储。
4. 路由键格式 `oneway:出发代码-到达代码:YYYY-MM-DD:舱位`；每班身份是 `canonicalNo|departTime|arriveTime`；每班价格序列嵌在 `route.flightHistory`（样本 `[t, price]`）。
5. 删除/清空会写墓碑时间（`ctripDeleted` / `ctripClearedAt`），配合 `pageStartedAt` 防止删除前打开的旧页面把数据写回来。
6. 容量预算集中在 `src/shared/flight.js`（每班 240 样本、300 条序列、单航线 200 条、保留 90 天等），全部 copy-on-write；`background.js` 捕获 `QUOTA_BYTES` 后用 `compactRoutes` 压缩重试。

模块写成双环境封装：Node 下 `module.exports`，浏览器下挂到 `globalThis`（如 `CtripRecord`、`CtripStore`），因此扩展代码可以被 `test/*.test.js` 直接 require。

## 界面

- 弹窗（`src/popup/`）：按「出发地 → 目的地」分组，组间按组内最近记录时间倒序、组内按出发日期升序；每张日期卡片标题行右侧的「再查一次」使用采集时保存的 `route.url` 直达携程页面；卡片内可展开航班明细并按价格/用时/起飞排序；删除、清空均有二次确认；导入导出走 `shared/backup.js`（备份 v2，兼容 v1）。
- 仪表盘（`src/dashboard/`）：同时是 `options_ui`（新标签页打开），只读；包含统计概览、日期对比、航班 × 日期矩阵、单航班趋势和样本表，数据模型在 `src/shared/model.js`；顶部「导出报告」通过 `src/shared/report.js` 生成可离线打开、可打印为 PDF 的单文件 HTML 报告。

## 测试约定

- Node 测试在 `test/*.test.js`（`node:test` + `assert/strict`）。
- 浏览器测试页在仓库根目录（`test-autoscroll.html` 等），页面把结果写入 `<div id="result" data-result="pass|fail">`，`tools/run-browser-test.js` 据此判定退出码。
- 改数据形状、备份格式或 manifest 时，同步更新对应的 `test/*.test.js`；改弹窗结构时同步 `test-popup.html`。
- 测试数据要能区分「排序生效」和「按插入顺序」：需要时调整夹具写入顺序，避免断言失去区分力。
- 手动验收：`edge://extensions` 开启开发人员模式 →「加载解压缩的扩展」选择仓库根目录，改代码后点卡片上的「刷新」。

## 发布流程

1. 更新 `manifest.json` 的 `version`；CHANGELOG 的开发中条目从「未发布」改为「版本号 — 日期」。
2. `node tools/run-all-tests.js`，再 `node tools/build-package.js`。
3. 提交并推送，打 tag `vX.Y.Z`，`gh release create` 上传 `dist/flight-price-log-X.Y.Z.zip`。
4. 商店资料：`docs/store-listing.md` 和 `dist/edge-upload/`（含 `partner-center-submission.md`、`listing.txt`、截图与促销磁贴）。`dist/` 被 gitignore，需要本地重建。
5. 商店要求版本号单调递增，且每个版本的程序包内容应与 tag 和 Release 资产一致。
6. `docs/` 是 GitHub Pages 产品页与隐私政策，部署地址 `https://akinixy.github.io/flight-price-log/`（隐私政策 `…/privacy-policy.html`），改版本号时同步页脚；Partner Center 的网站/支持地址以 `partner-center-submission.md` 为准。

## 仓库约定

- 不提交 `dist/`、`preview-popup.html`、`.superpowers/`（见 `.gitignore`）。
- 不使用框架、转译或第三方依赖；代码风格跟随所在文件：内容脚本用 `var`/`function` 的 IIFE，后台与弹窗使用 `const`/`async`。新增依赖或构建步骤需要先讨论。
- 界面与注释使用中文；价格一律显示人民币。
- Git 提示 LF→CRLF 是 Windows 下 `core.autocrlf` 的正常现象。
- 推送若报 `Recv failure: Connection was reset`，先用 `git -c http.version=HTTP/1.1 push` 重试（当前网络下 HTTP/2 到 github.com 会失败）。
