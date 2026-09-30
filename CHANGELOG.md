# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [1.2.0] — 2026-09-30

> **主题**：正确性修复（P0 全清）+ Cloudflare 过盾

### 新增

- **Cloudflare 过盾（自动检测 + 自动通过）**
  - **挑战检测器**（`src/core/cf-detector.js`）：基于响应头 / HTML / 页面标题 / 帧树四类证据，
    识别 `jsd` / `managed` / `turnstile` / `block` 四种挑战。**强证据单独定案，弱信号（如 `server: cloudflare`）永不误报**。
  - **自动过盾**：检测到挑战后按类型分流——非交互式挑战等待自动通过；
    Turnstile 支持键盘导航方式触发（默认关闭，仅限自有/授权站点）。
  - **绝不假装成功**：过盾失败时明确告知并给出建议（关无头 / 换出口 IP / 手动介入），
    结果写入 `metadata.json.cf` 供追溯。
  - UI 新增「反爬处理」配置组；开启过盾时**自动关闭无头模式**（无头更易被识别）并提示。
  - 全程可被「停止」中断。

- **HAR 响应体（`content.text`）**：这是本次最重要的能力补齐，见下方「修复」。

- 新增测试：`test/unit-p0.js`（22 项）、`test/unit-cf-detector.js`（32 项）、
  `test/e2e-p0-acceptance.js`（14 项真实 E2E）、`test/e2e-cf.js`（10 项 CF 集成 E2E）
- 新增 npm scripts：`test:unit` / `test:p0` / `test:cf` / `test:all`

### 修复

- **HAR 是「空壳」——响应体从未写入**（CRITICAL）
  此前抓取虽拿到了响应体并写入磁盘，却**没有写进 HAR**。导出的 `network.har`
  在 Chrome DevTools / Charles / Postman 中「有请求无内容」，与实际使用场景严重不符。
  现通过 `HarBuilder.attachBody()` 把响应体写入 `content.text`（base64 内容带 `content.encoding`）。
  **体积保护**：超过 1MB 的 body 不内联，改为 `_bodyOmitted` + `_bodyFile` 指向磁盘文件，避免 `.har` 膨胀到 GB 级。
  *实测证据：`example.com` 抓取后 `content.text` 长度 1769，且与磁盘文件**字节完全一致**。*

- **`Runtime.enable` 暴露自动化特征给 Cloudflare**（HIGH）
  `rebrowser-patches` 项目实证：`Runtime.enable` 的使用**可被页面侧 JS 检测**，
  Cloudflare / DataDome 均在使用该技术识别自动化。
  经实测确认 `Runtime.evaluate` **无需 `enable` 即可工作**，而本引擎对 Runtime 域的
  唯一用途就是 `evaluate`（导出 DOM / 滚动），**从不消费任何 Runtime 事件**——
  故直接移除该调用，零功能损失。*实测：移除后 38 项原有测试全绿，`page.html` 正常产出。*

- **事件分发缺陷：并发 `waitFor` 互相失效**（HIGH）
  原实现用「替换单例 `onEvent` 再包一层」实现 `waitFor`，两个并发 `waitFor`
  会互相覆盖包装器，导致其中一个**永远收不到事件**（静默超时）。
  重构为「订阅者集合 `_listeners` + 一次性等待器集合 `_waiters`」，二者互不干扰；
  订阅者抛出异常不再影响其他订阅者与等待器。

- **命中缓存导致资源漏抓**（HIGH）
  未调用 `Network.setCacheDisabled`，二次抓取同站点时 Chrome 命中磁盘缓存、
  不保留响应体，`Network.getResponseBody` 返回 `-32000 No data found`，资源被静默跳过。
  现于 `Network.enable` 后强制禁用缓存。

- **「停止」按钮不生效**（HIGH）
  CDP 命令超时长达 60s、取响应体 30s，其间点「停止」毫无反应。
  新增 `CDPClient.abortAll()`：中止时立即 reject 所有在途命令与等待器；
  且中止不再被误计为「抓取失败」。

- **懒加载漏抓**（HIGH）
  原滚动按预设轮次「滚完就停」——对无限滚动页面（高度持续增长）漏抓，
  对短页面又浪费轮次。现改为**检测 `scrollHeight` 是否停止增长**：连续 2 轮不变且已到底则提前结束；
  每轮后等待网络空闲而非固定延迟。

- **超长文件名截断失效**（HIGH）
  `safeFileName` 中 `slice(0, maxLen - ext.length)` 在扩展名本身超长时参数为负，
  返回空串 → 结果退化为「纯扩展名」，**且长度远超 maxLen**（实测输入 501 字符 → 输出 621 字符），
  多个文件互相覆盖。现限制扩展名配额并加兜底硬截断，**保证结果永不超过 maxLen**。
  *实测：修复后 5/8/16/32/64/120 六档 maxLen × 5 类极端输入全部满足契约。*

- **滚动阶段总时长失控**（HIGH，修复提交过程中自查发现）
  改为「检测高度稳定」后，`_scrollPage` 每轮都调用 `_waitNetworkIdle()`，
  而后者每次上限是完整的 `timeout`（默认 45s）→ 最坏 50 轮 × 45s ≈ **37 分钟**，
  静默违反超时契约。现为滚动阶段设立**共享总预算**（`deadline`），
  每轮只消耗剩余预算，并给 `_waitNetworkIdle` 增加 `budgetMs` 参数。

- **浏览器崩溃后在途命令要等 30–60s 才失败**（MEDIUM）
  `ws.on("close")` 此前只广播 `disconnected` 事件，不清理在途 `send()`；
  浏览器意外崩溃时，`Network.getResponseBody` 等命令要各自等到超时才返回。
  现断连时一并调用 `abortAll()`，挂起命令立即失败。

### 测试

| 套件 | 项数 | 结果 |
|------|-----:|------|
| P0 定点单测（`test/unit-p0.js`） | 26 | ✅ |
| CF 检测器单测（`test/unit-cf-detector.js`） | 32 | ✅ |
| 边界与异常（`test/edge-cases.js`） | 20 | ✅ |
| 单元 + 集成（`test/test.js`） | 38 | ✅ |
| **小计** | **116** | ✅ 全通过 |
| P0 真实 E2E 验收（`test/e2e-p0-acceptance.js`） | 14 | ✅ |
| CF 集成 E2E（`test/e2e-cf.js`） | 10 | ✅ |
| UI 真实渲染验证（`test/e2e-ui.js`） | 16 | ✅ |

**稳定性与并发**（本次实测）：

| 测试 | 结果 |
|------|------|
| Soak 6 轮连续抓取 | ✅ 6/6 成功，heap +0.9MB，**进程零泄漏** |
| 并发 3 压测 | ✅ 3/3 成功，峰值 67 进程 → 结束 31，**零残留**，端口 3/3 释放 |
| 打包（NSIS + portable） | ✅ 各 107MB，新模块已入 asar |

**贡献说明**：上述「滚动总时长失控」「断连未清理在途命令」「safeFileName 小 maxLen 违契」
三项由独立审查代理在交叉审查中发现，已全部修复并补回归测试。

---

## [1.1.0] — 2026-09-30

> **主题**：内置浏览器 + 登录态抓取

### 新增

- **内置浏览器（按需下载）**：没有安装 Chrome/Edge 的用户也能开箱即用。
  - 自动从 **Chrome for Testing** 官方 CDN 下载，支持**国内镜像自动回退**（`registry.npmmirror.com`）
  - 双资产可选：完整 Chrome（196MB，支持可见窗口登录）或 Headless Shell（115MB，体积更小）
  - 下载进度实时显示；解压后缓存复用，无需重复下载
  - 原子落盘 + 版本戳，避免半包与重复安装

- **登录态抓取（专用 profile）**：可抓取需要登录的网站。
  - 提供「打开登录窗口」→ 用户登录一次 → 关闭 → 抓取自动带会话
  - Profile 模式可选：**临时**（抓完即弃）或**持久**（长期复用）
  - 使用工具专属 profile 目录，**绝不读写用户日常浏览器的数据**
  - 支持多账号（多个命名 profile）

- **自定义浏览器路径**：可手动指定任意 Chromium 内核浏览器

- **实用增强**
  - 新增 `test/e2e-login.js`：登录态持久化端到端验证
  - 新增 `test/e2e-combo.js`：内置浏览器 + 登录态 + 抓取组合验证
  - 新增 `test/bench.js`：并发压测（成功率 / 进程峰值 / 泄漏检测 / 端口释放）
  - UI 增加浏览器来源选择、下载进度条、登录态管理区块

### 修复

- **`abort()` 无效**：此前点击「停止」在导航阶段完全无效，`run()` 仍返回"成功"。
  现改为多阶段检查点 + 可中断等待，正确返回 `{aborted:true}` 并发出 `aborted` 事件。
- **半截文件风险**：所有写盘改为**原子写**（先写 `.part` 再 `rename`），
  磁盘满或崩溃不再留下损坏文件。
- **浏览器中途断连被静默忽略**：现检测 `disconnected` 事件并在结果中标记
  `connectionLost`，避免把"残缺结果"当成功交付。
- **同名资源互相覆盖**：带 query 的 URL 现附加短 hash 消歧（`app.js?v=1` ≠ `app.js?v=2`）。

### 安全

- **IPC 输入校验**：`capture:start` 的浏览器来源 / profile 名 / asset 均做白名单与边界校验
- **路径穿越防护**：profile 名经安全化（`../../etc` → `______etc`），确保不逃出 profiles 目录
- **`cleanupEphemeral` 删除范围收窄**：仅删除 temp 下带 `gsc-ephemeral-` 前缀的目录
- **应用退出清理**：`before-quit` 与 `window-all-closed` 双重兜底关闭浏览器，防孤儿进程

### 测试

| 套件 | 项数 | 结果 |
|------|-----:|------|
| 单元 + 集成（`npm test`） | 31 | ✅ 全通过 |
| 登录态 E2E（`npm run test:login`） | 6 | ✅ 全通过 |
| 组合 E2E（`npm run test:combo`） | 11 | ✅ 全通过 |
| **合计** | **48** | ✅ |

**压测数据**（并发抓取）：

| 并发 | 成功率 | 平均耗时 | 进程峰值 | 结束进程 | 泄漏 | 端口释放 |
|-----:|-------:|---------:|---------:|---------:|-----:|---------:|
| 3 | 100% | 13.9s | — | 基线 | **0** | 3/3 |
| 5 | 100% | 37.3s | 101 | 基线 | **0** | 5/5 |

> 结论：并发 ≤ 3 时性能良好；并发 5 呈超线性退化（资源竞争），建议默认并发不超过 3。

---

## [1.0.0] — 2026-09-29

### 新增

- 首个版本：基于 Chrome DevTools Protocol 的网站源码抓取工具
- **源码资源抓取**：JS / CSS / 字体 / WASM，保留原始目录结构（`source/<host>/…`）
- **HAR 网络数据包**：符合 HAR 1.2 规范，可导入 Chrome DevTools / Charles / Fiddler / Postman
- **页面快照**：保存 JS 执行后的完整 DOM（非原始 HTML）
- **媒体资源**：图片 / 视频 / 音频，按需开启
- **懒加载触发**：可配置滚动次数
- **可视化界面**：实时进度、文件列表、目录树、日志
- **跨平台**：Windows / macOS / Linux，自动探测 Chrome / Edge / Brave / Chromium
- Electron 桌面应用；支持打包为 NSIS 安装版与 portable 免安装版

### 技术要点

- 自研极简 CDP 客户端（运行时依赖仅 `ws`）
- 核心引擎与 Electron 解耦，可独立用于 CLI / CI
- WebSocket 握手不发送 `Origin` 头（Chrome DevTools 端点会校验，否则 403）
- 独立 profile 启动，不污染用户浏览器数据
- `contextIsolation: true` + `nodeIntegration: false` + preload 白名单
