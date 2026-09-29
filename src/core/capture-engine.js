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
const { MimeClassifier, safeFileName, buildLocalPath } = require("./mime-utils");
const { HarBuilder } = require("./har-builder");

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
    await this.cdp.send("Page.enable", {}, { sessionId });
    await this.cdp.send("Runtime.enable", {}, { sessionId });
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
      this._emit("file", { kind: "har", path: harPath });
    }

    // 11) 写清单（原子落盘）
    const metaPath = path.join(outputDir, "metadata.json");
    const meta = {
      tool: "GetSourceCode",
      version: require("../../package.json").version,
      targetUrl,
      capturedAt: new Date().toISOString(),
      browser: version.Browser,
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

      const rel = buildLocalPath(url, cls, this.opts.targetUrl);
      const abs = path.join(this.opts.outputDir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      writeBufferAtomic(abs, buf);

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
      this.stats.failed++;
      this.resources.push({ url, kind: cls.kind, status: "failed", error: e.message });
      // 常见原因：body 已被浏览器释放 / 跨域 opaque 响应
      this._emit("skip", { url, reason: e.message.slice(0, 80) });
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

  /** 等待网络空闲：连续 N 次轮询无新请求 */
  async _waitNetworkIdle(idle = this.opts.idleWait, stableChecks = 3) {
    let lastCount = this.har.entries.length;
    let stable = 0;
    const start = Date.now();
    while (Date.now() - start < this.opts.timeout) {
      if (this._aborted) return;
      await new Promise((r) => setTimeout(r, idle / stableChecks));
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

  async _scrollPage(rounds, delay) {
    for (let i = 0; i < rounds; i++) {
      if (this._aborted) return;
      const ratio = (i + 1) / rounds;
      await this.cdp.send("Runtime.evaluate", {
        expression: `(function(){const h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight);window.scrollTo(0,h*${ratio});})()`,
      }, { sessionId: this.sessionId }).catch(() => {});
      await new Promise((r) => setTimeout(r, delay));
    }
    // 回到顶部
    await this.cdp.send("Runtime.evaluate", { expression: "window.scrollTo(0,0)" }, { sessionId: this.sessionId }).catch(() => {});
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
