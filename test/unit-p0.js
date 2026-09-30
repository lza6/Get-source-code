"use strict";

/**
 * P0 修复项的定点单测（不依赖浏览器，纯逻辑）
 * 覆盖：P0-1 事件分发 / P0-2 HAR 响应体 / P0-3 文件名截断 / P0-6 Runtime 域契约
 *
 * 用法: node test/unit-p0.js
 */

const assert = require("assert");
const { CDPClient } = require("../src/core/cdp-client");
const { HarBuilder } = require("../src/core/har-builder");
const { safeFileName, buildLocalPath, MimeClassifier } = require("../src/core/mime-utils");

let passed = 0, failed = 0;
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
  const r = run();
  if (r && typeof r.then === "function") pending.push(r);
}

/* ================= P0-1：CDPClient 事件分发 ================= */
console.log("\n=== P0-1 CDPClient 事件分发 ===\n");

test("并发 waitFor 均能收到各自事件（原实现会有一个静默失效）", async () => {
  const c = new CDPClient("ws://unused", {});
  const p1 = c.waitFor("A", { timeout: 500 });
  const p2 = c.waitFor("B", { timeout: 500 });
  c._dispatch({ type: "event", method: "A", params: { v: 1 } });
  c._dispatch({ type: "event", method: "B", params: { v: 2 } });
  assert.deepStrictEqual(await p1, { v: 1 }, "第一个 waitFor 未收到事件");
  assert.deepStrictEqual(await p2, { v: 2 }, "第二个 waitFor 未收到事件");
  c.close();
});

test("多订阅者都会收到事件且互不影响", () => {
  const c = new CDPClient("ws://unused", {});
  const got = [];
  const off1 = c.on((e) => got.push("a:" + e.method));
  const off2 = c.on((e) => got.push("b:" + e.method));
  c._dispatch({ type: "event", method: "X", params: {} });
  assert.deepStrictEqual(got, ["a:X", "b:X"]);
  off1();
  c._dispatch({ type: "event", method: "Y", params: {} });
  assert.deepStrictEqual(got, ["a:X", "b:X", "b:Y"], "取消订阅后仍被调用");
  c.close();
});

test("单个订阅者抛异常不影响其他订阅者与 waitFor", async () => {
  const c = new CDPClient("ws://unused", {});
  c.on(() => { throw new Error("订阅者内部错误"); });
  const p = c.waitFor("Z", { timeout: 500 });
  c._dispatch({ type: "event", method: "Z", params: { ok: true } });
  assert.deepStrictEqual(await p, { ok: true });
  c.close();
});

test("waitFor 按 sessionId 过滤", async () => {
  const c = new CDPClient("ws://unused", {});
  const p = c.waitFor("E", { sessionId: "s2", timeout: 500 });
  c._dispatch({ type: "event", method: "E", sessionId: "s1", params: { n: 1 } });
  c._dispatch({ type: "event", method: "E", sessionId: "s2", params: { n: 2 } });
  assert.deepStrictEqual(await p, { n: 2 });
  c.close();
});

test("waitFor 支持 predicate 谓词", async () => {
  const c = new CDPClient("ws://unused", {});
  const p = c.waitFor("E", { timeout: 500, predicate: (x) => x.n === 2 });
  c._dispatch({ type: "event", method: "E", params: { n: 1 } });
  assert.strictEqual(c._waiters.size, 1, "不满足谓词时不应消费 waiter");
  c._dispatch({ type: "event", method: "E", params: { n: 2 } });
  assert.deepStrictEqual(await p, { n: 2 });
  c.close();
});

test("waitFor 超时后不残留等待器（原实现会泄漏包装器）", async () => {
  const c = new CDPClient("ws://unused", {});
  await assert.rejects(() => c.waitFor("NEVER", { timeout: 60 }), /超时/);
  assert.strictEqual(c._waiters.size, 0, "超时后仍残留 waiter");
  c.close();
});

test("abortAll 使挂起的 send 与 waitFor 立即失败（不等超时）", async () => {
  const c = new CDPClient("ws://unused", {});
  c._connected = true;
  c._ws = { send: () => {} }; // 伪造 socket，让 send 进入 pending
  const started = Date.now();
  const ps = c.send("SlowCmd", {}, { timeout: 10000 }).catch((e) => e);
  const pw = c.waitFor("SlowEvt", { timeout: 10000 }).catch((e) => e);
  setTimeout(() => c.abortAll("用户已中止"), 30);
  const [es, ew] = await Promise.all([ps, pw]);
  assert.strictEqual(es.aborted, true, "send 未标记 aborted");
  assert.strictEqual(ew.aborted, true, "waitFor 未标记 aborted");
  assert.ok(Date.now() - started < 2000, "abortAll 未立即生效");
  assert.strictEqual(c._pending.size, 0, "pending 未清空");
  assert.strictEqual(c._waiters.size, 0, "waiters 未清空");
});

test("断连时挂起的 waitFor 立即失败而非挂死", async () => {
  const c = new CDPClient("ws://unused", {});
  const p = c.waitFor("ANY", { timeout: 5000 });
  c._dispatch({ type: "disconnected" });
  await assert.rejects(() => p, /断开/);
});

test("断连时在途 send 也被清理（不等 60s 超时）", async () => {
  const c = new CDPClient("ws://unused", {});
  c._connected = true;
  c._ws = { send: () => {} };
  const started = Date.now();
  const p = c.send("SlowCmd", {}, { timeout: 30000 }).catch((e) => e);
  setTimeout(() => c.abortAll("CDP 连接已断开"), 30);
  const e = await p;
  assert.strictEqual(e.aborted, true);
  assert.ok(Date.now() - started < 2000, "未立即失败");
});

test("_scrollPage 共享总时长预算（不因轮次叠加放大）", () => {
  // 静态断言：_scrollPage 内部必须把剩余预算传给 _waitNetworkIdle
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "core", "capture-engine.js"), "utf8"
  );
  const body = src.slice(src.indexOf("async _scrollPage"), src.indexOf("async cleanup"));
  assert.ok(/deadline|remaining\(\)/.test(body), "_scrollPage 未设置总预算 deadline");
  assert.ok(/_waitNetworkIdle\([^)]*remaining\(\)/.test(body),
    "_waitNetworkIdle 未接收剩余预算 —— 最坏情况会退化为 rounds × timeout");
});

test("_scrollPage 支持 scrollToBottom 模式开关", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "core", "capture-engine.js"), "utf8"
  );
  assert.ok(/scrollToBottom/.test(src), "缺少 scrollToBottom 选项");
  assert.ok(/scrollToBottom: true/.test(src), "scrollToBottom 默认值应为 true");
});

test("滚动采用分步推进（避免瞬间跳到底部导致懒加载不触发）", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "core", "capture-engine.js"), "utf8"
  );
  const body = src.slice(src.indexOf("async _scrollStepwise"), src.indexOf("async _handleChallenge"));
  assert.ok(/step/.test(body) && /scrollTo/.test(body), "_scrollStepwise 未实现分步滚动");
  // 每步不应一次到底：应基于 innerHeight 计算步长
  assert.ok(/innerHeight/.test(body), "步长未基于视口高度计算");
});

test("close() 使挂起者失败，不产生悬挂 Promise", async () => {
  const c = new CDPClient("ws://unused", {});
  c._ws = { close: () => {} };
  const p = c.waitFor("ANY", { timeout: 5000 });
  c.close();
  await assert.rejects(() => p);
  assert.strictEqual(c.connected, false);
});

/* ================= P0-2：HAR 响应体 ================= */
console.log("\n=== P0-2 HAR 响应体（content.text）===\n");

function seedEntry(hb, id, url, mimeType = "text/javascript") {
  hb.onRequestWillBeSent({ requestId: id, wallTime: 1, timestamp: 1, request: { url, method: "GET", headers: {} } });
  hb.onResponseReceived({ requestId: id, timestamp: 1.1, type: "Script", response: { url, status: 200, mimeType, headers: {}, encodedDataLength: 10 } });
  hb.onLoadingFinished({ requestId: id, timestamp: 1.2, encodedDataLength: 10 });
}

test("小响应体内联到 content.text 且与原文一致", () => {
  const hb = new HarBuilder();
  seedEntry(hb, "r1", "https://x.com/a.js");
  hb.attachBody("r1", { text: "console.log(1)", mimeType: "text/javascript", size: 14 });
  const e = hb.build().log.entries[0];
  assert.strictEqual(e.response.content.text, "console.log(1)");
  assert.strictEqual(e.response.content.size, 14);
  assert.strictEqual(e.response.content.encoding, undefined);
});

test("base64 响应体带 encoding 标记且可解码还原", () => {
  const hb = new HarBuilder();
  seedEntry(hb, "r2", "https://x.com/a.png");
  const raw = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  hb.attachBody("r2", { text: raw.toString("base64"), encoding: "base64", mimeType: "image/png", size: raw.length });
  const c = hb.build().log.entries[0].response.content;
  assert.strictEqual(c.encoding, "base64");
  assert.deepStrictEqual(Buffer.from(c.text, "base64"), raw, "base64 解码后与原字节不一致");
});

test("超过 1MB 的 body 不内联，改为 _bodyOmitted + _bodyFile", () => {
  const hb = new HarBuilder();
  seedEntry(hb, "r3", "https://x.com/big.js");
  hb.setSavedFile("r3", "source/x.com/big.js");
  hb.attachBody("r3", { text: "x".repeat(10), mimeType: "text/javascript", size: 2 * 1024 * 1024 });
  const c = hb.build().log.entries[0].response.content;
  assert.strictEqual(c.text, undefined, "大 body 不应内联");
  assert.strictEqual(c._bodyOmitted, true);
  assert.strictEqual(c._bodyFile, "source/x.com/big.js");
  assert.strictEqual(c.size, 2 * 1024 * 1024);
});

test("attachBody 对未知 requestId 安全忽略（不抛异常）", () => {
  const hb = new HarBuilder();
  hb.attachBody("nonexistent", { text: "x", mimeType: "t", size: 1 });
});

test("未调用 attachBody 时 content 结构仍合法（向后兼容）", () => {
  const hb = new HarBuilder();
  seedEntry(hb, "r4", "https://x.com/c.css", "text/css");
  const c = hb.build().log.entries[0].response.content;
  assert.strictEqual(typeof c.size, "number");
  assert.strictEqual(c.mimeType, "text/css");
  assert.strictEqual(c.text, undefined);
});

/* ================= P0-3：文件名截断 ================= */
console.log("\n=== P0-3 safeFileName 超长截断 ===\n");

test("普通超长名截断后保留扩展名", () => {
  const s = safeFileName("a".repeat(300) + ".js", 120);
  assert.ok(s.length <= 120, `长度 ${s.length} 超限`);
  assert.ok(s.endsWith(".js"));
  assert.ok(s.length > 3, "stem 被清空");
});

test("扩展名超长时截断仍生效（原实现输出 621 字符）", () => {
  const long = "a".repeat(300) + "." + "b".repeat(200);
  const s = safeFileName(long, 120);
  assert.ok(s.length <= 120, `截断失效：输出 ${s.length} 字符，应 <= 120`);
  assert.ok(s.length > 0);
});

test("无扩展名超长名截断正常", () => {
  const s = safeFileName("a".repeat(500), 120);
  assert.ok(s.length <= 120);
});

test("截断结果不为空且不含路径分隔符", () => {
  const cases = [".".repeat(200), "x".repeat(400), "a.".repeat(200)];
  for (const c of cases) {
    const s = safeFileName(c, 120);
    assert.ok(s.length > 0, `输入 ${c.slice(0, 10)}… 产出空名`);
    assert.ok(!/[\\/]/.test(s), "产出含路径分隔符");
  }
});

test("超长文件名经 buildLocalPath 后不会互相覆盖（hash 消歧生效）", () => {
  const u1 = "https://x.com/" + "a".repeat(300) + ".js";
  const u2 = "https://x.com/" + "b".repeat(300) + ".js";
  const c1 = MimeClassifier.classify(u1, "text/javascript", "Script");
  const c2 = MimeClassifier.classify(u2, "text/javascript", "Script");
  const p1 = buildLocalPath(u1, c1, "https://x.com");
  const p2 = buildLocalPath(u2, c2, "https://x.com");
  assert.notStrictEqual(p1, p2, "不同 URL 产生了相同本地路径");
});

test("任意 maxLen 下都严格遵守长度契约（含极小值）", () => {
  const inputs = [
    "a".repeat(500),
    "a".repeat(300) + "." + "b".repeat(200),
    "x.".repeat(200),
    "正常中文文件名".repeat(50),
    "." + "z".repeat(100),
  ];
  for (const maxLen of [5, 8, 16, 32, 64, 120]) {
    for (const inp of inputs) {
      const s = safeFileName(inp, maxLen);
      assert.ok(s.length <= maxLen,
        `maxLen=${maxLen} 时输出 ${s.length} 字符（输入 ${inp.slice(0, 12)}…）`);
      assert.ok(s.length > 0, `maxLen=${maxLen} 时输出空名`);
    }
  }
});

test("maxLen 极小且扩展名超长时不崩坏", () => {
  const s = safeFileName("a".repeat(100) + "." + "b".repeat(100), 5);
  assert.ok(s.length <= 5, `输出 ${s.length} 字符`);
  assert.ok(s.length > 0);
  assert.ok(!/[\\/]/.test(s));
});

/* ================= P0-6：Runtime 域契约 ================= */
console.log("\n=== P0-6 Runtime 域契约（静态）===\n");

test("capture-engine 不再调用 Runtime.enable", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "core", "capture-engine.js"), "utf8"
  );
  // 排除注释行后再断言
  const code = src.replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/Runtime\.enable/.test(code), "仍存在 Runtime.enable 调用（暴露自动化特征）");
});

test("capture-engine 仍使用 Runtime.evaluate（证明未误删功能）", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "core", "capture-engine.js"), "utf8"
  );
  assert.ok(/Runtime\.evaluate/.test(src), "Runtime.evaluate 被误删");
});

test("capture-engine 启用了 setCacheDisabled", () => {
  const src = require("fs").readFileSync(
    require("path").join(__dirname, "..", "src", "core", "capture-engine.js"), "utf8"
  );
  assert.ok(/setCacheDisabled/.test(src), "未禁用缓存，命中缓存时 body 会丢失");
});

/* ================= 汇总 ================= */
(async () => {
  await Promise.all(pending);
  console.log("\n" + "=".repeat(46));
  console.log(`  P0 定点测试：${passed} 通过, ${failed} 失败`);
  console.log("=".repeat(46));
  process.exit(failed ? 1 : 0);
})();
