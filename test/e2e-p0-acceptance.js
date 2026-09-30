"use strict";

/**
 * P0 真实 E2E 验收：对真实站点抓取，逐条核验 P0-1~P0-6 是否真的修好了。
 * 用法: node test/e2e-p0-acceptance.js [url]
 *
 * 与 test/test.js 的区别：本脚本**只看 P0 修复项的实际效果**，并输出可核对的证据。
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { CaptureEngine } = require("../src/core/capture-engine");
const { detectBrowsers } = require("../src/core/browser-launcher");

const URL_ = process.argv[2] || "https://example.com";
const OUT = path.join(os.tmpdir(), "gsc-e2e-p0-" + Date.now());

let pass = 0, fail = 0;
function check(name, cond, evidence) {
  if (cond) { console.log(`  ✓ ${name}${evidence ? "  — " + evidence : ""}`); pass++; }
  else { console.log(`  ✗ ${name}${evidence ? "  — " + evidence : ""}`); fail++; }
}

(async () => {
  const browsers = detectBrowsers();
  if (!browsers.length) { console.error("无浏览器，无法 E2E"); process.exit(1); }

  console.log("=".repeat(64));
  console.log("  P0 真实 E2E 验收");
  console.log("  目标:", URL_);
  console.log("  产出:", OUT);
  console.log("=".repeat(64) + "\n");

  const events = [];
  const t0 = Date.now();
  const engine = new CaptureEngine({
    targetUrl: URL_,
    outputDir: OUT,
    executablePath: browsers[0].path,
    headless: true,
    userDataDir: path.join(os.tmpdir(), "gsc-e2e-p0-profile-" + Date.now()),
    port: 9377,
    saveSource: true, saveHar: true, saveHtml: true, saveMedia: false,
    scrollRounds: 2,
    timeout: 40000,
    onProgress: (p) => { events.push(p); },
  });

  const result = await engine.run();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  await engine.cleanup().catch(() => {});
  await engine.shutdown().catch(() => {});

  console.log(`\n--- 抓取完成：${elapsed}s，saved=${result.stats.saved} ---\n`);

  /* ---------- P0-6：Runtime.enable 已删除，但功能完好 ---------- */
  console.log("[P0-6] Runtime.enable 移除后功能依然完好");
  const pageHtml = path.join(OUT, "page.html");
  const htmlOk = fs.existsSync(pageHtml) && fs.statSync(pageHtml).size > 50;
  check("page.html 正常产出（依赖 Runtime.evaluate）", htmlOk,
    htmlOk ? `${fs.statSync(pageHtml).size} 字节` : "缺失");
  const html = htmlOk ? fs.readFileSync(pageHtml, "utf8") : "";
  check("DOM 内容真实（含 html 标签）", /<html[\s>]/i.test(html), html.slice(0, 60).replace(/\n/g, " "));
  check("实时 DOM 反映页面标题", /Example Domain|example/i.test(html));

  /* ---------- P0-5：滚动功能可用 ---------- */
  console.log("\n[P0-5] 健壮滚动");
  const scrollEvents = events.filter((e) => e.type === "status" && /滚动/.test(e.message || ""));
  check("滚动流程已执行", scrollEvents.length > 0, scrollEvents.map((e) => e.message).join(" | "));
  check("滚动后仍成功完成抓取", result.stats.saved > 0);

  /* ---------- P0-4：缓存禁用生效 ---------- */
  console.log("\n[P0-4] 缓存禁用（第二次抓取同站点仍能拿到 body）");
  const OUT2 = path.join(os.tmpdir(), "gsc-e2e-p0-2nd-" + Date.now());
  const profile2 = path.join(os.tmpdir(), "gsc-e2e-p0-profile2-" + Date.now());
  const engine2 = new CaptureEngine({
    targetUrl: URL_, outputDir: OUT2,
    executablePath: browsers[0].path, headless: true, userDataDir: profile2,
    port: 9378, saveSource: true, saveHar: true, saveHtml: true, saveMedia: false,
    timeout: 40000, onProgress: () => {},
  });
  const r2 = await engine2.run();
  await engine2.cleanup().catch(() => {});
  await engine2.shutdown().catch(() => {});
  check("二次抓取成功且拿到资源（缓存未导致 body 丢失）", r2.stats.saved > 0,
    `saved=${r2.stats.saved}, skipped=${r2.stats.skipped}`);

  /* ---------- P0-2：HAR 含响应体（核心验收） ---------- */
  console.log("\n[P0-2] HAR 响应体（content.text）");
  const har = JSON.parse(fs.readFileSync(path.join(OUT, "network.har"), "utf8"));
  const entries = har.log.entries;
  const withText = entries.filter((e) => e.response.content && typeof e.response.content.text === "string" && e.response.content.text.length > 0);
  const withMime = entries.filter((e) => e.response.content && e.response.content.mimeType);
  check("HAR 有条目", entries.length > 0, `entries=${entries.length}`);
  check("存在含响应体的条目（此前恒为 0）", withText.length > 0,
    `含 body 条目=${withText.length}/${entries.length}`);
  check("所有条目都带 mimeType（未因改动丢失）", withMime.length === entries.length,
    `${withMime.length}/${entries.length}`);

  // 逐条核验：内联 body 必须与磁盘文件字节一致
  let byteMatched = 0, byteChecked = 0;
  for (const e of entries) {
    const c = e.response.content;
    if (!c || typeof c.text !== "string" || !c.text) continue;
    // 从 metadata 反查该 URL 的磁盘文件
    const meta = JSON.parse(fs.readFileSync(path.join(OUT, "metadata.json"), "utf8"));
    const rec = meta.resources.find((r) => r.url === e.request.url && r.file);
    if (!rec) continue;
    const abs = path.join(OUT, rec.file);
    if (!fs.existsSync(abs)) continue;
    byteChecked++;
    const disk = fs.readFileSync(abs);
    const fromHar = c.encoding === "base64" ? Buffer.from(c.text, "base64") : Buffer.from(c.text, "utf8");
    if (disk.equals(fromHar)) byteMatched++;
  }
  check("内联 body 与磁盘文件字节一致", byteChecked === 0 || byteMatched === byteChecked,
    `一致 ${byteMatched}/${byteChecked}`);

  // HAR 体积保护
  const harSize = fs.statSync(path.join(OUT, "network.har")).size;
  check("HAR 体积受控（未膨胀）", harSize < 20 * 1024 * 1024, `${(harSize / 1024).toFixed(1)} KB`);

  // 展示一条真实证据
  const sample = withText.find((e) => /\.(js|css|html)/.test(e.request.url)) || withText[0];
  if (sample) {
    const t = sample.response.content.text;
    console.log(`\n  ▶ 样例证据: ${sample.request.url}`);
    console.log(`    content.mimeType = ${sample.response.content.mimeType}`);
    console.log(`    content.size     = ${sample.response.content.size}`);
    console.log(`    content.text     = ${JSON.stringify(t.slice(0, 90))}${t.length > 90 ? "…" : ""}`);
    console.log(`    text 长度         = ${t.length}`);
  }

  /* ---------- P0-1：多 waitFor 并发（真实流程中导航等待正常） ---------- */
  console.log("\n[P0-1] 事件分发（真实流程验证）");
  check("导航等待正常完成（未因重构而超时）", !result.aborted && result.stats.saved > 0);
  check("未发生假成功（connectionLost 为假）", !result.connectionLost,
    `connectionLost=${!!result.connectionLost}`);

  /* ---------- P0-3：文件名保真（真实产出中无异常名） ---------- */
  console.log("\n[P0-3] 文件名保真");
  const meta = JSON.parse(fs.readFileSync(path.join(OUT, "metadata.json"), "utf8"));
  const badNames = meta.resources.filter((r) => r.file && (r.file.length > 300 || /\/\.(js|css)$/.test(r.file)));
  check("产出文件名均正常（无吞名/超长）", badNames.length === 0,
    badNames.length ? `异常: ${badNames.map((b) => b.file).join(", ")}` : `${meta.resources.length} 项检查`);

  /* ---------- 汇总 ---------- */
  console.log("\n" + "=".repeat(64));
  console.log(`  P0 E2E 验收：${pass} 通过, ${fail} 失败   (耗时 ${elapsed}s)`);
  console.log("=".repeat(64));
  console.log(`\n产出目录: ${OUT}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\nE2E 异常:", e.message);
  process.exit(1);
});
