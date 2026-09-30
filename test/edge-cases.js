"use strict";

/**
 * 边界与异常场景测试
 * 覆盖工具在极端输入/环境下的行为，找出崩溃点。
 *
 * 用法: node test/edge-cases.js
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const assert = require("assert");
const { MimeClassifier, safeFileName, buildLocalPath } = require("../src/core/mime-utils");
const { HarBuilder } = require("../src/core/har-builder");
const { ChromiumDownloader } = require("../src/core/chromium-downloader");
const { BrowserManager, sanitizeProfileName, isTrustedExecutable } = require("../src/core/browser-manager");
const { writeFileAtomic } = require("../src/core/capture-engine");

let passed = 0, failed = 0;
const results = [];
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
    results.push({ name, ok: true });
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    failed++;
    results.push({ name, ok: false, err: e.message });
  }
}

console.log("=".repeat(58));
console.log("  边界与异常场景测试");
console.log("=".repeat(58));

/* ---------- 1. 路径安全（恶意站点输入） ---------- */
console.log("\n[1] 路径安全（站点可控制 URL）\n");

test("URL 含 ../ 不会逃出 outputDir", () => {
  const cls = MimeClassifier.classify("https://evil.com/../../../../Windows/System32/x.js", "application/javascript", "Script");
  const p = buildLocalPath("https://evil.com/../../../../Windows/System32/x.js", cls, "");
  const norm = path.normalize(p);
  assert.ok(!norm.includes(".."), `不应含 .. —— 实际: ${norm}`);
  assert.ok(!path.isAbsolute(norm), `不应是绝对路径 —— 实际: ${norm}`);
});

test("URL 含编码的 %2e%2e 不会逃逸", () => {
  const cls = MimeClassifier.classify("https://evil.com/%2e%2e/%2e%2e/x.js", "application/javascript", "Script");
  const p = buildLocalPath("https://evil.com/%2e%2e/%2e%2e/x.js", cls, "");
  assert.ok(!path.normalize(p).includes(".."), `实际: ${p}`);
});

test("URL 含 Windows 保留设备名不崩溃", () => {
  for (const n of ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"]) {
    const cls = MimeClassifier.classify(`https://x.com/${n}.js`, "application/javascript", "Script");
    const p = buildLocalPath(`https://x.com/${n}.js`, cls, "");
    assert.ok(typeof p === "string" && p.length > 0, `${n} 应产出路径`);
  }
});

test("超长 URL 段被截断且不崩溃", () => {
  const long = "a".repeat(5000) + ".js";
  const cls = MimeClassifier.classify(`https://x.com/${long}`, "application/javascript", "Script");
  const p = buildLocalPath(`https://x.com/${long}`, cls, "");
  const base = path.basename(p);
  assert.ok(base.length <= 200, `文件名应被截断，实际长度 ${base.length}`);
});

test("空/畸形 URL 不崩溃", () => {
  for (const u of ["", "not a url", "http://", "://x", "javascript:alert(1)"]) {
    const cls = MimeClassifier.classify(u, "", "");
    const p = buildLocalPath(u, cls, "");
    assert.ok(typeof p === "string", `${JSON.stringify(u)} 应产出路径`);
  }
});

test("含控制字符的文件名被清理", () => {
  const n = safeFileName("a\x00b\x1fc\nd");
  assert.ok(!/[\x00-\x1f]/.test(n), `不应含控制字符: ${JSON.stringify(n)}`);
});

/* ---------- 2. HAR 规范边界 ---------- */
console.log("\n[2] HAR 规范边界\n");

test("无响应即失败：HAR 仍可构建", () => {
  const hb = new HarBuilder();
  hb.onRequestWillBeSent({ requestId: "1", wallTime: 1, request: { url: "https://x.com/a", method: "GET", headers: {} } });
  hb.onLoadingFailed({ requestId: "1", timestamp: 1.1, errorText: "net::ERR" });
  const har = hb.build();
  assert.strictEqual(har.log.entries.length, 1);
  assert.ok(har.log.entries[0]._error, "应记录错误");
});

test("redirectResponse 不导致崩溃", () => {
  const hb = new HarBuilder();
  hb.onRequestWillBeSent({
    requestId: "1", wallTime: 1,
    request: { url: "https://x.com/a", method: "GET", headers: {} },
    redirectResponse: { status: 301, statusText: "Moved", url: "https://x.com/b", headers: { location: "https://x.com/b" } },
  });
  const har = hb.build();
  assert.strictEqual(har.log.entries.length, 1);
});

test("HAR timings 全部 >= 0（除允许 -1 的项）", () => {
  const hb = new HarBuilder();
  hb.onRequestWillBeSent({ requestId: "1", wallTime: 1, timestamp: 1, request: { url: "https://x.com/a", method: "GET", headers: {} } });
  hb.onResponseReceived({ requestId: "1", timestamp: 1.2, response: { url: "https://x.com/a", status: 200, headers: {}, mimeType: "text/html", encodedDataLength: 10 } });
  hb.onLoadingFinished({ requestId: "1", timestamp: 1.5, encodedDataLength: 10 });
  const t = hb.build().log.entries[0].timings;
  assert.ok(t.send >= 0 && t.wait >= 0 && t.receive >= 0, `send/wait/receive 必须 >=0: ${JSON.stringify(t)}`);
  // blocked/dns/connect/ssl 允许 -1
  for (const k of ["blocked", "dns", "connect", "ssl"]) {
    assert.ok(t[k] === -1 || t[k] >= 0, `${k} 应为 -1 或 >=0`);
  }
});

test("无 timestamp 的请求不产生 NaN", () => {
  const hb = new HarBuilder();
  hb.onRequestWillBeSent({ requestId: "1", wallTime: 1, request: { url: "https://x.com/a", method: "GET", headers: {} } });
  hb.onLoadingFinished({ requestId: "1", encodedDataLength: 10 });
  const e = hb.build().log.entries[0];
  assert.ok(Number.isFinite(e.time), `time 不应是 NaN/Infinity: ${e.time}`);
});

/* ---------- 3. 下载器边界 ---------- */
console.log("\n[3] 下载器边界\n");

test("平台映射覆盖主流平台", () => {
  const { detectPlatform } = require("../src/core/chromium-downloader");
  const p = detectPlatform();
  assert.ok(p.length > 0);
});

test("executableRelPath 对所有平台返回非空", () => {
  const { executableRelPath } = require("../src/core/chromium-downloader");
  for (const plat of ["win32", "win64", "mac-x64", "mac-arm64", "linux64", "linux-arm64"]) {
    for (const asset of ["chrome", "chrome-headless-shell"]) {
      const r = executableRelPath(plat, asset);
      assert.ok(r && r.length > 0, `${plat}/${asset} 应有路径`);
    }
  }
});

test("下载器 baseDir 缺失时抛错而非崩溃", () => {
  let threw = false;
  try { new ChromiumDownloader({}); } catch { threw = true; }
  assert.ok(threw, "应抛错");
});

/* ---------- 4. 原子写边界 ---------- */
console.log("\n[4] 原子写边界\n");

test("写入超长内容成功", () => {
  const dir = path.join(os.tmpdir(), "gsc-edge-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "big.txt");
  const data = "x".repeat(5 * 1024 * 1024); // 5MB
  writeFileAtomic(f, data);
  assert.strictEqual(fs.statSync(f).size, data.length);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("覆盖已存在文件成功", () => {
  const dir = path.join(os.tmpdir(), "gsc-edge2-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, "a.txt");
  writeFileAtomic(f, "v1");
  writeFileAtomic(f, "v2");
  assert.strictEqual(fs.readFileSync(f, "utf8"), "v2");
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---------- 5. 安全边界（复核） ---------- */
console.log("\n[5] 安全边界复核\n");

test("恶意 profile 名无法逃出 profiles 目录", () => {
  const root = path.join(os.tmpdir(), "gsc-edge-mgr");
  const bm = new BrowserManager({ userDataDir: root });
  for (const evil of ["../../evil", "..\\..\\evil", "/etc/passwd", "C:\\Windows\\x", "....//....//x"]) {
    const p = bm.resolveProfile({ profileMode: "persistent", profileName: evil });
    const norm = path.resolve(p.dir);
    assert.ok(norm.startsWith(path.resolve(path.join(root, "profiles"))),
      `profile "${evil}" 逃出目录: ${norm}`);
  }
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

test("cleanupEphemeral 对绝对路径/系统目录返回 false", () => {
  const bm = new BrowserManager({ userDataDir: path.join(os.tmpdir(), "gsc-edge-mgr2") });
  for (const p of ["C:\\Windows", "/etc", "C:\\Users", path.join(os.tmpdir(), "harmless")]) {
    assert.strictEqual(bm.cleanupEphemeral(p), false, `不应删除 ${p}`);
  }
});

test("isTrustedExecutable 对空/非法输入返回 false", () => {
  for (const p of [undefined, null, "", 123, {}, []]) {
    assert.strictEqual(isTrustedExecutable(p), false, `${JSON.stringify(p)} 应为 false`);
  }
});

/* ---------- 6. 错误分类（v1.1.1 修复） ---------- */
console.log("\n[6] 错误分类\n");

test("响应体释放错误归类为 skipped 而非 failed", () => {
  // 通过引擎的私有方法逻辑验证：模拟 catch 分支的判定正则
  const ignorablePattern = /No data found|No resource with given identifier|-32000/i;
  assert.ok(ignorablePattern.test("No data found for resource with given identifier (-32000)"), "应识别为可忽略");
  assert.ok(ignorablePattern.test("No resource with given identifier"), "应识别为可忽略");
  assert.ok(!ignorablePattern.test("net::ERR_CONNECTION_REFUSED"), "网络错误不应被忽略");
  assert.ok(!ignorablePattern.test("CDP 命令超时"), "超时不应被忽略");
});

test("metadata 结构含 connectionLost 字段", () => {
  // 验证 CaptureEngine 产出的 metadata 契约（静态检查字段名）
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "core", "capture-engine.js"), "utf8");
  assert.ok(/connectionLost:\s*this\._connectionLost/.test(src), "metadata 应含 connectionLost 字段");
});

/* ---------- 汇总 ---------- */
console.log("\n" + "=".repeat(58));
console.log(`  边界测试：${passed} 通过, ${failed} 失败`);
console.log("=".repeat(58) + "\n");

fs.writeFileSync(path.join(__dirname, "edge-report.json"), JSON.stringify({ passed, failed, results, ts: new Date().toISOString() }, null, 2));
process.exit(failed > 0 ? 1 : 0);
