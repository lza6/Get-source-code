"use strict";

/**
 * Cloudflare 挑战检测器
 *
 * 纯函数、无副作用、不发起网络请求 —— 仅根据「响应头 / HTML / 页面标题 / 帧树」
 * 判断当前页面是否被 Cloudflare 拦截，以及属于哪一类挑战。
 *
 * 设计目标：
 *  1. 准确 —— 只在真有证据时判定为挑战，避免正常站点误报
 *  2. 可解释 —— 返回命中的具体证据，便于 UI 展示与排障
 *  3. 可测试 —— 全部输入为普通对象，无需浏览器即可单测
 *
 * 依据（外部实证）：
 *  - Cloudflare 挑战页会带 `cf-mitigated: challenge` 响应头
 *  - 挑战页会加载 `/cdn-cgi/challenge-platform/` 下的脚本
 *  - 页面标题典型为 "Just a moment..." / "Attention Required!"
 *  - Turnstile 交互式验证在 `challenges.cloudflare.com` 的 iframe 中
 */

/** 挑战类型 */
const CF_TYPE = {
  JSD: "jsd",             // 非交互式 JS 挑战（可纯协议解，也可浏览器等待通过）
  MANAGED: "managed",     // 托管挑战（需真实浏览器执行 JS）
  TURNSTILE: "turnstile", // 交互式验证框（需用户交互或模拟点击）
  BLOCK: "block",         // 硬封禁（无解，需换 IP）
};

/** 判定证据的权重（强证据单独即可定案；弱证据需组合） */
const STRONG = "strong";
const WEAK = "weak";

/**
 * 从响应头判定
 * @param {Record<string,string>} headers 大小写不敏感的响应头对象（或已小写化）
 * @returns {{hit:boolean, type:string|null, evidence:string[], strength:string}}
 */
function detectFromHeaders(headers) {
  const h = normalizeHeaders(headers);
  const evidence = [];
  let type = null;
  let strength = WEAK;
  let hit = false;

  // 强证据：CF 明确标记本次响应为挑战
  if (h["cf-mitigated"] === "challenge") {
    evidence.push("header:cf-mitigated=challenge");
    strength = STRONG;
    hit = true;
  }

  // 强证据：CF 拦截页（403/503 + cf-ray）
  if (h["cf-ray"] && (h[":status"] === "403" || h[":status"] === "503")) {
    evidence.push(`header:cf-ray + status ${h[":status"]}`);
    strength = STRONG;
    hit = true;
    type = CF_TYPE.BLOCK;
  }

  // 弱证据：server 头是 cloudflare（仅说明经 CF 代理，不一定是挑战）
  if (/cloudflare/i.test(h["server"] || "")) {
    evidence.push("header:server=cloudflare");
  }

  return { hit, type, evidence, strength };
}

/**
 * 从 HTML 文本判定
 * @param {string} html
 * @returns {{hit:boolean, type:string|null, evidence:string[], strength:string}}
 */
function detectFromHtml(html) {
  const s = String(html || "");
  const evidence = [];
  let type = null;
  let strength = WEAK;

  if (!s) return { hit: false, type: null, evidence, strength };

  // 强证据：挑战平台脚本
  if (/\/cdn-cgi\/challenge-platform\//.test(s)) {
    evidence.push("html:cdn-cgi/challenge-platform");
    strength = STRONG;
    type = CF_TYPE.JSD;
  }

  // 强证据：Turnstile widget
  if (/challenges\.cloudflare\.com/.test(s)) {
    evidence.push("html:challenges.cloudflare.com");
    strength = STRONG;
    type = CF_TYPE.TURNSTILE;
  }

  // CF 专属标记（普通站点不会出现这些 token）→ 强证据
  if (/_cf_chl_opt|cf-chl-|challenge-running|cf_chl_prog/.test(s)) {
    evidence.push("html:cf challenge marker");
    strength = STRONG;
    if (!type) type = CF_TYPE.MANAGED;
  }

  // CF 错误页 → 强证据
  if (/__cf_error|cf-error-details|Error 1020|Attention Required/i.test(s)) {
    evidence.push("html:cf error page");
    strength = STRONG;
    if (!type) type = CF_TYPE.BLOCK;
  }

  return { hit: strength === STRONG, type, evidence, strength };
}

/**
 * 从页面标题判定
 * 这三个精确标题是 CF 挑战页专属，普通站点几乎不可能使用 → 强证据。
 * @param {string} title
 */
function detectFromTitle(title) {
  const t = String(title || "").trim();
  const evidence = [];
  let type = null;
  let strength = WEAK;

  if (/^Just a moment/i.test(t)) {
    evidence.push(`title:${t}`);
    type = CF_TYPE.MANAGED;
    strength = STRONG;
  } else if (/^Attention Required/i.test(t)) {
    evidence.push(`title:${t}`);
    type = CF_TYPE.BLOCK;
    strength = STRONG;
  } else if (/^Verifying you are human/i.test(t)) {
    evidence.push(`title:${t}`);
    type = CF_TYPE.TURNSTILE;
    strength = STRONG;
  }
  return { hit: strength === STRONG, type, evidence, strength };
}

/**
 * 从 CDP 帧树判定 Turnstile iframe
 * @param {object} frameTree Page.getFrameTree 的返回
 */
function detectFromFrameTree(frameTree) {
  const evidence = [];
  let type = null;
  const walk = (node) => {
    if (!node) return;
    const url = (node.frame && node.frame.url) || "";
    if (/challenges\.cloudflare\.com/.test(url)) {
      evidence.push("frame:challenges.cloudflare.com");
      type = CF_TYPE.TURNSTILE;
    }
    for (const c of node.childFrames || []) walk(c);
  };
  walk(frameTree && frameTree.frameTree);
  return { hit: evidence.length > 0, type, evidence };
}

/**
 * 综合判定
 *
 * @param {object} input
 * @param {Record<string,string>} [input.headers] 主文档响应头
 * @param {string} [input.html]                  页面 HTML（或前若干 KB）
 * @param {string} [input.title]                 页面标题
 * @param {object} [input.frameTree]             Page.getFrameTree 结果
 * @returns {{challenged:boolean, type:string|null, evidence:string[], confidence:'high'|'medium'|'low'}}
 */
function detectChallenge(input = {}) {
  const parts = [];
  if (input.headers) parts.push(detectFromHeaders(input.headers));
  if (input.html) parts.push(detectFromHtml(input.html));
  if (input.title) parts.push(detectFromTitle(input.title));
  if (input.frameTree) parts.push(detectFromFrameTree(input.frameTree));

  const evidence = parts.flatMap((p) => p.evidence || []);
  // 类型优先级：turnstile > block > managed > jsd（越靠前越"重"）
  const order = [CF_TYPE.TURNSTILE, CF_TYPE.BLOCK, CF_TYPE.MANAGED, CF_TYPE.JSD];
  const types = parts.map((p) => p.type).filter(Boolean);
  const type = order.find((t) => types.includes(t)) || null;

  // 判定策略：
  //  - 强证据（CF 专属标记，正常站点不会出现）单独即可定案
  //  - 弱证据（如 server:cloudflare，仅表示经 CF 代理）永不定案，只作补充说明
  //  - 多个独立强证据互相印证 → 提升置信度
  const strongCount = parts.filter((p) => p.hit && p.strength === STRONG).length;
  const challenged = strongCount > 0;
  const confidence = strongCount >= 2 ? "high" : strongCount === 1 ? "medium" : "low";

  return { challenged, type: challenged ? type : null, evidence, confidence };
}

/** 归一化响应头键名（小写、去空格） */
function normalizeHeaders(headers) {
  const out = {};
  if (!headers || typeof headers !== "object") return out;
  for (const [k, v] of Object.entries(headers)) {
    out[String(k).toLowerCase().trim()] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  return out;
}

/** 该挑战类型是否可能通过"等待"自动通过（无需交互） */
function canAutoWait(type) {
  return type === CF_TYPE.JSD || type === CF_TYPE.MANAGED;
}

/** 该挑战类型是否需要人工/模拟交互 */
function needsInteraction(type) {
  return type === CF_TYPE.TURNSTILE;
}

module.exports = {
  CF_TYPE,
  detectChallenge,
  detectFromHeaders,
  detectFromHtml,
  detectFromTitle,
  detectFromFrameTree,
  normalizeHeaders,
  canAutoWait,
  needsInteraction,
};
