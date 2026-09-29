# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

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
