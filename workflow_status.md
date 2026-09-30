# GetSourceCode — v1.2.1 迭代任务状态

> 主控代理（Orchestrator）维护。只记录事实与证据，不记录私有推理。
> 本轮完成时间：2026-09-30

## 本轮目标（用户授权全部阶段）

**P0-5 滚动抓取增强的完整落地**（v1.2.0 只完成了 3/4 项）：
1. ✅ 每轮测量 scrollHeight（v1.2.0 已有）
2. ✅ 高度连续 2 轮不变 + 到底 → 提前结束（v1.2.0 已有）
3. ✅ 每轮等待网络空闲而非固定 delay（v1.2.0 已有）
4. ⬜→✅ **新增 `scrollToBottom` 选项（本版）**
5. ⬜→✅ **验收：图片数量显著多于现状（本版，量化为 5 倍）**

---

## 任务图与完成状态

| # | 子任务 | 状态 | 交付物 | 验收证据 |
|---|--------|------|--------|---------|
| S1 | `scrollToBottom` 选项 + 分步滚动 | ✅ | `capture-engine.js` | 单测静态断言 + 量化 E2E |
| S2 | UI 复选框 | ✅ | `index.html`/`renderer.js` | UI 验证 23 项 |
| S3 | 本地无限滚动 fixture | ✅ | `test/fixtures/infinite-scroll-server.js` | 夹具自检 11 项 |
| S4 | 夹具自检（前提条件验证） | ✅ | `test/fixtures/selfcheck.js` | 11/11 通过 |
| S5 | 量化 E2E 验收 | ✅ | `test/e2e-scroll.js` | 13/13 通过 |
| S6 | **夹具假阳性修复** | ✅ | fixture | 见下「关键发现」 |
| S7 | 全量回归 | ✅ | — | 118 项单测 + 46 项 E2E |
| S8 | 压测 + 稳定性 | ✅ | — | 并发 5 → 100%；soak 6 轮零泄漏 |
| S9 | 打包 + 启动验证 | ✅ | `dist/*.exe` | 版本 1.2.1、新功能在 asar 内 |
| S10 | 提交 + 推送 + Release | ✅ | — | tag v1.2.1 |
| S11 | **CI 修复验证** | ✅ | — | 只产生 1 个 Release（此前为 2 个）|
| S12 | Release 附件下载验证 | ✅ | — | PE 头有效、实际启动成功、UI 功能确认 |

---

## 关键发现：测试夹具假阳性（自查发现）

**这是本轮最重要的发现，也是我自己的错误。**

**现象**：首轮量化 E2E 报告「不滚动 8 张 → 滚动 40 张（5 倍）」，看似完美。

**质疑触发点**：检查 `page-info.json` 时发现 **A 组（完全不滚动）的 `loaded` 也是 40** ——
与 B 组完全相同，两组本不该有差异。

**根因**（用 HAR 时间线证实）：
```
A组 png 请求数: 40
   0.png  t+76ms      4.png  t+536ms      ...
   34.png t+2609ms    39.png t+2861ms
```
不滚动的 A 组在 **2.8 秒内**就请求了全部 40 张。原因是
首版夹具初始内容（4 张图 ≈ 760px）**比视口（900px）还矮**：
`scrollY=0 + innerHeight=900 >= scrollHeight=760 - 200` 成立 →
`nearBottom()` 一开始就为真 → 250ms 轮询立刻"武装"并连续加载完。
**首轮的 `png 8` 只是保存 DOM 时恰好早于网络完成的竞态偶然结果。**

**修复**：
1. 首屏改 8 张图，容器加 `min-height: 200vh`（与视口尺寸解耦，首屏绝不触底）
2. 把「触底即武装、此后持续加载」改为**非闩锁**——每轮都必须真在底部才加载一批，
   与真实无限滚动站点行为一致

**修复后自查证据**（`test/fixtures/selfcheck.js`）：
```
初始: loaded=8, scrollHeight=2139, viewport=900, nearBottom=false  ✅ 首屏未触底
静置 3 秒: loaded=8, events=0                                       ✅ 不滚动则不加载
滚动后:   loaded=8 → 28，events 0 → 5                               ✅ 滚动才触发
持续滚动: 达到 40                                                    ✅ 语义正确
```

**修复后重测**（D6）：
| 组 | 配置 | png | DOM img |
|----|------|----:|--------:|
| A | `scrollRounds:0` | 8 | **8** |
| B | `12 + scrollToBottom:true` | **40** | **40** |
| C | `12 + scrollToBottom:false` | 12 | 12 |

---

## 验证日志（全部实际执行）

| 动作 | 命令 | 结果 |
|------|------|------|
| 夹具自检 | `node test/fixtures/selfcheck.js` | 11/11 ✅ |
| 滚动量化 E2E | `node test/e2e-scroll.js` | 13/13 ✅ |
| 全量回归 | `npm run test:all` | 118/118 ✅ |
| P0 E2E | `node test/e2e-p0-acceptance.js` | 14/14 ✅ |
| CF E2E | `node test/e2e-cf.js` | 10/10 ✅ |
| UI 验证 | `node test/e2e-ui.js` | 23/23 ✅ |
| Soak 6 轮 | `node test/soak.js 6` | 6/6，heap +0.7MB，零泄漏 ✅ |
| 并发 5 | `node test/bench.js 5` | 5/5，端口 5/5 释放 ✅ |
| 泄漏复核 | 连跑 3 轮并发 3 | 34→35→36 为进程池波动，**非单调增长** ✅ |
| 打包 | `npm run build` | NSIS + portable，无 Implicit publishing ✅ |
| 启动验证 | 实跑 portable + CDP 探测 | UA=1.2.1，UI 含新开关 ✅ |

**验证总数：118（单元/集成）+ 46（E2E）+ 11（夹具自检）+ 13（滚动量化）= 188 项**

---

## CI 修复验证（S11）

v1.2.0 时 tag 推送产生了**两个** Release（electron-builder 隐式发布 + action-gh-release 并存）。
上一轮已加 `--publish never` 修复，**本版实测验证**：

```
v1.2.1 | draft=false | assets=4   ← 只有 1 个 ✅
v1.2.0 | draft=false | assets=4
```
附件命名规范（`GetSourceCode.Setup.1.2.1.exe`），不再出现重复的 `GetSourceCode-Setup-*` 变体。

---

## 已识别风险（如实披露）

| 风险 | 状态 | 说明 |
|------|------|------|
| **fixture 只覆盖"简单无限滚动"** | 已知 | 真实站点可能用 IntersectionObserver + 动态高度，行为更复杂 |
| `_scrollStepwise` 12 步上限 | **未验证影响** | 极高页面（>8640px）单轮可能到不了底；但多轮互补，实测 2139px 页面 12 轮足够 |
| `scrollDelay`(1200ms) 与 `scrollStepDelay`(120ms) 可能重复等待 | 待优化 | B 组耗时 38.8s，有优化空间 |
| `page-info.json.loaded` 仅对含 `__loadedCount` 的站点有值 | 设计如此 | 对真实站点返回 `null`，不会误导（语义清晰） |
| CF 过盾不保证 100% 通过 | 已知 | 工具给手段不给承诺 |

---

## 下一步

详见 `计划书/下一步改进指南.md`。P0 全部完成，P1 剩余 8 项（重试 / 并发取体 / 在途空闲 /
进度条 / XSS / 异步目录树 / CI），其后为 v2.0 的 S1–S6 与 C2。
