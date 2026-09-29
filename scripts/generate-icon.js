"use strict";

/**
 * 生成应用图标（无外部依赖）
 *  - 输出 build/icon.ico（Windows，多尺寸）
 *  - 输出 build/icon.png（256x256，其它平台/文档用）
 *
 * 设计：深色圆角底 + 青蓝渐变 + 白色 "</>" 代码符号
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT_DIR = path.join(__dirname, "..", "build");
fs.mkdirSync(OUT_DIR, { recursive: true });

/* ---------- 极简光栅绘制 ---------- */

const BG_TOP = [47, 129, 247];     // #2f81f7
const BG_BOT = [163, 113, 247];    // #a371f7
const BG_DARK = [13, 17, 23];      // #0d1117
const WHITE = [255, 255, 255];

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 圆角矩形内部判定 */
function inRoundedRect(x, y, w, h, r) {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= r && x < w - r) || (y >= r && y < h - r);
}

/**
 * 绘制 256x256 RGBA 像素
 * 图案：外圆角方块（深色）→ 内圆角渐变 → 白色代码符号
 */
function renderIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const S = size;
  const scale = S / 256;
  const radius = 56 * scale;
  const pad = 0;

  // 代码符号的几何参数（基于 256 坐标系，再缩放）
  const cx = S / 2;
  const cy = S / 2;
  const thick = Math.max(2, Math.round(11 * scale));
  const arm = 46 * scale;      // 尖括号横臂长度
  const gap = 8 * scale;       // 斜杠间距

  const distToSeg = (px_, py_, x1, y1, x2, y2) => {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px_ - x1) * dx + (py_ - y1) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = x1 + t * dx, qy = y1 + t * dy;
    return Math.hypot(px_ - qx, py_ - qy);
  };

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      let r = 0, g = 0, b = 0, a = 0;

      if (!inRoundedRect(x, y, S - pad, S - pad, radius)) {
        // 圆角外：透明
        px[i] = px[i + 1] = px[i + 2] = px[i + 3] = 0;
        continue;
      }

      // 深色底
      r = BG_DARK[0]; g = BG_DARK[1]; b = BG_DARK[2]; a = 255;

      // 渐变内层（略微内缩）
      const inset = 22 * scale;
      if (inRoundedRect(x - inset, y - inset, S - inset * 2, S - inset * 2, radius - inset * 0.6)) {
        const t = y / S;
        r = Math.round(lerp(BG_TOP[0], BG_BOT[0], t));
        g = Math.round(lerp(BG_TOP[1], BG_BOT[1], t));
        b = Math.round(lerp(BG_TOP[2], BG_BOT[2], t));
      }

      // 白色代码符号： < / >
      // 左尖括号 <
      const lx = cx - 40 * scale, ly = cy;
      const d1 = distToSeg(x, y, lx - arm * 0.15, ly - arm, lx + arm * 0.55, ly);
      const d2 = distToSeg(x, y, lx + arm * 0.55, ly, lx - arm * 0.15, ly + arm);
      // 右尖括号 >
      const rx = cx + 40 * scale;
      const d3 = distToSeg(x, y, rx + arm * 0.15, ly - arm, rx - arm * 0.55, ly);
      const d4 = distToSeg(x, y, rx - arm * 0.55, ly, rx + arm * 0.15, ly + arm);
      // 中间斜杠 /
      const d5 = distToSeg(x, y, cx + gap * 1.6, cy - arm * 0.85, cx - gap * 1.6, cy + arm * 0.85);

      const minDist = Math.min(d1, d2, d3, d4, d5);
      const half = thick / 2;
      if (minDist <= half) {
        // 抗锯齿
        const aa = minDist > half - 1.2 ? Math.max(0, (half - minDist) / 1.2) : 1;
        r = Math.round(lerp(r, WHITE[0], aa));
        g = Math.round(lerp(g, WHITE[1], aa));
        b = Math.round(lerp(b, WHITE[2], aa));
      }

      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
    }
  }
  return px;
}

/* ---------- PNG 编码 ---------- */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePNG(rgba, size) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // 每行前加 filter byte 0
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * size * 4, size * 4)
      .copy(raw, y * (size * 4 + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- ICO 编码（PNG 嵌入） ---------- */

function encodeICO(images) {
  // images: [{size, png}]
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);      // reserved
  header.writeUInt16LE(1, 2);      // type = icon
  header.writeUInt16LE(count, 4);  // count

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;
  const blobs = [];
  images.forEach((img, idx) => {
    const e = idx * 16;
    dir[e] = img.size >= 256 ? 0 : img.size;         // width
    dir[e + 1] = img.size >= 256 ? 0 : img.size;     // height
    dir[e + 2] = 0;   // palette
    dir[e + 3] = 0;   // reserved
    dir.writeUInt16LE(1, e + 4);                     // color planes
    dir.writeUInt16LE(32, e + 6);                    // bits per pixel
    dir.writeUInt32LE(img.png.length, e + 8);        // size
    dir.writeUInt32LE(offset, e + 12);               // offset
    offset += img.png.length;
    blobs.push(img.png);
  });
  return Buffer.concat([header, dir, ...blobs]);
}

/* ---------- 执行 ---------- */

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const images = SIZES.map((size) => ({ size, png: encodePNG(renderIcon(size), size) }));

fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), encodeICO(images));
fs.writeFileSync(path.join(OUT_DIR, "icon.png"), encodePNG(renderIcon(256), 256));

console.log("✓ build/icon.ico", fs.statSync(path.join(OUT_DIR, "icon.ico")).size, "bytes",
  `(${SIZES.join("/")})`);
console.log("✓ build/icon.png", fs.statSync(path.join(OUT_DIR, "icon.png")).size, "bytes (256x256)");
