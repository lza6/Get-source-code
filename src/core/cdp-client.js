"use strict";

/**
 * 极简 CDP (Chrome DevTools Protocol) 客户端
 *
 * 为什么不用 puppeteer / chrome-remote-interface？
 *  - Electron 环境已内建 WebSocket，无需额外 native 依赖
 *  - 本工具只需少量 CDP 域（Page/Network/Runtime/Target），自研更可控
 *  - 打包体积更小、无安装期 native 编译风险
 */

const WebSocket = require("ws");

class CDPClient {
  constructor(wsUrl, { onEvent } = {}) {
    this.wsUrl = wsUrl;
    this._id = 0;
    this._pending = new Map();   // id -> { resolve, reject, timer }
    this._listeners = new Set(); // 常驻订阅者（事件流）
    this._waiters = new Set();   // 一次性等待器（waitFor）
    this._connected = false;
    if (onEvent) this._listeners.add(onEvent);
  }

  /**
   * 订阅事件流，返回取消订阅函数。
   *
   * 为什么不用 `onEvent` 单例回调？——原实现用「替换 onEvent 再包一层」实现 waitFor，
   * 两个并发 waitFor 会互相覆盖包装器，导致其中一个永远收不到事件（静默失效）。
   * 现改为「订阅者集合 + 等待器集合」，二者互不干扰。
   */
  on(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  /** 分发事件给所有订阅者与匹配的等待器 */
  _dispatch(evt) {
    for (const fn of [...this._listeners]) {
      try {
        fn(evt);
      } catch {
        /* 单个订阅者异常不得影响其他订阅者与等待器 */
      }
    }
    for (const w of [...this._waiters]) {
      let hit = false;
      try {
        hit = w.match(evt);
      } catch {
        hit = false;
      }
      if (!hit) continue;
      this._waiters.delete(w);
      clearTimeout(w.timer);
      if (evt.type === "disconnected") w.reject(new Error("CDP 连接已断开"));
      else w.resolve(evt.params);
    }
  }

  /** 建立连接 */
  connect() {
    return new Promise((resolve, reject) => {
      // 关键：不要发送 Origin 头。Chrome 的 DevTools 端点会校验 Origin，
      // 非允许值（缺失或 devtools://）一律回 403。ws 默认不发 Origin，
      // 因此这里绝不设置 origin 选项。
      const ws = new WebSocket(this.wsUrl, {
        maxPayload: 512 * 1024 * 1024, // 允许大响应体（视频/大 JS）
        perMessageDeflate: false,
        handshakeTimeout: 10000,
      });
      this._ws = ws;
      const timer = setTimeout(() => reject(new Error("CDP 连接超时")), 12000);

      ws.on("open", () => {
        clearTimeout(timer);
        this._connected = true;
        resolve();
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      ws.on("close", () => {
        this._connected = false;
        this._dispatch({ type: "disconnected" });
        // 一并清理在途命令：浏览器崩溃/被关闭时，否则 send 要各自等到 30–60s 超时才失败
        this.abortAll("CDP 连接已断开");
      });
      ws.on("message", (raw) => this._handleMessage(raw));
    });
  }

  _handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // 命令响应
    if (msg.id && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      clearTimeout(timer);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message || "CDP 错误"} (${msg.error.code})`));
      else resolve(msg.result);
      return;
    }
    // 事件
    if (msg.method) {
      this._dispatch({ type: "event", method: msg.method, params: msg.params, sessionId: msg.sessionId });
    }
  }

  /**
   * 发送命令
   * @param {string} method
   * @param {object} params
   * @param {object} [opts] { sessionId, timeout }
   */
  send(method, params = {}, opts = {}) {
    const { sessionId, timeout = 60000 } = opts;
    return new Promise((resolve, reject) => {
      if (!this._connected) return reject(new Error("CDP 未连接"));
      const id = ++this._id;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP 命令超时: ${method}`));
      }, timeout);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._ws.send(JSON.stringify(payload));
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  /**
   * 等待某个事件（一次性）。
   * 多个 waitFor 可并发，互不覆盖。
   */
  waitFor(method, { sessionId, timeout = 30000, predicate } = {}) {
    return new Promise((resolve, reject) => {
      const waiter = {
        match: (evt) => {
          if (evt.type === "disconnected") return true; // 断连时立即失败，避免挂死
          return (
            evt.type === "event" &&
            evt.method === method &&
            (!sessionId || evt.sessionId === sessionId) &&
            (!predicate || predicate(evt.params))
          );
        },
        resolve,
        reject,
        timer: null,
      };
      waiter.timer = setTimeout(() => {
        this._waiters.delete(waiter);
        reject(new Error(`等待事件超时: ${method}`));
      }, timeout);
      this._waiters.add(waiter);
    });
  }

  /**
   * 中止所有在途命令与等待器（用户点「停止」时调用）。
   * 使挂起的 send/waitFor 立即 reject（带 aborted 标记），而不是等到超时。
   */
  abortAll(reason = "已中止") {
    for (const [id, { reject, timer }] of this._pending) {
      clearTimeout(timer);
      this._pending.delete(id);
      reject(Object.assign(new Error(reason), { aborted: true }));
    }
    for (const w of [...this._waiters]) {
      clearTimeout(w.timer);
      this._waiters.delete(w);
      w.reject(Object.assign(new Error(reason), { aborted: true }));
    }
  }

  close() {
    // 先让挂起者失败，再断开，避免 Promise 永久悬挂
    this.abortAll("CDP 连接已关闭");
    try {
      if (this._ws) this._ws.close();
    } catch {
      /* ignore */
    }
    this._connected = false;
  }

  get connected() {
    return this._connected;
  }
}

module.exports = { CDPClient };
