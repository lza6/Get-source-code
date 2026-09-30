"use strict";

/**
 * HAR 1.2 构建器
 *  - 将 CDP Network 域事件聚合为符合 HAR 1.2 规范的对象
 *  - 产出的 .har 可直接导入 Chrome DevTools / Charles / Fiddler / Postman
 */

const pkg = require("../../package.json");

/** 内联进 HAR 的响应体上限（超过则只记元数据 + 磁盘路径，避免 .har 膨胀到 GB 级） */
const MAX_INLINE_BODY = 1024 * 1024;

class HarBuilder {
  constructor() {
    this.entries = [];
    this._byId = new Map();       // requestId -> entry（内部引用）
    this._extraReq = new Map();   // requestId -> 额外请求头
    this._extraRes = new Map();   // requestId -> 额外响应头
    this._startWallTime = Date.now();
  }

  _get(requestId) {
    if (!this._byId.has(requestId)) {
      const now = new Date().toISOString();
      const entry = {
        _cdpId: requestId,
        startedDateTime: now,
        time: 0,
        request: {
          method: "GET",
          url: "",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [],
          queryString: [],
          headersSize: -1,
          bodySize: -1,
        },
        response: {
          status: 0,
          statusText: "",
          httpVersion: "HTTP/1.1",
          cookies: [],
          headers: [],
          content: { size: 0, mimeType: "" },
          redirectURL: "",
          headersSize: -1,
          bodySize: -1,
        },
        cache: {},
        timings: { send: 0, wait: 0, receive: 0 },
        _pending: true,
      };
      this._byId.set(requestId, entry);
      this.entries.push(entry);
    }
    return this._byId.get(requestId);
  }

  onRequestWillBeSent(p) {
    const e = this._get(p.requestId);
    const r = p.request;
    e.startedDateTime = p.wallTime ? new Date(p.wallTime * 1000).toISOString() : new Date().toISOString();
    e.request.method = r.method || "GET";
    e.request.url = r.url || "";
    e.request.httpVersion = "HTTP/1.1";
    e.request.headers = objectToHeaders(r.headers);
    e.request.queryString = parseQuery(r.url);
    if (r.postData) {
      e.request.postData = { mimeType: r.postDataEntries ? guessMime(r.headers) : "application/octet-stream", text: r.postData };
      e.request.bodySize = Buffer.byteLength(r.postData, "utf8");
    }
    if (p.type) e._resourceType = p.type;
    if (p.redirectResponse) {
      // 记录重定向
      e.response.status = p.redirectResponse.status;
      e.response.statusText = p.redirectResponse.statusText || "";
      e.response.redirectURL = p.redirectResponse.url || "";
      e.response.headers = objectToHeaders(p.redirectResponse.headers);
    }
    // 时间戳（单调）
    e._ts = p.timestamp;
  }

  onRequestExtraInfo(p) {
    this._extraReq.set(p.requestId, p.headers || {});
  }

  onResponseExtraInfo(p) {
    this._extraRes.set(p.requestId, { headers: p.headers || {}, statusCode: p.statusCode });
  }

  onResponseReceived(p) {
    const e = this._get(p.requestId);
    const r = p.response;
    e.response.status = r.status;
    e.response.statusText = r.statusText || statusText(r.status);
    e.response.httpVersion = r.protocol === "h2" ? "HTTP/2" : r.protocol === "h3" ? "HTTP/3" : "HTTP/1.1";
    e.response.headers = objectToHeaders({ ...(this._extraRes.get(p.requestId)?.headers || {}), ...r.headers });
    e.response.content.size = r.encodedDataLength || 0;
    e.response.content.mimeType = r.mimeType || "";
    e.response.redirectURL = r.headers?.location || "";
    e._encodedDataLength = r.encodedDataLength;
    e._responseTs = p.timestamp;
    e._resourceType = p.type || e._resourceType;
  }

  onLoadingFinished(p) {
    const e = this._get(p.requestId);
    const total = p.encodedDataLength || 0;
    e.response.content.size = total || e.response.content.size;
    e.response.bodySize = total;
    e._pending = false;
    e._endTs = p.timestamp;
    this._finalizeTimings(e, p.timestamp);
    if (p.response?.headersText) e.response.headersText = p.response.headersText;
  }

  onLoadingFailed(p) {
    const e = this._get(p.requestId);
    e._pending = false;
    e._failed = true;
    e.response.status = e.response.status || 0;
    e.response._error = p.errorText || "failed";
    e._error = { errorText: p.errorText, canceled: p.canceled, blockedReason: p.blockedReason };
    e._endTs = p.timestamp;
    this._finalizeTimings(e, p.timestamp);
  }

  _finalizeTimings(e, endTs) {
    if (!e._ts || !endTs) return;
    // HAR 1.2 timings 语义：
    //   send    = 发出请求耗时（此处近似为 0，CDP 未单列）
    //   wait    = TTFB：从请求发出到收到响应首字节（responseReceived）
    //   receive = 从收到响应首字节到响应体接收完毕（loadingFinished）
    // 注意：send/wait/receive 必须 >= 0（-1 仅允许 blocked/dns/connect/ssl）
    const reqTs = e._ts;
    const resTs = e._responseTs || endTs;
    const finTs = endTs;

    const wait = Math.max(0, (resTs - reqTs) * 1000);
    const receive = Math.max(0, (finTs - resTs) * 1000);
    const send = 0;

    e.timings = {
      blocked: -1,
      dns: -1,
      connect: -1,
      send,
      wait,
      receive,
      ssl: -1,
    };
    // HAR 1.2：entry.time 应等于各非 -1 timing 之和
    e.time = send + wait + receive;
  }

  /**
   * 记录该请求的响应体在磁盘上的相对路径（用于大 body 不内联时指向文件）
   * @param {string} requestId
   * @param {string} relPath 相对 outputDir 的路径（正斜杠）
   */
  setSavedFile(requestId, relPath) {
    const e = this._byId.get(requestId);
    if (e) e._savedFile = relPath;
  }

  /**
   * 把响应体挂到对应 HAR entry 的 response.content 上。
   *
   * HAR 1.2 规范中 `content.text` 承载响应体；此前实现只写 size/mimeType，
   * 导致导出的 .har 在 DevTools / Charles / Postman 中「有请求无内容」。
   *
   * 体积保护：超过 MAX_INLINE_BODY 的 body 不内联（否则 .har 可达 GB 级且加载卡死），
   * 改为写 `_bodyOmitted` + `_bodyFile`（非标准扩展字段，标准客户端会忽略）。
   *
   * @param {string} requestId
   * @param {object} p
   * @param {string} p.text      响应体（base64 编码时传原始 base64 串）
   * @param {string} [p.encoding] 仅二进制为 "base64"
   * @param {string} p.mimeType
   * @param {number} p.size      解码后的字节数
   */
  attachBody(requestId, { text, encoding, mimeType, size }) {
    const e = this._byId.get(requestId);
    if (!e) return;
    const content = { ...e.response.content, mimeType: mimeType || e.response.content.mimeType, size };

    if (size > MAX_INLINE_BODY) {
      e.response.content = { ...content, _bodyOmitted: true, _bodyFile: e._savedFile || null };
      return;
    }
    e.response.content = encoding
      ? { ...content, text, encoding }
      : { ...content, text };
  }

  /** 产出 HAR 1.2 对象 */
  build() {
    const pages = [{
      startedDateTime: new Date(this._startWallTime).toISOString(),
      id: "page_1",
      title: "",
      pageTimings: { onContentLoad: -1, onLoad: -1 },
    }];
    const entries = this.entries.map((e) => {
      e.pageref = "page_1";
      // 清理内部字段
      const clean = {
        pageref: e.pageref,
        startedDateTime: e.startedDateTime,
        time: Math.round(e.time),
        request: e.request,
        response: e.response,
        cache: e.cache,
        timings: e.timings,
        serverIPAddress: e._serverIPAddress || undefined,
        connection: undefined,
        _resourceType: e._resourceType,
        _error: e._error,
      };
      if (!clean.serverIPAddress) delete clean.serverIPAddress;
      if (!clean.connection) delete clean.connection;
      if (!clean._error) delete clean._error;
      return clean;
    });
    return {
      log: {
        version: "1.2",
        creator: { name: "GetSourceCode", version: pkg.version },
        browser: { name: "Chrome", version: "" },
        pages,
        entries,
      },
    };
  }
}

function objectToHeaders(obj) {
  if (!obj) return [];
  return Object.entries(obj).map(([name, value]) => ({
    name,
    value: Array.isArray(value) ? value.join(", ") : String(value),
  }));
}

function parseQuery(url) {
  try {
    const u = new URL(url);
    const out = [];
    for (const [name, value] of u.searchParams) out.push({ name, value });
    return out;
  } catch {
    return [];
  }
}

function guessMime(headers) {
  const h = headers || {};
  return h["Content-Type"] || h["content-type"] || "application/octet-stream";
}

function statusText(code) {
  const map = {
    200: "OK", 201: "Created", 204: "No Content", 301: "Moved Permanently", 302: "Found",
    304: "Not Modified", 307: "Temporary Redirect", 308: "Permanent Redirect",
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
    405: "Method Not Allowed", 429: "Too Many Requests", 500: "Internal Server Error",
    502: "Bad Gateway", 503: "Service Unavailable",
  };
  return map[code] || "";
}

module.exports = { HarBuilder };
