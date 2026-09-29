"use strict";

/**
 * CLI 自测脚本：不启动 Electron，直接驱动核心引擎
 * 用法: node test/run-capture.js <url> [outputDir]
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { CaptureEngine } = require("../src/core/capture-engine");
const { detectBrowsers } = require("../src/core/browser-launcher");

const url = process.argv[2] || "https://example.com";
const outDir = process.argv[3] || path.join(__dirname, "..", "captures", Date.now().toString());

const browsers = detectBrowsers();
console.log("检测到浏览器:", browsers.map((b) => `${b.name} (${b.path})`).join(", ") || "无");
if (!browsers.length) {
  console.error("未检测到浏览器，退出");
  process.exit(1);
}

const engine = new CaptureEngine({
  targetUrl: url,
  outputDir: outDir,
  executablePath: browsers[0].path,
  headless: true,
  userDataDir: path.join(os.tmpdir(), "gsc-test-profile-" + Date.now()),
  port: 9333,
  saveSource: true,
  saveHar: true,
  saveHtml: true,
  saveMedia: false,
  scrollRounds: 2,
  timeout: 40000,
  onProgress: (p) => {
    switch (p.type) {
      case "status": console.log("  »", p.message); break;
      case "file": console.log("  ✔", "[" + p.kind + "]", p.path || p.url, p.size ? `(${p.size}B)` : ""); break;
      case "skip": console.log("  ∅ 跳过", String(p.url || "").slice(0, 60), "—", p.reason); break;
      case "error": console.log("  ✘", p.message); break;
    }
  },
});

(async () => {
  const t0 = Date.now();
  try {
    const res = await engine.run();
    console.log("\n=== 完成 ===");
    console.log("耗时:", ((Date.now() - t0) / 1000).toFixed(1) + "s");
    console.log("统计:", JSON.stringify(res.stats));
    console.log("目录:", res.outputDir);

    // 校验产出
    const check = ["metadata.json", "network.har", "page.html"];
    for (const f of check) {
      const p = path.join(outDir, f);
      console.log(`  ${fs.existsSync(p) ? "✓" : "✗"} ${f} ${fs.existsSync(p) ? `(${fs.statSync(p).size}B)` : ""}`);
    }
    // HAR 校验
    const har = JSON.parse(fs.readFileSync(path.join(outDir, "network.har"), "utf8"));
    console.log("  HAR entries:", har.log.entries.length);
    console.log("  HAR creator:", JSON.stringify(har.log.creator));
    await engine.shutdown();
    process.exit(0);
  } catch (e) {
    console.error("失败:", e.message);
    await engine.shutdown().catch(() => {});
    process.exit(1);
  }
})();
