"use strict";

/**
 * HAR 1.2 构建器
 *  - 将 CDP Network 域事件聚合为符合 HAR 1.2 规范的对象
 *  - 产出的 .har 可直接导入 Chrome DevTools / Charles / Fiddler / Postman
 */

const pkg = require("../../package.json");

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
    if (e._ts && endTs) {
      const send = Math.max(0, ((e._responseTs || e._ts) - e._ts) * 1000);
      const wait = Math.max(0, ((e._endTs || endTs) - (e._responseTs || e._ts)) * 1000);
      e.timings = { blocked: -1, dns: -1, connect: -1, send, wait, receive: 0, ssl: -1 };
      e.time = send + wait;
    }
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
