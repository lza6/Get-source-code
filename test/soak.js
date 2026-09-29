"use strict";

/**
 * 稳定性（soak）测试：连续多次抓取，监测内存/句柄/进程是否泄漏
 * 用法: node test/soak.js [轮数]
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const { CaptureEngine } = require("../src/core/capture-engine");
const { detectBrowsers } = require("../src/core/browser-launcher");

const ROUNDS = parseInt(process.argv[2], 10) || 8;
const PORT = 9900;

function countChrome() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV', { encoding: "utf8" });
    return out.trim().split("\n").length - 1;
  } catch { return -1; }
}

function handles() {
  try {
    // Windows: 用 tasklist 拿当前 node 进程句柄数不可行，改用内存与 chrome 进程数近似
    return null;
  } catch { return null; }
}

(async () => {
  const browsers = detectBrowsers();
  if (!browsers.length) { console.error("无浏览器"); process.exit(1); }

  console.log("=".repeat(56));
  console.log(`  稳定性测试：${ROUNDS} 轮连续抓取`);
  console.log("=".repeat(56) + "\n");

  const samples = [];
  const baseChrome = countChrome();
  console.log(`基线: chrome=${baseChrome}, heap=${(process.memoryUsage().heapUsed / 1048576).toFixed(1)}MB\n`);

  const profileDir = path.join(os.tmpdir(), "gsc-soak-prof-" + Date.now());
  let okCount = 0;

  for (let i = 1; i <= ROUNDS; i++) {
    const outDir = path.join(os.tmpdir(), `gsc-soak-${Date.now()}-${i}`);
    const engine = new CaptureEngine({
      targetUrl: "https://example.com",
      outputDir: outDir,
      executablePath: browsers[0].path,
      headless: true,
      userDataDir: profileDir,     // 复用 profile 以模拟真实连续使用
      port: PORT,
      saveSource: true, saveHar: true, saveHtml: true,
      scrollRounds: 0, timeout: 25000,
      onProgress: () => {},
    });

    const t0 = Date.now();
    let ok = false, saved = 0, err = null;
    try {
      const r = await engine.run();
      ok = !r.aborted && r.stats.saved >= 0;
      saved = r.stats.saved;
    } catch (e) { err = e.message; }
    finally {
      await engine.shutdown().catch(() => {});
      try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(path.join(outDir, "..", "nonexistent"), { force: true }); } catch {}
    }

    const ms = Date.now() - t0;
    if (ok) okCount++;

    await new Promise((r) => setTimeout(r, 800)); // 让端口释放
    const chrome = countChrome();
    const heap = process.memoryUsage().heapUsed / 1048576;
    samples.push({ round: i, ok, ms, saved, chrome, heapMB: heap, err });

    const status = ok ? "✓" : "✗";
    console.log(
      `  ${status} 第${String(i).padStart(2)}轮 | ${(ms / 1000).toFixed(1).padStart(5)}s | ` +
      `保存 ${String(saved).padStart(3)} | chrome ${String(chrome).padStart(3)} | heap ${heap.toFixed(1).padStart(5)}MB` +
      (err ? ` | ${err.slice(0, 30)}` : "")
    );
  }

  // 清理 profile
  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch {}

  await new Promise((r) => setTimeout(r, 3000));
  const finalChrome = countChrome();
  const finalHeap = process.memoryUsage().heapUsed / 1048576;

  console.log("\n" + "=".repeat(56));
  console.log("  汇总");
  console.log("=".repeat(56));
  console.log(`  成功率: ${okCount}/${ROUNDS}`);
  const firstHeap = samples[0].heapMB, lastHeap = samples[samples.length - 1].heapMB;
  const heapGrowth = lastHeap - firstHeap;
  console.log(`  heap: ${firstHeap.toFixed(1)} → ${lastHeap.toFixed(1)} MB (增长 ${heapGrowth.toFixed(1)})`);
  console.log(`  chrome: ${baseChrome} → ${finalChrome} (差 ${finalChrome - baseChrome})`);

  const avgMs = samples.reduce((s, x) => s + x.ms, 0) / samples.length;
  console.log(`  平均每轮: ${(avgMs / 1000).toFixed(1)}s`);

  // 泄漏判定
  const leakProcs = finalChrome - baseChrome;
  const perRoundHeap = heapGrowth / ROUNDS;
  console.log("\n  判定:");
  console.log(`    进程泄漏: ${leakProcs <= 2 ? "✓ 无（≤2）" : "⚠ 疑似 +" + leakProcs}`);
  console.log(`    内存泄漏: ${perRoundHeap < 2 ? "✓ 无（每轮 <2MB）" : "⚠ 疑似 每轮 +" + perRoundHeap.toFixed(1) + "MB"}`);
  console.log(`    成功率: ${okCount === ROUNDS ? "✓ 100%" : "⚠ " + ((okCount / ROUNDS) * 100).toFixed(0) + "%"}`);

  const report = { rounds: ROUNDS, okCount, baseChrome, finalChrome, leakProcs, heapGrowth, perRoundHeap, avgMs, samples, ts: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, "..", "test", "soak-report.json"), JSON.stringify(report, null, 2));
  console.log("\n  报告: test/soak-report.json");

  process.exit(okCount === ROUNDS && leakProcs <= 2 ? 0 : 1);
})();
