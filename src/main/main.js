"use strict";

/**
 * Electron 主进程
 *  - 创建窗口，加载渲染层 UI
 *  - 通过 IPC 暴露：浏览器检测、目录选择、启动抓取、进度推送、取消
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { CaptureEngine } = require("../core/capture-engine");
const { detectBrowsers } = require("../core/browser-launcher");
const { BrowserManager } = require("../core/browser-manager");
const { ChromiumDownloader } = require("../core/chromium-downloader");

let mainWindow = null;
let currentEngine = null;
let browserManager = null;
const loginLaunchers = new Map();  // profileName -> BrowserLauncher（登录窗口）

/** 惰性初始化 BrowserManager（需要 app ready） */
function getBrowserManager() {
  if (!browserManager) {
    browserManager = new BrowserManager({ userDataDir: app.getPath("userData") });
  }
  return browserManager;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: "#0d1117",
    title: "GetSourceCode — 一键获取网站源代码",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (currentEngine) {
    currentEngine.abort();
    currentEngine.shutdown().catch(() => {});
  }
  for (const launcher of loginLaunchers.values()) {
    launcher.close().catch(() => {});
  }
  if (process.platform !== "darwin") app.quit();
});

/** 退出前清理：防止浏览器孤儿进程 */
app.on("before-quit", () => {
  try {
    if (currentEngine) currentEngine.abort();
  } catch { /* ignore */ }
  for (const launcher of loginLaunchers.values()) {
    try { launcher.close(); } catch { /* ignore */ }
  }
});

/* ---------------- IPC ---------------- */

/** 检测可用浏览器 */
ipcMain.handle("browsers:detect", () => {
  const list = detectBrowsers();
  return list.map((b) => ({ name: b.name, path: b.path }));
});

/** 列出所有浏览器来源（系统 + 内置状态） */
ipcMain.handle("browsers:sources", () => {
  try {
    return { ok: true, ...getBrowserManager().listSources() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** 内置浏览器状态 */
ipcMain.handle("browsers:bundledStatus", (_e, asset) => {
  try {
    const dl = new ChromiumDownloader({ baseDir: getBrowserManager().browserDir, asset: asset || "chrome" });
    return { ok: true, ...dl.status() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** 下载内置浏览器（带进度推送） */
ipcMain.handle("browsers:download", async (event, opts) => {
  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("browser:download", payload);
  };
  try {
    const dl = new ChromiumDownloader({
      baseDir: getBrowserManager().browserDir,
      asset: (opts && opts.asset) || "chrome",
      preferMirror: !(opts && opts.preferMirror === false),
      onProgress: (p) => send(p),
    });
    const r = await dl.ensure();
    return { ok: true, exe: r.exe, version: r.version };
  } catch (e) {
    send({ phase: "error", message: e.message });
    return { ok: false, error: e.message };
  }
});

/** 删除内置浏览器 */
ipcMain.handle("browsers:removeBundled", (_e, asset) => {
  try {
    const dl = new ChromiumDownloader({ baseDir: getBrowserManager().browserDir, asset: asset || "chrome" });
    return { ok: dl.remove() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** 持久 profile 列表 */
ipcMain.handle("profiles:list", () => {
  try {
    return { ok: true, profiles: getBrowserManager().listProfiles() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** 持久 profile 状态 */
ipcMain.handle("profiles:status", (_e, name) => {
  try {
    return { ok: true, ...getBrowserManager().profileStatus(name) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** 删除持久 profile */
ipcMain.handle("profiles:remove", (_e, name) => {
  try {
    return { ok: getBrowserManager().removeProfile(name) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/**
 * 打开「登录窗口」：用指定 profile 启动可见浏览器，让用户登录一次
 * 返回后 cookie 持久化在该 profile，之后抓取可带登录态
 */
ipcMain.handle("profiles:openLogin", async (_e, opts) => {
  try {
    const bm = getBrowserManager();
    const { profileName, url, source, executablePath, asset } = opts || {};
    const browser = await bm.resolveBrowser({ source: source || "system", executablePath, asset });
    const profile = bm.resolveProfile({ profileMode: "persistent", profileName });

    const { BrowserLauncher } = require("../core/browser-launcher");
    const launcher = new BrowserLauncher({
      executablePath: browser.exe,
      port: (opts && opts.port) || 9444,
      headless: false, // 登录必须可见
      userDataDir: profile.dir,
    });
    await launcher.launch();
    // 在新标签打开目标站点，供用户登录
    if (url) {
      try { await launcher.newTab(url); } catch { /* ignore */ }
    }
    loginLaunchers.set(profileName || "default", launcher);
    return { ok: true, profileDir: profile.dir, browser: browser.exe, port: launcher.port };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

/** 关闭登录窗口 */
ipcMain.handle("profiles:closeLogin", async (_e, name) => {
  const key = name || "default";
  const launcher = loginLaunchers.get(key);
  if (launcher) {
    await launcher.close().catch(() => {});
    loginLaunchers.delete(key);
    return { ok: true };
  }
  return { ok: false, error: "未找到登录窗口" };
});

/** 选择保存目录 */
ipcMain.handle("dialog:selectDir", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "选择保存目录",
    properties: ["openDirectory", "createDirectory"],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

/** 选择浏览器可执行文件 */
ipcMain.handle("dialog:selectBrowser", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: "选择浏览器可执行文件",
    filters: [{ name: "可执行文件", extensions: ["exe", ""] }],
    properties: ["openFile"],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

/** 用系统默认程序打开文件/目录 */
ipcMain.handle("shell:openPath", async (_e, p) => {
  if (!p) return false;
  try {
    await shell.openPath(p);
    return true;
  } catch {
    return false;
  }
});

/** 在文件管理器中显示 */
ipcMain.handle("shell:showInFolder", (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
  return true;
});

/** 默认保存目录 */
ipcMain.handle("app:defaultDir", () => {
  return app.getPath("downloads");
});

/** 启动抓取 */
ipcMain.handle("capture:start", async (event, opts) => {
  if (currentEngine) {
    return { ok: false, error: "已有抓取任务在运行" };
  }
  const send = (payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("capture:progress", payload);
    }
  };

  const bm = getBrowserManager();
  let profile = null;
  try {
    // 1) 解析浏览器（可能触发内置浏览器下载）
    const browser = await bm.resolveBrowser({
      source: opts.source || "system",
      executablePath: opts.executablePath,
      asset: opts.asset,
      preferMirror: opts.preferMirror,
      onProgress: (p) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("browser:download", p);
      },
    });

    // 2) 解析 profile
    profile = bm.resolveProfile({
      profileMode: opts.profileMode || "ephemeral",
      profileName: opts.profileName,
    });

    if (opts.onBrowserResolved) opts.onBrowserResolved(browser);

    const engine = new CaptureEngine({
      ...opts,
      executablePath: browser.exe,
      userDataDir: profile.dir,
      onProgress: (p) => send(p),
    });
    // 记录临时 profile，供 shutdown 清理
    if (profile.ephemeral) {
      engine._ephemeralProfile = profile.dir;
      engine._ownsProfile = true;
    }
    currentEngine = engine;

    try {
      const result = await engine.run();
      return { ok: true, ...result, browser: { source: browser.source, version: browser.version } };
    } finally {
      await engine.cleanup().catch(() => {});
      currentEngine = null;
      // 临时 profile 清理
      if (profile && profile.ephemeral) {
        bm.cleanupEphemeral(profile.dir);
      }
    }
  } catch (err) {
    send({ type: "error", message: err.message });
    if (profile && profile.ephemeral) bm.cleanupEphemeral(profile.dir);
    currentEngine = null;
    return { ok: false, error: err.message };
  }
});

/** 取消抓取 */
ipcMain.handle("capture:abort", async () => {
  if (currentEngine) {
    currentEngine.abort();
    return { ok: true };
  }
  return { ok: false, error: "没有正在运行的任务" };
});

/** 关闭浏览器（抓取结束后由用户决定） */
ipcMain.handle("capture:shutdownBrowser", async () => {
  if (currentEngine) {
    await currentEngine.shutdown().catch(() => {});
    return { ok: true };
  }
  return { ok: false };
});

/** 读取目录树（用于结果展示） */
ipcMain.handle("fs:readTree", async (_e, dir) => {
  try {
    return { ok: true, tree: readDirTree(dir, 0, 4) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function readDirTree(dir, depth, maxDepth) {
  if (depth > maxDepth) return null;
  const name = path.basename(dir) || dir;
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) {
    return { name, type: "file", size: stat.size };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { name, type: "dir", children: [] };
  }
  const children = [];
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const child = readDirTree(path.join(dir, e.name), depth + 1, maxDepth);
    if (child) children.push(child);
    if (children.length >= 500) break; // 防止超大目录卡顿
  }
  children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { name, type: "dir", children };
}
