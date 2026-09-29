"use strict";

/**
 * preload —— 安全地向前端暴露受限 API
 * contextIsolation 开 + nodeIntegration 关，通过 contextBridge 暴露白名单方法
 */

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // 浏览器
  detectBrowsers: () => ipcRenderer.invoke("browsers:detect"),
  selectBrowser: () => ipcRenderer.invoke("dialog:selectBrowser"),
  listSources: () => ipcRenderer.invoke("browsers:sources"),
  bundledStatus: (asset) => ipcRenderer.invoke("browsers:bundledStatus", asset),
  downloadBundled: (opts) => ipcRenderer.invoke("browsers:download", opts),
  removeBundled: (asset) => ipcRenderer.invoke("browsers:removeBundled", asset),
  onDownloadProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("browser:download", handler);
    return () => ipcRenderer.removeListener("browser:download", handler);
  },

  // 持久 profile（登录态）
  listProfiles: () => ipcRenderer.invoke("profiles:list"),
  profileStatus: (name) => ipcRenderer.invoke("profiles:status", name),
  removeProfile: (name) => ipcRenderer.invoke("profiles:remove", name),
  openLoginWindow: (opts) => ipcRenderer.invoke("profiles:openLogin", opts),
  closeLoginWindow: (name) => ipcRenderer.invoke("profiles:closeLogin", name),

  // 目录
  selectDir: () => ipcRenderer.invoke("dialog:selectDir"),
  defaultDir: () => ipcRenderer.invoke("app:defaultDir"),
  readTree: (dir) => ipcRenderer.invoke("fs:readTree", dir),

  // 抓取
  start: (opts) => ipcRenderer.invoke("capture:start", opts),
  abort: () => ipcRenderer.invoke("capture:abort"),
  shutdownBrowser: () => ipcRenderer.invoke("capture:shutdownBrowser"),
  onProgress: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on("capture:progress", handler);
    return () => ipcRenderer.removeListener("capture:progress", handler);
  },

  // 系统
  openPath: (p) => ipcRenderer.invoke("shell:openPath", p),
  showInFolder: (p) => ipcRenderer.invoke("shell:showInFolder", p),
});
