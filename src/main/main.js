"use strict";

/**
 * Electron 主进程
 *  - 创建窗口，加载渲染层 UI
 *  - 通过 IPC 暴露：浏览器检测、目录选择、启动抓取、进度推送、取消
 */

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { CaptureEngine } = require("../core/capture-engine");
const { detectBrowsers } = require("../core/browser-launcher");

let mainWindow = null;
let currentEngine = null;

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
  if (process.platform !== "darwin") app.quit();
});

/* ---------------- IPC ---------------- */

/** 检测可用浏览器 */
ipcMain.handle("browsers:detect", () => {
  const list = detectBrowsers();
  return list.map((b) => ({ name: b.name, path: b.path }));
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

  const engine = new CaptureEngine({
    ...opts,
    onProgress: (p) => send(p),
  });
  currentEngine = engine;

  try {
    const result = await engine.run();
    return { ok: true, ...result };
  } catch (err) {
    send({ type: "error", message: err.message });
    return { ok: false, error: err.message };
  } finally {
    await engine.cleanup().catch(() => {});
    currentEngine = null;
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
