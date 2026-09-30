"use strict";

/**
 * 无限滚动测试夹具（infinite scroll fixture）
 *
 * 用途：为 CDP 抓取/滚动相关测试提供一个“接近真实”的目标站点：
 *   - 首屏 4 张图片，滚动到底部附近时每次追加 4 张，直到 40 张
 *   - 图片为真实合法的 PNG（zlib 手工编码），带 ~30ms 网络延迟
 *   - 同时依赖 scroll 事件与 250ms 轮询，兼容 CDP 的 scrollTo 不触发 scroll 的场景
 *
 * 约束：纯 Node 内置模块（http / zlib），不引入任何依赖，不访问外部网络。
 * 用法：const { startServer } = require("./test/fixtures/infinite-scroll-server");
 */

const http = require("http");
const zlib = require("zlib");

const LISTEN_HOST = "127.0.0.1";
const IMAGE_DELAY_MS = 30;
const PNG_SIZE = 8; // 8x8 像素，足够小但完全合法

/* ------------------------------------------------------------------ *
 * PNG 编码（zlib 手工生成合法 PNG，不依赖任何第三方库）
 * ------------------------------------------------------------------ */

let crcTable = null;

function makeCrcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
}

function crc32(buf) {
  // Node >= 20.15 / 22 提供 zlib.crc32，优先使用
  if (typeof zlib.crc32 === "function") {
    return zlib.crc32(buf) >>> 0;
  }
  if (!crcTable) crcTable = makeCrcTable();
  let c = -1;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ -1) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuf = Buffer.from(type, "latin1");
  const body = Buffer.concat([typeBuf, data]);

  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);

  return Buffer.concat([length, body, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 生成一张 size x size 的纯色 RGBA PNG。
 * @param {number} size 边长（像素）
 * @param {number} seed 用于让不同编号的图片有可区分的颜色
 * @returns {Buffer}
 */
function buildPng(size, seed) {
  const w = size;
  const h = size;

  const r = 40 + ((seed * 37) % 180);
  const g = 60 + ((seed * 71) % 160);
  const b = 90 + ((seed * 113) % 140);

  // 原始扫描线：每行 1 字节 filter(0) + w * 4 字节 RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  let off = 0;
  for (let y = 0; y < h; y++) {
    raw[off++] = 0; // filter type: None
    for (let x = 0; x < w; x++) {
      raw[off++] = r;
      raw[off++] = g;
      raw[off++] = b;
      raw[off++] = 255;
    }
  }

  // IHDR: width, height, bitDepth, colorType(RGBA=6), compression, filter, interlace
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const pngCache = new Map();

function getPng(n) {
  if (!pngCache.has(n)) {
    pngCache.set(n, buildPng(PNG_SIZE, n));
  }
  return pngCache.get(n);
}

/* ------------------------------------------------------------------ *
 * HTML 页面
 * ------------------------------------------------------------------ */

const INITIAL_IMAGES = 8;
const BATCH_SIZE = 4;
const TARGET_IMAGES = 40;
const BOTTOM_THRESHOLD_PX = 200;
const POLL_INTERVAL_MS = 250;
const IMAGE_HEIGHT_PX = 200;

function buildHtml() {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Infinite Scroll Fixture</title>",
    "<style>",
    "  html, body { margin: 0; padding: 0; background: #f3f4f6; font-family: sans-serif; }",
    "  header { padding: 16px; background: #1f2937; color: #fff; }",
    // 关键：gallery 预留 200vh 高度，确保「首屏绝不触底」与视口尺寸无关。
    // 若初始内容比视口还矮，nearBottom() 一开始就为真，无需滚动即全部加载，
    // 夹具就失去了「验证滚动是否触发懒加载」的能力（曾因此产生过假阳性测试）。
    "  #gallery { padding: 0 0 24px; min-height: 200vh; }",
    "  #gallery img { display: block; width: 100px; height: " + IMAGE_HEIGHT_PX + "px;",
    "                margin: 24px auto; border: 1px solid #cbd5e1; }",
    "  #sentinel { height: 120px; background: #e5e7eb; border-top: 2px dashed #94a3b8;",
    "              display: flex; align-items: center; justify-content: center; color: #475569; }",
    "</style>",
    "</head>",
    "<body>",
    "  <header>",
    "    <h1>Infinite Scroll Fixture</h1>",
    '    <p>loaded: <span id="count">' + INITIAL_IMAGES + "</span> / " + TARGET_IMAGES + "</p>",
    "  </header>",
    '  <main id="gallery">',
    makeInitialImages(INITIAL_IMAGES),
    "  </main>",
    '  <div id="sentinel">sentinel</div>',
    "  <script>",
    "    (function () {",
    "      'use strict';",
    "      var TARGET = " + TARGET_IMAGES + ";",
    "      var BATCH = " + BATCH_SIZE + ";",
    "      var THRESHOLD = " + BOTTOM_THRESHOLD_PX + ";",
    "      window.__loadedCount = " + INITIAL_IMAGES + ";",
    "      window.__loadEvents = 0;",
    "      var gallery = document.getElementById('gallery');",
    "      var counter = document.getElementById('count');",
    "",
    "      function appendImage() {",
    "        var n = window.__loadedCount;",
    "        var img = document.createElement('img');",
    "        img.setAttribute('src', '/img/' + n + '.png');",
    "        img.setAttribute('alt', 'image ' + n);",
    "        img.setAttribute('data-index', String(n));",
    "        gallery.appendChild(img);",
    "        window.__loadedCount += 1;",
    "      }",
    "",
    "      function updateCounter() {",
    "        if (counter) counter.textContent = String(window.__loadedCount);",
    "      }",
    "",
    "      function nearBottom() {",
    "        return (window.scrollY + window.innerHeight) >= (document.body.scrollHeight - THRESHOLD);",
    "      }",
    "",
    "      // 非闩锁：每次都必须「真的在底部」才加载一批。",
    "      // 追加内容会把底部推远，因而需要再次滚动才会继续加载 ——",
    "      // 这正是真实无限滚动站点的行为，也让测试能真正区分「滚了」与「没滚」。",
    "      window.__nearBottom = nearBottom;",
    "      function maybeLoadMore() {",
    "        if (window.__loadedCount >= TARGET) return;",
    "        if (!nearBottom()) return;",
    "        for (var i = 0; i < BATCH && window.__loadedCount < TARGET; i++) {",
    "          appendImage();",
    "        }",
    "        window.__loadEvents += 1;",
    "        updateCounter();",
    "      }",
    "",
    "      window.__loadMore = maybeLoadMore;",
    "      window.addEventListener('scroll', maybeLoadMore, { passive: true });",
    "      window.addEventListener('resize', maybeLoadMore, { passive: true });",
    "      // 兜底轮询：CDP 的 scrollTo 可能不触发 scroll 事件",
    "      setInterval(maybeLoadMore, " + POLL_INTERVAL_MS + ");",
    "      updateCounter();",
    "    })();",
    "  </script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function makeInitialImages(count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(
      '    <img src="/img/' + i + '.png" alt="image ' + i + '" data-index="' + i + '">'
    );
  }
  return lines.join("\n");
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */

const IMG_ROUTE = /^\/img\/([^/]+)\.png$/;

function sendHtml(res) {
  const body = Buffer.from(buildHtml(), "utf8");
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendImage(res, index) {
  await delay(IMAGE_DELAY_MS);
  const body = getPng(index);
  res.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, message) {
  const body = Buffer.from(message, "utf8");
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": body.length,
  });
  res.end(body);
}

function createRequestHandler() {
  return function handleRequest(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, "http://" + LISTEN_HOST).pathname;
    } catch (err) {
      sendError(res, 400, "Bad Request");
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendError(res, 404, "Not Found");
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      sendHtml(res);
      return;
    }

    const match = IMG_ROUTE.exec(pathname);
    if (match) {
      const raw = match[1];
      if (!/^\d+$/.test(raw)) {
        sendError(res, 400, "Bad Request: image index must be a number");
        return;
      }
      sendImage(res, Number(raw)).catch(() => {
        if (!res.headersSent) sendError(res, 500, "Internal Server Error");
      });
      return;
    }

    sendError(res, 404, "Not Found");
  };
}

/**
 * 启动夹具服务。
 * @returns {Promise<{url: string, port: number, close: () => Promise<void>}>}
 */
function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer(createRequestHandler());

    const onError = (err) => {
      server.removeListener("listening", onListening);
      reject(err);
    };

    const onListening = () => {
      server.removeListener("error", onError);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;

      resolve({
        port,
        url: "http://" + LISTEN_HOST + ":" + port + "/",
        close: () =>
          new Promise((resolveClose, rejectClose) => {
            // 主动断开 keep-alive 连接，避免 close 长时间挂起
            if (typeof server.closeAllConnections === "function") {
              server.closeAllConnections();
            }
            server.close((err) => (err ? rejectClose(err) : resolveClose()));
          }),
      });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, LISTEN_HOST);
  });
}

module.exports = { startServer };
