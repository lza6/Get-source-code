"use strict";

/**
 * 夹具自检：验证无限滚动 fixture 真的需要「滚动」才会加载更多。
 *
 * 这是测试的前提条件 —— 若夹具本身不需要滚动就加载全部，
 * 任何基于它的滚动测试都是假阳性（本项目曾因此产生过一次无效验收）。
 *
 * 用法: node test/fixtures/selfcheck.js
 */

const path = require("path");
const os = require("os");
const { startServer } = require("./infinite-scroll-server");
const { BrowserLauncher, detectBrowsers } = require("../../src/core/browser-launcher");
const { CDPClient } = require("../../src/core/cdp-client");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(name, cond, ev) {
  if (cond) { console.log(`  ✓ ${name}${ev ? "  — " + ev : ""}`); pass++; }
  else { console.log(`  ✗ ${name}${ev ? "  — " + ev : ""}`); fail++; }
}

(async () => {
  const browsers = detectBrowsers();
  if (!browsers.length) { console.error("无浏览器"); process.exit(1); }

  console.log("=".repeat(60));
  console.log("  无限滚动夹具自检（前提条件验证）");
  console.log("=".repeat(60) + "\n");

  const srv = await startServer();
  const launcher = new BrowserLauncher({
    executablePath: browsers[0].path,
    port: 9455, headless: true,
    userDataDir: path.join(os.tmpdir(), "gsc-fixture-self-" + Date.now()),
  });
  const { version } = await launcher.launch();
  const cdp = new CDPClient(version.webSocketDebuggerUrl, { onEvent: () => {} });
  await cdp.connect();
  const tab = await launcher.newTab("about:blank");
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: tab.id, flatten: true });
  await cdp.send("Page.enable", {}, { sessionId });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  }, { sessionId }).catch(() => {});

  const loaded = cdp.waitFor("Page.loadEventFired", { sessionId, timeout: 20000 }).catch(() => null);
  await cdp.send("Page.navigate", { url: srv.url }, { sessionId });
  await loaded;

  const evalJs = async (expr) => {
    const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true }, { sessionId });
    return r.result && r.result.value;
  };
  const state = async () => JSON.parse(await evalJs(`JSON.stringify({
    loaded: window.__loadedCount,
    events: window.__loadEvents,
    h: document.body.scrollHeight,
    vh: window.innerHeight,
    y: window.scrollY,
    near: window.__nearBottom ? window.__nearBottom() : null
  })`));

  try {
    /* ---- 前提 1：首屏绝不触底 ---- */
    console.log("[前提] 首屏不应触底（否则无需滚动即加载）");
    await sleep(1500); // 等若干轮轮询
    const s0 = await state();
    console.log(`      初始: loaded=${s0.loaded}, scrollHeight=${s0.h}, viewport=${s0.vh}, nearBottom=${s0.near}`);
    check("首屏未触底", s0.near === false, `nearBottom=${s0.near}`);
    check("首屏高度大于视口", s0.h > s0.vh, `${s0.h} > ${s0.vh}`);

    /* ---- 前提 2：不滚动则不加载 ---- */
    console.log("\n[前提] 静置 3 秒（不滚动）不应加载更多");
    await sleep(3000);
    const s1 = await state();
    console.log(`      静置后: loaded=${s1.loaded}, events=${s1.events}`);
    check("静置后图片数未增长", s1.loaded === s0.loaded, `${s0.loaded} → ${s1.loaded}`);
    check("静置后加载事件数未增长", s1.events === s0.events, `${s0.events} → ${s1.events}`);

    /* ---- 前提 3：滚动后才加载 ---- */
    console.log("\n[前提] 滚动到底部应触发加载");
    const before = await state();
    // 分步滚动（模拟真实滚动）
    for (let i = 0; i < 8; i++) {
      await evalJs("window.scrollTo(0, Math.min(window.scrollY + window.innerHeight*0.8, document.body.scrollHeight))");
      await sleep(150);
    }
    await sleep(1200);
    const after = await state();
    console.log(`      滚动后: loaded=${before.loaded} → ${after.loaded}`);
    check("滚动后图片数增加", after.loaded > before.loaded, `${before.loaded} → ${after.loaded}`);
    check("滚动后触发过加载事件", after.events > before.events, `events ${before.events} → ${after.events}`);

    /* ---- 前提 4：能加载到目标总数 ---- */
    console.log("\n[前提] 持续滚动可达目标总数");
    for (let round = 0; round < 15; round++) {
      await evalJs("window.scrollTo(0, document.body.scrollHeight)");
      await sleep(300);
      const s = await state();
      if (s.loaded >= 40) break;
    }
    const fin = await state();
    check("可持续加载至 40 张（无限滚动语义正确）", fin.loaded >= 40, `loaded=${fin.loaded}`);

    /* ---- 前提 5：HTTP 层正确 ---- */
    console.log("\n[前提] HTTP 层");
    const html = await fetch(srv.url).then((r) => r.text());
    check("HTML 含 __loadedCount", /__loadedCount/.test(html));
    check("HTML 含 200vh 视口保护", /min-height:\s*200vh/.test(html));
    const imgRes = await fetch(new URL("/img/5.png", srv.url));
    const buf = Buffer.from(await imgRes.arrayBuffer());
    check("图片路由返回 PNG", imgRes.headers.get("content-type") === "image/png" &&
      buf[0] === 0x89 && buf[1] === 0x50, `${buf.length} bytes`);
    const badRes = await fetch(new URL("/img/abc.png", srv.url));
    check("非数字图片索引返回 400", badRes.status === 400, `status=${badRes.status}`);

  } finally {
    cdp.close();
    await launcher.close();
    await srv.close().catch(() => {});
  }

  console.log("\n" + "=".repeat(60));
  console.log(`  夹具自检：${pass} 通过, ${fail} 失败`);
  console.log("=".repeat(60));
  console.log(fail === 0
    ? "  ✅ 夹具可靠：只有在真正滚动时才会加载更多"
    : "  ❌ 夹具不可靠：基于它的测试结论无效");
  // exitCode 而非 process.exit()：避免在 libuv 句柄仍在关闭时强退导致断言噪声
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error("\n自检异常:", e.message);
  process.exitCode = 1;
});
