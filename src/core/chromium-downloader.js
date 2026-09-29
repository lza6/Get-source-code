"use strict";

/**
 * Chrome for Testing 下载器
 *
 * 让"没有安装浏览器"的用户也能用：从官方 CDN（或国内镜像）按需下载
 * Chrome for Testing，解压到应用数据目录并缓存。
 *
 * 设计要点（均经实测验证）：
 *  - 解压到 userData 而非 %TEMP%：TEMP 下启动会触发 sandbox 0x5 拒绝访问
 *  - 原子落盘：先写 .part，成功后 rename，避免半包
 *  - 双源回退：镜像 → 官方（或反之）
 *  - 版本戳 .version：避免重复下载
 *  - 不引入原生依赖：用 extract-zip（纯 JS）
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");
const { pipeline } = require("stream/promises");
const extractZip = require("extract-zip");

const CFT_API = "https://googlechromelabs.github.io/chrome-for-testing";
const CFT_ORIGIN = "https://storage.googleapis.com/chrome-for-testing-public";
const CFT_MIRROR = "https://registry.npmmirror.com/-/binary/chrome-for-testing";
const UA = "Mozilla/5.0 (compatible; GetSourceCode/1.0)";

const ASSETS = {
  chrome: "完整 Chrome（支持可见窗口登录）",
  "chrome-headless-shell": "Headless Shell（体积小，仅无头）",
};

/** 当前平台对应的 CfT 标识 */
function detectPlatform() {
  const p = process.platform;
  const a = process.arch;
  if (p === "win32") return a === "ia32" ? "win32" : "win64";
  if (p === "darwin") return a === "arm64" ? "mac-arm64" : "mac-x64";
  if (p === "linux") return a === "arm64" ? "linux-arm64" : "linux64";
  throw new Error(`不支持的平台: ${p}/${a}`);
}

/** 解压后，可执行文件相对于解压根目录的路径 */
function executableRelPath(platform, asset) {
  if (asset === "chrome-headless-shell") {
    return platform.startsWith("win")
      ? `chrome-headless-shell-${platform}/chrome-headless-shell.exe`
      : `chrome-headless-shell-${platform}/chrome-headless-shell`;
  }
  if (platform.startsWith("win")) return `chrome-${platform}/chrome.exe`;
  if (platform.startsWith("linux")) return `chrome-${platform}/chrome`;
  // macOS：注意是 .app 包结构，不是直下
  return `chrome-${platform}/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
}

/** GET（自动跟随重定向） */
function request(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("重定向次数过多"));
    const lib = url.startsWith("http://") ? http : https;
    const req = lib.get(url, { headers: { "user-agent": UA }, timeout: 30000 }, (res) => {
      const code = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
        res.resume();
        try {
          const next = new URL(res.headers.location, url).href;
          return request(next, redirects + 1).then(resolve, reject);
        } catch (e) {
          return reject(e);
        }
      }
      if (code !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${code} — ${url}`));
      }
      resolve(res);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("连接超时"));
    });
    req.on("error", reject);
  });
}

/** 获取最新稳定版下载信息（含镜像地址） */
async function fetchLatest(asset = "chrome", channel = "Stable") {
  const res = await request(`${CFT_API}/last-known-good-versions-with-downloads.json`);
  let raw = "";
  for await (const chunk of res) raw += chunk;
  const data = JSON.parse(raw);

  const ch = data.channels?.[channel];
  if (!ch) throw new Error(`未知通道: ${channel}`);

  const platform = detectPlatform();
  const list = ch.downloads?.[asset];
  if (!list) throw new Error(`该版本无 ${asset} 资产`);
  const entry = list.find((d) => d.platform === platform);
  if (!entry) throw new Error(`${asset} 不支持平台 ${platform}`);

  return {
    version: ch.version,
    platform,
    official: entry.url,
    mirror: entry.url.replace(CFT_ORIGIN, CFT_MIRROR),
  };
}

/** 流式下载到文件（原子落盘），返回字节数 */
async function downloadTo(url, dest, onProgress) {
  const part = dest + ".part";
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(part)) fs.rmSync(part, { force: true });

  const res = await request(url);
  const total = Number(res.headers["content-length"] || 0);
  let received = 0;
  res.on("data", (c) => {
    received += c.length;
    if (onProgress) onProgress(received, total);
  });

  await pipeline(res, fs.createWriteStream(part));
  if (total && received !== total) {
    fs.rmSync(part, { force: true });
    throw new Error(`下载不完整：${received}/${total} 字节`);
  }
  fs.renameSync(part, dest);
  return received;
}

class ChromiumDownloader {
  /**
   * @param {object} opts
   * @param {string} opts.baseDir  安装根目录（应传 app.getPath('userData')/browser）
   * @param {string} [opts.asset]  chrome | chrome-headless-shell
   * @param {string} [opts.channel] Stable|Beta|Dev|Canary
   * @param {boolean} [opts.preferMirror] 是否优先用国内镜像
   * @param {(p:{phase:string,received?:number,total?:number,percent?:number,message?:string})=>void} [opts.onProgress]
   */
  constructor(opts = {}) {
    this.baseDir = opts.baseDir;
    this.asset = opts.asset || "chrome";
    this.channel = opts.channel || "Stable";
    this.preferMirror = opts.preferMirror !== false;
    this.onProgress = opts.onProgress || (() => {});
    if (!this.baseDir) throw new Error("ChromiumDownloader 需要 baseDir");
  }

  get platform() {
    return detectPlatform();
  }

  /** 该资产的安装目录 */
  get installDir() {
    return path.join(this.baseDir, this.platform, this.asset);
  }

  get stampFile() {
    return path.join(this.installDir, ".version");
  }

  /** 已安装则返回可执行文件路径，否则 null */
  getInstalled() {
    try {
      const exe = path.join(this.installDir, executableRelPath(this.platform, this.asset));
      if (fs.existsSync(exe) && fs.existsSync(this.stampFile)) {
        return { exe, version: fs.readFileSync(this.stampFile, "utf8").trim() };
      }
    } catch {
      /* ignore */
    }
    return null;
  }

  /**
   * 确保浏览器就绪，返回可执行文件绝对路径
   * @returns {Promise<{exe:string, version:string, downloaded:boolean}>}
   */
  async ensure() {
    const installed = this.getInstalled();
    if (installed) {
      this.onProgress({ phase: "ready", message: `已安装 v${installed.version}` });
      return { ...installed, downloaded: false };
    }

    this.onProgress({ phase: "meta", message: "正在获取最新版本信息…" });
    const info = await fetchLatest(this.asset, this.channel);

    const sources = this.preferMirror
      ? [{ name: "国内镜像", url: info.mirror }, { name: "官方源", url: info.official }]
      : [{ name: "官方源", url: info.official }, { name: "国内镜像", url: info.mirror }];

    const zipPath = path.join(this.baseDir, `${this.asset}-${info.version}-${info.platform}.zip`);
    let lastErr = null;

    for (const src of sources) {
      try {
        this.onProgress({ phase: "download", message: `从${src.name}下载 v${info.version}…`, percent: 0 });
        await downloadTo(src.url, zipPath, (received, total) => {
          this.onProgress({
            phase: "download",
            received,
            total,
            percent: total ? Math.round((received / total) * 100) : 0,
            message: `下载中 ${(received / 1048576).toFixed(1)}${total ? "/" + (total / 1048576).toFixed(1) : ""} MB`,
          });
        });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        this.onProgress({ phase: "retry", message: `${src.name}失败：${e.message}` });
        try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
      }
    }
    if (lastErr) throw new Error(`全部下载源均失败：${lastErr.message}`);

    // 解压（先清空目标，避免残留旧文件）
    this.onProgress({ phase: "extract", message: "正在解压…" });
    try { fs.rmSync(this.installDir, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.mkdirSync(this.installDir, { recursive: true });
    try {
      await extractZip(zipPath, { dir: path.resolve(this.installDir) });
    } catch (e) {
      // 解压失败：清理残留的半成品，避免占用磁盘 / 被误判
      try { fs.rmSync(this.installDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }
      throw new Error(`解压失败：${e.message}`);
    }

    // 写版本戳
    fs.writeFileSync(this.stampFile, info.version, "utf8");
    try { fs.rmSync(zipPath, { force: true }); } catch { /* ignore */ }

    // 校验可执行文件存在
    const exe = path.join(this.installDir, executableRelPath(this.platform, this.asset));
    if (!fs.existsSync(exe)) {
      throw new Error(`解压后未找到可执行文件：${exe}`);
    }
    // POSIX 平台补可执行权限
    if (!this.platform.startsWith("win")) {
      try { fs.chmodSync(exe, 0o755); } catch { /* ignore */ }
    }

    this.onProgress({ phase: "ready", message: `安装完成 v${info.version}` });
    return { exe, version: info.version, downloaded: true };
  }

  /** 卸载内置浏览器 */
  remove() {
    const dir = path.join(this.baseDir, this.platform);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** 查询已安装情况（不下载） */
  status() {
    const inst = this.getInstalled();
    return {
      installed: !!inst,
      version: inst ? inst.version : null,
      exe: inst ? inst.exe : null,
      platform: this.platform,
      asset: this.asset,
      installDir: this.installDir,
    };
  }
}

module.exports = {
  ChromiumDownloader,
  detectPlatform,
  executableRelPath,
  fetchLatest,
  downloadTo,
  CFT_API,
  CFT_ORIGIN,
  CFT_MIRROR,
  ASSETS,
};
