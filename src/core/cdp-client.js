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
    this.onEvent = onEvent || (() => {});
    this._id = 0;
    this._pending = new Map();
    this._connected = false;
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
        this.onEvent({ type: "disconnected" });
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
      this.onEvent({ type: "event", method: msg.method, params: msg.params, sessionId: msg.sessionId });
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

  /** 注册事件监听（用于特定流程等待） */
  waitFor(method, { sessionId, timeout = 30000, predicate } = {}) {
    return new Promise((resolve, reject) => {
      const prev = this.onEvent;
      const timer = setTimeout(() => {
        this.onEvent = prev;
        reject(new Error(`等待事件超时: ${method}`));
      }, timeout);
      this.onEvent = (evt) => {
        prev(evt);
        if (evt.type === "event" && evt.method === method) {
          if (sessionId && evt.sessionId !== sessionId) return;
          if (predicate && !predicate(evt.params)) return;
          clearTimeout(timer);
          this.onEvent = prev;
          resolve(evt.params);
        }
      };
    });
  }

  close() {
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
