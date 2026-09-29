"use strict";

/**
 * 浏览器源管理器
 *
 * 统一管理三种浏览器来源，供抓取引擎选择：
 *   1. system   — 使用系统已安装的 Chrome / Edge（默认）
 *   2. bundled  — 下载并使用内置 Chrome for Testing（无浏览器用户）
 *   3. custom   — 用户指定的可执行文件路径
 *
 * 同时管理「浏览器 profile 策略」：
 *   - ephemeral — 每次抓取用临时 profile（不保留登录态，默认）
 *   - persistent — 固定 profile，可引导用户登录一次，之后带登录态抓取
 *
 * 设计依据（经实测）：
 *   - 绝不复用用户真实 Chrome profile：Chrome 运行时 → exit 21；
 *     Chrome 136+ 对默认目录禁用 CDP；强挂载会 0 cookie 且可能损坏用户数据
 *   - persistent profile 必须位于非默认目录，否则新版 Chrome 拒绝开 CDP
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { detectBrowsers } = require("./browser-launcher");
const { ChromiumDownloader } = require("./chromium-downloader");

/** 浏览器来源类型 */
const SOURCE = {
  SYSTEM: "system",
  BUNDLED: "bundled",
  CUSTOM: "custom",
};

const ALLOWED_SOURCES = new Set([SOURCE.SYSTEM, SOURCE.BUNDLED, SOURCE.CUSTOM]);
const ALLOWED_ASSETS = new Set(["chrome", "chrome-headless-shell"]);

/** 允许的可执行文件名（防任意 exe 执行） */
const ALLOWED_EXE = /^(chrome|chrome-headless-shell|msedge|brave|chromium|chromium-browser)(\.exe)?$/i;

/** 校验可执行文件是否可信 */
function isTrustedExecutable(p) {
  if (!p || typeof p !== "string") return false;
  const base = path.basename(p);
  return ALLOWED_EXE.test(base);
}

/** profile 策略 */
const PROFILE_MODE = {
  EPHEMERAL: "ephemeral",   // 临时，抓完即弃
  PERSISTENT: "persistent", // 持久，可带登录态
};

class BrowserManager {
  /**
   * @param {object} opts
   * @param {string} opts.userDataDir 应用数据目录（app.getPath('userData')）
   */
  constructor(opts = {}) {
    this.userDataDir = opts.userDataDir || path.join(os.tmpdir(), "gsc-data");
    this.browserDir = path.join(this.userDataDir, "browser");
    this.profileRoot = path.join(this.userDataDir, "profiles");
    fs.mkdirSync(this.browserDir, { recursive: true });
    fs.mkdirSync(this.profileRoot, { recursive: true });
  }

  /** 列出所有可用的浏览器来源 */
  listSources() {
    const system = detectBrowsers().map((b) => ({
      id: `system:${b.path}`,
      type: SOURCE.SYSTEM,
      name: `${b.name}（系统已安装）`,
      path: b.path,
      available: true,
    }));

    const dl = new ChromiumDownloader({ baseDir: this.browserDir, asset: "chrome" });
    const dlShell = new ChromiumDownloader({ baseDir: this.browserDir, asset: "chrome-headless-shell" });
    const shellStatus = dlShell.status();

    return { system, bundled: shellStatus, installDir: this.browserDir };
  }

  /** 系统浏览器列表 */
  getSystemBrowsers() {
    return detectBrowsers();
  }

  /**
   * 解析出实际可用的浏览器可执行文件路径
   * @param {object} req
   * @param {string} [req.source]       system | bundled | custom
   * @param {string} [req.executablePath] custom / system 时显式指定
   * @param {string} [req.asset]        bundled 时用 chrome 还是 chrome-headless-shell
   * @param {(p:object)=>void} [req.onProgress]
   * @param {boolean} [req.preferMirror]
   * @returns {Promise<{exe:string, source:string, version?:string}>}
   */
  async resolveBrowser(req = {}) {
    const source = req.source || SOURCE.SYSTEM;

    // 白名单校验来源
    if (!ALLOWED_SOURCES.has(source)) {
      throw new Error(`非法的浏览器来源: ${source}`);
    }
    // 白名单校验 asset
    const asset = req.asset || "chrome";
    if (!ALLOWED_ASSETS.has(asset)) {
      throw new Error(`非法的浏览器资产: ${asset}`);
    }

    if (source === SOURCE.CUSTOM) {
      if (!req.executablePath || !fs.existsSync(req.executablePath)) {
        throw new Error("自定义浏览器路径无效或不存在");
      }
      // 纵深防御：仅允许已知浏览器可执行文件名，避免任意 exe 被执行
      if (!isTrustedExecutable(req.executablePath)) {
        throw new Error("自定义路径不是受支持的浏览器可执行文件");
      }
      return { exe: req.executablePath, source: SOURCE.CUSTOM };
    }

    if (source === SOURCE.BUNDLED) {
      const dl = new ChromiumDownloader({
        baseDir: this.browserDir,
        asset,
        preferMirror: req.preferMirror !== false,
        onProgress: req.onProgress,
      });
      const r = await dl.ensure();
      return { exe: r.exe, source: SOURCE.BUNDLED, version: r.version };
    }

    // system（默认）
    if (req.executablePath && fs.existsSync(req.executablePath) && isTrustedExecutable(req.executablePath)) {
      return { exe: req.executablePath, source: SOURCE.SYSTEM };
    }
    const list = detectBrowsers();
    if (!list.length) {
      throw new Error("未检测到系统浏览器，请改用「内置浏览器」或手动指定路径");
    }
    return { exe: list[0].path, source: SOURCE.SYSTEM };
  }

  /**
   * 解析 profile 目录
   * @param {object} req
   * @param {'ephemeral'|'persistent'} [req.profileMode]
   * @param {string} [req.profileName] persistent 时的名字（多账号）
   * @returns {{dir:string, mode:string, ephemeral:boolean}}
   */
  resolveProfile(req = {}) {
    const mode = req.profileMode || PROFILE_MODE.EPHEMERAL;
    if (mode === PROFILE_MODE.PERSISTENT) {
      const name = sanitizeProfileName(req.profileName || "default");
      const dir = path.join(this.profileRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      return { dir, mode, ephemeral: false };
    }
    const dir = path.join(os.tmpdir(), `gsc-ephemeral-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    return { dir, mode, ephemeral: true };
  }

  /** 列出所有持久 profile（可用于"选择已登录的账号"） */
  listProfiles() {
    const out = [];
    try {
      for (const name of fs.readdirSync(this.profileRoot)) {
        const dir = path.join(this.profileRoot, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        const hasDefault = fs.existsSync(path.join(dir, "Default"));
        let mtime = 0;
        try { mtime = fs.statSync(dir).mtimeMs; } catch { /* ignore */ }
        out.push({ name, dir, loggedIn: hasDefault, lastUsed: mtime ? new Date(mtime).toISOString() : null });
      }
    } catch { /* ignore */ }
    return out.sort((a, b) => (b.lastUsed || "").localeCompare(a.lastUsed || ""));
  }

  /** 删除某个持久 profile */
  removeProfile(name) {
    const safe = sanitizeProfileName(name);
    const dir = path.join(this.profileRoot, safe);
    if (path.dirname(dir) !== this.profileRoot) return false;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** 清理临时 profile（抓取结束后调用） */
  cleanupEphemeral(dir) {
    if (!dir) return false;
    // 安全校验：只删 temp 下带 gsc-ephemeral 前缀的目录
    const norm = path.resolve(dir);
    if (!norm.startsWith(path.resolve(os.tmpdir())) || !path.basename(norm).startsWith("gsc-ephemeral-")) {
      return false;
    }
    try {
      fs.rmSync(norm, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** 获取持久 profile 的登录状态概览（不读 cookie 内容，只判断是否存在） */
  profileStatus(name) {
    const safe = sanitizeProfileName(name || "default");
    const dir = path.join(this.profileRoot, safe);
    const candidates = [
      path.join(dir, "Default", "Network", "Cookies"),
      path.join(dir, "Default", "Cookies"),
    ];
    let cookieFile = null;
    for (const c of candidates) {
      if (fs.existsSync(c)) { cookieFile = c; break; }
    }
    return {
      name: safe,
      dir,
      exists: fs.existsSync(dir),
      hasCookies: !!cookieFile,
      cookieSize: cookieFile ? (() => { try { return fs.statSync(cookieFile).size; } catch { return 0; } })() : 0,
    };
  }
}

/** profile 名安全化（防路径穿越） */
function sanitizeProfileName(name) {
  const s = String(name).replace(/[^a-zA-Z0-9_一-龥-]/g, "_").slice(0, 40);
  return s || "default";
}

module.exports = { BrowserManager, SOURCE, PROFILE_MODE, sanitizeProfileName, isTrustedExecutable, ALLOWED_SOURCES, ALLOWED_ASSETS };
