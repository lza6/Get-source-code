"use strict";

/* 渲染层：与主进程通过 window.api 通信 */

const $ = (id) => document.getElementById(id);

const state = {
  running: false,
  lastDir: null,
  savedFiles: [],
  stats: { saved: 0, bytes: 0, skipped: 0, failed: 0 },
  browsers: [],
  browserPath: null,
};

/* ---------------- 初始化 ---------------- */
async function init() {
  // 默认目录
  try {
    const d = await window.api.defaultDir();
    if (d) $("outDir").value = "";
  } catch { /* ignore */ }

  // 检测浏览器
  await loadBrowsers();

  // 事件绑定
  $("btnPickDir").onclick = pickDir;
  $("btnPickBrowser").onclick = pickBrowser;
  $("btnStart").onclick = start;
  $("btnAbort").onclick = abort;
  $("btnOpenDir").onclick = () => state.lastDir && window.api.openPath(state.lastDir);
  $("btnCloseBrowser").onclick = closeBrowser;
  $("btnHelp").onclick = () => $("helpModal").classList.add("open");
  $("btnCloseHelp").onclick = () => $("helpModal").classList.remove("open");
  $("helpModal").onclick = (e) => {
    if (e.target === $("helpModal")) $("helpModal").classList.remove("open");
  };

  // tabs
  document.querySelectorAll(".tab").forEach((t) => {
    t.onclick = () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      document.querySelectorAll(".tabpane").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      document.querySelector(`.tabpane[data-pane="${t.dataset.tab}"]`).classList.add("active");
    };
  });

  // 进度回调
  window.api.onProgress(handleProgress);

  // 回车即开始
  $("url").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !state.running) start();
  });

  log("info", "GetSourceCode 已就绪。填写目标网址与保存目录后点击「开始抓取」。");
}

async function loadBrowsers() {
  const sel = $("browserSelect");
  sel.innerHTML = "";
  try {
    state.browsers = await window.api.detectBrowsers();
  } catch {
    state.browsers = [];
  }
  if (!state.browsers.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "未检测到浏览器（请手动选择）";
    sel.appendChild(opt);
    setBrowserBadge("未检测到浏览器", false);
    return;
  }
  state.browsers.forEach((b, i) => {
    const opt = document.createElement("option");
    opt.value = b.path;
    opt.textContent = `${b.name} — ${shortPath(b.path)}`;
    sel.appendChild(opt);
    if (i === 0) state.browserPath = b.path;
  });
  sel.onchange = () => { state.browserPath = sel.value; };
  setBrowserBadge(state.browsers[0].name, true);
}

function setBrowserBadge(text, ok) {
  const b = $("browserBadge");
  b.textContent = text;
  b.className = "badge " + (ok ? "ok" : "err");
}

function shortPath(p) {
  if (!p) return "";
  const parts = p.split(/[\\/]/);
  return parts.length > 3 ? "...\\" + parts.slice(-2).join("\\") : p;
}

/* ---------------- 操作 ---------------- */
async function pickDir() {
  const d = await window.api.selectDir();
  if (d) $("outDir").value = d;
}

async function pickBrowser() {
  const p = await window.api.selectBrowser();
  if (p) {
    state.browserPath = p;
    const sel = $("browserSelect");
    const opt = document.createElement("option");
    opt.value = p;
    opt.textContent = `自定义 — ${shortPath(p)}`;
    opt.selected = true;
    sel.appendChild(opt);
    setBrowserBadge("自定义", true);
  }
}

function normalizeUrl(raw) {
  let u = (raw || "").trim();
  if (!u) return "";
  if (!/^https?:\/\//i.test(u)) u = "https://" + u;
  return u;
}

async function start() {
  if (state.running) return;
  const url = normalizeUrl($("url").value);
  const outDir = $("outDir").value.trim();
  if (!url) return setStatus("请填写目标网址", false);
  if (!outDir) return setStatus("请选择保存目录", false);
  if (!state.browserPath) return setStatus("未选择浏览器", false);

  // 重置
  state.running = true;
  state.savedFiles = [];
  state.stats = { saved: 0, bytes: 0, skipped: 0, failed: 0 };
  $("fileRows").innerHTML = "";
  $("tree").textContent = "抓取中…";
  $("log").innerHTML = "";
  updateStats();
  toggleRunning(true);
  setStatus("抓取中…", null);

  const opts = {
    targetUrl: url,
    outputDir: outDir,
    executablePath: state.browserPath,
    headless: $("headless").checked,
    saveSource: $("saveSource").checked,
    saveHar: $("saveHar").checked,
    saveHtml: $("saveHtml").checked,
    saveMedia: $("saveMedia").checked,
    scrollRounds: clampInt($("scrollRounds").value, 0, 50),
    extraWait: clampInt($("extraWait").value, 0, 120) * 1000,
    timeout: clampInt($("timeout").value, 5, 600) * 1000,
    maxResourceSize: clampInt($("maxFileMB").value, 1, 2048) * 1024 * 1024,
  };

  const res = await window.api.start(opts);
  state.running = false;
  toggleRunning(false);

  if (res.ok) {
    state.lastDir = res.outputDir;
    $("btnOpenDir").disabled = false;
    $("btnCloseBrowser").disabled = false;
    setStatus(`完成：保存 ${state.stats.saved} 个文件`, true);
    log("done", `✔ 抓取完成 → ${res.outputDir}`);
    await loadTree(res.outputDir);
    // 切到文件页
    document.querySelector('.tab[data-tab="files"]').click();
  } else {
    setStatus(`失败：${res.error}`, false);
    log("err", `✘ ${res.error}`);
  }
}

async function abort() {
  await window.api.abort();
  log("skip", "已请求停止…");
  setStatus("正在停止…", null);
}

async function closeBrowser() {
  await window.api.shutdownBrowser();
  $("btnCloseBrowser").disabled = true;
  log("info", "已关闭浏览器实例。");
}

function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function toggleRunning(run) {
  $("btnStart").disabled = run;
  $("btnAbort").disabled = !run;
  $("url").disabled = run;
  $("btnPickDir").disabled = run;
  $("browserSelect").disabled = run;
}

/* ---------------- 进度处理 ---------------- */
function handleProgress(p) {
  switch (p.type) {
    case "status":
      log("status", "» " + p.message);
      setStatus(p.message, null);
      break;
    case "file": {
      if (p.kind === "metadata") { log("info", `» 写入清单 ${p.path}`); break; }
      if (p.kind === "har") { log("info", `» 写入 HAR ${p.path}`); state.stats.saved++; updateStats(); addFileRow("har", "network.har", "-", "HAR 1.2 网络数据包"); break; }
      if (p.kind === "html") { log("file", `✔ [html] page.html (${fmtBytes(p.size)})`); addFileRow("html", "page.html", p.size, "渲染后 DOM"); break; }
      state.stats.saved++;
      state.stats.bytes += p.size || 0;
      updateStats();
      const rel = p.path ? p.path.replace(/\\/g, "/").split("/").slice(-3).join("/") : "";
      log("file", `✔ [${p.kind}] ${rel} (${fmtBytes(p.size)})`);
      addFileRow(p.kind, rel, p.size, p.url || "");
      break;
    }
    case "skip":
      state.stats.skipped++;
      updateStats();
      log("skip", `∅ 跳过 ${trunc(p.url || "", 70)} — ${p.reason}`);
      break;
    case "done":
      break;
    case "error":
      log("err", "✘ " + p.message);
      break;
    default:
      break;
  }
}

function updateStats() {
  $("statSaved").textContent = state.stats.saved;
  $("statBytes").textContent = fmtBytes(state.stats.bytes);
  $("statSkip").textContent = state.stats.skipped;
  $("statFail").textContent = state.stats.failed;
}

function addFileRow(kind, file, size, url) {
  const tr = document.createElement("tr");
  const kClass = ["source", "media", "html", "har"].includes(kind) ? kind : "";
  tr.innerHTML =
    `<td class="k ${kClass}">${escapeHtml(kind)}</td>` +
    `<td class="path">${escapeHtml(file)}</td>` +
    `<td class="size">${typeof size === "number" ? fmtBytes(size) : escapeHtml(String(size))}</td>` +
    `<td class="url">${escapeHtml(trunc(url, 120))}</td>`;
  const tbody = $("fileRows");
  tbody.appendChild(tr);
  if (tbody.childElementCount > 3000) tbody.removeChild(tbody.firstChild);
  // 自动滚动到底
  const wrap = tbody.closest(".tablewrap");
  if (wrap) wrap.scrollTop = wrap.scrollHeight;
}

/* ---------------- 日志 ---------------- */
function log(level, msg) {
  const el = $("log");
  const line = document.createElement("div");
  line.className = "l-" + level;
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  line.textContent = `[${t}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
  if (el.childElementCount > 5000) el.removeChild(el.firstChild);
}

function setStatus(text, ok) {
  const el = $("statusText");
  el.textContent = text;
  el.className = "status" + (ok === true ? " ok" : ok === false ? " err" : "");
}

/* ---------------- 目录树 ---------------- */
async function loadTree(dir) {
  const res = await window.api.readTree(dir);
  if (!res.ok) { $("tree").textContent = "读取目录失败：" + res.error; return; }
  $("tree").innerHTML = renderTree(res.tree, 0);
}

function renderTree(node, depth) {
  if (!node) return "";
  const pad = "  ".repeat(depth);
  if (node.type === "file") {
    return `<div class="file">${pad}${escapeHtml(node.name)} <span style="color:var(--text-dim2)">${fmtBytes(node.size)}</span></div>`;
  }
  let html = `<div class="dir">${pad}${depth === 0 ? "" : "▸ "}${escapeHtml(node.name)}/</div>`;
  const children = node.children || [];
  const max = 200;
  children.slice(0, max).forEach((c) => { html += renderTree(c, depth + 1); });
  if (children.length > max) html += `<div class="file">${pad}  … 还有 ${children.length - max} 项</div>`;
  return html;
}

/* ---------------- 工具 ---------------- */
function fmtBytes(n) {
  if (!n || n < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + " " + u[i];
}
function trunc(s, n) { return s && s.length > n ? s.slice(0, n - 1) + "…" : s || ""; }
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

init();
