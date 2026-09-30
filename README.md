# GetSourceCode

> 一键获取目标网站的**源代码信息**、**网络数据包（HAR）**、**页面快照**与**媒体资源**，方便进行逆向、二次开发与安全分析。
> 基于 **Chrome DevTools Protocol (CDP)** —— 让开发者不再需要手动 F12 逐条另存。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)](#)
[![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron)](https://www.electronjs.org/)

---

## 为什么需要它

逆向分析、安全测试、竞品研究时，我们常常要：

- 打开 F12 → Network → 逐个资源「Open in new tab → 另存为」 ❌ 低效
- 想保留下载后的 JS/CSS 目录结构 ❌ 手动重建
- 想保存完整请求/响应记录 ❌ 只能截图
- 想看 JS 执行后的真实 DOM ❌ 右键「查看源代码」拿不到

**GetSourceCode 把这些变成一次点击。**

---

## 功能特性

| 能力 | 说明 |
|------|------|
| **源码资源抓取** | JS / CSS / 字体 / WASM，按**原始目录结构**保存到 `source/<host>/…` |
| **HAR 网络数据包** | 符合 HAR 1.2 规范，**含响应体**（`content.text`），可直接拖入 Chrome DevTools Network 面板、Charles、Fiddler、Postman |
| **页面快照** | 保存 **JS 执行后**的完整 DOM（非原始 HTML）+ 标题等元信息 |
| **媒体资源** | 图片 / 视频 / 音频，按需开启（体积较大） |
| **懒加载触发** | 自动检测页面高度是否停止增长；可选「滚动到底部」或「按比例逐屏」两种模式，分步滚动避免漏触发 |
| **并发任务捕获** | 监听整个页面生命周期，包括 XHR/Fetch 异步请求 |
| **Cloudflare 过盾** | 自动检测人机验证并尝试通过（jsd / managed / Turnstile），失败时明确告知而非假装成功 |
| **浏览器来源可选** | ① 系统已装 Chrome/Edge ② **内置浏览器**（无浏览器时自动下载）③ 自定义路径 |
| **登录态抓取** | 专用持久 profile，引导登录一次后可抓需登录的网站（**不碰你的日常浏览器数据**） |
| **可视化界面** | 实时进度、文件列表、目录树、日志 |
| **跨平台** | Windows / macOS / Linux，自动探测浏览器 |

### Cloudflare 过盾

部分站点会弹出 Cloudflare 人机验证。勾选「自动检测并尝试通过」后：

1. 工具识别挑战类型（`jsd` / `managed` / `turnstile` / `block`）
2. 非交互式挑战**等待其自动通过**；Turnstile 可选键盘导航触发
3. 通过后继续正常抓取；**未通过则明确告知**，并给出建议（关闭无头 / 更换网络出口 / 手动介入）

**注意事项**：

- 开启过盾时会**自动关闭「无头模式」**——无头浏览器更容易被识别
- 建议仅用于**自有站点或已授权测试**的目标
- Cloudflare 是持续对抗的，**不承诺 100% 通过**
- 过盾结果记录在 `metadata.json` 的 `cf` 字段，便于追溯

> 工具通过移除 `Runtime.enable`（该命令可被页面检测出自动化，`rebrowser-patches` 实证 Cloudflare/DataDome 在用）、
> 强制非无头、等待挑战自然通过等方式提升通过率，**不做指纹伪造**。

### 浏览器来源说明

| 来源 | 适用场景 | 说明 |
|------|---------|------|
| **系统浏览器** | 大多数情况 | 复用已安装的 Chrome / Edge / Brave，零下载 |
| **内置浏览器** | 未安装浏览器 | 从官方 CDN 或**国内镜像**按需下载 Chrome for Testing（约 115–196MB），缓存复用 |
| **自定义路径** | 特殊需求 | 手动指定任意 Chromium 内核浏览器 |

> 下载源支持**国内镜像自动回退**（`registry.npmmirror.com` ↔ `storage.googleapis.com`）。

### 登录态抓取（需登录的网站）

**推荐流程**（安全、不污染你的数据）：

1. Profile 模式切到「**持久**」，填入 profile 名称（如 `work`）
2. 点「**打开登录窗口**」→ 在弹出浏览器里登录目标站点
3. 关闭登录窗口（登录态已保存到工具专用 profile）
4. 开始抓取 → 自动带上登录态

**原理与安全边界**（经实测验证）：

- 工具使用 `userDataDir/profiles/<name>` 作为**独立 profile**，**绝不**读写你日常 Chrome 的 profile
- 复用真实 profile 不可行：Chrome 运行时会返回 `exit 21 (PROFILE_IN_USE)`；Chrome 136+ 对默认目录**禁用 CDP**；强挂载会读到 0 条 cookie 且可能损坏数据
- cookie 由浏览器自身解密后通过 CDP 交出，工具**不触碰** SQLite / DPAPI / App-Bound Encryption

---

## 快速开始

### 方式一：下载免安装版（推荐）

从 [Releases](https://github.com/lza6/Get-source-code/releases) 下载：

- `GetSourceCode-x.x.x-portable.exe` —— 免安装，双击即用
- `GetSourceCode-Setup-x.x.x.exe` —— 安装版（含开始菜单 / 桌面快捷方式）

### 方式二：从源码运行

```bash
git clone https://github.com/lza6/Get-source-code.git
cd Get-source-code
npm install
npm start
```

### 方式三：自行打包

```bash
npm run build            # 生成安装版 + 免安装版
npm run build:portable   # 仅免安装版
```

产物位于 `dist/`。

---

## 使用步骤

1. **填写目标网址**（如 `https://example.com`）
2. **选择保存目录**
3. **勾选抓取内容**（源码 / HAR / 快照 / 媒体）
4. （可选）调整高级选项：无头模式、滚动次数、超时、单文件上限
5. 点击 **开始抓取**

---

## 输出结构

```
保存目录/
├── source/<host>/…      JS、CSS、字体、WASM（保留原始路径）
├── media/<host>/…       图片、视频、音频（开启媒体抓取时）
├── other/<host>/…       JSON、XML 等（含页面调用的 API 响应）
├── page.html            JS 执行后的完整 DOM
├── page-info.json       标题、URL、readyState
├── network.har          完整网络数据包（HAR 1.2）
└── metadata.json        抓取清单与统计
```

示例（抓取某站点）：

```
captures/example/
├── source/example.com/_next/static/chunks/5142.8cc95d.js
├── source/example.com/_next/static/css/app.css
├── other/example.com/api/user/profile.json
├── page.html
├── network.har          ← 107 条请求记录
└── metadata.json
```

---

## HAR 文件的用法

`network.har` 可直接用于：

| 工具 | 用法 |
|------|------|
| **Chrome DevTools** | F12 → Network → 右键 → Import HAR |
| **Charles Proxy** | File → Import… |
| **Fiddler** | File → Import Sessions → HAR |
| **Postman** | Import → 选择 .har 文件，自动生成全部请求 |
| **HAR Analyzer** | 在线工具，查看瀑布图 / 统计 |

---

## 工作原理

```
┌──────────────┐   spawn(--remote-debugging-port)   ┌──────────────┐
│  Electron UI │ ─────────────────────────────────> │  Chrome/Edge │
└──────┬───────┘                                    └──────┬───────┘
       │  IPC                                               │
       ▼                                                    │ WebSocket (CDP)
┌──────────────┐  Network.enable / Page.navigate            │
│ CaptureEngine│ <──────────────────────────────────────────┘
│  ├─ Network.responseReceived → 保存资源
│  ├─ Runtime.evaluate         → 导出 DOM
│  └─ HAR Builder              → 聚合请求记录
└──────────────┘
```

**关键设计**：

- 使用**独立 profile** 启动浏览器，不污染用户日常浏览器数据
- 通过 CDP `Network.getResponseBody` 获取**已解码的响应体**（无需二次请求）
- **不发送 WebSocket `Origin` 头**——这是 CDP 握手成功的关键（Chrome 会校验 Origin）
- 支持**复用**已在调试端口运行的浏览器，避免重复启动

---

## 常见问题

**Q：为什么抓不到某些资源？**
A：可能是 CORS opaque 响应、Service Worker 缓存命中、或响应体已被浏览器释放。日志中会标注 `∅ 跳过` 并说明原因。

**Q：如何抓取需要登录的页面？**
A：取消勾选「无头模式」，在弹出的浏览器窗口里手动登录，再等待抓取完成。

**Q：提示「未检测到浏览器」？**
A：点击浏览器下拉框旁的 `…`，手动选择 Chrome/Edge 的可执行文件。

**Q：某些站点返回 403 / 空白？**
A：可能启用了反爬（Cloudflare 等）。可尝试：(1) 关闭无头模式人工过验证；(2) 增大「额外等待」时间。

**Q：抓取会不会很慢？**
A：取决于站点规模。工具会等待「网络空闲」后结束，也可手动点「停止」提前收工。

---

## 开发

```bash
npm start                # 启动
npm run dev              # 启动（调试）
node test/run-capture.js <url> [outDir]   # 无 UI 自测
```

**目录结构**：

```
src/
├── main/           Electron 主进程（窗口、IPC、菜单）
│   ├── main.js
│   └── preload.js
├── core/           与 Electron 解耦的核心引擎
│   ├── cdp-client.js        极简 CDP 客户端（WebSocket）
│   ├── browser-launcher.js  浏览器探测与启动
│   ├── capture-engine.js    抓取编排（核心）
│   ├── har-builder.js       HAR 1.2 构建
│   └── mime-utils.js        类型分类与路径规划
└── renderer/       前端 UI（原生 HTML/CSS/JS，无框架）
    ├── index.html
    ├── style.css
    └── renderer.js
```

**设计原则**：
- 核心引擎（`src/core/*`）**不依赖 Electron**，可独立用于 CLI / 服务端
- 渲染层**零框架**，降低体积与复杂度
- IPC 白名单（`preload.js`）符合 Electron 安全最佳实践（`contextIsolation: true` + `nodeIntegration: false`）

---

## 免责声明

本工具仅供**合法授权**的用途：

- 对**自有网站**的备份与审计
- **授权范围内**的安全测试与渗透测试
- 逆向工程**学习与研究**

使用者须自行确保符合目标站点的服务条款及所在司法辖区的法律法规。**作者不对任何滥用行为负责。**

---

## 开源协议

[MIT](LICENSE) © lza6
