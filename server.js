#!/usr/bin/env node
/* ============================================================================
 * 学习积分平台 · 云同步服务端（Node 零依赖，无需 npm install）
 * ----------------------------------------------------------------------------
 * 功能：
 *  1. 托管页面：public/ 下的静态文件（默认 index.html），
 *     手机/iPad 访问 http://<服务器IP>:8080 即可打开平台；
 *  2. 数据备份 API：按孩子名字分文件存到 data/，浏览器清空也能找回；
 *  3. 每日首次写入前自动快照到 data/.history/（保留 30 天），可回滚防误删。
 *
 * 运行：  node server.js           （默认端口 8080）
 * 环境变量：PORT=9000 node server.js   改端口
 *          DATA_DIR=/srv/sd node server.js   改数据目录
 *
 * 数据文件：data/<孩子名字>.json     —— 定期备份这个目录即可。
 * ========================================================================== */
const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, "data"));
const HISTORY_DIR = path.join(DATA_DIR, ".history");
const HISTORY_KEEP_DAYS = 30;
const MAX_BODY = 5 * 1024 * 1024;         // 单次保存最大 5MB

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".txt":  "text/plain; charset=utf-8",
  ".csv":  "text/csv; charset=utf-8"
};

/* ---------- 工具 ---------- */
async function ensureDirs(){
  await fsp.mkdir(PUBLIC_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(HISTORY_DIR, { recursive: true });
}
function safeName(raw){
  let n = String(raw || "").trim();
  if(!n) return "kid";
  /* 去掉不能当文件名的字符，防止目录穿越 */
  n = n.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  return n || "kid";
}
function fileOf(name){ return path.join(DATA_DIR, safeName(name) + ".json"); }
function todayStr(){
  const d = new Date();
  const p = x => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}
/* 每日首次保存前，把“旧文件”快照进 .history，用作当天回滚点 */
async function snapshotIfNeeded(name, file){
  try{
    const before = await fsp.readFile(file, "utf8");
    const hFile = path.join(HISTORY_DIR, safeName(name) + "-" + todayStr() + ".json");
    try{ await fsp.access(hFile); return; }catch(e){ /* 今天还没有快照 */ }
    await fsp.writeFile(hFile, before, "utf8");
    await pruneHistory();
  }catch(e){ /* 首次保存没有旧档，忽略 */ }
}
async function pruneHistory(){
  try{
    const cutoff = Date.now() - HISTORY_KEEP_DAYS * 86400000;
    const files = await fsp.readdir(HISTORY_DIR);
    for(const f of files){
      const p = path.join(HISTORY_DIR, f);
      try{
        const st = await fsp.stat(p);
        if(st.mtimeMs < cutoff) await fsp.unlink(p);
      }catch(e){}
    }
  }catch(e){}
}
function sendJson(res, code, obj){
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}
function readBody(req){
  return new Promise((resolve, reject)=>{
    let size = 0; const chunks = [];
    req.on("data", c=>{
      size += c.length;
      if(size > MAX_BODY){ reject(new Error("too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", ()=>resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/* ---------- API ---------- */
async function apiGet(res, name){
  const file = fileOf(name);
  try{
    const st = await fsp.stat(file);
    const state = JSON.parse(await fsp.readFile(file, "utf8"));
    sendJson(res, 200, { state, updatedAt: st.mtimeMs });
  }catch(e){ sendJson(res, 404, { error: "not found" }); }
}
async function apiPut(req, res, name){
  let body;
  try{ body = await readBody(req); }catch(e){ return sendJson(res, 413, { error: "body too large" }); }
  let s;
  try{ s = JSON.parse(body); }catch(e){ return sendJson(res, 400, { error: "bad json" }); }
  if(typeof s.points !== "number") return sendJson(res, 400, { error: "missing points" });
  const file = fileOf(name);
  try{
    await snapshotIfNeeded(name, file);            /* 当天首次：把旧档存进 .history */
    /* 原子写入：先写临时文件再改名，避免写到一半崩溃损坏数据 */
    const tmp = file + "." + process.pid + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(s), "utf8");
    await fsp.rename(tmp, file);
    const now = Date.now();
    sendJson(res, 200, { ok: true, updatedAt: now });
    console.log("[" + new Date().toISOString() + "] PUT  " + name + "  (" +
      (s.ledger || []).length + " 条账本 / " + s.points + " 阳光)");
  }catch(e){ sendJson(res, 500, { error: String(e && e.message || e) }); }
}
async function apiDelete(res, name){
  const file = fileOf(name);
  try{
    await fsp.unlink(file);
    console.log("[" + new Date().toISOString() + "] DELETE  " + name);
    sendJson(res, 200, { ok: true });
  }catch(e){ sendJson(res, 404, { error: "not found" }); }
}

/* ---------- 静态页面 ---------- */
async function serveStatic(req, res, pathname){
  if(pathname === "/") pathname = "/index.html";
  let p = path.normalize(path.join(PUBLIC_DIR, pathname));
  if(!p.startsWith(PUBLIC_DIR)){ res.writeHead(403); return res.end("forbidden"); }
  try{
    let st = await fsp.stat(p);
    if(st.isDirectory()){
      p = path.join(p, "index.html"); st = await fsp.stat(p);
    }
    const ext = path.extname(p).toLowerCase();
    const body = await fsp.readFile(p);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": "no-cache"
    });
    res.end(body);
  }catch(e){
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("404 Not Found\n（请确认 public/index.html 存在）");
  }
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res)=>{
  try{
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if(req.method === "OPTIONS"){            /* 允许跨域（手动配 SERVER 的场景） */
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,PUT,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      return res.end();
    }
    if(p === "/api/ping"){           /* 前端用它自动识别“自建服务器”云模式 */
      if(req.method === "GET") return sendJson(res, 200, { ok: true });
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if(p === "/api/state"){
      const name = u.searchParams.get("name") || "";
      if(!name) return sendJson(res, 400, { error: "missing name" });
      if(req.method === "GET")    return apiGet(res, name);
      if(req.method === "PUT")    return apiPut(req, res, name);
      if(req.method === "DELETE") return apiDelete(res, name);
      return sendJson(res, 405, { error: "method not allowed" });
    }
    if(p.startsWith("/api/")) return sendJson(res, 404, { error: "unknown api" });
    if(req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, p);
    res.writeHead(405); res.end();
  }catch(e){
    try{ sendJson(res, 500, { error: "server error" }); }catch(_){}
  }
});

ensureDirs().then(()=>{
  server.listen(PORT, "0.0.0.0", ()=>{
    console.log("============================================================");
    console.log("  学习积分平台 · 云同步服务端已启动");
    console.log("  本机访问:   http://localhost:" + PORT);
    console.log("  iPad/手机:  http://<这台电脑的局域网IP>:" + PORT);
    console.log("  数据目录:   " + DATA_DIR);
    console.log("  （每个孩子一个 JSON 文件，浏览器清空数据也能从这里找回）");
    console.log("============================================================");
  });
}).catch(e=>{ console.error("启动失败:", e); process.exit(1); });
