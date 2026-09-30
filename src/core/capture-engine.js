"use strict";

/**
 * 抓取引擎
 *  - 导航目标站点，监听 Network 域，捕获全部响应
 *  - 按类型分流：source(JS/CSS/字体) / media(图片/视频/音频) / xhr(HAR) / html
 *  - 支持懒加载触发（滚动）、重定向、超时
 *  - 产出统一 metadata.json + 分类目录
 */

const fs = require("fs");
const path = require("path");
const { CDPClient } = require("./cdp-client");
const { BrowserLauncher } = require("./browser-launcher");
const { MimeClassifier, safeFileName, buildLocalPath, shortHash } = require("./mime-utils");
const { HarBuilder } = require("./har-builder");
const { detectChallenge, canAutoWait, needsInteraction, CF_TYPE } = require("./cf-detector");

const DEFAULT_OPTS = {
  port: 9333,
  headless: true,
  timeout: 45000,
  idleWait: 2500,          // 网络空闲后再等多久
  scrollRounds: 0,         // 滚动次数（触发懒加载）
  scrollDelay: 1200,
  saveSource: true,        // JS/CSS/字体
  saveMedia: false,        // 图片/视频/音频
  saveHtml: true,          // 渲染后的 DOM
  saveHar: true,           // HAR 网络包
  maxResourceSize: 50 * 1024 * 1024, // 单文件上限（默认 50MB）
  maxTotalSize: 500 * 1024 * 1024,   // 总上限（默认 500MB）
  extraWait: 0,            // 额外等待（用户可调，应对慢站点）
  userDataDir: null,       // 浏览器 profile 目录（由 BrowserManager 解析）
  executablePath: null,    // 浏览器可执行文件
  onBrowserResolved: null, // 回调：浏览器解析完成（用于 UI 显示）
  cfAutoPass: false,       // 是否自动检测并尝试通过 Cloudflare 挑战
  cfChallengeTimeout: 30000, // 等待挑战自动通过的上限
  cfClickTurnstile: false, // 是否允许模拟点击 Turnstile（需显式开启）
};

class CaptureEngine {
  /**
   * @param {object} opts 见 DEFAULT_OPTS，另含 targetUrl / outputDir / onProgress
   */
  constructor(opts = {}) {
    this.opts = { ...DEFAULT_OPTS, ...opts };
    this.cdp = null;
    this.launcher = null;
    this.har = new HarBuilder();
    this.resources = [];       // 已保存资源索引
    this.requestMap = new Map(); // requestId -> requestInfo
    this.stats = { saved: 0, failed: 0, skipped: 0, bytes: 0 };
    this._aborted = false;
    this._ephemeralProfile = null; // 临时 profile 路径
    this._ownsProfile = false;     // 是否由本引擎创建（可安全删除）
    this._connectionLost = false;  // 浏览器是否断连
  }

  _emit(type, payload) {
    if (typeof this.opts.onProgress === "function") {
      try {
        this.opts.onProgress({ type, ...payload });
      } catch {
        /* ignore */
      }
    }
  }

  /** 停止抓取 */
  abort() {
    this._aborted = true;
    // 通知正在等待的 CDP 事件，避免 run() 卡在 waitFor 上
    try {
      if (this.cdp && this.cdp.connected && this.sessionId) {
        // 中断可能挂起的导航等待
        this.cdp.send("Page.stopLoading", {}, { sessionId: this.sessionId, timeout: 3000 }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
    // 让所有在途命令（含 60s 超时的 send）与 waitFor 立即失败，
    // 否则用户点「停止」后仍要等最长 60s 才有反应。
    try {
      if (this.cdp) this.cdp.abortAll("用户已中止");
    } catch {
      /* ignore */
    }
  }

  /** 检查点：已中止则抛出，由 run() 捕获并返回 aborted 结果 */
  _checkAbort(stage) {
    if (this._aborted) {
      const err = new Error(`用户已中止（${stage}）`);
      err.aborted = true;
      throw err;
    }
  }

  async run() {
    const { targetUrl, outputDir } = this.opts;
    if (!targetUrl) throw new Error("缺少目标网址");
    if (!outputDir) throw new Error("缺少保存目录");
    fs.mkdirSync(outputDir, { recursive: true });

    try {
      return await this._runInternal();
    } catch (err) {
      if (err && err.aborted) {
        this._emit("aborted", { message: err.message, stats: this.stats });
        return { aborted: true, stats: this.stats, outputDir };
      }
      throw err;
    }
  }

  async _runInternal() {
    const { targetUrl, outputDir } = this.opts;

    // 1) 启动浏览器
    this._emit("status", { message: "正在启动浏览器…" });
    this.launcher = new BrowserLauncher({
      executablePath: this.opts.executablePath,
      port: this.opts.port,
      headless: this.opts.headless,
      userDataDir: this.opts.userDataDir,
    });
    this._checkAbort("启动浏览器前");
    const { version, reused } = await this.launcher.launch();
    this._emit("status", { message: reused ? "复用已运行的浏览器" : "浏览器已启动", browser: version.Browser });
    this._checkAbort("启动浏览器后");

    // 2) 连接 CDP
    this.cdp = new CDPClient(version.webSocketDebuggerUrl, { onEvent: (e) => this._onCdpEvent(e) });
    await this.cdp.connect();

    // 3) 创建标签页 + attach
    const tab = await this.launcher.newTab("about:blank");
    const { sessionId } = await this.cdp.send("Target.attachToTarget", { targetId: tab.id, flatten: true });
    this.sessionId = sessionId;

    // 4) 启用所需域
    await this.cdp.send("Network.enable", {
      maxResourceBufferSize: 512 * 1024 * 1024,
      maxTotalBufferSize: 1024 * 1024 * 1024,
    }, { sessionId });

    // 禁用缓存：命中磁盘缓存时 Chrome 不保留响应体，Network.getResponseBody 会返回
    // -32000 "No data found"，导致资源漏抓。抓取场景必须强制走网络。
    await this.cdp.send("Network.setCacheDisabled", { cacheDisabled: true }, { sessionId }).catch(() => {});

    await this.cdp.send("Page.enable", {}, { sessionId });

    // 刻意不调用 Runtime.enable：
    //   1) Runtime.enable 的使用可被页面侧 JS 检测（rebrowser-patches 实证，
    //      Cloudflare / DataDome 均用此特征识别自动化）。
    //   2) 本引擎对 Runtime 域的唯一用途是 Runtime.evaluate（导出 DOM / 滚动），
    //      实测该命令无需 enable 即可工作（见 test/unit-p0.js）。
    //   3) 本引擎从不消费任何 Runtime 事件，故删除 enable 零功能损失。
    //   若将来确需 Runtime 事件，应改用 rebrowser 的 addBinding 模式取 contextId，
    //   而非直接 enable。
    await this.cdp.send("Emulation.setDeviceMetricsOverride", {
      width: this.opts.viewportWidth || 1440,
      height: this.opts.viewportHeight || 900,
      deviceScaleFactor: 1,
      mobile: false,
    }, { sessionId }).catch(() => {});

    // 5) 导航（可被 abort 打断：waitFor 与 abortPromise 赛跑）
    this._checkAbort("导航前");
    this._emit("status", { message: `正在访问 ${targetUrl} …` });
    const loadPromise = this.cdp.waitFor("Page.loadEventFired", { sessionId, timeout: this.opts.timeout }).catch(() => null);
    await this.cdp.send("Page.navigate", { url: targetUrl }, { sessionId });
    const abortWait = this._abortPromise();
    try {
      await Promise.race([loadPromise, abortWait.promise]);
    } finally {
      abortWait.stop();   // 防止定时器链泄漏
    }
    this._checkAbort("导航后");

    // 5.5) Cloudflare 挑战处理（可选，默认关闭）
    if (this.opts.cfAutoPass) {
      await this._handleChallenge();
      this._checkAbort("过盾后");
    }

    // 6) 等待网络空闲
    await this._waitNetworkIdle();
    this._checkAbort("等待空闲后");

    // 7) 滚动触发懒加载
    if (this.opts.scrollRounds > 0) {
      this._emit("status", { message: "滚动页面触发懒加载…" });
      await this._scrollPage(this.opts.scrollRounds, this.opts.scrollDelay);
      this._checkAbort("滚动后");
      await this._waitNetworkIdle();
    }

    // 8) 额外等待（用户设定，应对慢站点/延迟请求）
    if (this.opts.extraWait > 0) {
      this._emit("status", { message: `额外等待 ${(this.opts.extraWait / 1000).toFixed(1)} 秒…` });
      await this._sleepInterruptible(this.opts.extraWait);
    }
    this._checkAbort("写盘前");

    // 9) 保存渲染后 DOM
    if (this.opts.saveHtml) {
      await this._saveRenderedHtml();
    }

    // 10) 写 HAR（原子落盘）
    if (this.opts.saveHar) {
      const harPath = path.join(outputDir, "network.har");
      writeFileAtomic(harPath, JSON.stringify(this.har.build(), null, 2));
      this._emit("file", { kind: "har", path: harPath, size: fs.statSync(harPath).size });
    }

    // 11) 写清单（原子落盘）
    const metaPath = path.join(outputDir, "metadata.json");
    const meta = {
      tool: "GetSourceCode",
      version: require("../../package.json").version,
      targetUrl,
      capturedAt: new Date().toISOString(),
      browser: version.Browser,
      connectionLost: this._connectionLost,
      cf: this._cfReport || { detected: false, note: "cfAutoPass 未开启" },
      stats: this.stats,
      resources: this.resources,
      tree: buildTree(this.resources, outputDir),
    };
    writeFileAtomic(metaPath, JSON.stringify(meta, null, 2));
    this._emit("file", { kind: "metadata", path: metaPath });

    // 若浏览器中途断连，明确告知（避免"假成功"）
    if (this._connectionLost) {
      this._emit("warning", { message: "浏览器在抓取过程中断开连接，结果可能不完整" });
    }

    this._emit("done", { stats: this.stats, outputDir });
    return { stats: this.stats, outputDir, connectionLost: this._connectionLost };
  }

  /**
   * 返回一个在 abort 时 resolve 的 Promise，并在 race 结束后可主动停止轮询。
   * @returns {{ promise: Promise<string>, stop: () => void }}
   */
  _abortPromise() {
    let timer = null;
    let stopped = false;
    const promise = new Promise((resolve) => {
      const tick = () => {
        if (stopped) return;
        if (this._aborted) return resolve("aborted");
        timer = setTimeout(tick, 150);
      };
      tick();
    });
    return {
      promise,
      stop: () => {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  }

  /** 可被 abort 打断的 sleep */
  _sleepInterruptible(ms) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        if (this._aborted || Date.now() - start >= ms) return resolve();
        setTimeout(tick, Math.min(200, ms));
      };
      tick();
    });
  }

  /** CDP 事件处理 */
  async _onCdpEvent(evt) {
    // 浏览器断连：置位，让 run() 判定为失败而非"成功"
    if (evt.type === "disconnected") {
      this._connectionLost = true;
      this._emit("status", { message: "浏览器连接已断开" });
      return;
    }
    if (evt.type !== "event") return;
    const { method, params, sessionId } = evt;
    if (sessionId && this.sessionId && sessionId !== this.sessionId) return;

    switch (method) {
      case "Network.requestWillBeSent":
        this.har.onRequestWillBeSent(params);
        this.requestMap.set(params.requestId, { url: params.request.url, startTime: params.wallTime });
        break;
      case "Network.responseReceived": {
        this.har.onResponseReceived(params);
        await this._maybeCapture(params);
        break;
      }
      case "Network.loadingFinished":
        this.har.onLoadingFinished(params);
        break;
      case "Network.loadingFailed":
        this.har.onLoadingFailed(params);
        break;
      case "Network.requestWillBeSentExtraInfo":
        this.har.onRequestExtraInfo(params);
        break;
      case "Network.responseReceivedExtraInfo":
        this.har.onResponseExtraInfo(params);
        break;
      default:
        break;
    }
  }

  /** 判断并保存响应体 */
  async _maybeCapture(params) {
    if (this._aborted) return;
    const { requestId, response, type } = params;
    const url = response.url;
    const mime = response.mimeType || "";
    const cls = MimeClassifier.classify(url, mime, type, response.headers);

    // 是否需要保存该类别
    if (!this._shouldSave(cls)) return;

    // 体积预判（Content-Length）
    const len = parseInt(response.headers["Content-Length"] || response.headers["content-length"] || "0", 10);
    if (len && len > this.opts.maxResourceSize) {
      this.stats.skipped++;
      this.resources.push({ url, kind: cls.kind, status: "skipped", reason: "size", size: len });
      this._emit("skip", { url, reason: `超过单文件上限 (${(len / 1048576).toFixed(1)}MB)` });
      return;
    }
    if (this.stats.bytes + len > this.opts.maxTotalSize) {
      this.stats.skipped++;
      this._emit("skip", { url, reason: "超过总大小上限" });
      return;
    }

    try {
      const body = await this.cdp.send("Network.getResponseBody", { requestId }, { sessionId: this.sessionId, timeout: 30000 });
      const isBase64 = body.base64Encoded;
      const buf = isBase64 ? Buffer.from(body.body, "base64") : Buffer.from(body.body, "utf8");

      const rel = this._resolveLocalPath(url, cls);
      const abs = path.join(this.opts.outputDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeBufferAtomic(abs, buf);

      // 把响应体回传给 HAR（HAR 1.2 的 content.text）——
      // 否则导出的 .har 只有请求元数据、没有内容，导入 DevTools/Charles 看不到响应。
      const relPosix = rel.replace(/\\/g, "/");
      this.har.setSavedFile(requestId, relPosix);
      if (this.opts.saveHar) {
        this.har.attachBody(requestId, {
          text: body.body,                       // base64 时保持原串，避免二次编解码
          encoding: isBase64 ? "base64" : undefined,
          mimeType: mime,
          size: buf.length,
        });
      }

      this.stats.saved++;
      this.stats.bytes += buf.length;
      this.resources.push({
        url,
        kind: cls.kind,
        ext: cls.ext,
        mime,
        size: buf.length,
        file: rel.replace(/\\/g, "/"),
        status: response.status,
      });
      this._emit("file", { kind: cls.kind, url, size: buf.length, path: abs });
    } catch (e) {
      const msg = e.message || String(e);
      // 区分「可忽略」与「真失败」：
      //  - 用户中止：既不算失败也不算跳过，静默退出（否则中止会把在途请求全记为失败）
      //  - 响应体已被浏览器释放（-32000 No data found）常见于预取/上报请求，属正常
      //  - 其它错误才计为 failed
      if (e && e.aborted) return;
      const ignorable = /No data found|No resource with given identifier|-32000/i.test(msg);
      if (ignorable) {
        this.stats.skipped++;
        this.resources.push({ url, kind: cls.kind, status: "skipped", reason: "body-released" });
      } else {
        this.stats.failed++;
        this.resources.push({ url, kind: cls.kind, status: "failed", error: msg });
      }
      this._emit("skip", { url, reason: msg.slice(0, 80) });
    }
  }

  _shouldSave(cls) {
    switch (cls.kind) {
      case "source": return this.opts.saveSource;
      case "media": return this.opts.saveMedia;
      case "html": return false; // HTML 单独处理（保存渲染后 DOM）
      case "other": return this.opts.saveSource; // 其它静态文本（json/txt/xml）随源码一起
      default: return false;
    }
  }

  /**
   * 解析本地相对路径：默认保留原始文件名；
   * 仅当同一路径已被**不同 URL**占用时，附加短 hash 消歧。
   * 这样既保持 `5142.xxx.js` 这样的原名（逆向友好），又避免 `?v=1`/`?v=2` 互相覆盖。
   */
  _resolveLocalPath(url, cls) {
    const primary = buildLocalPath(url, cls, this.opts.targetUrl);
    if (!this._pathOwner) this._pathOwner = new Map(); // rel -> url

    const owner = this._pathOwner.get(primary);
    if (owner === undefined) {
      this._pathOwner.set(primary, url);
      return primary;
    }
    if (owner === url) {
      return primary; // 同一 URL 重复请求，覆盖即可
    }
    // 冲突：附加 URL 的短 hash
    const h = shortHash(url);
    const disambig = buildLocalPath(url, cls, this.opts.targetUrl, h);
    this._pathOwner.set(disambig, url);
    return disambig;
  }

  /** 保存渲染后的完整 DOM */
  async _saveRenderedHtml() {
    try {
      const res = await this.cdp.send("Runtime.evaluate", {
        expression: "document.documentElement.outerHTML",
        returnByValue: true,
        timeout: 20000,
      }, { sessionId: this.sessionId });
      const html = res.result?.value || "";
      const file = path.join(this.opts.outputDir, "page.html");
      writeFileAtomic(file, html);
      this.resources.push({ url: this.opts.targetUrl, kind: "html", size: Buffer.byteLength(html), file: "page.html", status: 200 });
      this._emit("file", { kind: "html", size: html.length, path: file });

      // 同时保存标题等元信息
      const info = await this.cdp.send("Runtime.evaluate", {
        expression: "JSON.stringify({title:document.title,url:location.href,readyState:document.readyState})",
        returnByValue: true,
      }, { sessionId: this.sessionId }).catch(() => null);
      if (info?.result?.value) {
        writeFileAtomic(path.join(this.opts.outputDir, "page-info.json"), info.result.value);
      }
    } catch (e) {
      this._emit("skip", { url: "page.html", reason: `DOM 导出失败: ${e.message}` });
    }
  }

  /**
   * 等待网络空闲：连续 N 次轮询无新请求
   * @param {number} [idle]            采样间隔基准
   * @param {number} [stableChecks]    需要连续稳定的次数
   * @param {number} [budgetMs]        本次等待的时间预算（默认取 opts.timeout）；
   *                                   滚动阶段会传入剩余总预算，避免每轮各吃满一个 timeout
   */
  async _waitNetworkIdle(idle = this.opts.idleWait, stableChecks = 3, budgetMs) {
    let lastCount = this.har.entries.length;
    let stable = 0;
    const budget = typeof budgetMs === "number" ? budgetMs : this.opts.timeout;
    const start = Date.now();
    while (Date.now() - start < budget) {
      if (this._aborted) return;
      await this._sleepInterruptible(Math.min(idle / stableChecks, Math.max(0, budget - (Date.now() - start))));
      if (this._aborted) return;
      const now = this.har.entries.length;
      if (now === lastCount) {
        stable++;
        if (stable >= stableChecks) return;
      } else {
        stable = 0;
        lastCount = now;
      }
    }
  }

  /**
   * 滚动触发懒加载。
   *
   * 原实现按预设轮次"滚完就停"，对**无限滚动**页面（高度持续增长）会漏抓，
   * 对**短页面**又白白浪费轮次。现改为：
   *   - 每轮滚动后测量 scrollHeight；
   *   - 高度连续 2 轮不变且已接近底部 → 提前结束；
   *   - 每轮后等待网络空闲（而非固定 delay），让新资源有时间加载。
   * `scrollRounds` 语义保持不变：**最多**滚动多少轮。
   *
   * ⚠️ 总时长预算：整个滚动阶段共享**一个** `timeout` 预算（而非每轮各吃满一个），
   * 否则最坏情况 = rounds × timeout（50 × 45s ≈ 37 分钟），静默违反超时契约。
   */
  async _scrollPage(rounds, delay) {
    let lastHeight = -1;
    let stableRounds = 0;
    const deadline = Date.now() + this.opts.timeout;
    const remaining = () => deadline - Date.now();

    for (let i = 0; i < rounds; i++) {
      if (this._aborted || remaining() <= 0) return;

      const r = await this.cdp.send("Runtime.evaluate", {
        expression: `(function(){
          const h = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
          window.scrollTo(0, h);
          return JSON.stringify({ h, y: window.scrollY, vh: window.innerHeight });
        })()`,
        returnByValue: true,
      }, { sessionId: this.sessionId, timeout: Math.min(15000, Math.max(2000, remaining())) }).catch(() => null);

      let height = 0, atBottom = false;
      try {
        const v = JSON.parse((r && r.result && r.result.value) || "{}");
        height = v.h || 0;
        atBottom = v.y + v.vh >= v.h - 2;
      } catch { /* 忽略解析失败，按未到底处理 */ }

      // 高度不再增长 + 已在底部 → 连续 2 轮即认定到底
      if (height > 0 && height === lastHeight && atBottom) {
        stableRounds++;
        if (stableRounds >= 2) break;
      } else {
        stableRounds = 0;
      }
      lastHeight = height;

      if (remaining() <= 0) return;
      await this._sleepInterruptible(Math.min(delay, Math.max(0, remaining())));
      // 让懒加载请求发出去并完成，再测下一轮高度（共享总预算）
      await this._waitNetworkIdle(undefined, 3, remaining());
    }

    // 回到顶部
    await this.cdp.send("Runtime.evaluate", { expression: "window.scrollTo(0,0)" }, { sessionId: this.sessionId }).catch(() => {});
  }

  /**
   * Cloudflare 挑战处理（仅在 opts.cfAutoPass 为真时调用）
   *
   * 流程：采集证据 → 检测 → 按类型分流 → 等待/交互 → 复检 → 记录结果
   *
   * 原则：
   *  - 全程可被 abort 打断
   *  - 失败时**明确告知**，绝不假装成功
   *  - 不承诺 100% 通过（CF 是持续对抗的）
   */
  async _handleChallenge() {
    this._emit("status", { message: "正在检测 Cloudflare 挑战…" });

    const probe = await this._probeChallenge();
    const verdict = detectChallenge(probe);

    if (!verdict.challenged) {
      this._cfReport = { detected: false };
      return;
    }

    this._cfReport = {
      detected: true,
      type: verdict.type,
      confidence: verdict.confidence,
      evidence: verdict.evidence,
    };
    this._emit("cf:detected", { type: verdict.type, evidence: verdict.evidence });
    this._emit("status", {
      message: `检测到 Cloudflare 挑战（${verdict.type}），正在尝试自动通过…`,
    });

    if (verdict.type === CF_TYPE.BLOCK) {
      this._cfReport.passed = false;
      this._cfReport.reason = "hard-block";
      this._emit("cf:failed", {
        type: verdict.type,
        message: "被 Cloudflare 硬拦截，请更换出口 IP 或稍后重试",
      });
      return;
    }

    if (verdict.type === CF_TYPE.TURNSTILE && !this.opts.cfClickTurnstile) {
      // 未开启模拟点击 → 仅等待（用户可能手动点了），到点后如实报告
      this._emit("status", { message: "Turnstile 验证需人工交互，等待中…（可在设置中允许自动点击）" });
    } else if (verdict.type === CF_TYPE.TURNSTILE) {
      await this._tryClickTurnstile();
    }

    // 轮询等待挑战通过
    const passed = await this._waitForChallengePass();

    this._cfReport.passed = passed;
    this._cfReport.elapsedMs = this._cfStartedAt ? Date.now() - this._cfStartedAt : 0;

    if (passed) {
      this._emit("cf:passed", { type: verdict.type, elapsedMs: this._cfReport.elapsedMs });
      this._emit("status", {
        message: `✔ 已通过 Cloudflare 验证（${(this._cfReport.elapsedMs / 1000).toFixed(1)}s）`,
      });
    } else {
      this._cfReport.reason = "timeout";
      this._emit("cf:failed", {
        type: verdict.type,
        message: "未能自动通过 Cloudflare 挑战，结果可能不完整",
      });
      this._emit("warning", {
        message: "Cloudflare 挑战未通过：可尝试关闭无头模式、更换网络出口，或手动登录后重试",
      });
    }
  }

  /** 采集挑战判定所需的证据 */
  async _probeChallenge() {
    const probe = {};

    // 标题
    try {
      const r = await this.cdp.send("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      }, { sessionId: this.sessionId, timeout: 8000 });
      probe.title = (r && r.result && r.result.value) || "";
    } catch { /* 忽略 */ }

    // HTML 片段（取前 64KB，足够覆盖挑战页标记）
    try {
      const r = await this.cdp.send("Runtime.evaluate", {
        expression: "document.documentElement.outerHTML.slice(0, 65536)",
        returnByValue: true,
      }, { sessionId: this.sessionId, timeout: 8000 });
      probe.html = (r && r.result && r.result.value) || "";
    } catch { /* 忽略 */ }

    // 帧树（定位 Turnstile iframe）
    try {
      probe.frameTree = await this.cdp.send("Page.getFrameTree", {}, { sessionId: this.sessionId, timeout: 8000 });
    } catch { /* 忽略 */ }

    // 主文档响应头（从 HAR 的 Document 条目取）
    try {
      const doc = this.har.entries.find((e) => e._resourceType === "Document");
      if (doc) {
        const h = {};
        for (const { name, value } of doc.response.headers || []) h[name] = value;
        h[":status"] = String(doc.response.status || "");
        probe.headers = h;
      }
    } catch { /* 忽略 */ }

    return probe;
  }

  /** 轮询等待挑战通过（cookie 出现或页面脱离挑战态） */
  async _waitForChallengePass() {
    const deadline = Date.now() + this.opts.cfChallengeTimeout;
    this._cfStartedAt = Date.now();

    while (Date.now() < deadline) {
      if (this._aborted) return false;
      await this._sleepInterruptible(600);
      if (this._aborted) return false;

      // 1) cf_clearance cookie 出现 → 最强信号
      try {
        const r = await this.cdp.send("Network.getAllCookies", {}, { sessionId: this.sessionId, timeout: 8000 });
        const cookies = (r && r.cookies) || [];
        if (cookies.some((c) => c.name === "cf_clearance" && c.value)) return true;
      } catch {
        if (this._aborted) return false;
      }

      // 2) 页面已脱离挑战态
      try {
        const r = await this.cdp.send("Runtime.evaluate", {
          expression: "JSON.stringify({t:document.title,l:location.href})",
          returnByValue: true,
        }, { sessionId: this.sessionId, timeout: 8000 });
        const v = JSON.parse((r && r.result && r.result.value) || "{}");
        const stillChallenged = /Just a moment|Attention Required|Verifying you are human/i.test(v.t || "");
        if (!stillChallenged && v.l && v.l !== "about:blank") return true;
      } catch {
        if (this._aborted) return false;
      }
    }
    return false;
  }

  /**
   * 尝试通过 Tab 键聚焦 + 回车触发 Turnstile。
   *
   * 采用 FlareSolverr 的 `tabs_till_verify` 思路：Turnstile 的 checkbox 位于
   * shadow DOM 内，普通选择器定位不到；而 Tab 导航本身是"真实用户行为"，
   * 既绕开定位难题又不产生可疑的合成点击。
   * 仅用于用户自有/已授权站点的合规测试场景。
   */
  async _tryClickTurnstile() {
    this._emit("status", { message: "尝试通过键盘导航触发 Turnstile…" });
    const presses = this.opts.cfTurnstileTabs || 3;
    for (let i = 0; i < presses; i++) {
      if (this._aborted) return;
      try {
        await this.cdp.send("Input.dispatchKeyEvent", {
          type: "rawKeyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9,
        }, { sessionId: this.sessionId, timeout: 5000 });
        await this.cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9,
        }, { sessionId: this.sessionId, timeout: 5000 });
      } catch { /* 忽略单次失败 */ }
      await this._sleepInterruptible(200);
    }
    // 回车确认
    for (const type of ["rawKeyDown", "char", "keyUp"]) {
      try {
        await this.cdp.send("Input.dispatchKeyEvent", {
          type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: type === "char" ? "\r" : undefined,
        }, { sessionId: this.sessionId, timeout: 5000 });
      } catch { /* 忽略 */ }
    }
  }

  async cleanup() {
    if (this.cdp) this.cdp.close();
    // 注意：不主动关闭浏览器，方便用户复用/查看；由 UI 决定是否关闭
  }

  /**
   * 关闭浏览器并清理临时资源
   * @param {object} [opts]
   * @param {boolean} [opts.removeEphemeralProfile] 是否删除临时 profile（默认 true）
   */
  async shutdown(opts = {}) {
    await this.cleanup();
    if (this.launcher) await this.launcher.close();
    // 清理临时 profile（仅当由本次运行创建且未被复用）
    if (opts.removeEphemeralProfile !== false && this._ephemeralProfile && this._ownsProfile) {
      try {
        fs.rmSync(this._ephemeralProfile, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 原子写文件：先写 .part，成功后 rename，避免磁盘满/崩溃留下半截文件
 */
function writeFileAtomic(file, data) {
  const part = file + ".part";
  try {
    fs.writeFileSync(part, data);
    fs.renameSync(part, file);
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/** 原子写二进制（用于资源文件） */
function writeBufferAtomic(file, buf) {
  const part = file + ".part";
  try {
    fs.writeFileSync(part, buf);
    fs.renameSync(part, file);
  } catch (e) {
    try { fs.rmSync(part, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}

/** 按目录构建树（供 UI 展示） */
function buildTree(resources, rootDir) {
  const tree = { name: path.basename(rootDir), type: "dir", children: {} };
  for (const r of resources) {
    if (!r.file) continue;
    const parts = r.file.split("/");
    let node = tree;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (i === parts.length - 1) {
        node.children[p] = { name: p, type: "file", size: r.size, kind: r.kind, url: r.url };
      } else {
        if (!node.children[p]) node.children[p] = { name: p, type: "dir", children: {} };
        node = node.children[p];
      }
    }
  }
  return tree;
}

module.exports = { CaptureEngine, DEFAULT_OPTS, writeFileAtomic, writeBufferAtomic };
