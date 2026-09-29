"use strict";

/**
 * 浏览器启动器
 *  - 自动探测 Chrome / Edge 安装路径
 *  - 以 --remote-debugging-port 启动独立 profile，避免污染用户日常浏览器
 *  - 提供 CDP HTTP 端点（/json/version、/json/list、/json/new）
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");

/** 常见浏览器安装路径（Windows 优先，兼容 macOS/Linux） */
function candidateBrowsers() {
  const plat = process.platform;
  const list = [];
  if (plat === "win32") {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] || "";
    list.push(
      { name: "Chrome", path: path.join(pf, "Google\\Chrome\\Application\\chrome.exe") },
      { name: "Chrome", path: path.join(pf86, "Google\\Chrome\\Application\\chrome.exe") },
      { name: "Chrome", path: path.join(local, "Google\\Chrome\\Application\\chrome.exe") },
      { name: "Edge", path: path.join(pf, "Microsoft\\Edge\\Application\\msedge.exe") },
      { name: "Edge", path: path.join(pf86, "Microsoft\\Edge\\Application\\msedge.exe") },
      { name: "Brave", path: path.join(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe") }
    );
  } else if (plat === "darwin") {
    list.push(
      { name: "Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { name: "Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
      { name: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
      { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" }
    );
  } else {
    list.push(
      { name: "Chrome", path: "/usr/bin/google-chrome" },
      { name: "Chrome", path: "/usr/bin/google-chrome-stable" },
      { name: "Chromium", path: "/usr/bin/chromium" },
      { name: "Chromium", path: "/usr/bin/chromium-browser" },
      { name: "Edge", path: "/usr/bin/microsoft-edge" }
    );
  }
  return list;
}

/** 返回系统中可用的浏览器列表 */
function detectBrowsers() {
  return candidateBrowsers().filter((b) => {
    try {
      return fs.existsSync(b.path);
    } catch {
      return false;
    }
  });
}

/** HTTP GET JSON 辅助 */
function getJSON(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`响应非 JSON: ${data.slice(0, 120)}`));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    req.on("error", reject);
  });
}

/** 等待调试端口就绪 */
async function waitForDevTools(port, { retries = 60, interval = 250 } = {}) {
  for (let i = 0; i < retries; i++) {
    try {
      const v = await getJSON(`http://127.0.0.1:${port}/json/version`);
      if (v && v.webSocketDebuggerUrl) return v;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`等待浏览器调试端口 ${port} 超时（请检查是否有其它程序占用该端口）`);
}

class BrowserLauncher {
  /**
   * @param {object} opts
   * @param {string} opts.executablePath 浏览器可执行文件
   * @param {number} opts.port           调试端口
   * @param {string} opts.userDataDir    独立 profile 目录（避免锁定用户主 profile）
   * @param {boolean} opts.headless      是否无头
   * @param {string[]} opts.extraArgs    额外启动参数
   */
  constructor(opts = {}) {
    this.executablePath = opts.executablePath;
    this.port = opts.port || 9222;
    this.userDataDir = opts.userDataDir || path.join(os.tmpdir(), "gsc-browser-profile");
    this.headless = !!opts.headless;
    this.extraArgs = opts.extraArgs || [];
    this.proc = null;
    this._launchedByUs = false;
  }

  /** 若端口已有浏览器在跑，直接复用 */
  async isPortAlive() {
    try {
      const v = await getJSON(`http://127.0.0.1:${this.port}/json/version`, 1500);
      return v && v.webSocketDebuggerUrl ? v : null;
    } catch {
      return null;
    }
  }

  /**
   * 启动（或复用）浏览器并返回连接信息
   * @returns {{ version: object, reused: boolean }}
   */
  async launch() {
    const alive = await this.isPortAlive();
    if (alive) {
      return { version: alive, reused: true };
    }
    if (!this.executablePath || !fs.existsSync(this.executablePath)) {
      throw new Error("未找到可用的浏览器，请手动指定浏览器路径");
    }
    fs.mkdirSync(this.userDataDir, { recursive: true });

    const args = [
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=Translate,OptimizationHints",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1440,900",
      // 反检测：不暴露 webdriver 标记（部分站点据此拦截）
      "--excludeSwitches=enable-automation",
      ...(this.headless ? ["--headless=new"] : []),
      ...this.extraArgs,
      "about:blank",
    ];

    this.proc = spawn(this.executablePath, args, {
      detached: false,
      stdio: "ignore",
      windowsHide: false,
    });
    this._launchedByUs = true;
    this.proc.on("exit", () => {
      this.proc = null;
    });

    const version = await waitForDevTools(this.port);
    return { version, reused: false };
  }

  /** 打开新标签页并返回 targetId */
  async newTab(url = "about:blank") {
    const res = await getJSON(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, 8000).catch(() => null);
    if (res && res.id) return res;
    // 回退：通过 HTTP PUT（新版 Chrome 要求）
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: this.port, path: `/json/new?${encodeURIComponent(url)}`, method: "PUT" },
        (r) => {
          let d = "";
          r.on("data", (c) => (d += c));
          r.on("end", () => {
            try {
              resolve(JSON.parse(d));
            } catch (e) {
              reject(new Error(d.slice(0, 200)));
            }
          });
        }
      );
      req.on("error", reject);
      req.end();
    });
  }

  /** 关闭浏览器（仅当由本工具启动） */
  async close() {
    if (!this._launchedByUs) return;
    // 优先优雅关闭
    try {
      await new Promise((resolve) => {
        const req = http.request(
          { host: "127.0.0.1", port: this.port, path: "/json/close", method: "PUT" },
          () => resolve()
        );
        req.on("error", () => resolve());
        req.end();
      });
    } catch {
      /* ignore */
    }
    try {
      if (this.proc && !this.proc.killed) this.proc.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}

module.exports = { BrowserLauncher, detectBrowsers, getJSON, waitForDevTools };
