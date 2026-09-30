# GetSourceCode — v1.2.0 迭代任务状态

> 主控代理（Orchestrator）维护。只记录事实与证据，不记录私有推理。
> 本轮完成时间：2026-09-30

## 本轮目标（用户授权全部阶段）

1. **P0 正确性修复**（6 项，含 1 项联网调研新发现）
2. **P1 稳定性修复**（可中断 / 断连清理 / 总时长预算）
3. **Cloudflare 过盾**（检测 + 自动通过 + UI）
4. **真实 E2E 验收 + 独立审计 + 压测 + 稳定性**
5. **提交、推送 main、创建 Release v1.2.0**

**明确排除**：线上部署（用户明确要求不做）

---

## 任务图与完成状态

| # | 子任务 | 状态 | 交付物 | 验收证据 |
|---|--------|------|--------|---------|
| P0-1 | CDPClient 事件分发重构 | ✅ | `cdp-client.js` | 6 项单测；原有 38 项全绿 |
| P0-2 | HAR 响应体注入 | ✅ | `har-builder.js` + engine | E2E：`content.text` 长度 1769，**与磁盘字节一致** |
| P0-3 | safeFileName 截断修复 | ✅ | `mime-utils.js` | 6 档 maxLen × 5 类输入全满足契约 |
| P0-4 | 禁用缓存 | ✅ | `capture-engine.js` | E2E 二次抓取 saved=1 未丢 body |
| P0-5 | 健壮滚动 | ✅ | `capture-engine.js` | E2E 滚动执行 + 高度检测生效 |
| P0-6 | 移除 Runtime.enable | ✅ | `capture-engine.js` | 实测 evaluate 无需 enable；38 项回归全绿 |
| P0-7 | 滚动总时长预算（审查发现） | ✅ | `capture-engine.js` | 静态断言 + 共享 deadline |
| P1-1 | 可中断 CDP（abortAll） | ✅ | `cdp-client.js` | 4 项单测，中止 <2s 生效 |
| P1-2 | 断连清理在途命令（审查发现） | ✅ | `cdp-client.js` | 单测：断连后 <2s 失败 |
| C1 | CF 挑战检测器 | ✅ | `cf-detector.js`（新） | 32 项单测 + 真实浏览器零误报 |
| C3 | 浏览器内过盾 | ✅ | `capture-engine.js` | 10 项 CF E2E |
| C4 | UI 开关与反馈 | ✅ | `index.html` / `renderer.js` | 16 项 UI 验证（含点击联动） |
| T1 | 独立代码审查 | ✅ | 审查报告 | 发现 3 真实缺陷，全部修复 |
| T2 | HAR 规范审计 | ✅ | 审计报告 | 见下 |
| T3 | 全量回归 | ✅ | — | **116 项单测全绿** |
| T4 | E2E 验收 | ✅ | — | P0 14 项 + CF 10 项 + UI 16 项 |
| T5 | 压测 + 稳定性 | ✅ | — | 并发 3 → 100%；soak 6 轮零泄漏 |
| T6 | 打包验证 | ✅ | `dist/*.exe` | NSIS + portable 各 107MB，含新模块 |
| T7 | 文档三件套 | ✅ | CHANGELOG / README / 本文档 | — |
| T8 | 提交 + 推送 main | ✅ | — | `8f01dcd` → `origin/main` |
| T9 | Tag + Release | ✅ | GitHub Release | https://github.com/lza6/Get-source-code/releases/tag/v1.2.0 |
| T10 | Release 附件真实下载验证 | ✅ | — | SHA256 与本地一致、PE 头有效、**实际启动成功** |
| T11 | CI 重复发布根因修复 | ✅ | `.github/workflows/build.yml` | 见下 |

---

## 发布过程发现并修复的问题（T11）

**现象**：tag 推送后 CI 产生了**两个** v1.2.0 Release（一个 Draft、一个 Published），
且 Published 中有重复安装包（`GetSourceCode-Setup-*.exe` 与 `GetSourceCode.Setup-*.exe` 同内容异名）。

**根因**（来自 CI 日志原文）：
```
• Implicit publishing triggered by git tag. This behavior will be disabled
  in electron-builder v27. Please use --publish explicitly.  tag=v1.2.0
• publishing publisher=Github (owner: lza6, project: Get-source-code)   ← 出现两次
• creating GitHub release reason=release doesn't exist tag=v1.2.0
```
`electron-builder` 检测到 git tag + `GH_TOKEN` 后**隐式发布**，与
`softprops/action-gh-release` 形成**两个发布者**竞争 → 重复 Release 与重复附件。

**修复**：
1. `package.json` → `build` 加 `--publish never`，禁用隐式发布，使 Action 成为唯一发布者
2. `build.yml` → Create Release 补传 `dist/latest.yml`（禁用隐式发布后该文件将丢失，影响自动更新）
3. `build.yml` → **移除 `continue-on-error: true`**（此前 JS 语法错误无法被 CI 捕获）

**验证**：本地 `npm run build` 日志中 `Implicit publishing` 与 `publishing` **均已消失**，构建正常产出。

**线上清理**：删除 Draft Release、删除重复附件、按 v1.1.x 规范命名重新上传。

---

## Release 附件验证（T10，真实下载）

| 验证项 | 方法 | 结果 |
|--------|------|------|
| 可下载 | `gh release download v1.2.0` | ✅ 107MB |
| 完整性 | 下载包 SHA256 vs 本地产物 | ✅ **完全一致** |
| 有效性 | PE 头校验 | ✅ `4d5a` (`MZ`) |
| **可运行** | 实际启动 + CDP 探测 | ✅ UA 显示 `GetSourceCode/1.2.0 Electron/44.4.5` |
| 功能存在 | 打包版 UI 检查 | ✅ `cf:true, cfGroup:true`（CF 开关与反爬分组均在） |

**Release 最终附件**：
```
GetSourceCode-1.2.0-portable.exe          107MB
GetSourceCode.Setup.1.2.0.exe             107MB
GetSourceCode.Setup.1.2.0.exe.blockmap    115KB
latest.yml                                355B
```

---

## 验证日志（全部实际执行）

| 时间 | 动作 | 命令 | 结果 |
|------|------|------|------|
| 基线 | 原有测试 | `node test/test.js` | 38/38 ✅ |
| P0 后 | P0 定点单测 | `node test/unit-p0.js` | 26/26 ✅ |
| P0 后 | CF 检测器单测 | `node test/unit-cf-detector.js` | 32/32 ✅ |
| P0 后 | 边界测试 | `node test/edge-cases.js` | 20/20 ✅ |
| P0 后 | 全量回归 | `npm run test:all` | **116/116 ✅** |
| P0 后 | 真实 E2E | `node test/e2e-p0-acceptance.js` | 14/14 ✅ |
| CF 后 | CF 集成 E2E | `node test/e2e-cf.js` | 10/10 ✅ |
| CF 后 | UI 真实渲染 | `node test/e2e-ui.js` | 16/16 ✅ |
| 稳定性 | Soak 6 轮 | `node test/soak.js 6` | 6/6，heap +0.9MB，进程零泄漏 ✅ |
| 并发 | 压测并发 3 | `node test/bench.js 3` | 3/3，峰值 67→31，零残留 ✅ |
| 打包 | NSIS+portable | `npm run build` | 成功，新模块入 asar ✅ |

**验证总数：116（单元/集成）+ 40（E2E/UI）+ 6（soak）+ 3（并发）= 165 项**

---

## 关键实测证据

### HAR 响应体（P0-2）—— 此前恒为空

```
▶ 样例证据: https://example.com/s.js
  content.mimeType = text/javascript
  content.size     = 2153
  content.text     = "var B=document.body,P,i,j,p,f;B.children[0].insertAdjacentHTML(..."
  text 长度         = 1769
  ⇒ 内联 body 与磁盘文件字节一致：一致 1/1
  ⇒ HAR 体积受控：7.9 KB
```

### Runtime.enable 移除（P0-6）—— 实测证明可行

```
--- 未调用 Runtime.enable，直接 Runtime.evaluate ---
✅ 成功: {"title":"Example Domain","url":"https://example.com/"}
--- 对照：补一次 Runtime.enable 后再 evaluate ---
✅ 成功: Example Domain
```
移除后 38 项原有测试全绿，`page.html` 产出 23210 字节正常。

### UI 交互反馈（C4）—— 用户关心的"点击后有反馈"

```
✓ 勾选后 Turnstile 行显示  — flex
✓ 勾选过盾后无头模式被自动关闭  — headless=false
✓ 日志给出了无头模式提示（有反馈）
```

---

## 独立审查发现（已全部修复）

| # | 缺陷 | 严重度 | 由谁发现 | 修复 |
|---|------|--------|---------|------|
| 1 | `_scrollPage` 每轮吃满 timeout → 最坏 37 分钟 | HIGH | 审查代理 | 共享 deadline 预算 + `budgetMs` 参数 |
| 2 | `ws.on("close")` 不清理在途 send → 崩溃后等 30–60s | MEDIUM | 审查代理 | 断连时调用 `abortAll()` |
| 3 | `safeFileName` 小 maxLen 下仍超限 | LOW | 审查代理 | 扩展名配额 + 兜底硬截断 |
| 4 | `_dispatch` 中 `w.resolve` 在 disconnected 分支 | 无问题 | — | 逻辑正确（走 reject 分支） |
| 5 | `attachBody` 用解码后 size 判定 | 无问题 | — | 符合 HAR 规范 |
| 6 | `close()`/`abortAll()` 竞态 | 无问题 | — | 无竞态 |

> **审查结论摘要**：核心重构（`_dispatch` / `abortAll` / `waitFor`）逻辑**正确**；
> C 项（attachBody 体积判定）按 HAR 规范站得住；真正值得修的是滚动总时长，已修。

---

## 已识别风险（本轮未消除，如实披露）

| 风险 | 状态 | 说明 |
|------|------|------|
| CF 过盾不保证 100% 通过 | 已知 | CF 是持续对抗；工具提供手段但不承诺结果；失败时明确告知 |
| 纯协议 `cf_clearance` 未实现 | **未做** | 受 JA3 限制（Node TLS 栈 ≠ Chrome），收益低于成本，留待 v2.0 |
| Turnstile 交互自动点击 | 默认关闭 | 采用键盘导航（FlareSolverr 思路）；需用户显式开启 |
| iframe / OOPIF 内容导出 | **未覆盖** | `Runtime.evaluate` 不带 contextId，跨源 iframe 不导出；属既有局限 |
| `Runtime.enable` 相关测试为静态断言 | 已知 | 可被动态方式绕过；E2E 已提供行为级证据作为补充 |

---

## 本轮不做（明确排除）

- 线上部署（用户明确要求）
- 第三方商业过盾 API 集成
- 批量/并发绕过 CF（合规红线）
- puppeteer / playwright 等重型依赖（破坏零原生依赖卖点）

---

## 下一步（v2.0 方向）

详见 `计划书/下一步改进指南.md`：S1 HAR 完整化（WS 帧）/ S2 sourcemap 还原 /
S3 依赖图 / S4 接口清单 / S5 站点镜像 / S6 任务系统 / C2 纯协议求解。
