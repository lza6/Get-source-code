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
