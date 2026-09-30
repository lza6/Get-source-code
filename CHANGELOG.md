# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [1.2.2] — 2026-09-30

> **主题**：消除全部剩余风险（R1–R4）+ CF 状态反馈缺陷修复

### 修复

- **CF 状态反馈完全失效**（HIGH，本版最重要的修复）
  `_emit(type, payload)` 实现为 `{ type, ...payload }`，而 CF 事件用
  `{ type: verdict.type }` 传挑战类型 → **payload 的 `type` 覆盖了事件名**。
  导致 `renderer.js` 中 `case "cf:detected"` / `"cf:passed"` / `"cf:failed"`
  **三个分支永远不会命中** —— 界面上检测到 Cloudflare、过盾成功/失败**没有任何提示**，
  用户无从得知发生了什么。
  **修复**：`_emit` 改为 `{ ...payload, type }`（事件名不可被覆盖），
  CF 事件改用 `challengeType` 字段承载挑战类型。
  **该缺陷此前逃过了全部测试** —— 现有单测只验证事件被发出，没有任何测试覆盖
  「主进程事件 → UI 渲染」这一段。本版为此新增 `preload.__testDispatch` 测试通道
  与 6 项 UI 反馈断言，实测可捕获该缺陷。

### 改进（剩余风险 R1–R4）

- **R2：分步滚动步数按距离推导**（`_scrollStepwise`）
  原先硬编码 12 步上限，极高页面（>8640px）单轮**永远到不了底部**，
  因而不会触发懒加载。现改为 `steps = ceil(distance / step)`，
  仅保留 3000 步防御性上限，并接受 `deadlineFn` 让总时长可控。
  *验收：800vh 极高页面实测 `__loadedCount=40`（全部加载完成）。*

- **R3：消除 `scrollDelay` 与网络空闲的重复等待**
  原先每轮「先固定睡满 1200ms，再等网络空闲」，两者叠加。
  现以网络空闲为主判据，仅当它**很快**判定空闲（说明懒加载尚未发出请求）时
  才补足 `delay` 作为最小间隔，补齐后再等一次空闲。
  *验收：B 组 42.0s、E 组（高页）25.6s，功能未受影响。*

- **R1：夹具新增 IntersectionObserver 模式 + 极高页面模式**
  - `?mode=io` —— 用 `IntersectionObserver` 观察哨兵（更接近现代真实站点，
    且**只有真正滚动过**才会触发，正是验证分步滚动必要性的场景）
  - `?tall=1` —— 容器 800vh，制造需要多步滚动才能到底的极高页面
  *验收：IO 模式 png 8→40；高页面 40/40。*

- **R4：CF 失败由「不可控」变为「可诊断」**
  CF 过盾本质是概率性的（CF 持续对抗），无法靠代码消除。改为：
  - `_buildCfNextSteps(type)` 按挑战类型（jsd/managed/turnstile/block）给出**可操作**建议
  - UI 逐条展示建议（此前只有一句笼统的"失败了"）
  - `metadata.json.cf` 新增 `attempts[]`（每次尝试结果）与 `nextSteps[]`
  - 明确区分「硬封禁」（换 IP）与「超时」（调参/手动介入）

### 测试

| 套件 | 项数 | 结果 |
|------|-----:|------|
| P0 定点单测 | 34 | ✅ |
| CF 检测器单测 | 32 | ✅ |
| 边界与异常 | 20 | ✅ |
| 单元 + 集成 | 38 | ✅ |
| **小计** | **124** | ✅ |
| UI 真实渲染（含 CF 反馈链路） | 30 | ✅ |
| CF E2E（含失败路径） | 21 | ✅ |
| 夹具自检 | 11 | ✅ |
| 滚动量化 E2E（A/B/C/D/E 五组） | 19 | ✅ |

**滚动增强五组量化结果**：

| 组 | 场景 | png | DOM img | 耗时 |
|----|------|----:|--------:|-----:|
| A | 不滚动（基线） | 8 | 8 | 10.5s |
| B | 滚动到底 | **40** | **40** | 42.0s |
| C | 按比例滚动 | 16 | 16 | 50.2s |
| D | IntersectionObserver 模式 | **40** | **40** | 40.9s |
| E | 极高页面（800vh） | **40** | **40** | 25.6s |

---

## [1.2.1] — 2026-09-30

> **主题**：滚动抓取增强（P0-5 完整落地）

### 新增

- **`scrollToBottom` 选项**：滚动模式可选
  - `true`（默认）每轮把页面推到**底部**，适合无限滚动（每次到底触发追加）
  - `false` 按比例逐屏推进，适合固定高度页面
  - UI 新增「滚动到底部模式」复选框
- **分步滚动**（`_scrollStepwise`）：不再一次性 `scrollTo(largeValue)`，
  改为每步不超过一屏地推进。依赖 `IntersectionObserver` 的懒加载实现
  不再因"瞬移"而漏触发。
- **`page-info.json` 增强**：新增 `images` / `scripts` / `loaded` 字段，
  可直接观察懒加载是否真的被触发（`images` 为 DOM 中实际渲染的图片数）。
- **本地无限滚动测试夹具**（`test/fixtures/infinite-scroll-server.js`）
  - 纯 Node 内置模块，零依赖，不访问外网
  - 首屏 8 张图 + `min-height:200vh`（保证首屏绝不触底，与视口无关）
  - 必须在**真正滚动到底部**时才追加，每次 4 张直到 40 张
  - 同时绑定 `scroll` 事件与 250ms 轮询（兼容 CDP 的 `scrollTo` 不触发 scroll）
  - 附 `test/fixtures/selfcheck.js`：**验证夹具本身可靠**
- 新增 `npm run test:scroll` / `test:fixture`

### 修复（本版最重要的部分）

- **测试夹具假阳性**（HIGH，自查发现）
  首版夹具初始内容（4 张图 ≈ 760px）**比视口（900px）还矮**，
  导致 `nearBottom()` 一开始就为真 → 250ms 轮询立刻把 40 张全部加载完。
  实测证据：`scrollRounds:0`（完全不滚动）的 A 组，**2.8 秒内**也抓到了全部 40 张 png。
  基于它的「滚动带来 5 倍提升」结论**不成立**。
  **修复**：首屏改 8 张图 + 容器 `min-height:200vh`（与视口尺寸解耦），
  并把"触底即武装后持续加载"改为**非闩锁**（每轮都必须真在底部才加载），
  使其与真实无限滚动站点行为一致。
  修复后自查证据：静置 3 秒 `loaded` 保持 8 不变；滚动后才 8 → 28 → 40。

### 测试

| 套件 | 项数 | 结果 |
|------|-----:|------|
| P0 定点单测 | 28 | ✅ |
| CF 检测器单测 | 32 | ✅ |
| 边界与异常 | 20 | ✅ |
| 单元 + 集成 | 38 | ✅ |
| **小计** | **118** | ✅ |
| UI 真实渲染（`test/e2e-ui.js`） | 23 | ✅ |
| 夹具自检（`test/fixtures/selfcheck.js`） | 11 | ✅ |
| 滚动量化 E2E（`test/e2e-scroll.js`） | 13 | ✅ |

**滚动增强量化验收（本地 fixture，修复夹具后重测）**：

| 组 | 配置 | 抓到 png | DOM 中 img |
|----|------|--------:|-----------:|
| A 基线 | `scrollRounds: 0` | 8 | **8** |
| B 增强 | `scrollRounds: 12` + `scrollToBottom: true` | **40** | **40** |
| C 对照 | `scrollRounds: 12` + `scrollToBottom: false` | 12 | 12 |

- 提升幅度：**8 → 40（5 倍）**，达到手册要求的"显著多于现状"
- **决定性证据**：DOM 中实际渲染的 `img` 数 8 → 40（比网络抓取更直接，排除重复抓取干扰）
- 两种滚动模式均有效；`scrollToBottom` 在无限滚动场景下明显优于按比例（40 vs 12）

**稳定性与并发**：

| 测试 | 结果 |
|------|------|
| Soak 6 轮 | ✅ 6/6，heap +0.7MB，进程零泄漏 |
| 并发 5 压测 | ✅ 5/5 成功，端口 5/5 释放 |
| 并发泄漏复核（连跑 3 轮） | ✅ 基线 34→35→36 为进程池波动，**非单调增长**（真实泄漏会累加） |

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
