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
const dns = require('dns');
const readline = require('readline');
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

// 输出目录：一律走 lib/desktop-dir.js 统一解析（禁止在这里写死桌面根目录）
// 背景：2026-10-19 这里原本是 `process.env.HD_DESKTOP_DIR || 'D:\\Users\\30205\\Desktop'`，
// 默认值直接落到桌面根目录，把二维码和进度预览页撒了一桌面 —— 同一个错第三次犯。
const { resolveOutDir } = require('../lib/desktop-dir');
const DESKTOP_DIR = resolveOutDir() || path.resolve(ROOT, 'qr');

/** 生成二维码（只保留关键行输出） */
function makeQr(url) {
  console.log('\n  正在生成二维码…');
  try {
    const out = execFileSync(NODE, [path.join(__dirname, 'make-qr.js'), url, '--desktop'],
      { cwd: ROOT, encoding: 'utf8', env: Object.assign({}, process.env, { HD_DESKTOP_DIR: DESKTOP_DIR }) });
    out.split(/\r?\n/).filter((l) => /二维码内容|规格|已输出/.test(l)).forEach((l) => console.log('  ' + l.trim()));
  } catch (e) {
    console.log('  ⚠️ 二维码生成失败：' + e.message);
  }
}

/** 生成"打分进度实时预览"页（顺手刷新，让用户随时看到票数进度） */
function makeStatus(url, online, actualPort) {
  // 本机访问不到公网地址时，退回用本地端口取数据，保证预览页照样能生成
  const port = actualPort || PORT;
  const target = online === false ? ('http://127.0.0.1:' + port) : url;
  try {
    const out = execFileSync(NODE, [path.join(__dirname, 'make-status.js'), target],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: Object.assign({}, process.env, { HD_DESKTOP_DIR: DESKTOP_DIR, PORT: String(port) })
      });
    out.split(/\r?\n/).filter((l) => /累计票数|已进榜|✅ /.test(l)).forEach((l) => console.log('  ' + l.trim()));
    if (online === false) console.log('  （数据取自本机，页面上的网址仍是公网地址）');
  } catch (e) {
    console.log('  ⚠️ 进度预览生成失败：' + String(e.message).split('\n')[0]);
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

  // ---------- 0. 已经在线？ ----------
  // 如果上次发布的地址还活着，就不要又开一条新隧道（否则会冒出两个地址，容易搞混）。
  // 默认复用，只把二维码按当前地址重新生成一遍。
  let liveUrl = null;
  try {
    const prev = fs.readFileSync(URL_FILE, 'utf8').trim();
    if (/^https:\/\//.test(prev)) {
      const res = await fetch(prev + '/api/stats', { signal: AbortSignal.timeout(12000) });
      if (res.ok) liveUrl = prev;
    }
  } catch (e) { /* 没在线，正常继续 */ }

  if (liveUrl) {
    console.log('  ℹ️  检测到网站**已经在线**了：');
    console.log('      ' + liveUrl + '\n');
    console.log('  继续会把二维码按这个地址重新生成一遍（不会换地址）。');
    console.log('  如果你想换一个新地址，请输入 n 再回车。\n');
    const ans = await new Promise((resolve) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      let done = false;
      const finish = (v) => { if (!done) { done = true; try { rl.close(); } catch (e) { /* 忽略 */ } resolve(v); } };
      rl.question('  直接回车 = 重新生成二维码；输入 n = 换新地址：', (a) => finish((a || '').trim().toLowerCase()));
      setTimeout(() => finish(''), 30000);   // 30 秒没人理就默认重新生成二维码
    });
    if (ans !== 'n') {
      makeQr(liveUrl);
      console.log('\n  顺便刷新一下进度预览…');
      makeStatus(liveUrl);
      console.log('\n  ✅ 二维码和进度预览都已更新（桌面上的文件是新的）。');
      console.log('  ⚠️ 网站还是原来那个地址，之前发出去的链接继续有效。\n');
      return;
    }
    console.log('\n  好，那就开一条新的隧道（旧地址会在稍后失效）。\n');
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
    // ⚠️ 对外发布时**永远不允许出现演示数据**。
    // 2026-10-19 踩过：手动设了 HD_FORCE_LOCAL=1 启动，结果 loadEnvFiles() 直接返回 null，
    // FEISHU_CONFIGURED_AT_BOOT 变成 false，系统误判成"开发环境"，把 599 票演示数据
    // 当成真实榜单显示给了同学。这里强制打开 HD_NO_DEMO，堵死这条路。
    server = spawn(NODE, [path.join(ROOT, 'server', 'local.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: String(PORT), HD_NO_DEMO: '1' }),
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
  // 教训（真踩过）：**不要用本机 DNS 去判断隧道地址是否可用**。
  // 这台机器的 DNS 解析器看不到 *.trycloudflare.com 子域，但阿里/腾讯/Google 公共 DNS 都能解析，
  // 结果"检查"把好地址判成坏地址，脚本卡在同一个地址上空转 3 次后放弃 —— 明明隧道是好的。
  // 正确做法：起隧道 → 拿到地址 → 直接用 HTTP 请求验证（本机不通也先当成可用，让用户手机去证实）。
  console.log('\n  [2/3] 建立公网隧道（约 20~40 秒，窗口先别关）…');

  let url = null;
  let verified = false;      // 本机是否验证通过（本机不通不代表同学打不开）
  for (let attempt = 1; attempt <= 3 && !url; attempt++) {
    if (attempt > 1) console.log('        重新建隧道（第 ' + attempt + ' 次）…');
    try { if (fs.existsSync(LOG_FILE)) fs.unlinkSync(LOG_FILE); } catch (e) { /* 忽略 */ }
    try { if (cf) cf.kill(); } catch (e) { /* 忽略 */ }
    cf = spawn(CF, ['tunnel', '--no-autoupdate', '--logfile', LOG_FILE, '--url', 'http://localhost:' + PORT],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    cf.stderr.on('data', () => { /* cloudflared 写日志文件，这里忽略 */ });

    let got = null;
    for (let i = 0; i < 50 && !got; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const log = fs.readFileSync(LOG_FILE, 'utf8');
        const m = log.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
        if (m) got = m[0];
      } catch (e) { /* 日志还没生成 */ }
      if (cf.exitCode !== null) break;
    }
    if (!got) { console.log('        ⚠️ 这次没拿到地址，重试…'); continue; }

    // 用 HTTP 请求判断地址是否真的活着（最多等 24 秒）
    for (let i = 0; i < 8 && !verified; i++) {
      try {
        const res = await fetch(got + '/api/stats', { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const j = await res.json();
          verified = true;
          console.log('        公网已可用 ✅  数据源：' + j.dataSource + ' · 已有打分：' + j.totalVotes + ' 票');
        }
      } catch (e) { /* 还没生效，继续等 */ }
      if (!verified) await new Promise((r) => setTimeout(r, 3000));
    }
    url = got;                 // 只要拿到了地址就先采用；本机不通也让用户手机去试
    if (!verified) console.log('        公网地址已生成：' + url + '（本机暂未验证通，同学手机一般可以打开）');
  }
  if (!url) {
    console.log('\n  ❌ 没能拿到公网地址。');
    console.log('     这通常是网络或 Cloudflare 侧临时问题，过几分钟重新双击一次通常就好了。');
    shutdown();
    process.exit(1);
  }

  try { fs.writeFileSync(URL_FILE, url + '\n'); } catch (e) { /* 忽略 */ }

  // ---------- 3. 二维码 ----------
  console.log('\n  [3/3] 生成二维码…');
  const online = verified;
  if (!online) {
    console.log('        ⚠️ 本机暂时访问不到这个新地址（DNS 是正常的，可能只是本机到 Cloudflare 慢）。');
    console.log('           同学扫码一般可以打开；若过几分钟还不行，关掉窗口重新双击一次。');
  }

  console.log('\n  ┌────────────────────────────────────────────────────────┐');
  console.log('  │  网站地址（发给同学的链接）：');
  console.log('  │  ' + url);
  console.log('  └────────────────────────────────────────────────────────┘');

  makeQr(url);

  // 关掉之前的降级提示，改成按"数据实际存在哪里"来说，避免误导用户
  let src = null;
  try {
    const r = await fetch('http://127.0.0.1:' + PORT + '/api/stats', { signal: AbortSignal.timeout(8000) });
    src = await r.json();
  } catch (e) { /* 拿不到就不显示这句 */ }

  console.log('\n  ✅ 已上线。二维码和群发文案都在桌面文件夹里，可转发到班群。');
  if (src && src.feishuDegraded) {
    console.log('  ⚠️ 飞书暂时连不上，分数会存在本机（data\\ratings.json），**没有进飞书表**。');
    console.log('     原因：' + String(src.degradeReason || '').slice(0, 70));
    console.log('     飞书恢复后重启一次本脚本，就会自动切回飞书表。');
  } else if (src && String(src.dataSource).indexOf('本地') === 0) {
    console.log('  ℹ️ 当前数据存在本机（data\\ratings.json），没有进飞书表。');
  } else {
    console.log('  ✅ 数据源：' + (src ? src.dataSource : '飞书多维表格') + '（分数会进飞书表）');
  }
  console.log('  ⚠️⚠️ 这个窗口要一直开着！关掉窗口网站就下线了。');
  console.log('      想下线就按 Ctrl+C。\n');
  console.log('  顺便生成进度预览页…');
  makeStatus(url, online);

  process.on('SIGINT', () => { console.log('\n  正在关闭…'); shutdown(); setTimeout(() => process.exit(0), 600); });
  process.on('exit', shutdown);
})().catch((e) => { console.error('出错：' + e.message); shutdown(); process.exit(1); });
