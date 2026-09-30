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

  /**
   * 测试注入通道：把一组进度事件直接喂给渲染层，用于验证 UI 反馈链路。
   *
   * 为什么需要：CF 状态反馈此前因事件名被 payload.type 覆盖而完全失效，
   * 但没有任何测试覆盖「主进程事件 → UI 渲染」这一段。此通道让
   * test/e2e-ui.js 能真实驱动渲染层，而不必依赖触发真实 CF 挑战。
   * 只接收事件对象，不做任何特权操作，不扩大攻击面。
   */
  __testDispatch: (events) => {
    if (!Array.isArray(events)) return;
    for (const e of events) {
      ipcRenderer.emit("capture:progress", null, e);
    }
  },
});
