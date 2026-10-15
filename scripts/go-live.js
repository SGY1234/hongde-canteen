'use strict';
/**
 * 一键对外发布：本地服务 + Cloudflare 隧道 + 自动重新生成二维码
 *
 * 为什么要这个脚本：
 *   隧道用的是 Cloudflare 免费临时通道，**每次重启地址都会变**（xxx.trycloudflare.com）。
 *   手动流程是：起服务 → 起隧道 → 从日志里抄地址 → 再手动跑 make-qr.js。
 *   这个脚本把四步合成一步，并且自动把新二维码输出到桌面。
 *
 * 用法：
 *   node scripts/go-live.js               # 正常使用（会一直运行，Ctrl+C 停止）
 *   node scripts/go-live.js --port 5180   # 换端口
 *   node scripts/go-live.js --qr-only     # 只按当前地址重新生成二维码，不起服务
 */

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const argVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };

const PORT = Number(argVal('--port')) || 5173;
const QR_ONLY = argv.includes('--qr-only');
const CF = argVal('--cloudflared') || path.resolve(ROOT, '..', 'tools', 'cloudflared.exe');
const URL_FILE = path.resolve(ROOT, '..', 'tools', 'current-url.txt');
const LOG_FILE = path.resolve(ROOT, '..', 'tools', 'tunnel.log');
const NODE = process.execPath;

/** 生成二维码（只保留关键行输出） */
function makeQr(url) {
  console.log('\n  正在生成二维码…');
  try {
    const out = execFileSync(NODE, [path.join(__dirname, 'make-qr.js'), url, '--desktop'],
      { cwd: ROOT, encoding: 'utf8' });
    out.split(/\r?\n/).filter((l) => /二维码内容|规格|已输出/.test(l)).forEach((l) => console.log('  ' + l.trim()));
  } catch (e) {
    console.log('  ⚠️ 二维码生成失败：' + e.message);
  }
}

let server = null;      // 本地服务进程
let cf = null;          // 隧道进程
let stopping = false;   // 是否正在收尾

/** 收尾：把本地服务和隧道都关掉（可重复调用） */
function shutdown() {
  if (stopping) return;
  stopping = true;
  try { if (cf) cf.kill(); } catch (e) { /* 忽略 */ }
  try { if (server) server.kill(); } catch (e) { /* 忽略 */ }
}

(async () => {
  if (QR_ONLY) {
    if (!fs.existsSync(URL_FILE)) { console.log('还没有 ' + URL_FILE + '，先正常跑一次吧。'); return; }
    const u = fs.readFileSync(URL_FILE, 'utf8').trim();
    console.log('按当前地址重新生成二维码：' + u);
    makeQr(u);
    return;
  }

  console.log('\n  ================================================');
  console.log('   鸿德食堂打分工具 · 对外发布');
  console.log('  ================================================\n');

  if (!fs.existsSync(CF)) {
    console.log('  ❌ 没找到隧道程序：' + CF);
    console.log('     它应该放在 default-workspace\\tools\\cloudflared.exe');
    process.exit(1);
  }

  // ---------- 1. 本地服务 ----------
  // 先探测端口：如果已经有一个本工具的服务在跑（例如上次关窗口没关干净），
  // 就直接复用，避免端口冲突让新进程启动失败。
  let probe = null;
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/api/stats', { signal: AbortSignal.timeout(3000) });
    if (res.ok) probe = await res.json();
  } catch (e) { /* 没有在跑，正常情况 */ }

  if (probe) {
    console.log('  [1/3] 端口 ' + PORT + ' 已有服务在跑，直接复用（不重复启动）');
    console.log('        数据源：' + probe.dataSource);
  } else {
    console.log('  [1/3] 启动本地服务（端口 ' + PORT + '）…');
    server = spawn(NODE, [path.join(ROOT, 'server', 'local.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(PORT) }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let serverLog = '';
    let saidSrc = false;
    server.stdout.on('data', (d) => {
      serverLog += d.toString();
      const m = serverLog.match(/数据源：(.+)/);
      if (m && !saidSrc) { saidSrc = true; console.log('        数据源：' + m[1].trim()); }
    });
    server.stderr.on('data', (d) => { serverLog += d.toString(); });
    server.on('exit', (code) => {
      if (!stopping) {
        console.log('\n  ⚠️ 本地服务退出了（code ' + code + '）');
        if (serverLog.trim()) {
          console.log('     服务日志：\n' + serverLog.trim().split(/\r?\n/).slice(-8).map((l) => '       ' + l).join('\n'));
        }
        shutdown();
        process.exit(1);
      }
    });
  }

  let ready = !!probe;
  for (let i = 0; i < 30 && !ready; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/api/stats');
      if (res.ok) { ready = true; break; }
    } catch (e) { /* 还没起来，继续等 */ }
  }
  if (!ready) { console.log('  ❌ 本地服务 15 秒内没起来。'); shutdown(); process.exit(1); }
  console.log('        本地服务已就绪 ✅');

  // ---------- 2. 隧道 ----------
  console.log('\n  [2/3] 建立公网隧道（约 5~20 秒）…');
  try { if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE); } catch (e) { /* 忽略 */ }
  cf = spawn(CF, ['tunnel', '--no-autoupdate', '--logfile', LOG_FILE, '--url', 'http://localhost:' + PORT],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  cf.stderr.on('data', () => { /* cloudflared 写日志文件，这里忽略 */ });

  let url = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const log = fs.readFileSync(LOG_FILE, 'utf8');
      const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { url = m[0]; break; }
    } catch (e) { /* 日志还没生成 */ }
    if (cf.exitCode !== null) { console.log('  ❌ 隧道进程退出了，看日志：' + LOG_FILE); shutdown(); process.exit(1); }
  }
  if (!url) { console.log('  ❌ 60 秒内没拿到公网地址，看日志：' + LOG_FILE); shutdown(); process.exit(1); }

  try { fs.writeFileSync(URL_FILE, url + '\n'); } catch (e) { /* 忽略 */ }

  // ---------- 3. 验证 + 二维码 ----------
  console.log('  [3/3] 验证公网访问…');
  try {
    const res = await fetch(url + '/api/stats', { signal: AbortSignal.timeout(30000) });
    const j = await res.json();
    console.log('        HTTP ' + res.status + ' · 数据源：' + j.dataSource + ' · 已有打分：' + j.totalVotes + ' 票 ✅');
  } catch (e) {
    console.log('        ⚠️ 公网自检没通过（可能还在生效中）：' + e.message);
  }

  console.log('\n  ┌────────────────────────────────────────────────────────┐');
  console.log('  │  网站地址（发给同学的链接）：');
  console.log('  │  ' + url);
  console.log('  └────────────────────────────────────────────────────────┘');

  makeQr(url);

  console.log('\n  ✅ 已上线。二维码在桌面（鸿德食堂打分-二维码.html），可转发到班群。');
  console.log('  ⚠️ 这个窗口要一直开着；按 Ctrl+C 下线（分数不会丢，都在飞书表里）。\n');

  process.on('SIGINT', () => { console.log('\n  正在关闭…'); shutdown(); setTimeout(() => process.exit(0), 600); });
  process.on('exit', shutdown);
})().catch((e) => { console.error('出错：' + e.message); shutdown(); process.exit(1); });
