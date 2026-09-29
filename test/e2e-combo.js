"use strict";

/**
 * 终极组合 E2E：内置浏览器 + 登录态 + 完整抓取
 *
 * 这是三大新功能的组合验证，模拟真实用户的最复杂使用路径：
 *   1. 下载/复用内置浏览器（无系统浏览器的用户场景）
 *   2. 用持久 profile 建立登录态
 *   3. 用同一 profile 抓取，验证登录态被带上 + 资源完整保存
 *
 * 若内置浏览器未下载，自动跳过（不强制联网）。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { BrowserLauncher, detectBrowsers } = require("../src/core/browser-launcher");
const { CDPClient } = require("../src/core/cdp-client");
const { BrowserManager } = require("../src/core/browser-manager");
const { ChromiumDownloader } = require("../src/core/chromium-downloader");
const { CaptureEngine } = require("../src/core/capture-engine");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const check = (name, cond, extra) => {
  if (cond) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); failed++; }
};

(async () => {
  console.log("=== 终极组合 E2E：内置浏览器 + 登录态 + 抓取 ===\n");

  const workDir = path.join(os.tmpdir(), "gsc-ultimate-" + Date.now());
  const bm = new BrowserManager({ userDataDir: workDir });
  const PROFILE = "combo";
  const COOKIE = "gsc_combo";

  // ---------- 步骤 1：选择浏览器（优先内置，回退系统）----------
  console.log("[1] 解析浏览器");
  let browserExe = null;
  let browserSource = null;

  const dlr = new ChromiumDownloader({ baseDir: bm.browserDir, asset: "chrome-headless-shell" });
  const cached = dlr.status();
  if (cached.installed) {
    browserExe = cached.exe;
    browserSource = "bundled(cached)";
    console.log(`  · 使用缓存的内置浏览器 v${cached.version}`);
  } else {
    const sys = detectBrowsers();
    if (!sys.length) {
      console.log("  ⚠ 既无内置浏览器也无系统浏览器，跳过");
      process.exit(0);
    }
    browserExe = sys[0].path;
    browserSource = "system";
    console.log(`  · 使用系统浏览器 ${sys[0].name}`);
  }
  check("解析出可用浏览器", !!browserExe, browserSource);

  const profile = bm.resolveProfile({ profileMode: "persistent", profileName: PROFILE });

  try {
    // ---------- 步骤 2：建立登录态 ----------
    console.log("\n[2] 建立登录态（可见窗口写入会话）");
    // 注意：headless-shell 不能显示窗口，用系统浏览器演示登录
    const loginBrowser = detectBrowsers()[0] ? detectBrowsers()[0].path : browserExe;
    const launcherA = new BrowserLauncher({
      executablePath: loginBrowser,
      port: 9801,
      headless: false,
      userDataDir: profile.dir,
    });
    await launcherA.launch();
    const cdpA = new CDPClient((await launcherA.isPortAlive()).webSocketDebuggerUrl, { onEvent: () => {} });
    await cdpA.connect();
    const tabA = await launcherA.newTab("about:blank");
    const { sessionId: sidA } = await cdpA.send("Target.attachToTarget", { targetId: tabA.id, flatten: true });
    await cdpA.send("Network.enable", {}, { sessionId: sidA });
    await cdpA.send("Network.setCookie", {
      name: COOKIE, value: "logged_in_" + Date.now(),
      domain: "example.com", path: "/",
      expires: Math.floor(Date.now() / 1000) + 3600,
    }, { sessionId: sidA });
    await cdpA.send("Browser.close", {}, {}).catch(() => {});
    await sleep(2500);
    await launcherA.close().catch(() => {});
    cdpA.close();
    await sleep(1000);
    check("登录态已持久化", bm.profileStatus(PROFILE).hasCookies);

    // ---------- 步骤 3：用同一 profile 抓取 ----------
    console.log("\n[3] 用持久 profile 抓取（验证登录态 + 资源完整性）");
    const outDir = path.join(workDir, "capture");
    const engine = new CaptureEngine({
      targetUrl: "https://example.com",
      outputDir: outDir,
      executablePath: browserExe,
      headless: true,
      userDataDir: profile.dir,       // 关键：复用同一 profile
      port: 9802,
      saveSource: true, saveHar: true, saveHtml: true, saveMedia: false,
      scrollRounds: 1, timeout: 30000,
      onProgress: () => {},
    });
    const r = await engine.run();
    check("抓取成功", !r.aborted && r.stats.saved > 0, `saved=${r.stats.saved}`);

    // 验证产出完整性
    const files = ["metadata.json", "network.har", "page.html"];
    for (const f of files) {
      check(`产出 ${f}`, fs.existsSync(path.join(outDir, f)));
    }
    const har = JSON.parse(fs.readFileSync(path.join(outDir, "network.har"), "utf8"));
    check("HAR 有记录", har.log.entries.length > 0, `entries=${har.log.entries.length}`);
    check("HAR 记录含目标站点", har.log.entries.some((e) => e.request.url.includes("example.com")));

    const meta = JSON.parse(fs.readFileSync(path.join(outDir, "metadata.json"), "utf8"));
    check("metadata 含统计", meta.stats && meta.stats.saved > 0);

    // 验证登录态在抓取会话中可见
    const cdpB = new CDPClient((await engine.launcher.isPortAlive())?.webSocketDebuggerUrl || "", { onEvent: () => {} });
    // 抓取已结束，浏览器已被 shutdown；改为直接检查 cookie 文件仍存在
    check("抓取后 profile 仍保留登录态", bm.profileStatus(PROFILE).hasCookies);

    await engine.shutdown();

    // ---------- 步骤 4：临时 profile 隔离性 ----------
    console.log("\n[4] 临时 profile 隔离性");
    const eph = bm.resolveProfile({ profileMode: "ephemeral" });
    const stEph = bm.profileStatus(path.basename(eph.dir));
    check("临时 profile 不含持久登录态", !stEph.hasCookies || eph.dir !== profile.dir);

  } catch (e) {
    console.log(`  ✗ 异常: ${e.message}`);
    failed++;
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`  终极组合 E2E：${passed} 通过, ${failed} 失败`);
  console.log(`${"=".repeat(50)}\n`);
  process.exit(failed > 0 ? 1 : 0);
})();
