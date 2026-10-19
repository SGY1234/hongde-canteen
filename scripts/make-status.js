'use strict';
/**
 * 生成「打分进度实时预览页」——不用打开飞书表也能看当前战况
 *
 * 为什么需要它：
 *   进榜门槛是 5 票，刚上线时票数不够，正式榜单是**空的**，
 *   用户会以为"是不是坏了"。这个预览页把「已进榜」和「还差几票」都列出来，
 *   一眼就能看出系统在正常工作、进度到哪了。
 *
 * 用法：
 *   node scripts/make-status.js              # 用当前公网地址（tools/current-url.txt）
 *   node scripts/make-status.js https://xx   # 指定地址
 *   node scripts/make-status.js --local      # 用本地 5173（不依赖隧道）
 *
 * 输出：桌面 + 项目 qr/ 目录下的「打分进度-实时预览.html」
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const USE_LOCAL = argv.includes('--local');
const URL_FILE = path.resolve(ROOT, '..', 'tools', 'current-url.txt');

let base = argv.find((a) => /^https?:\/\//.test(a));
if (!base) {
  if (USE_LOCAL) base = 'http://127.0.0.1:' + (process.env.PORT || 5173);
  else {
    try { base = fs.readFileSync(URL_FILE, 'utf8').trim(); } catch (e) { /* 下面兜底 */ }
    if (!base) base = 'http://127.0.0.1:' + (process.env.PORT || 5173);
  }
}
base = base.replace(/\/+$/, '');

/** 取 JSON；若给的是公网地址而本机访问不通（新隧道刚建好时常见），自动退回本地端口 */
// 端口优先取环境变量（由 go-live.js 传入，保证和服务实际监听的一致）
const LOCAL_PORT = process.env.PORT || 5173;
const LOCAL = 'http://127.0.0.1:' + LOCAL_PORT;
async function api(pathname) {
  const isLocal = base.indexOf('127.0.0.1') >= 0 || base.indexOf('localhost') >= 0;
  try {
    const r = await fetch(base + pathname, { signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    if (isLocal) throw e;                  // 本来就是本地地址，没得退
    console.log('  · 公网地址本机访问不通，改用本地端口取数据…');
    const r2 = await fetch(LOCAL + pathname, { signal: AbortSignal.timeout(15000) });
    return await r2.json();
  }
}

/**
 * 桌面输出目录：统一走 lib/desktop-dir.js，
 * 优先桌面上的「鸿德食堂打分-上线文件」文件夹，不往桌面根目录散文件。
 */
function findDesktop() {
  return require('../lib/desktop-dir.js').resolveOutDir();
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stars(avg) {
  const n = Math.round(Number(avg) || 0);
  return '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
}

function fmtPrice(p, unit) {
  if (p == null || p === '') return '';
  const n = Number(p);
  if (!isFinite(n) || n === 0) return '';
  return (Number.isInteger(n) ? n : n.toFixed(1)) + (unit || '元');
}

(async () => {
  let stats, menu, boards = {};
  try {
    stats = await api('/api/stats');
    menu = await api('/api/menu');
    for (const c of (menu.canteens || [])) {
      boards[c.id] = await api('/api/board/canteen?canteenId=' + c.id);
    }
  } catch (e) {
    console.error('拿不到数据（网站是不是没开？）：' + e.message);
    process.exit(1);
  }

  const minVotes = stats.minVotes || 5;
  const qualified = [];    // 已进榜
  const pending = [];      // 还差票
  for (const cid of Object.keys(boards)) {
    const b = boards[cid] || {};
    for (const st of (b.stalls || [])) {
      for (const d of (st.dishes || [])) {
        if (d.qualified !== false) qualified.push(d);
      }
    }
    for (const d of (b.pending || [])) pending.push(d);
  }
  // 已进榜的也可能在 stalls 里嵌套，做个去重
  const seen = {};
  const qualifiedList = qualified.filter((d) => {
    const k = d.dishId || (d.stallName + '|' + d.dishName);
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  });
  pending.sort((a, b) => (b.votes - a.votes) || ((b.average || 0) - (a.average || 0)));

  const now = new Date();
  const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

  const rowPending = (d, i) => {
    const need = Math.max(0, minVotes - (d.votes || 0));
    const pct = Math.min(100, Math.round(((d.votes || 0) / minVotes) * 100));
    return `
      <tr>
        <td class="idx">${i + 1}</td>
        <td>
          <div class="dish">${esc(d.dishName)} ${d.price ? '<span class="price">' + fmtPrice(d.price, d.unit) + '</span>' : ''}</div>
          <div class="meta">${esc(d.canteenName)} · ${esc(d.stallName)}${d.stallCode ? '（' + esc(d.stallCode) + '）' : ''}</div>
          <div class="bar"><i style="width:${pct}%"></i></div>
        </td>
        <td class="num"><b>${(Number(d.average) || 0).toFixed(1)}</b><div class="stars">${stars(d.average)}</div></td>
        <td class="num">${d.votes} 票</td>
        <td class="need">差 ${need} 票</td>
      </tr>`;
  };

  const rowQualified = (d, i) => `
      <tr class="ok">
        <td class="idx">${i + 1}</td>
        <td>
          <div class="dish">${esc(d.dishName || d.name)} ${d.price ? '<span class="price">' + fmtPrice(d.price, d.unit) + '</span>' : ''}</div>
          <div class="meta">${esc(d.canteenName || '')} · ${esc(d.stallName || '')}</div>
        </td>
        <td class="num"><b>${(Number(d.average) || 0).toFixed(1)}</b><div class="stars">${stars(d.average)}</div></td>
        <td class="num">${d.votes} 票</td>
        <td class="need ok">已进榜 ✅</td>
      </tr>`;

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>鸿德食堂打分 · 实时进度</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:22px 14px 40px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
       background:#f4f5f7;color:#1b1b1b;display:flex;justify-content:center}
  .wrap{max-width:760px;width:100%}
  h1{font-size:22px;margin:0 0 4px}
  .sub{font-size:13px;color:#888;margin-bottom:16px}
  .cards{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:18px}
  .card{flex:1 1 130px;background:#fff;border:1px solid #ececec;border-radius:14px;padding:14px 16px}
  .card b{display:block;font-size:26px;line-height:1.2}
  .card span{font-size:12.5px;color:#888}
  .src{background:#fff;border:1px solid #ececec;border-radius:14px;padding:12px 16px;font-size:13px;color:#555;margin-bottom:18px}
  .src b{color:#111}
  .box{background:#fff;border:1px solid #ececec;border-radius:14px;padding:16px;margin-bottom:16px}
  .box h2{font-size:15.5px;margin:0 0 12px;display:flex;align-items:center;gap:8px}
  .box h2 em{font-style:normal;font-size:12px;color:#999;font-weight:400}
  table{width:100%;border-collapse:collapse;font-size:13.5px}
  th{text-align:left;color:#999;font-weight:500;font-size:12px;padding:0 6px 8px;border-bottom:1px solid #f0f0f0}
  td{padding:10px 6px;border-bottom:1px solid #f6f6f6;vertical-align:top}
  tr:last-child td{border-bottom:0}
  .idx{color:#bbb;width:26px}
  .dish{font-weight:600}
  .price{color:#e4572e;font-weight:500;font-size:12.5px;margin-left:4px}
  .meta{color:#999;font-size:12px;margin-top:2px}
  .num{text-align:right;white-space:nowrap;color:#555}
  .num b{font-size:15px;color:#111}
  .stars{color:#f5a623;font-size:11px;letter-spacing:-1px}
  .need{text-align:right;color:#e4572e;font-size:12.5px;white-space:nowrap}
  .need.ok{color:#1a9c5b}
  .bar{height:5px;background:#f0f0f0;border-radius:99px;margin-top:6px;overflow:hidden}
  .bar i{display:block;height:100%;background:#4a8cff;border-radius:99px}
  tr.ok .bar{display:none}
  .empty{color:#999;font-size:13px;padding:8px 0}
  .tip{font-size:12.5px;color:#888;line-height:1.9;background:#fff;border:1px solid #ececec;border-radius:14px;padding:14px 16px}
  .tip b{color:#444}
</style>
</head>
<body>
<div class="wrap">
  <h1>鸿德食堂打分 · 实时进度</h1>
  <div class="sub">生成时间 ${stamp} · 每刷新一次就是最新数据</div>

  <div class="cards">
    <div class="card"><b>${stats.totalVotes || 0}</b><span>累计票数</span></div>
    <div class="card"><b>${stats.dishes || 0}</b><span>被打过分的菜</span></div>
    <div class="card"><b>${qualifiedList.length}</b><span>已进榜</span></div>
    <div class="card"><b>${minVotes}</b><span>进榜门槛（票）</span></div>
  </div>

  <div class="src">
    数据源：<b>${esc(stats.dataSource)}</b>${stats.isDemoData ? ' ⚠️ 当前是演示数据' : ' ✅ 真实打分'}
    &nbsp;·&nbsp; 网址：${esc(base)}
  </div>

  <div class="box">
    <h2>🏆 已进榜 <em>（够 ${minVotes} 票、可上正式榜单）</em></h2>
    ${qualifiedList.length
      ? '<table><thead><tr><th></th><th>菜品</th><th class="num">均分</th><th class="num">票数</th><th class="need">状态</th></tr></thead><tbody>'
        + qualifiedList.map(rowQualified).join('') + '</tbody></table>'
      : '<div class="empty">还没有菜品攒够 ' + minVotes + ' 票 —— 榜单暂时是空的，这是正常的（门槛就是防止人太少乱排名）。</div>'}
  </div>

  <div class="box">
    <h2>⏳ 还差几票 <em>（达到 ' + minVotes + ' 票就自动进榜）</em></h2>
    ${pending.length
      ? '<table><thead><tr><th></th><th>菜品</th><th class="num">均分</th><th class="num">票数</th><th class="need">进度</th></tr></thead><tbody>'
        + pending.map(rowPending).join('') + '</tbody></table>'
      : '<div class="empty">还没有人打分。</div>'}
  </div>

  <div class="tip">
    <b>怎么用这个页面：</b><br>
    · 想催票就把它截图发群里 —— 「招牌花甲粉就差 3 票了」比干说有效率<br>
    · 票数够了以后，同学在正式页面的「单食堂榜单 / 全校总榜」里就能看到排名<br>
    · 正式榜单是实时算的，<b>不需要手动刷新数据</b>；这个预览页重新生成一次就是最新的
  </div>
</div>
</body>
</html>
`;

  const targets = [{ dir: path.join(ROOT, 'qr'), tag: '(项目内)' }];
  const desktop = findDesktop();
  if (desktop) targets.push({ dir: desktop, tag: '(桌面)' });

  console.log('\n=== 生成打分进度预览 ===\n');
  console.log('  数据来源：' + base);
  console.log('  累计票数：' + (stats.totalVotes || 0) + ' · 被打分的菜：' + (stats.dishes || 0)
    + ' · 已进榜：' + qualifiedList.length + ' · 待进榜：' + pending.length + '（门槛 ' + minVotes + ' 票）');
  for (const t of targets) {
    try {
      fs.mkdirSync(t.dir, { recursive: true });
      const dest = path.join(t.dir, '打分进度-实时预览.html');
      fs.writeFileSync(dest, html, 'utf8');
      console.log('  ✅ ' + dest + ' ' + t.tag);
    } catch (e) {
      console.log('  ❌ 写不了 ' + t.dir + '：' + e.message);
    }
  }
  console.log('\n  双击那个 html 就能看当前战况（浏览器里按 F5 会看到旧快照，要最新的就重新跑这个脚本）。\n');
})().catch((e) => { console.error('出错：' + e.message); process.exit(1); });
