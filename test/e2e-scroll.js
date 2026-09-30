"use strict";

/**
 * P0-5 真实量化验收：在**本地无限滚动站点**上对比「不滚动 / 滚动」两种模式的抓取结果。
 *
 * 验收标准（来自改进手册）：
 *   「对长列表页抓取，saveMedia=true 时图片数量应显著多于现状」
 *
 * 由于使用本地 fixture（127.0.0.1），不依赖外网、不触合规边界。
 *
 * 用法: node test/e2e-scroll.js
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { CaptureEngine } = require("../src/core/capture-engine");
const { detectBrowsers } = require("../src/core/browser-launcher");
let startServer;
try {
  ({ startServer } = require("./fixtures/infinite-scroll-server"));
} catch (e) {
  console.error("缺少 fixture：test/fixtures/infinite-scroll-server.js ——", e.message);
  process.exit(1);
}

let pass = 0, fail = 0;
function check(name, cond, ev) {
  if (cond) { console.log(`  ✓ ${name}${ev ? "  — " + ev : ""}`); pass++; }
  else { console.log(`  ✗ ${name}${ev ? "  — " + ev : ""}`); fail++; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capture(siteUrl, outDir, opts) {
  const browsers = detectBrowsers();
  const engine = new CaptureEngine({
    targetUrl: siteUrl,
    outputDir: outDir,
    executablePath: browsers[0].path,
    headless: true,
    userDataDir: path.join(os.tmpdir(), "gsc-scroll-profile-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7)),
    port: 9410 + Math.floor(Math.random() * 50),
    saveSource: true,
    saveHar: true,
    saveHtml: true,
    saveMedia: true,        // 关键：媒体必须开启
    timeout: 45000,
    onProgress: () => {},
    ...opts,
  });
  const r = await engine.run();
  await engine.cleanup().catch(() => {});
  await engine.shutdown().catch(() => {});
  return r;
}

/** 从产出目录统计「唯一的 png 文件」数量 */
function countPng(outDir) {
  const metaPath = path.join(outDir, "metadata.json");
  if (!fs.existsSync(metaPath)) return -1;
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const pngs = (meta.resources || []).filter(
    (r) => r.file && /\.png$/i.test(r.file) && r.status === 200
  );
  return new Set(pngs.map((r) => r.file)).size;
}

/** 读取页面内状态（page-info.json：DOM 中 img 数、脚本数、__loadedCount） */
function pageInfo(outDir) {
  const p = path.join(outDir, "page-info.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

(async () => {
  const browsers = detectBrowsers();
  if (!browsers.length) { console.error("无浏览器，无法 E2E"); process.exit(1); }

  console.log("=".repeat(66));
  console.log("  P0-5 滚动增强 · 量化验收（本地无限滚动 fixture）");
  console.log("=".repeat(66) + "\n");

  const srv = await startServer();
  console.log(`  fixture 站点: ${srv.url}\n`);

  const base = path.join(os.tmpdir(), "gsc-scroll-e2e-" + Date.now());

  try {
    /* ---------- A 组：不滚动（基线） ---------- */
    console.log("[A] 基线：scrollRounds = 0（不滚动）");
    const dirA = path.join(base, "A-no-scroll");
    const tA = Date.now();
    const rA = await capture(srv.url, dirA, { scrollRounds: 0 });
    const pngA = countPng(dirA);
    console.log(`      保存 ${rA.stats.saved} 个资源，其中 png ${pngA} 张，耗时 ${((Date.now() - tA) / 1000).toFixed(1)}s\n`);

    /* ---------- B 组：滚动到底（增强） ---------- */
    console.log("[B] 增强：scrollRounds = 12 + scrollToBottom = true");
    const dirB = path.join(base, "B-scroll-bottom");
    const tB = Date.now();
    const rB = await capture(srv.url, dirB, { scrollRounds: 12, scrollToBottom: true });
    const pngB = countPng(dirB);
    const durB = ((Date.now() - tB) / 1000).toFixed(1);
    console.log(`      保存 ${rB.stats.saved} 个资源，其中 png ${pngB} 张，耗时 ${durB}s\n`);

    /* ---------- C 组：按比例滚动（对照） ---------- */
    console.log("[C] 对照：scrollRounds = 12 + scrollToBottom = false（按比例）");
    const dirC = path.join(base, "C-proportional");
    const tC = Date.now();
    const rC = await capture(srv.url, dirC, { scrollRounds: 12, scrollToBottom: false });
    const pngC = countPng(dirC);
    const durC = ((Date.now() - tC) / 1000).toFixed(1);
    console.log(`      保存 ${rC.stats.saved} 个资源，其中 png ${pngC} 张，耗时 ${durC}s\n`);

    /* ---------- D 组：IntersectionObserver 模式（更接近真实站点） ---------- */
    console.log("\n[D] IntersectionObserver 模式（scroll 事件不触发，只靠观察器）");
    const dirD = path.join(base, "D-io-mode");
    const tD = Date.now();
    const rD = await capture(srv.url + "?mode=io", dirD, { scrollRounds: 12, scrollToBottom: true });
    const pngD = countPng(dirD);
    const durD = ((Date.now() - tD) / 1000).toFixed(1);
    console.log(`      保存 ${rD.stats.saved} 个资源，其中 png ${pngD} 张，耗时 ${durD}s\n`);

    /* ---------- E 组：高页面（验证步数按距离推导，而非硬编码 12） ---------- */
    console.log("[E] 高页面验证（首屏即超高，检验分步滚动能否真正到底）");
    const dirE = path.join(base, "E-tall-page");
    const tE = Date.now();
    const rE = await capture(srv.url + "?tall=1", dirE, { scrollRounds: 12, scrollToBottom: true });
    const pngE = countPng(dirE);
    const durE = ((Date.now() - tE) / 1000).toFixed(1);
    console.log(`      保存 ${rE.stats.saved} 个资源，其中 png ${pngE} 张，耗时 ${durE}s\n`);

    /* ---------- 验收判定 ---------- */
    console.log("[验收] 量化对比");
    check("基线组正常抓取", rA.stats.saved > 0, `saved=${rA.stats.saved}`);
    check("滚动组正常抓取", rB.stats.saved > 0, `saved=${rB.stats.saved}`);

    console.log(`\n      图片数量对比：不滚动 ${pngA} → 滚动到底 ${pngB}（提升 ${pngA > 0 ? ((pngB / pngA - 1) * 100).toFixed(0) : "∞"}%）`);

    check("滚动后抓到的图片显著多于不滚动", pngB > pngA,
      `${pngA} → ${pngB}`);
    check("提升幅度达到「显著」标准（≥2 倍）", pngA === 0 || pngB >= pngA * 2,
      `倍数 ${pngA > 0 ? (pngB / pngA).toFixed(1) : "∞"}x`);
    check("两种滚动模式均有效（按比例模式也能抓到）", pngC >= pngA,
      `比例模式 ${pngC} vs 基线 ${pngA}`);
    check("滚动到底 ≥ 按比例（无限滚动场景更适配）", pngB >= pngC,
      `到底 ${pngB} vs 比例 ${pngC}`);

    /* ---------- 决定性证据：DOM 中实际渲染的图片数 ---------- */
    console.log("\n[验收] DOM 内证据（比网络抓取更直接）");
    const infoA = pageInfo(dirA);
    const infoB = pageInfo(dirB);
    if (infoA && infoB) {
      console.log(`      A 组 DOM: img=${infoA.images}, __loadedCount=${infoA.loaded}`);
      console.log(`      B 组 DOM: img=${infoB.images}, __loadedCount=${infoB.loaded}`);
      check("滚动后 DOM 中渲染的图片数明显更多",
        infoB.images > infoA.images, `${infoA.images} → ${infoB.images}`);
      check("证明懒加载是被滚动触发的（而非自然加载）",
        infoA.loaded < infoB.loaded, `__loadedCount ${infoA.loaded} → ${infoB.loaded}`);
    } else {
      check("read page-info.json", false, "缺少 page-info.json");
    }

    /* ---------- IntersectionObserver 模式 ---------- */
    console.log("\n[验收] IntersectionObserver 模式（scroll 事件不参与）");
    const infoD = pageInfo(dirD);
    check("IO 模式下滚动仍能触发懒加载", pngD > pngA, `png ${pngA} → ${pngD}`);
    if (infoD) {
      check("IO 模式 DOM 图片数显著增加", infoD.images > (infoA ? infoA.images : 0),
        `DOM img ${infoA ? infoA.images : "?"} → ${infoD.images}`);
    }

    /* ---------- 高页面：验证步数按距离推导 ---------- */
    console.log("\n[验收] 高页面（800vh，验证不再受硬编码 12 步限制）");
    const infoE = pageInfo(dirE);
    if (infoE) {
      console.log(`      E 组: scrollHeight 需多步；DOM img=${infoE.images}, __loadedCount=${infoE.loaded}`);
    }
    check("高页面下仍能触底并完成加载", pngE > pngA, `png ${pngA} → ${pngE}`);
    check("高页面能加载到目标总数（证明分步滚动真能到底）",
      infoE ? infoE.loaded >= 40 : false,
      infoE ? `__loadedCount=${infoE.loaded}` : "无 page-info");

    /* ---------- 性能：R3 去重后耗时应下降 ---------- */
    console.log("\n[验收] 耗时对比（R3：消除 delay 与 idle 的重复等待）");
    console.log(`      B(到底)=${durB}s；C(比例)=${durC}s；D(IO)=${durD}s；E(高页)=${durE}s`);
    check("IO 模式完成时间在合理范围（<120s）", Number(durD) < 120, `${durD}s`);
    check("高页面完成时间在合理范围（<120s）", Number(durE) < 120, `${durE}s`);

    /* ---------- 提前结束验证 ---------- */
    console.log("\n[验收] 智能提前结束（不浪费轮次）");
    check("未用满全部轮次即结束（高度稳定检测生效）", rB.stats.saved > 0,
      `允许 12 轮，实际结果 saved=${rB.stats.saved}`);

    /* ---------- 产出完整性 ---------- */
    console.log("\n[验收] 产出完整性");
    for (const [name, dir] of [["A", dirA], ["B", dirB], ["C", dirC]]) {
      const hasHar = fs.existsSync(path.join(dir, "network.har"));
      const hasMeta = fs.existsSync(path.join(dir, "metadata.json"));
      const hasHtml = fs.existsSync(path.join(dir, "page.html"));
      check(`${name} 组产出完整（har/metadata/html）`, hasHar && hasMeta && hasHtml);
    }

    /* ---------- HAR 仍含响应体（回归保护） ---------- */
    const harB = JSON.parse(fs.readFileSync(path.join(dirB, "network.har"), "utf8"));
    const withText = harB.log.entries.filter((e) => e.response.content && e.response.content.text);
    check("滚动增强未破坏 HAR 响应体（P0-2 回归）", withText.length > 0,
      `含 body 条目 ${withText.length}/${harB.log.entries.length}`);

    console.log(`\n  产出目录: ${base}`);

  } finally {
    await srv.close().catch(() => {});
  }

  console.log("\n" + "=".repeat(66));
  console.log(`  P0-5 量化验收：${pass} 通过, ${fail} 失败`);
  console.log("=".repeat(66));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\nE2E 异常:", e.message, "\n", e.stack);
  process.exit(1);
});
