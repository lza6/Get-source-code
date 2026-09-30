"use strict";

/**
 * CF 过盾集成 E2E：用真实浏览器验证
 *   1) 正常站点不会被误判为 CF 挑战（防止误报导致行为异常）
 *   2) cfAutoPass 开启后，正常站点抓取流程不受影响（零副作用）
 *   3) 挑战处理路径可被触发且能被 abort 中断（不挂死）
 *
 * 说明：不使用真实 CF 站点（不稳定 + 合规边界），
 *      用「正常站点 + 强制注入的假挑战信号」验证代码路径。
 *
 * 用法: node test/e2e-cf.js
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { CaptureEngine } = require("../src/core/capture-engine");
const { detectBrowsers } = require("../src/core/browser-launcher");
const { detectChallenge, CF_TYPE } = require("../src/core/cf-detector");

let pass = 0, fail = 0;
function check(name, cond, ev) {
  if (cond) { console.log(`  ✓ ${name}${ev ? "  — " + ev : ""}`); pass++; }
  else { console.log(`  ✗ ${name}${ev ? "  — " + ev : ""}`); fail++; }
}

(async () => {
  const browsers = detectBrowsers();
  if (!browsers.length) { console.error("无浏览器"); process.exit(1); }

  console.log("=".repeat(64));
  console.log("  CF 过盾集成 E2E（真实浏览器）");
  console.log("=".repeat(64) + "\n");

  const URL_ = "https://example.com";

  /* ---------- 1. 真实浏览器探测：正常站点不应被判为挑战 ---------- */
  console.log("[1] 真实探测：正常站点不误报");

  const outDir = path.join(os.tmpdir(), "gsc-cf-e2e-" + Date.now());
  const engine = new CaptureEngine({
    targetUrl: URL_,
    outputDir: outDir,
    executablePath: browsers[0].path,
    headless: true,
    userDataDir: path.join(os.tmpdir(), "gsc-cf-profile-" + Date.now()),
    port: 9381,
    saveSource: true, saveHar: true, saveHtml: true,
    timeout: 35000,
    cfAutoPass: true,          // 开启过盾，验证对正常站点零副作用
    cfChallengeTimeout: 5000,
    onProgress: () => {},
  });

  // 直接调用探测方法，拿到真实浏览器里的判定输入
  await engine.launcher ? null : null; // 占位，下面走完整 run
  const result = await engine.run();

  check("cfAutoPass 开启后正常站点仍成功抓取", result.stats.saved > 0, `saved=${result.stats.saved}`);
  check("未误判为 CF 挑战", !result.aborted && !engine._cfReport?.detected,
    `cfReport=${JSON.stringify(engine._cfReport)}`);

  const meta = JSON.parse(fs.readFileSync(path.join(outDir, "metadata.json"), "utf8"));
  check("metadata 含 cf 字段", "cf" in meta, JSON.stringify(meta.cf));

  await engine.cleanup().catch(() => {});
  await engine.shutdown().catch(() => {});

  /* ---------- 2. 探测方法在真实浏览器下可用 ---------- */
  console.log("\n[2] _probeChallenge 真实浏览器验证");

  const engine2 = new CaptureEngine({
    targetUrl: URL_,
    outputDir: path.join(os.tmpdir(), "gsc-cf-probe-" + Date.now()),
    executablePath: browsers[0].path,
    headless: true,
    userDataDir: path.join(os.tmpdir(), "gsc-cf-profile2-" + Date.now()),
    port: 9382,
    timeout: 35000,
    onProgress: () => {},
  });

  // 手动走一遍探测所需的准备（启动 + 导航），不跑完整 run
  const { BrowserLauncher } = require("../src/core/browser-launcher");
  const { CDPClient } = require("../src/core/cdp-client");
  const launcher = new BrowserLauncher({
    executablePath: browsers[0].path, port: 9383, headless: true,
    userDataDir: path.join(os.tmpdir(), "gsc-cf-profile3-" + Date.now()),
  });
  const { version } = await launcher.launch();
  const cdp = new CDPClient(version.webSocketDebuggerUrl, { onEvent: () => {} });
  await cdp.connect();
  const tab = await launcher.newTab("about:blank");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.id, flatten: true });
  await cdp.send("Page.enable", {}, { sessionId });

  const loaded = cdp.waitFor("Page.loadEventFired", { sessionId, timeout: 25000 }).catch(() => null);
  await cdp.send("Page.navigate", { url: URL_ }, { sessionId });
  await loaded;
  await new Promise((r) => setTimeout(r, 800));

  // 用真实引擎实例的探测方法（需要 sessionId / har）
  engine2.cdp = cdp;
  engine2.sessionId = sessionId;
  const probe = await engine2._probeChallenge();

  check("探测到页面标题", typeof probe.title === "string" && probe.title.length > 0, JSON.stringify(probe.title));
  check("探测到 HTML 内容", typeof probe.html === "string" && probe.html.length > 0, `${(probe.html || "").length} 字节`);
  check("探测到帧树", !!(probe.frameTree && probe.frameTree.frameTree));

  const verdict = detectChallenge(probe);
  check("真实正常站点判定为「非挑战」", verdict.challenged === false,
    `challenged=${verdict.challenged}, evidence=${JSON.stringify(verdict.evidence)}`);

  /* ---------- 3. 强制注入假挑战信号 → 验证检测能命中 ---------- */
  console.log("\n[3] 注入假挑战信号验证检测生效");
  const fakeVerdict = detectChallenge({
    ...probe,
    headers: { "cf-mitigated": "challenge" },
    title: "Just a moment...",
  });
  check("注入 CF 信号后被正确识别为挑战", fakeVerdict.challenged === true,
    `type=${fakeVerdict.type}, confidence=${fakeVerdict.confidence}`);

  /* ---------- 4. abort 能中断挑战等待 ---------- */
  console.log("\n[4] 挑战等待可被 abort 中断（不挂死）");
  engine2.opts.cfChallengeTimeout = 30000;
  const t0 = Date.now();
  const waitP = engine2._waitForChallengePass();
  setTimeout(() => engine2.abort(), 500);
  const passed = await waitP;
  const elapsed = Date.now() - t0;
  check("abort 后等待立即返回 false", passed === false, `passed=${passed}`);
  check("未等到超时（<5s）", elapsed < 5000, `${elapsed}ms`);

  cdp.close();
  await launcher.close();

  console.log("\n" + "=".repeat(64));
  console.log(`  CF E2E：${pass} 通过, ${fail} 失败`);
  console.log("=".repeat(64));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\nE2E 异常:", e.message, "\n", e.stack);
  process.exit(1);
});
