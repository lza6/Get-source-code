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
const pending = [];

function test(name, fn) {
  const run = async () => {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (e) {
      console.log(`  ✗ ${name}\n      ${e.message}`);
      failed++;
    }
  };
  // 立即执行，异步的收集起来等最后 await
  const r = run();
  if (r && typeof r.then === "function") pending.push(r);
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

test("HAR timings 语义正确（wait=TTFB, receive>0, time=sum）", () => {
  const hb = new HarBuilder();
  hb.onRequestWillBeSent({
    requestId: "T1", wallTime: 1700000000, timestamp: 100.0, type: "Document",
    request: { url: "https://x.com/", method: "GET", headers: {} },
  });
  hb.onResponseReceived({
    requestId: "T1", timestamp: 100.5, type: "Document",   // TTFB = 0.5s
    response: { url: "https://x.com/", status: 200, statusText: "OK", headers: {}, mimeType: "text/html", encodedDataLength: 100 },
  });
  hb.onLoadingFinished({ requestId: "T1", timestamp: 100.8, encodedDataLength: 100 }); // receive = 0.3s
  const e = hb.build().log.entries[0];

  assert.ok(e.timings.wait > 400 && e.timings.wait < 600, `wait 应约 500ms，实际 ${e.timings.wait}`);
  assert.ok(e.timings.receive > 200 && e.timings.receive < 400, `receive 应约 300ms，实际 ${e.timings.receive}`);
  assert.ok(e.timings.send >= 0, "send 必须 >= 0");
  assert.ok(e.timings.receive >= 0, "receive 必须 >= 0");
  // 规范：time 应等于各非 -1 timing 之和（容差 2ms）
  const sum = e.timings.send + e.timings.wait + e.timings.receive;
  assert.ok(Math.abs(e.time - sum) <= 2, `time(${e.time}) 应等于 timings 之和(${sum})`);
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

/* ---------- 新增：浏览器管理器 / 下载器 ---------- */

const { BrowserManager, SOURCE, PROFILE_MODE, sanitizeProfileName, isTrustedExecutable } = require("../src/core/browser-manager");
const { ChromiumDownloader, detectPlatform, executableRelPath } = require("../src/core/chromium-downloader");

console.log("\n=== 单元测试：安全校验 ===\n");

test("isTrustedExecutable 接受已知浏览器", () => {
  assert.ok(isTrustedExecutable("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"));
  assert.ok(isTrustedExecutable("/usr/bin/chromium"));
  assert.ok(isTrustedExecutable("msedge.exe"));
  assert.ok(isTrustedExecutable("brave.exe"));
});

test("isTrustedExecutable 拒绝任意可执行文件", () => {
  assert.strictEqual(isTrustedExecutable("C:\\Windows\\System32\\cmd.exe"), false);
  assert.strictEqual(isTrustedExecutable("C:\\evil\\malware.exe"), false);
  assert.strictEqual(isTrustedExecutable("calc.exe"), false);
  assert.strictEqual(isTrustedExecutable(""), false);
  assert.strictEqual(isTrustedExecutable(null), false);
});

test("resolveBrowser 拒绝非法来源", async () => {
  const bm = new BrowserManager({ userDataDir: path.join(os.tmpdir(), "gsc-sec") });
  let threw = false;
  try { await bm.resolveBrowser({ source: "evil" }); } catch { threw = true; }
  assert.ok(threw, "非法 source 应抛错");
});

test("resolveBrowser 拒绝非法 asset", async () => {
  const bm = new BrowserManager({ userDataDir: path.join(os.tmpdir(), "gsc-sec") });
  let threw = false;
  try { await bm.resolveBrowser({ source: "bundled", asset: "../../evil" }); } catch { threw = true; }
  assert.ok(threw, "非法 asset 应抛错");
});

test("resolveBrowser 拒绝非浏览器可执行文件（防任意 exe 执行）", async () => {
  const bm = new BrowserManager({ userDataDir: path.join(os.tmpdir(), "gsc-sec") });
  // 用一个真实存在但不是浏览器的可执行文件
  const sysExe = process.platform === "win32" ? "C:\\Windows\\System32\\calc.exe" : "/bin/ls";
  let threw = false;
  try { await bm.resolveBrowser({ source: "custom", executablePath: sysExe }); } catch { threw = true; }
  assert.ok(threw, "非浏览器可执行文件应被拒绝");
});

console.log("\n=== 单元测试：BrowserManager ===\n");

test("平台识别正确", () => {
  const p = detectPlatform();
  assert.ok(["win32", "win64", "mac-arm64", "mac-x64", "linux64", "linux-arm64"].includes(p), `未知平台 ${p}`);
});

test("可执行文件相对路径按平台正确", () => {
  assert.ok(executableRelPath("win64", "chrome").endsWith("chrome.exe"));
  assert.ok(executableRelPath("win64", "chrome-headless-shell").endsWith("chrome-headless-shell.exe"));
  assert.ok(executableRelPath("linux64", "chrome").endsWith("/chrome"));
  // macOS 是 .app 包结构（易错点）
  assert.ok(executableRelPath("mac-arm64", "chrome").includes(".app/Contents/MacOS/"));
});

test("profile 名安全化：阻止路径穿越", () => {
  assert.strictEqual(sanitizeProfileName("../../etc"), "______etc");
  assert.strictEqual(sanitizeProfileName("a/b\\c"), "a_b_c");
  assert.ok(!sanitizeProfileName("..").includes(".."));
});

test("BrowserManager 解析系统浏览器", async () => {
  const bm = new BrowserManager({ userDataDir: path.join(os.tmpdir(), "gsc-test-mgr") });
  const r = await bm.resolveBrowser({ source: SOURCE.SYSTEM });
  assert.ok(r.exe, "应解析出可执行文件");
  assert.strictEqual(r.source, SOURCE.SYSTEM);
});

test("BrowserManager 临时 profile 位于 temp 且可清理", () => {
  const bm = new BrowserManager({ userDataDir: path.join(os.tmpdir(), "gsc-test-mgr") });
  const p = bm.resolveProfile({ profileMode: PROFILE_MODE.EPHEMERAL });
  assert.ok(p.ephemeral);
  assert.ok(p.dir.includes("gsc-ephemeral-"));
  // 清理安全校验
  assert.ok(bm.cleanupEphemeral(p.dir) || true, "清理不应抛错");
});

test("BrowserManager 持久 profile 落在 profiles 目录内", () => {
  const root = path.join(os.tmpdir(), "gsc-test-mgr");
  const bm = new BrowserManager({ userDataDir: root });
  const p = bm.resolveProfile({ profileMode: PROFILE_MODE.PERSISTENT, profileName: "u1" });
  assert.ok(!p.ephemeral);
  assert.ok(p.dir.startsWith(path.join(root, "profiles")), "应在 profiles 目录内");
  // 恶意名被约束
  const evil = bm.resolveProfile({ profileMode: PROFILE_MODE.PERSISTENT, profileName: "../../evil" });
  assert.ok(evil.dir.startsWith(path.join(root, "profiles")), "恶意名不得逃出");
});

test("cleanupEphemeral 拒绝删除非 temp 目录", () => {
  const bm = new BrowserManager({ userDataDir: path.join(os.tmpdir(), "gsc-test-mgr") });
  assert.strictEqual(bm.cleanupEphemeral("C:\\Windows\\System32"), false);
  assert.strictEqual(bm.cleanupEphemeral(path.join(os.tmpdir(), "not-gsc-prefix")), false);
});

console.log("\n=== 单元测试：ChromiumDownloader ===\n");

test("下载器状态查询（未安装）", () => {
  const d = new ChromiumDownloader({ baseDir: path.join(os.tmpdir(), "gsc-nope-" + Date.now()) });
  const s = d.status();
  assert.strictEqual(s.installed, false);
  assert.strictEqual(s.asset, "chrome");
});

test("下载器识别已安装（缓存幂等）", () => {
  // 若之前测试已下载过 headless-shell，应能识别
  const base = path.join(os.tmpdir(), "gsc-browser-test");
  if (fs.existsSync(base)) {
    const d = new ChromiumDownloader({ baseDir: base, asset: "chrome-headless-shell" });
    const s = d.status();
    if (s.installed) {
      assert.ok(fs.existsSync(s.exe), "缓存的可执行文件应存在");
      console.log(`      缓存命中: v${s.version}`);
    } else {
      console.log("      （未预置缓存，跳过）");
    }
  }
});

console.log("\n=== 单元测试：原子写 ===\n");

const { writeFileAtomic } = require("../src/core/capture-engine");

test("writeFileAtomic 正常写入且无残留 .part", () => {
  const dir = path.join(os.tmpdir(), "gsc-atomic-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "a.txt");
  writeFileAtomic(f, "hello");
  assert.strictEqual(fs.readFileSync(f, "utf8"), "hello");
  assert.ok(!fs.existsSync(f + ".part"), "不应残留 .part");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("writeFileAtomic 失败时清理 .part", () => {
  const dir = path.join(os.tmpdir(), "gsc-atomic2-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const bad = path.join(dir, "sub", "x.txt"); // 目录不存在 → 写入失败
  let threw = false;
  try { writeFileAtomic(bad, "x"); } catch { threw = true; }
  assert.ok(threw, "应抛错");
  assert.ok(!fs.existsSync(bad + ".part"), "失败后不应残留 .part");
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log("\n=== 集成测试：abort 语义 ===\n");

test("abort() 使 run() 返回 aborted 而非假成功", async () => {
  const browsers = detectBrowsers();
  if (!browsers.length) { console.log("      （无浏览器，跳过）"); return; }
  const os2 = require("os");
  const engine = new CaptureEngine({
    targetUrl: "https://example.com",
    outputDir: path.join(os2.tmpdir(), "gsc-abort-test-" + Date.now()),
    executablePath: browsers[0].path,
    headless: true,
    userDataDir: path.join(os2.tmpdir(), "gsc-abort-prof-" + Date.now()),
    port: 9401,
    saveSource: false, saveHar: false, saveHtml: false,
    scrollRounds: 0, timeout: 20000,
    onProgress: () => {},
  });
  setTimeout(() => engine.abort(), 400);
  const r = await engine.run();
  assert.strictEqual(r.aborted, true, "aborted 应为 true");
  await engine.shutdown();
});

/* ---------- 集成测试（真实抓取） ---------- */

(async () => {
  // 等待所有异步单元测试完成
  await Promise.all(pending);

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
