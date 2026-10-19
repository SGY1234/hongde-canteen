'use strict';
/**
 * 生成食堂墙上贴的二维码
 *
 * 用法：
 *   node scripts/make-qr.js                                  # 用本机局域网地址生成（供你现在测试）
 *   node scripts/make-qr.js https://xxx.vercel.app           # 上线后带网址重新生成
 *   node scripts/make-qr.js https://xxx.vercel.app --desktop  # 同时输出到桌面
 *
 * 输出：项目里的 qr/ 文件夹 + （可选）桌面
 *   - 鸿德食堂打分-二维码.svg   矢量图，打印不糊
 *   - 鸿德食堂打分-二维码.html  可直接打开/打印/发群里
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const qr = require('../lib/qrcode.js');
const { encodePNG } = require('../lib/png.js');

const ROOT = path.resolve(__dirname, '..');

/** 本机局域网 IPv4 */
function lanIps() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push({ name, ip: net.address });
    }
  }
  return out;
}

/**
 * 桌面输出目录：统一走 lib/desktop-dir.js。
 * 它会优先选桌面上的「鸿德食堂打分-上线文件」文件夹，
 * 绝不把二维码等文件散落到桌面根目录（用户明确要求过）。
 */
function findDesktop() {
  return require('../lib/desktop-dir.js').resolveOutDir();
}

const args = process.argv.slice(2);
const toDesktop = args.includes('--desktop');
const outArgIdx = args.indexOf('--out');
const extraOut = outArgIdx >= 0 ? args[outArgIdx + 1] : null;
const port = process.env.PORT || 5173;
let url = args.find((a) => !a.startsWith('--') && a !== extraOut);
let source = '手动指定';

if (!url) {
  const ips = lanIps();
  // 优先挑 192.168 / 10.x 这类常见内网地址
  const pick = ips.find((x) => /^192\.168\./.test(x.ip))
    || ips.find((x) => /^10\./.test(x.ip))
    || ips[0];
  if (!pick) {
    console.error('找不到局域网地址。请带上网址运行：node scripts/make-qr.js https://你的域名');
    process.exit(1);
  }
  url = 'http://' + pick.ip + ':' + port;
  source = '本机局域网（' + pick.name + '）';
}

console.log('\n二维码内容：' + url);
console.log('地址来源：' + source);

const qrInfo = qr.encode(url, { ecLevel: 'M' });
console.log('二维码规格：版本 ' + qrInfo.version + ' · ' + qrInfo.size + '×' + qrInfo.size
  + ' · 纠错等级 ' + qrInfo.ecLevel + ' · 掩码 ' + qrInfo.mask);

const svgSmall = qr.toSVG(url, { scale: 8, margin: 3, ecLevel: 'M' });
const svgBig = qr.toSVG(url, { scale: 16, margin: 4, ecLevel: 'M' });

// PNG 位图（微信发图用）。两个尺寸：
//   pngShare  = 每格 10px → 410×410，微信里点开清楚、长按可识别，文件才 600 字节左右
//   pngPrint  = 每格 24px → 984×984，打印贴墙用
const qrModules = qrInfo.modules;
const pngShare = encodePNG(qrModules, { scale: 10, margin: 4 });
const pngPrint = encodePNG(qrModules, { scale: 24, margin: 4 });

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>鸿德食堂打分 · 扫码</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;padding:28px 16px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
       background:#f5f5f5;color:#1a1a1a;display:flex;justify-content:center}
  .card{background:#fff;border:1px solid #ececec;border-radius:18px;padding:28px 24px;max-width:420px;width:100%;text-align:center}
  h1{font-size:23px;margin:0 0 6px;letter-spacing:.5px}
  .sub{font-size:13px;color:#888;margin-bottom:18px}
  .qr{display:flex;justify-content:center;margin:6px 0 12px}
  .qr svg{width:100%;max-width:300px;height:auto}
  .url{font-size:12px;color:#666;word-break:break-all;background:#f7f7f7;border-radius:8px;padding:8px 10px;margin-bottom:14px}
  .steps{text-align:left;font-size:13.5px;line-height:2;color:#444;border-top:1px dashed #e6e6e6;padding-top:14px;margin:0}
  .steps b{color:#111}
  .tip{font-size:12px;color:#999;margin-top:14px;line-height:1.8}
  .badge{display:inline-block;font-size:12px;background:#f0f0f0;border:1px solid #e0e0e0;color:#666;
         border-radius:999px;padding:4px 12px;margin-bottom:14px}
  @media print{body{background:#fff;padding:0}.card{border:0;max-width:none}}
</style>
</head>
<body>
  <div class="card">
    <h1>鸿德食堂打分</h1>
    <div class="sub">哪个窗口好吃，同学说了算</div>
    <div class="badge">用微信扫一扫 · 不用下载 · 不用登录</div>
    <div class="qr">${svgBig}</div>
    <div class="url">${url}</div>
    <p class="steps">
      <b>怎么用：</b><br>
      1. 微信扫一扫上面这个码<br>
      2. 选你刚吃的那个窗口、那道菜<br>
      3. 点星星打分，提交 —— 3 秒完事<br>
      4. 想看排名，点底部「单食堂榜单」「全校总榜」
    </p>
    <div class="tip">
      本工具由同学自建，免费、无广告、不收集个人信息。<br>
      同一道菜每天只能打一次分，防止有人给自己家刷分。
    </div>
  </div>
</body>
</html>
`;

const outDir = path.join(ROOT, 'qr');
fs.mkdirSync(outDir, { recursive: true });
const targets = [
  { dir: outDir, tag: '(项目内)' }
];
if (extraOut) targets.push({ dir: extraOut, tag: '(指定目录)' });
if (toDesktop) {
  const desktop = findDesktop();
  if (desktop) targets.push({ dir: desktop, tag: '(桌面)' });
  else console.log('  ⚠️ 找不到桌面文件夹，跳过');
}

// 现成的群发文案：用户直接复制到班群即可（省得自己想怎么说）
const groupText = [
  '【鸿德食堂打分】想让大家一起投出「哪个窗口最好吃」，麻烦花 10 秒投一票 🙏',
  '',
  '👉 点这个链接就能打分（不用下载、不用注册）：',
  url,
  '',
  '或者直接扫我发的二维码图片。',
  '选你吃过的窗口和菜，点星星提交就行。',
  '每个菜每天只能投一次，投完能看到实时排名。'
].join('\r\n') + '\r\n';

for (const t of targets) {
  try {
    fs.mkdirSync(t.dir, { recursive: true });
    fs.writeFileSync(path.join(t.dir, '鸿德食堂打分-二维码.html'), html, 'utf8');
    fs.writeFileSync(path.join(t.dir, '鸿德食堂打分-二维码.svg'), svgSmall, 'utf8');
    // PNG 位图：**发给同学就发这个**。
    // 微信里发 HTML 附件，内置浏览器经常渲染不出 SVG → 二维码一片空白；
    // 直接发图片则点开就能长按识别。
    fs.writeFileSync(path.join(t.dir, '鸿德食堂打分-二维码.png'), pngShare);
    fs.writeFileSync(path.join(t.dir, '鸿德食堂打分-二维码-高清.png'), pngPrint);
    fs.writeFileSync(path.join(t.dir, '发给同学的话.txt'), groupText, 'utf8');
    console.log('  ✅ 已输出到 ' + t.dir + ' ' + t.tag);
  } catch (e) {
    console.log('  ❌ 写不了 ' + t.dir + '：' + e.message);
  }
}
console.log('\n【怎么发到班群】两种方式，任选一种：');
console.log('  1) 发图片：直接把【鸿德食堂打分-二维码.png】当图片发出去（同学点开长按识别）');
console.log('  2) 发文字：打开【发给同学的话.txt】，全选复制，粘到群里（含可点击的链接）');
console.log('\n⚠️ 不要把 .html 文件发到微信里——微信打开 HTML 附件经常渲染不出二维码。');
console.log('打印贴墙上用【鸿德食堂打分-二维码-高清.png】或 .svg。');


