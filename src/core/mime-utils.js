"use strict";

/**
 * MIME / 资源类型分类与本地路径规划
 */

const path = require("path");

const KIND_DIR = {
  source: "source",
  media: "media",
  html: "html",
  other: "other",
};

const KIND_LABEL = {
  source: "源码资源 (JS/CSS/字体)",
  media: "媒体文件 (图片/视频/音频)",
  html: "页面快照",
  other: "其它文本",
};

/** 扩展名 -> 类别 */
const EXT_KIND = {
  // 源码
  js: "source", mjs: "source", cjs: "source", jsx: "source", ts: "source", tsx: "source",
  css: "source", scss: "source", less: "source", map: "source",
  // 字体
  woff: "source", woff2: "source", ttf: "source", otf: "source", eot: "source",
  // 其它文本
  json: "other", xml: "other", txt: "other", csv: "other", svg: "other",
  // 媒体
  png: "media", jpg: "media", jpeg: "media", gif: "media", webp: "media",
  bmp: "media", ico: "media", avif: "media", apng: "media",
  mp4: "media", webm: "media", ogg: "media", ogv: "media", mov: "media", m4v: "media",
  mp3: "media", wav: "media", flac: "media", aac: "media", m4a: "media", opus: "media",
  // 文档
  pdf: "media", zip: "media",
};

class MimeClassifier {
  /**
   * @param {string} url
   * @param {string} mime
   * @param {string} cdpType  CDP 的 resource type（Document/Script/Stylesheet/Image/Media/Font/XHR/Fetch...）
   * @param {object} headers
   * @returns {{ kind: string, ext: string, dir: string }}
   */
  static classify(url, mime, cdpType, headers = {}) {
    const ext = MimeClassifier.extFromUrl(url, mime);
    let kind = EXT_KIND[ext];

    if (!kind) {
      // 依据 CDP type 兜底
      const t = (cdpType || "").toLowerCase();
      if (t === "script" || t === "stylesheet" || t === "font") kind = "source";
      else if (t === "image" || t === "media") kind = "media";
      else if (t === "document") kind = "html";
      else if (t === "xhr" || t === "fetch") kind = "other";
      else {
        // 依据 mime 兜底
        if (/javascript|ecmascript|css|font/i.test(mime)) kind = "source";
        else if (/^image\/|^video\/|^audio\//i.test(mime)) kind = "media";
        else if (/html/i.test(mime)) kind = "html";
        else if (/json|xml|text\/plain/i.test(mime)) kind = "other";
        else kind = "other";
      }
    }

    return { kind, ext: ext || "bin", dir: KIND_DIR[kind] || "other" };
  }

  /** 从 URL 或 MIME 推断扩展名 */
  static extFromUrl(url, mime = "") {
    try {
      const u = new URL(url);
      const base = u.pathname.split("/").pop() || "";
      const m = base.match(/\.([a-z0-9]{1,6})(?:$|\?)/i);
      if (m) {
        const e = m[1].toLowerCase();
        // 排除常见误判
        if (!["php", "asp", "aspx", "jsp", "do", "html", "htm"].includes(e)) return e;
      }
    } catch {
      /* ignore */
    }
    const MIME_EXT = {
      "application/javascript": "js",
      "text/javascript": "js",
      "application/x-javascript": "js",
      "text/css": "css",
      "text/html": "html",
      "application/json": "json",
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/gif": "gif",
      "image/webp": "webp",
      "image/svg+xml": "svg",
      "image/x-icon": "ico",
      "video/mp4": "mp4",
      "video/webm": "webm",
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "font/woff": "woff",
      "font/woff2": "woff2",
      "font/ttf": "ttf",
      "application/wasm": "wasm",
    };
    return MIME_EXT[mime.split(";")[0].trim().toLowerCase()] || "";
  }
}

/** 生成安全的文件名（去除非法字符，限长） */
function safeFileName(name, maxLen = 120) {
  let n = String(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/^\.+/, "_")
    .replace(/[. ]+$/, "_");
  if (!n) n = "_";
  if (n.length > maxLen) {
    const ext = path.extname(n);
    n = n.slice(0, maxLen - ext.length) + ext;
  }
  return n;
}

/**
 * 由 URL 构建本地相对路径
 *  源码: source/{host}/{path}
 *  媒体: media/{host}/{path}
 *  其它: other/{host}/{path}
 * 保留原始目录结构；无文件名时用 hash 生成
 * 带 query 的 URL 会附加短 hash，避免同名覆盖
 */
function buildLocalPath(url, cls, baseUrl) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return path.join(cls.dir, "unknown", `unknown_${Date.now()}.${cls.ext}`);
  }
  const host = safeFileName(u.hostname);
  let segs = u.pathname.split("/").filter(Boolean).map((s) => safeFileName(decodeURIComponentSafe(s)));
  if (segs.length === 0) segs = ["index"];
  let last = segs[segs.length - 1];
  const hasExt = /\.[a-z0-9]{1,6}$/i.test(last);

  // 有 query/fragment 时附加短 hash，避免“同名不同参”互相覆盖
  const needDisambig = !!(u.search || u.hash);
  const h = needDisambig ? shortHash(u.search + u.hash) : "";

  if (!hasExt) {
    // 无扩展名（目录型 / API）：补扩展名
    last = h ? `${last}_${h}.${cls.ext}` : `${last}.${cls.ext}`;
  } else if (h) {
    // 有扩展名但带参数：file.js → file_ab12cd.js
    const dot = last.lastIndexOf(".");
    last = `${last.slice(0, dot)}_${h}${last.slice(dot)}`;
  }
  segs[segs.length - 1] = last;
  return path.join(cls.dir, host, ...segs);
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function shortHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36).slice(0, 6);
}

module.exports = { MimeClassifier, safeFileName, buildLocalPath, KIND_LABEL, KIND_DIR, shortHash };
