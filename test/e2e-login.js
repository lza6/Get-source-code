"use strict";

/**
 * E2E：登录态抓取全流程验证
 *
 * 流程：
 *  1. 用持久 profile 启动可见浏览器（模拟"打开登录窗口"）
 *  2. 在页面里写入一个测试 cookie（模拟用户登录后的会话）
 *  3. 关闭浏览器
 *  4. 用同一 profile 重新启动（headless），访问站点
 *  5. 通过 CDP 读取 cookie，验证登录态是否被保留
 *
 * 这验证了「专用 profile + 登录一次 + 复用」这一核心设计是否真的可行。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { BrowserLauncher, detectBrowsers } = require("../src/core/browser-launcher");
const { CDPClient } = require("../src/core/cdp-client");
const { BrowserManager } = require("../src/core/browser-manager");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log("=== E2E: 登录态持久化验证 ===\n");

  const browsers = detectBrowsers();
  if (!browsers.length) {
    console.log("⚠ 无浏览器，跳过");
    process.exit(0);
  }

  const userDataDir = path.join(os.tmpdir(), "gsc-login-e2e-" + Date.now());
  const bm = new BrowserManager({ userDataDir });
  const PROFILE = "e2e-acct";
  const PORT_A = 9701;
  const PORT_B = 9702;
  const TEST_COOKIE = "gsc_login_test";
  const TEST_VALUE = "session_" + Date.now();

  let passed = 0, failed = 0;
  const check = (name, cond, extra) => {
    if (cond) { console.log(`  ✓ ${name}`); passed++; }
    else { console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); failed++; }
  };

  const profile = bm.resolveProfile({ profileMode: "persistent", profileName: PROFILE });
  console.log(`Profile 目录: ${profile.dir}\n`);

  try {
    // ---------- 阶段 1：模拟"登录窗口"（可见浏览器）----------
    console.log("[阶段 1] 打开登录窗口（可见）并写入会话 cookie");
    const launcherA = new BrowserLauncher({
      executablePath: browsers[0].path,
      port: PORT_A,
      headless: false,          // 登录必须可见
      userDataDir: profile.dir,
    });
    await launcherA.launch();
    const cdpA = new CDPClient((await launcherA.isPortAlive()).webSocketDebuggerUrl, { onEvent: () => {} });
    await cdpA.connect();
    const tabA = await launcherA.newTab("about:blank");
    const { sessionId: sidA } = await cdpA.send("Target.attachToTarget", { targetId: tabA.id, flatten: true });
    await cdpA.send("Network.enable", {}, { sessionId: sidA });

    // 写入 cookie（模拟登录）
    const setRes = await cdpA.send("Network.setCookie", {
      name: TEST_COOKIE,
      value: TEST_VALUE,
      domain: "example.com",
      path: "/",
      expires: Math.floor(Date.now() / 1000) + 86400,
    }, { sessionId: sidA });
    check("设置测试 cookie", setRes.success === true);

    // 关闭浏览器（优雅：先 CDP Browser.close，再 kill 兜底）
    await cdpA.send("Browser.close", {}, {}).catch(() => {});
    await sleep(2500);
    await launcherA.close().catch(() => {});
    await sleep(1500);
    cdpA.close();
    console.log("  · 登录窗口已关闭\n");

    // 验证 cookie 文件已落盘
    const st = bm.profileStatus(PROFILE);
    check("cookie 文件已落盘", st.hasCookies, `cookieSize=${st.cookieSize}`);

    // ---------- 阶段 2：抓取（持久 profile，headless）----------
    console.log("[阶段 2] 重新启动（headless）验证登录态保留");
    const profile2 = bm.resolveProfile({ profileMode: "persistent", profileName: PROFILE });
    const launcherB = new BrowserLauncher({
      executablePath: browsers[0].path,
      port: PORT_B,
      headless: true,
      userDataDir: profile2.dir,
    });
    await launcherB.launch();
    const cdpB = new CDPClient((await launcherB.isPortAlive()).webSocketDebuggerUrl, { onEvent: () => {} });
    await cdpB.connect();
    const tabB = await launcherB.newTab("about:blank");
    const { sessionId: sidB } = await cdpB.send("Target.attachToTarget", { targetId: tabB.id, flatten: true });
    await cdpB.send("Network.enable", {}, { sessionId: sidB });

    const cookies = await cdpB.send("Network.getAllCookies", {}, { sessionId: sidB });
    const found = (cookies.cookies || []).find((c) => c.name === TEST_COOKIE);
    check("登录态（cookie）跨启动保留", !!found, found ? "" : "未找到 " + TEST_COOKIE);
    if (found) {
      check("cookie 值一致", found.value === TEST_VALUE);
      console.log(`      cookie: ${found.name}=${found.value.slice(0, 24)}… domain=${found.domain}`);
    }

    // 收尾
    await cdpB.send("Browser.close", {}, {}).catch(() => {});
    await sleep(2000);
    await launcherB.close().catch(() => {});
    cdpB.close();

    // ---------- 阶段 3：临时 profile 不复用 ----------
    console.log("\n[阶段 3] 临时 profile 不应带登录态");
    const eph = bm.resolveProfile({ profileMode: "ephemeral" });
    check("临时 profile 位于 temp 且带唯一后缀", eph.dir.includes("gsc-ephemeral-"));
    check("临时 profile 与持久 profile 不同", eph.dir !== profile.dir);

  } catch (e) {
    console.log(`  ✗ 异常: ${e.message}`);
    failed++;
  } finally {
    // 清理
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
  }

  console.log(`\n${"=".repeat(46)}`);
  console.log(`  E2E 登录态验证：${passed} 通过, ${failed} 失败`);
  console.log(`${"=".repeat(46)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
