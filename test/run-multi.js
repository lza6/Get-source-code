"use strict";

/**
 * 多路由批量抓取（用本工具的核心引擎）
 * 目的：抓取单页抓不到的懒加载 chunk（语言包、定价页、订阅页等）
 *
 * 用法: node test/run-multi.js <站点根> <输出目录>
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { CaptureEngine } = require("../src/core/capture-engine");
const { detectBrowsers } = require("../src/core/browser-launcher");

const BASE = process.argv[2] || "https://www.creen.ai";
const OUT = process.argv[3] || path.join(__dirname, "..", "captures", "multi");

const ROUTES = [
  "/",
  "/create",
  "/explore",
  "/models",
  "/features",
  "/features/ai-motion-control",
  "/pricing",
  "/my-assets",
  "/profile",
  "/subscriptions",
  "/about-us",
  "/contact-us",
  "/faqs",
  "/refund-policy",
  "/privacy",
  "/terms",
];

(async () => {
  const browsers = detectBrowsers();
  if (!browsers.length) { console.error("无浏览器"); process.exit(1); }

  fs.mkdirSync(OUT, { recursive: true });
  const profileDir = path.join(os.tmpdir(), "gsc-multi-prof-" + Date.now());

  console.log("=".repeat(56));
  console.log(`  多路由抓取：${ROUTES.length} 个路由`);
  console.log(`  目标: ${BASE}`);
  console.log(`  输出: ${OUT}`);
  console.log("=".repeat(56) + "\n");

  const seenChunks = new Set();
  let totalSaved = 0;
  let port = 9610;

  for (const route of ROUTES) {
    const url = BASE + route;
    const routeDir = path.join(OUT, route === "/" ? "_root" : route.replace(/\//g, "_"));
    process.stdout.write(`  ${route.padEnd(30)} `);

    const engine = new CaptureEngine({
      targetUrl: url,
      outputDir: routeDir,
      executablePath: browsers[0].path,
      headless: true,
      userDataDir: profileDir,
      port: port++,
      saveSource: true, saveHar: false, saveHtml: false, saveMedia: false,
      scrollRounds: 2,
      timeout: 35000,
      onProgress: (p) => {
        if (p.type === "file" && p.path) {
          const name = path.basename(p.path);
          seenChunks.add(name);
        }
      },
    });

    try {
      const r = await engine.run();
      totalSaved += r.stats.saved;
      console.log(`✓ 保存 ${r.stats.saved}`);
    } catch (e) {
      console.log(`✗ ${e.message.slice(0, 40)}`);
    } finally {
      await engine.shutdown().catch(() => {});
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // 汇总去重后的 chunk
  const allFiles = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else allFiles.push(p);
    }
  })(OUT);

  const jsFiles = allFiles.filter((f) => f.endsWith(".js"));
  const chunkNames = [...new Set(jsFiles.map((f) => path.basename(f)))];

  console.log("\n" + "=".repeat(56));
  console.log(`  汇总`);
  console.log("=".repeat(56));
  console.log(`  总保存: ${totalSaved}`);
  console.log(`  唯一 JS chunk: ${chunkNames.length}`);
  console.log(`  唯一文件总数: ${new Set(allFiles.map((f) => path.basename(f))).size}`);

  // 识别语言包
  let langPacks = 0;
  for (const f of jsFiles) {
    try {
      const s = fs.readFileSync(f, "utf8");
      if (s.includes("JSON.parse(") && /"metadata"\s*:/.test(s)) langPacks++;
    } catch { /* ignore */ }
  }
  console.log(`  语言包: ${langPacks}`);

  try { fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* ignore */ }
  process.exit(0);
})();
