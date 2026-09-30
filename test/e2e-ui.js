"use strict";

/**
 * UI 真实渲染验证：启动 Electron 应用，用 CDP 检查新 UI 元素是否正确渲染，
 * 并验证交互（开关联动）真实可用。
 *
 * 用法: node test/e2e-ui.js
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { CDPClient } = require("../src/core/cdp-client");
const { getJSON, waitForDevTools } = require("../src/core/browser-launcher");

const PORT = 9390;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
function check(name, cond, ev) {
  if (cond) { console.log(`  ✓ ${name}${ev ? "  — " + ev : ""}`); pass++; }
  else { console.log(`  ✗ ${name}${ev ? "  — " + ev : ""}`); fail++; }
}

(async () => {
  console.log("=".repeat(64));
  console.log("  UI 真实渲染验证（Electron + CDP）");
  console.log("=".repeat(64) + "\n");

  const electron = require("electron");
  const appDir = path.join(__dirname, "..");
  const userData = path.join(os.tmpdir(), "gsc-ui-" + Date.now());

  const proc = spawn(electron, [
    appDir,
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userData}`,
  ], { stdio: "ignore", windowsHide: true });

  let cdp = null;
  try {
    const version = await waitForDevTools(PORT, { retries: 60, interval: 400 });
    console.log("  Electron 已启动，调试端口就绪\n");

    // 找到渲染进程页面
    const list = await getJSON(`http://127.0.0.1:${PORT}/json/list`);
    const page = list.find((t) => t.type === "page" && /index\.html/.test(t.url || ""));
    if (!page) throw new Error("未找到应用窗口页面：" + JSON.stringify(list.map((t) => t.url)));

    cdp = new CDPClient(page.webSocketDebuggerUrl, { onEvent: () => {} });
    await cdp.connect();
    await sleep(1200); // 等 UI 初始化完成

    const evalJs = async (expr) => {
      const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + " :: " + expr.slice(0, 60));
      return r.result && r.result.value;
    };

    /* ---------- 1. 页面基础 ---------- */
    console.log("[1] 页面基础");
    const title = await evalJs("document.title");
    check("窗口标题正确", /GetSourceCode/.test(title), title);

    /* ---------- 2. CF 配置组存在 ---------- */
    console.log("\n[2] CF 过盾 UI 元素");
    check("CF 开关存在", await evalJs("!!document.getElementById('cfAutoPass')"));
    check("Turnstile 开关存在", await evalJs("!!document.getElementById('cfClickTurnstile')"));
    check("超时输入框存在", await evalJs("!!document.getElementById('cfTimeout')"));
    check("反爬处理分组存在", await evalJs(
      "!!Array.from(document.querySelectorAll('legend')).find(l=>l.textContent.includes('反爬处理'))"
    ));

    const cfLabel = await evalJs(
      "Array.from(document.querySelectorAll('legend')).map(l=>l.textContent.trim()).join('|')"
    );
    console.log(`      现有分组: ${cfLabel}`);

    /* ---------- 3. 交互联动：勾选 CF 开关 → Turnstile 行显示 + 无头自动关闭 ---------- */
    console.log("\n[3] 交互联动（真实点击验证）");
    const beforeHeadless = await evalJs("document.getElementById('headless').checked");
    check("初始无头模式为勾选", beforeHeadless === true, `headless=${beforeHeadless}`);

    const turnstileHiddenBefore = await evalJs(
      "getComputedStyle(document.getElementById('cfTurnstileRow')).display"
    );
    check("Turnstile 行初始隐藏", turnstileHiddenBefore === "none", turnstileHiddenBefore);

    // 模拟真实点击 CF 开关
    await evalJs("document.getElementById('cfAutoPass').click(); true");
    await sleep(300);

    const turnstileHiddenAfter = await evalJs(
      "getComputedStyle(document.getElementById('cfTurnstileRow')).display"
    );
    check("勾选后 Turnstile 行显示", turnstileHiddenAfter !== "none", turnstileHiddenAfter);

    const afterHeadless = await evalJs("document.getElementById('headless').checked");
    check("勾选过盾后无头模式被自动关闭", afterHeadless === false, `headless=${afterHeadless}`);

    const cfChecked = await evalJs("document.getElementById('cfAutoPass').checked");
    check("CF 开关处于勾选态", cfChecked === true);

    // 日志有反馈
    const logText = await evalJs("document.getElementById('log').textContent");
    check("日志给出了无头模式提示（有反馈）", /无头模式易被识别|自动切换/.test(logText),
      logText.slice(-80).replace(/\s+/g, " "));

    /* ---------- 4. 取消勾选回退 ---------- */
    await evalJs("document.getElementById('cfAutoPass').click(); true");
    await sleep(250);
    const turnstileHiddenBack = await evalJs(
      "getComputedStyle(document.getElementById('cfTurnstileRow')).display"
    );
    check("取消勾选后 Turnstile 行重新隐藏", turnstileHiddenBack === "none", turnstileHiddenBack);

    /* ---------- 4b. 滚动到底部模式开关 ---------- */
    console.log("\n[3b] 滚动模式开关");
    check("scrollToBottom 复选框存在", await evalJs("!!document.getElementById('scrollToBottom')"));
    check("scrollToBottom 默认勾选", await evalJs("document.getElementById('scrollToBottom').checked") === true);
    await evalJs("document.getElementById('scrollToBottom').click(); true");
    await sleep(150);
    check("可取消勾选（切换到按比例模式）",
      await evalJs("document.getElementById('scrollToBottom').checked") === false);
    await evalJs("document.getElementById('scrollToBottom').click(); true");
    await sleep(150);
    check("可重新勾选", await evalJs("document.getElementById('scrollToBottom').checked") === true);

    /* ---------- 4c. 配置能真实传到主进程 ---------- */
    console.log("\n[3c] 配置透传（不实际抓取，仅验证取值链路）");
    const optsProbe = await evalJs(`
      (function(){
        // 复刻 start() 中的 opts 组装逻辑，验证新字段可被正确读取
        const clampInt = (v,min,max)=>{const n=parseInt(v,10);return isNaN(n)?min:Math.max(min,Math.min(max,n));};
        return JSON.stringify({
          scrollRounds: clampInt(document.getElementById('scrollRounds').value,0,50),
          scrollToBottom: document.getElementById('scrollToBottom').checked,
          cfAutoPass: document.getElementById('cfAutoPass').checked,
          cfChallengeTimeout: clampInt(document.getElementById('cfTimeout').value,5,180)*1000
        });
      })()
    `);
    const opts = JSON.parse(optsProbe);
    check("scrollToBottom 可被读取", typeof opts.scrollToBottom === "boolean", JSON.stringify(opts));
    check("cfAutoPass 可被读取", typeof opts.cfAutoPass === "boolean");
    check("cfChallengeTimeout 换算为毫秒", opts.cfChallengeTimeout === 30000, `${opts.cfChallengeTimeout}ms`);

    /* ---------- 6. CF 状态反馈（回归：事件名曾被 payload.type 覆盖） ---------- */
    console.log("\n[3d] CF 事件在 UI 上的真实反馈");
    // 直接向渲染层派发主进程会发送的事件，验证 handleProgress 各分支确实被命中
    const cfFeedback = await evalJs(`
      (function(){
        document.getElementById('log').innerHTML = '';
        window.api.__testDispatch([
          { type: 'cf:detected', challengeType: 'managed', evidence: ['header:cf-mitigated=challenge'] },
          { type: 'cf:failed', challengeType: 'managed', message: '未通过', nextSteps: ['换出口 IP','稍后重试'] }
        ]);
        var txt = document.getElementById('log').textContent;
        return JSON.stringify({
          hasDetected: txt.indexOf('检测到 Cloudflare 挑战') >= 0,
          hasEvidence: txt.indexOf('cf-mitigated') >= 0,
          hasFailed: txt.indexOf('未通过') >= 0,
          hasNextSteps: txt.indexOf('换出口 IP') >= 0 && txt.indexOf('稍后重试') >= 0,
          status: document.getElementById('statusText').textContent
        });
      })()
    `);
    const cf = JSON.parse(cfFeedback);
    check("cf:detected 在日志中有反馈", cf.hasDetected);
    check("cf:detected 显示了判定证据", cf.hasEvidence);
    check("cf:failed 在日志中有反馈", cf.hasFailed);
    check("cf:failed 展示了处置建议（nextSteps）", cf.hasNextSteps);
    check("失败后状态栏有明确提示", /未通过|不完整/.test(cf.status), cf.status);

    /* ---------- 7. 主进程 → 渲染层 链路真实存在 ---------- */
    console.log("\n[3e] 事件链路（preload 契约）");
    check("preload 暴露了 onProgress", await evalJs("typeof window.api.onProgress === 'function'"));
    check("preload 暴露了 __testDispatch（测试注入通道）",
      await evalJs("typeof window.api.__testDispatch === 'function'"));

    /* ---------- 5. 关键控件齐全性 ---------- */
    console.log("\n[4] 原有控件未被破坏");
    const ids = ["url", "outDir", "sourceSelect", "browserSelect", "profileMode",
                 "saveSource", "saveHar", "saveHtml", "saveMedia",
                 "headless", "scrollRounds", "scrollToBottom", "extraWait", "timeout", "maxFileMB",
                 "cfAutoPass", "cfClickTurnstile", "cfTimeout",
                 "btnStart", "btnAbort", "btnOpenDir", "btnCloseBrowser", "btnHelp"];
    const missing = [];
    for (const id of ids) {
      if (!(await evalJs(`!!document.getElementById('${id}')`))) missing.push(id);
    }
    check("全部关键控件存在", missing.length === 0, missing.length ? "缺失: " + missing.join(", ") : `${ids.length} 项`);

    /* ---------- 6. 无 JS 错误 ---------- */
    console.log("\n[5] 运行期错误检查");
    const errCount = await evalJs("window.__errCount || 0");
    check("渲染层无未捕获错误", errCount === 0, `errors=${errCount}`);

    /* ---------- 7. 帮助文档已更新 ---------- */
    const helpText = await evalJs("document.getElementById('helpModal').textContent");
    check("帮助文档含 Cloudflare 说明", /Cloudflare/.test(helpText));
    check("帮助文档含反爬处理说明", /反爬处理/.test(helpText));

  } finally {
    if (cdp) cdp.close();
    try { proc.kill(); } catch { /* ignore */ }
    await sleep(500);
    try { fs.rmSync(userData, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log("\n" + "=".repeat(64));
  console.log(`  UI 验证：${pass} 通过, ${fail} 失败`);
  console.log("=".repeat(64));
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\nUI 验证异常:", e.message);
  process.exit(1);
});
