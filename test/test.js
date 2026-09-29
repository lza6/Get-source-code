"use strict";

/**
 * 端到端测试：验证主进程 IPC 逻辑 + 核心引擎协同
 * 覆盖：浏览器检测、目录树读取、抓取、产出校验
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { CaptureEngine } = require("../src/core/capture-engine");
const { detectBrowsers } = require("../src/core/browser-launcher");
const { MimeClassifier, buildLocalPath, safeFileName } = require("../src/core/mime-utils");
const { HarBuilder } = require("../src/core/har-builder");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    failed++;
  }
}

console.log("\n=== 单元测试：MimeClassifier ===\n");

test("JS 归类为 source", () => {
  const c = MimeClassifier.classify("https://x.com/app.js", "application/javascript", "Script");
  assert.strictEqual(c.kind, "source");
  assert.strictEqual(c.ext, "js");
});

test("CSS/字体归类为 source", () => {
  assert.strictEqual(MimeClassifier.classify("https://x.com/a.css", "text/css", "Stylesheet").kind, "source");
  assert.strictEqual(MimeClassifier.classify("https://x.com/f.woff2", "font/woff2", "Font").kind, "source");
});

test("图片/视频/音频归类为 media", () => {
  assert.strictEqual(MimeClassifier.classify("https://x.com/a.png", "image/png", "Image").kind, "media");
  assert.strictEqual(MimeClassifier.classify("https://x.com/a.mp4", "video/mp4", "Media").kind, "media");
  assert.strictEqual(MimeClassifier.classify("https://x.com/a.mp3", "audio/mpeg", "Media").kind, "media");
});

test("JSON/XML 归类为 other", () => {
  assert.strictEqual(MimeClassifier.classify("https://x.com/d.json", "application/json", "XHR").kind, "other");
  assert.strictEqual(MimeClassifier.classify("https://x.com/d.xml", "text/xml", "XHR").kind, "other");
});

test("无扩展名 URL 从 MIME 推断", () => {
  const c = MimeClassifier.classify("https://x.com/chunk", "application/javascript", "Script");
  assert.strictEqual(c.ext, "js");
});

test("CDP type 兜底（无 MIME 无扩展名）", () => {
  assert.strictEqual(MimeClassifier.classify("https://x.com/blob", "", "Font").kind, "source");
  assert.strictEqual(MimeClassifier.classify("https://x.com/blob", "", "Image").kind, "media");
});

console.log("\n=== 单元测试：路径规划 ===\n");

test("保留原始目录结构", () => {
  const cls = MimeClassifier.classify("https://cdn.x.com/a/b/c.js", "application/javascript", "Script");
  const p = buildLocalPath("https://cdn.x.com/a/b/c.js", cls, "");
  assert.ok(p.includes("source"), "应含 source");
  assert.ok(p.includes("cdn.x.com"), "应含 host");
  assert.ok(p.endsWith("c.js"), "应保留文件名");
});

test("无扩展名 URL 自动补扩展名", () => {
  const cls = MimeClassifier.classify("https://x.com/api/data", "application/json", "XHR");
  const p = buildLocalPath("https://x.com/api/data", cls, "");
  assert.ok(/data.*\.json$/.test(p), `应补 .json，实际: ${p}`);
});

test("非法字符被清理", () => {
  const n = safeFileName('a<b>c:d"e|f?g*h');
  assert.ok(!/[<>:"|?*]/.test(n), `不应含非法字符: ${n}`);
});

test("同名不同 query 不冲突", () => {
  const cls = MimeClassifier.classify("https://x.com/a.js", "application/javascript", "Script");
  const p1 = buildLocalPath("https://x.com/a.js?v=1", cls, "");
  const p2 = buildLocalPath("https://x.com/a.js?v=2", cls, "");
  assert.notStrictEqual(p1, p2, "不同 query 应产出不同路径");
});

console.log("\n=== 单元测试：HAR Builder ===\n");

test("HAR 结构符合 1.2 规范", () => {
  const hb = new HarBuilder();
  hb.onRequestWillBeSent({
    requestId: "1", wallTime: 1700000000, type: "Document",
    request: { url: "https://x.com/", method: "GET", headers: { Accept: "text/html" } },
  });
  hb.onResponseReceived({
    requestId: "1", timestamp: 1700000000.1, type: "Document",
    response: { url: "https://x.com/", status: 200, statusText: "OK", headers: { "Content-Type": "text/html" }, mimeType: "text/html", encodedDataLength: 100 },
  });
  hb.onLoadingFinished({ requestId: "1", timestamp: 1700000000.5, encodedDataLength: 100 });
  const har = hb.build();
  assert.strictEqual(har.log.version, "1.2");
  assert.strictEqual(har.log.creator.name, "GetSourceCode");
  assert.strictEqual(har.log.entries.length, 1);
  const e = har.log.entries[0];
  assert.strictEqual(e.request.method, "GET");
  assert.strictEqual(e.response.status, 200);
  assert.ok(e.request.headers.length > 0, "应有请求头");
  assert.ok(e.response.headers.length > 0, "应有响应头");
  assert.ok(e.timings && typeof e.timings === "object", "应有 timings 对象");
  assert.ok(typeof e.time === "number", "应有 time 数值");
});

test("HAR 记录 POST body 与 query", () => {
  const hb = new HarBuilder();
  hb.onRequestWillBeSent({
    requestId: "2", wallTime: 1700000000, type: "XHR",
    request: { url: "https://x.com/api?q=1&p=2", method: "POST", headers: { "Content-Type": "application/json" }, postData: '{"a":1}' },
  });
  const har = hb.build();
  const e = har.log.entries[0];
  assert.strictEqual(e.request.method, "POST");
  assert.strictEqual(e.request.queryString.length, 2);
  assert.ok(e.request.postData, "应含 postData");
  assert.strictEqual(e.request.bodySize, 7);
});

test("HAR 记录失败请求", () => {
  const hb = new HarBuilder();
  hb.onRequestWillBeSent({ requestId: "3", wallTime: 1, type: "Fetch", request: { url: "https://x.com/x", method: "GET", headers: {} } });
  hb.onLoadingFailed({ requestId: "3", timestamp: 1.1, errorText: "net::ERR_FAILED" });
  const har = hb.build();
  assert.strictEqual(har.log.entries[0]._error.errorText, "net::ERR_FAILED");
});

console.log("\n=== 环境检测 ===\n");

test("检测到至少一个浏览器", () => {
  const b = detectBrowsers();
  assert.ok(b.length > 0, `未检测到浏览器；请安装 Chrome / Edge`);
  console.log(`      发现: ${b.map((x) => x.name).join(", ")}`);
});

/* ---------- 集成测试（真实抓取） ---------- */

(async () => {
  console.log("\n=== 集成测试：真实抓取 example.com ===\n");
  const browsers = detectBrowsers();
  if (!browsers.length) {
    console.log("  ⚠ 无浏览器，跳过集成测试");
    return summary();
  }
  const outDir = path.join(os.tmpdir(), "gsc-e2e-" + Date.now());
  const engine = new CaptureEngine({
    targetUrl: "https://example.com",
    outputDir: outDir,
    executablePath: browsers[0].path,
    headless: true,
    userDataDir: path.join(os.tmpdir(), "gsc-e2e-profile-" + Date.now()),
    port: 9355,
    saveSource: true, saveHar: true, saveHtml: true, saveMedia: false,
    scrollRounds: 1, timeout: 40000,
    onProgress: () => {},
  });

  try {
    const res = await engine.run();
    test("抓取产出 metadata.json", () => {
      assert.ok(fs.existsSync(path.join(outDir, "metadata.json")));
    });
    test("抓取产出 network.har", () => {
      assert.ok(fs.existsSync(path.join(outDir, "network.har")));
    });
    test("抓取产出 page.html", () => {
      const p = path.join(outDir, "page.html");
      assert.ok(fs.existsSync(p));
      const html = fs.readFileSync(p, "utf8");
      assert.ok(html.includes("<html"), "应为有效 HTML");
      assert.ok(html.length > 100, "HTML 不应为空");
    });
    test("HAR 含主文档请求", () => {
      const har = JSON.parse(fs.readFileSync(path.join(outDir, "network.har"), "utf8"));
      assert.ok(har.log.entries.length >= 1, "至少 1 条记录");
      assert.ok(har.log.entries.some((e) => e.request.url.includes("example.com")), "应含目标站点请求");
    });
    test("metadata 统计正确", () => {
      const m = JSON.parse(fs.readFileSync(path.join(outDir, "metadata.json"), "utf8"));
      assert.strictEqual(m.targetUrl, "https://example.com");
      assert.ok(m.stats.saved > 0, "应至少保存 1 个文件");
      assert.ok(Array.isArray(m.resources));
    });
    await engine.shutdown();
  } catch (e) {
    console.log(`  ✗ 集成测试异常: ${e.message}`);
    failed++;
    await engine.shutdown().catch(() => {});
  } finally {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
  summary();
})();

function summary() {
  console.log(`\n${"=".repeat(46)}`);
  console.log(`  测试完成：${passed} 通过, ${failed} 失败`);
  console.log(`${"=".repeat(46)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}
