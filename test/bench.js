"use strict";

/**
 * 压测脚本：并发抓取 + 资源观测
 * 用法: node test/bench.js [并发数] [站点数]
 *
 * 观测指标：
 *  - 各并发档的成功率、耗时
 *  - 浏览器进程数峰值 / 是否回落
 *  - Node 内存峰值
 *  - 端口占用与残留
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");
const { CaptureEngine } = require("../src/core/capture-engine");
const { detectBrowsers } = require("../src/core/browser-launcher");

const CONCURRENCY = parseInt(process.argv[2], 10) || 3;
const BASE_PORT = 9500;

function countBrowsers() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV', { encoding: "utf8" });
    return Math.max(0, out.trim().split("\n").length - 1);
  } catch {
    return -1;
  }
}

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const http = require("http");
    http.get(url, { timeout: 1500 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve(JSON.parse(d)));
    }).on("error", reject);
  });
}

async function portAlive(port) {
  try {
    const v = await getJSON(`http://127.0.0.1:${port}/json/version`);
    return !!v.webSocketDebuggerUrl;
  } catch {
    return false;
  }
}

/** 单个抓取任务 */
async function oneTask(idx, browsers, targetUrl, results) {
  const port = BASE_PORT + idx;
  const outDir = path.join(os.tmpdir(), `gsc-bench-${Date.now()}-${idx}`);
  const profileDir = path.join(os.tmpdir(), `gsc-bench-prof-${Date.now()}-${idx}`);
  const engine = new CaptureEngine({
    targetUrl,
    outputDir: outDir,
    executablePath: browsers[0].path,
    headless: true,
    userDataDir: profileDir,
    port,
    saveSource: true,
    saveHar: true,
    saveHtml: true,
    saveMedia: false,
    scrollRounds: 0,
    timeout: 30000,
    onProgress: () => {},
  });

  const t0 = Date.now();
  const rec = { idx, port, ok: false, ms: 0, saved: 0, bytes: 0, error: null };
  try {
    const r = await engine.run();
    rec.ok = !r.aborted;
    rec.saved = r.stats.saved;
    rec.bytes = r.stats.bytes;
  } catch (e) {
    rec.error = e.message;
  } finally {
    rec.ms = Date.now() - t0;
    // 关闭浏览器并清理
    await engine.shutdown().catch(() => {});
    // 等待端口释放
    await new Promise((r) => setTimeout(r, 1500));
    rec.portReleased = !(await portAlive(port));
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
  }
  results.push(rec);
}

(async () => {
  const browsers = detectBrowsers();
  if (!browsers.length) {
    console.error("未检测到浏览器，退出");
    process.exit(1);
  }

  // 目标站点：用 example.com（稳定、快），可改为多站点
  const targets = [
    "https://example.com",
    "https://www.iana.org/help/example-domains",
    "https://example.org",
  ];

  console.log("=".repeat(60));
  console.log(`  压测：并发 ${CONCURRENCY}，端口 ${BASE_PORT}~${BASE_PORT + CONCURRENCY - 1}`);
  console.log(`  浏览器: ${browsers[0].name}`);
  console.log("=".repeat(60));

  const procBefore = countBrowsers();
  const memBefore = process.memoryUsage().heapUsed;
  console.log(`\n基线:`);
  console.log(`  chrome 进程数: ${procBefore}`);
  console.log(`  Node heap: ${(memBefore / 1048576).toFixed(1)} MB\n`);

  const results = [];
  const t0 = Date.now();

  // 峰值采样器：抓取期间持续采样进程数，捕捉真实峰值
  let peakProcs = procBefore;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const c = countBrowsers();
      if (c > peakProcs) peakProcs = c;
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  // 并发启动
  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      oneTask(i, browsers, targets[i % targets.length], results)
    )
  );

  sampling = false;
  await sampler;

  const totalMs = Date.now() - t0;
  const memAfter = process.memoryUsage().heapUsed;

  // 等待浏览器全部退出
  await new Promise((r) => setTimeout(r, 4000));
  const procAfter = countBrowsers();

  // 结果
  console.log("结果明细:");
  console.log("  #  | 端口 | 状态 | 耗时(s) | 保存 | 大小(KB) | 端口释放 | 错误");
  console.log("  " + "-".repeat(76));
  for (const r of results) {
    console.log(
      `  ${String(r.idx).padEnd(2)} | ${r.port} | ${r.ok ? "成功" : "失败"} | ` +
      `${(r.ms / 1000).toFixed(1).padStart(6)} | ${String(r.saved).padStart(4)} | ` +
      `${(r.bytes / 1024).toFixed(0).padStart(8)} | ${r.portReleased ? "  ✓   " : "  ✗   "} | ${r.error || ""}`
    );
  }

  const okCount = results.filter((r) => r.ok).length;
  const avgMs = results.reduce((s, r) => s + r.ms, 0) / results.length;
  const releasedCount = results.filter((r) => r.portReleased).length;

  console.log("\n汇总:");
  console.log(`  成功率: ${okCount}/${results.length} (${((okCount / results.length) * 100).toFixed(0)}%)`);
  console.log(`  平均耗时: ${(avgMs / 1000).toFixed(1)}s`);
  console.log(`  总耗时: ${(totalMs / 1000).toFixed(1)}s`);
  console.log(`  端口释放: ${releasedCount}/${results.length}`);
  console.log("\n资源:");
  console.log(`  chrome 进程: ${procBefore} → 峰值 ${peakProcs} → 结束 ${procAfter}`);
  console.log(`  Node heap: ${(memBefore / 1048576).toFixed(1)} → ${(memAfter / 1048576).toFixed(1)} MB`);
  console.log(`  进程泄漏: ${procAfter > procBefore ? "⚠ 有残留 " + (procAfter - procBefore) + " 个" : "✓ 无残留"}`);

  // 写出报告
  const report = {
    concurrency: CONCURRENCY,
    totalMs,
    avgMs,
    successRate: okCount / results.length,
    portReleaseRate: releasedCount / results.length,
    procBefore,
    peakProcs,
    procAfter,
    heapBeforeMB: memBefore / 1048576,
    heapAfterMB: memAfter / 1048576,
    results,
    ts: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(__dirname, "bench-report.json"), JSON.stringify(report, null, 2));
  console.log("\n报告已写入 test/bench-report.json");

  process.exit(okCount === results.length && releasedCount === results.length ? 0 : 1);
})();
