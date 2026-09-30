"use strict";

/**
 * 单元测试：Cloudflare 挑战检测器
 * 用法: node test/unit-cf-detector.js
 */

const assert = require("assert");
const {
  CF_TYPE,
  detectChallenge,
  detectFromHeaders,
  detectFromHtml,
  detectFromTitle,
  detectFromFrameTree,
  canAutoWait,
  needsInteraction,
} = require("../src/core/cf-detector");

let passed = 0, failed = 0;
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

console.log("=".repeat(56));
console.log("  CF 检测器单元测试");
console.log("=".repeat(56));

/* ---------- 响应头 ---------- */
console.log("\n[1] 响应头信号\n");

test("cf-mitigated: challenge 判定为挑战（强证据）", () => {
  const r = detectFromHeaders({ "cf-mitigated": "challenge" });
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.strength, "strong");
  assert.ok(r.evidence.some((e) => e.includes("cf-mitigated")));
});

test("大小写不敏感（CF-Mitigated）", () => {
  assert.strictEqual(detectFromHeaders({ "CF-Mitigated": "Challenge" }).hit, false, "值需精确匹配 challenge");
  assert.strictEqual(detectFromHeaders({ "CF-Mitigated": "challenge" }).hit, true);
});

test("cf-ray + 403 判定为硬封（BLOCK）", () => {
  const r = detectFromHeaders({ "cf-ray": "abc123", ":status": "403" });
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.type, CF_TYPE.BLOCK);
});

test("仅 server:cloudflare 不判定为挑战（避免误报）", () => {
  assert.strictEqual(detectFromHeaders({ server: "cloudflare" }).hit, false);
});

test("普通响应头不误报", () => {
  const r = detectFromHeaders({ "content-type": "text/html", server: "nginx" });
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.evidence.length, 0);
});

test("空/非法输入不崩溃", () => {
  assert.strictEqual(detectFromHeaders(null).hit, false);
  assert.strictEqual(detectFromHeaders(undefined).hit, false);
  assert.strictEqual(detectFromHeaders({}).hit, false);
});

test("数组型头值被正确合并", () => {
  const r = detectFromHeaders({ "cf-ray": ["a", "b"], ":status": "503" });
  assert.strictEqual(r.hit, true);
});

/* ---------- HTML ---------- */
console.log("\n[2] HTML 信号\n");

test("challenge-platform 脚本 → JSD 挑战", () => {
  const r = detectFromHtml('<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.type, CF_TYPE.JSD);
});

test("Turnstile widget → TURNSTILE", () => {
  const r = detectFromHtml('<iframe src="https://challenges.cloudflare.com/cdn-cgi/..."></iframe>');
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.type, CF_TYPE.TURNSTILE);
});

test("_cf_chl_opt → 托管挑战", () => {
  const r = detectFromHtml("var _cf_chl_opt={cvId:'3'};");
  assert.strictEqual(r.hit, true);
});

test("CF 错误页 → BLOCK", () => {
  const r = detectFromHtml("<div id='cf-error-details'>Error 1020</div>");
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.type, CF_TYPE.BLOCK);
});

test("普通网页不误报", () => {
  const html = "<!DOCTYPE html><html><head><title>Hello</title></head><body><h1>World</h1></body></html>";
  const r = detectFromHtml(html);
  assert.strictEqual(r.hit, false, "正常网页被误判为挑战：" + r.evidence.join(","));
});

test("含 'challenge' 字样的普通页面不误报", () => {
  const r = detectFromHtml("<h1>Weekly Coding Challenge Results</h1><p>Join the challenge!</p>");
  assert.strictEqual(r.hit, false);
});

test("空 HTML 不崩溃", () => {
  assert.strictEqual(detectFromHtml("").hit, false);
  assert.strictEqual(detectFromHtml(null).hit, false);
});

/* ---------- 标题 ---------- */
console.log("\n[3] 页面标题信号\n");

test("Just a moment... → 托管挑战", () => {
  const r = detectFromTitle("Just a moment...");
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.type, CF_TYPE.MANAGED);
});

test("Attention Required! → BLOCK", () => {
  const r = detectFromTitle("Attention Required! | Cloudflare");
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.type, CF_TYPE.BLOCK);
});

test("Verifying you are human → TURNSTILE", () => {
  const r = detectFromTitle("Verifying you are human");
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.type, CF_TYPE.TURNSTILE);
});

test("普通标题不误报", () => {
  assert.strictEqual(detectFromTitle("Example Domain").hit, false);
  assert.strictEqual(detectFromTitle("").hit, false);
  // 含 moment 但非挑战页
  assert.strictEqual(detectFromTitle("A moment in time").hit, false);
});

/* ---------- 帧树 ---------- */
console.log("\n[4] 帧树信号\n");

test("嵌套的 Turnstile iframe 被检出", () => {
  const tree = {
    frameTree: {
      frame: { url: "https://target.com" },
      childFrames: [{
        frame: { url: "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/..." },
      }],
    },
  };
  const r = detectFromFrameTree(tree);
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.type, CF_TYPE.TURNSTILE);
});

test("无 CF 帧不误报", () => {
  const tree = { frameTree: { frame: { url: "https://target.com" }, childFrames: [{ frame: { url: "https://ads.example.com" } }] } };
  assert.strictEqual(detectFromFrameTree(tree).hit, false);
});

test("空帧树不崩溃", () => {
  assert.strictEqual(detectFromFrameTree(null).hit, false);
  assert.strictEqual(detectFromFrameTree({}).hit, false);
});

/* ---------- 综合判定 ---------- */
console.log("\n[5] 综合判定（detectChallenge）\n");

test("强证据单独即可定案（中置信）", () => {
  const r = detectChallenge({ headers: { "cf-mitigated": "challenge" } });
  assert.strictEqual(r.challenged, true);
  assert.strictEqual(r.confidence, "medium");
});

test("多个独立强证据互相印证 → 高置信", () => {
  const r = detectChallenge({
    headers: { "cf-mitigated": "challenge" },
    html: '<script src="/cdn-cgi/challenge-platform/x"></script>',
  });
  assert.strictEqual(r.challenged, true);
  assert.strictEqual(r.confidence, "high");
  assert.ok(r.evidence.length >= 2);
});

test("单个弱证据不足以定案（server:cloudflare 不等于被挑战）", () => {
  const r = detectChallenge({ headers: { server: "cloudflare" } });
  assert.strictEqual(r.challenged, false);
  assert.strictEqual(r.confidence, "low");
});

test("弱证据 + 强证据仍以强证据定案", () => {
  const r = detectChallenge({
    headers: { server: "cloudflare" },
    html: "var _cf_chl_opt={};",
  });
  assert.strictEqual(r.challenged, true, "CF 专属标记应被识别为强证据");
  assert.strictEqual(r.confidence, "medium");
});

test("多个弱证据叠加仍不定案（避免误报）", () => {
  const r = detectChallenge({ headers: { server: "cloudflare", "x-powered-by": "cloudflare" } });
  assert.strictEqual(r.challenged, false, "仅代理迹象不应判定为挑战");
});

test("类型优先级：turnstile 优先于 jsd", () => {
  const r = detectChallenge({
    html: '<script src="/cdn-cgi/challenge-platform/x"></script><iframe src="https://challenges.cloudflare.com/y"></iframe>',
  });
  assert.strictEqual(r.type, CF_TYPE.TURNSTILE);
});

test("完全正常页面不误报", () => {
  const r = detectChallenge({
    headers: { "content-type": "text/html", server: "nginx" },
    html: "<html><head><title>Example Domain</title></head><body></body></html>",
    title: "Example Domain",
  });
  assert.strictEqual(r.challenged, false, "正常页面被误判：" + r.evidence.join(","));
  assert.strictEqual(r.confidence, "low");
});

test("无任何输入不崩溃", () => {
  const r = detectChallenge({});
  assert.strictEqual(r.challenged, false);
  assert.deepStrictEqual(r.evidence, []);
});

test("返回结构稳定（字段齐全）", () => {
  const r = detectChallenge({ headers: { "cf-mitigated": "challenge" } });
  assert.ok("challenged" in r && "type" in r && "evidence" in r && "confidence" in r);
  assert.ok(Array.isArray(r.evidence));
});

/* ---------- 辅助判定 ---------- */
console.log("\n[6] 辅助判定\n");

test("canAutoWait：jsd/managed 可通过等待自动通过", () => {
  assert.strictEqual(canAutoWait(CF_TYPE.JSD), true);
  assert.strictEqual(canAutoWait(CF_TYPE.MANAGED), true);
  assert.strictEqual(canAutoWait(CF_TYPE.TURNSTILE), false);
  assert.strictEqual(canAutoWait(CF_TYPE.BLOCK), false);
  assert.strictEqual(canAutoWait(null), false);
});

test("needsInteraction：仅 turnstile 需交互", () => {
  assert.strictEqual(needsInteraction(CF_TYPE.TURNSTILE), true);
  assert.strictEqual(needsInteraction(CF_TYPE.JSD), false);
  assert.strictEqual(needsInteraction(null), false);
});

console.log("\n" + "=".repeat(56));
console.log(`  CF 检测器：${passed} 通过, ${failed} 失败`);
console.log("=".repeat(56));
process.exit(failed ? 1 : 0);
