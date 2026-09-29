# 一键CDP获取网站源代码 (GetSourceCode)

基于 **Chrome DevTools Protocol (CDP)** 的网站源码 / 网络数据包可视化抓取工具（Electron 桌面应用）。

---

## 目录

- [1. 需求与目标](#1-需求与目标)
- [2. 技术选型](#2-技术选型)
- [3. 架构设计](#3-架构设计)
- [4. 核心流程](#4-核心流程)
- [5. 关键技术点](#5-关键技术点)
- [6. 数据结构](#6-数据结构)
- [7. 打包与分发](#7-打包与分发)

---

## 1. 需求与目标

### 背景
逆向分析、安全测试、竞品研究时，开发者需要反复手动操作 F12 → Network → 逐条另存资源，效率极低。

### 目标
一键完成：
1. 抓取站点的 **JS / CSS / 字体** 等源码资源（保留目录结构）
2. 记录完整**网络数据包**（HAR 1.2，可导入 DevTools）
3. 保存 **JS 执行后**的页面 DOM 快照
4. （可选）抓取媒体文件

### 非目标
- 不做爬虫（不遍历站内链接）
- 不做登录态破解
- 不绕过反爬机制（提供人工介入手段）

---

## 2. 技术选型

| 维度 | 选择 | 理由 |
|------|------|------|
| 外壳 | **Electron 44** | 跨平台、生态成熟、可直接复用 Node 生态 |
| 抓取核心 | **自研 CDP 客户端** | 无需 puppeteer（体积大、自带 Chromium）、无需 chrome-remote-interface（依赖多）；Electron 已内置 WebSocket |
| 前端 | **原生 HTML/CSS/JS** | 零构建、零框架、体积最小、启动最快 |
| 打包 | **electron-builder** | 同时产出 NSIS 安装版与 portable 免安装版 |
| CDP 通信 | **ws** | 唯一运行时依赖 |

### 为什么不用 Puppeteer？
1. Puppeteer 自带一份 Chromium（~300MB），本工具只需连接**用户已装的浏览器**
2. Puppeteer 的 API 封装会隐藏 CDP 细节，而我们恰恰需要精细控制 `Network.getResponseBody`
3. 体积：自研方案运行时依赖仅 `ws`（~100KB）

---

## 3. 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                        Electron 主进程                        │
│  ┌──────────────┐   IPC    ┌──────────────────────────────┐  │
│  │  主窗口       │ <──────> │  main.js                     │  │
│  │  (Chromium)  │          │   - 窗口管理                  │  │
│  └──────┬───────┘          │   - 文件对话框                │  │
│         │ contextBridge    │   - IPC 路由                  │  │
│         ▼                  └───────────┬──────────────────┘  │
│  ┌──────────────┐                      │                     │
│  │  preload.js  │                      ▼                     │
│  │  (白名单 API) │          ┌──────────────────────────────┐  │
│  └──────────────┘          │  CaptureEngine (核心)         │  │
│                            │   ├─ BrowserLauncher         │  │
│                            │   ├─ CDPClient               │  │
│                            │   ├─ HARBuilder              │  │
│                            │   └─ MimeClassifier          │  │
│                            └───────────┬──────────────────┘  │
└────────────────────────────────────────┼─────────────────────┘
                                         │ WebSocket (CDP)
                                         ▼
                            ┌──────────────────────────────┐
                            │  Chrome / Edge (独立 profile) │
                            │  --remote-debugging-port=9333 │
                            └──────────────────────────────┘
```

### 分层原则
- **core/** 与 Electron **完全解耦** → 可独立用于 CLI、服务端、CI
- **main/** 只做进程编排与系统集成
- **renderer/** 只做展示与交互，无 Node 权限

---

## 4. 核心流程

```
1. 用户点击「开始抓取」
2. BrowserLauncher.launch()
   ├─ 检查端口 9333 是否已有浏览器（复用）
   └─ 否则 spawn 浏览器 + 独立 profile
3. CDPClient.connect()  → WebSocket 握手
4. Target.createTarget  → 新建标签页
5. Target.attachToTarget → 获取 sessionId（flatten 模式）
6. Network.enable / Page.enable / Runtime.enable
7. Page.navigate(targetUrl)
8. 监听 Network.responseReceived
   ├─ MimeClassifier.classify(url, mime, type)
   ├─ 判断类别是否需要保存
   ├─ Network.getResponseBody(requestId)  → 获取响应体
   └─ 按 buildLocalPath() 写入磁盘
9. 等待网络空闲（连续 3 次轮询无新请求）
10. （可选）滚动触发懒加载 → 再次等待空闲
11. Runtime.evaluate("document.documentElement.outerHTML") → page.html
12. HARBuilder.build() → network.har
13. 写 metadata.json（含目录树与统计）
```

---

## 5. 关键技术点

### 5.1 WebSocket 握手必须无 Origin 头 ⚠️
Chrome 的 DevTools 端点会**校验 Origin**。若发送 `Origin: http://127.0.0.1` 等非允许值，会返回 **403**。

```js
// ✅ 正确：不设置 origin
new WebSocket(url, { maxPayload: 512 * 1024 * 1024 });

// ❌ 错误：会被 403 拒绝
new WebSocket(url, { origin: "http://127.0.0.1" });
```

### 5.2 flatten 会话模式
`Target.attachToTarget({ flatten: true })` 后，所有 `send()` 需带 `sessionId`，事件也需按 `sessionId` 过滤（多标签页场景）。

### 5.3 响应体获取的两种编码
```js
const body = await cdp.send("Network.getResponseBody", { requestId });
const buf = body.base64Encoded
  ? Buffer.from(body.body, "base64")   // 二进制（图片/字体）
  : Buffer.from(body.body, "utf8");    // 文本（JS/HTML）
```

### 5.4 响应体可能已释放
若请求完成太久，Chrome 会释放 body 缓存，`getResponseBody` 返回：
```
-32000: No data found for resource with given identifier
```
处理：捕获异常 → 标记 `skipped` → 继续（不影响整体）。

### 5.5 大响应体
`Network.enable` 需设置足够的缓冲区，否则大文件会失败：
```js
Network.enable({
  maxResourceBufferSize: 512 * 1024 * 1024,
  maxTotalBufferSize: 1024 * 1024 * 1024,
})
```

### 5.6 反自动化检测
启动参数中移除 `enable-automation` 开关，降低被识别概率：
```
--disable-blink-features=AutomationControlled
--excludeSwitches=enable-automation
```

### 5.7 独立 profile
使用 `--user-data-dir=<temp>`，避免与用户日常浏览器争用 profile 锁（否则会打开失败或复用用户标签页）。

---

## 6. 数据结构

### 6.1 metadata.json
```jsonc
{
  "tool": "GetSourceCode",
  "version": "1.0.0",
  "targetUrl": "https://example.com",
  "capturedAt": "2026-01-01T00:00:00.000Z",
  "browser": "Chrome/151.0.7922.172",
  "stats": { "saved": 56, "failed": 8, "skipped": 0, "bytes": 3354781 },
  "resources": [
    { "url": "...", "kind": "source", "ext": "js", "mime": "text/javascript",
      "size": 42880, "file": "source/.../app.js", "status": 200 }
  ],
  "tree": { "name": "...", "type": "dir", "children": { /* 目录树 */ } }
}
```

### 6.2 资源分类

| kind | 内容 | 目录 |
|------|------|------|
| `source` | JS / CSS / 字体 / WASM | `source/<host>/…` |
| `media` | 图片 / 视频 / 音频 | `media/<host>/…` |
| `other` | JSON / XML / 文本 | `other/<host>/…` |
| `html` | 渲染后 DOM | `page.html` |

### 6.3 HAR 1.2
标准格式，关键字段：
```
log.entries[].request       { method, url, headers, queryString, postData }
log.entries[].response      { status, headers, content, redirectURL }
log.entries[].timings       { send, wait, receive }
log.entries[]._resourceType CDP 的 resource type（非标准扩展字段）
```

---

## 7. 打包与分发

```bash
npm run build            # NSIS 安装版 + portable 免安装版
npm run build:portable   # 仅 portable
npm run build:dir        # 不打安装包，仅生成可运行目录（调试用）
```

产物：
```
dist/
├── GetSourceCode Setup 1.0.0.exe        安装版
├── GetSourceCode-1.0.0-portable.exe     免安装版
└── win-unpacked/                         未压缩目录
```

---

## 附录：CDP 命令清单

本工具使用的 CDP 方法与事件：

| 类型 | 名称 | 用途 |
|------|------|------|
| 命令 | `Target.createTarget` | 新建标签页 |
| 命令 | `Target.attachToTarget` | 附加会话（flatten） |
| 命令 | `Page.enable` | 启用 Page 域 |
| 命令 | `Page.navigate` | 导航 |
| 命令 | `Runtime.enable` | 启用 Runtime 域 |
| 命令 | `Runtime.evaluate` | 执行 JS（导出 DOM） |
| 命令 | `Network.enable` | 启用 Network 域 |
| 命令 | `Network.getResponseBody` | 取响应体 |
| 命令 | `Emulation.setDeviceMetricsOverride` | 设置视口 |
| 事件 | `Page.loadEventFired` | 页面加载完成 |
| 事件 | `Network.requestWillBeSent` | 请求发出 |
| 事件 | `Network.responseReceived` | 响应到达 |
| 事件 | `Network.loadingFinished` | 加载完成 |
| 事件 | `Network.loadingFailed` | 加载失败 |
| 事件 | `Network.*ExtraInfo` | 额外头信息 |
