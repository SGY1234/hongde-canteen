'use strict';
/**
 * 前端接线契约测试 —— 零依赖：node test/frontend-contract.js
 *
 * 为什么需要它：没有浏览器可用时，最容易犯的错是
 *   「app.js 里 $('selStall') 但 index.html 里写的是 id="selstall"」这种低级致命错误，
 *   页面一打开就白屏，而且只有真机才能发现。
 * 这个测试把 HTML / JS / CSS / 后端路由 四者交叉比对，把这类问题挡在交付之前。
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server', 'local.js'), 'utf8');

let passed = 0, failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    failures.push(name + '  →  ' + e.message);
    console.log('  ✗ ' + name + '\n      ' + e.message);
  }
}

/* ---------- 1. HTML 里所有 id 集合 ---------- */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/* ---------- 2. app.js 里 $('xxx') 引用的 id ---------- */
const jsIds = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));

console.log('\n【1】DOM 接线（白屏类问题）');

check('app.js 引用的每个 id 都存在于 index.html', () => {
  const missing = [...jsIds].filter((id) => !htmlIds.has(id));
  assert.strictEqual(missing.length, 0,
    'app.js 引用了 HTML 里不存在的 id: ' + missing.join(', ') + '（会导致白屏）');
});

check('index.html 里的 id 没有被写成重复值', () => {
  const all = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dup = all.filter((id, i) => all.indexOf(id) !== i);
  assert.strictEqual(dup.length, 0, '重复 id: ' + [...new Set(dup)].join(', '));
});

check('三个 Tab 与三个屏幕一一对应', () => {
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual([...tabs].sort(), ['all', 'canteen', 'rate'], 'Tab 应正好是这三个: ' + tabs);
  tabs.forEach((t) => {
    assert.ok(htmlIds.has('screen-' + t), '缺少 #screen-' + t);
  });
  // 顺序要求：我要打分 / 单食堂榜单 / 全校总榜
  assert.deepStrictEqual(tabs, ['rate', 'canteen', 'all'], 'Tab 顺序应符合需求文档: ' + tabs);
});

/* ---------- 3. CSS 类名 ---------- */
console.log('\n【2】样式接线');

check('关键类名在 CSS 里都有定义', () => {
  const must = ['.screen.is-active', '.tab.is-active', '.row', '.rank', '.star', '.chip',
    '.picker', '.btn-primary', '.toast', '.tabbar', '.board', '.empty'];
  const missing = must.filter((c) => !css.includes(c));
  assert.strictEqual(missing.length, 0, 'CSS 缺少: ' + missing.join(', '));
});

check('移动端适配声明齐全（全屏 + 大字大按钮 + 底部安全区）', () => {
  assert.ok(/viewport-fit=cover/.test(html), '缺少 viewport-fit=cover（刘海屏会留白）');
  assert.ok(/safe-area-inset-bottom/.test(css), '缺少底部安全区处理（全面屏会被小黑条挡住Tab）');
  assert.ok(/user-scalable=no/.test(html), '缺少 user-scalable=no（手机双击会缩放）');
  assert.ok(/height:5[02]px/.test(css) || /height:5[02]px/.test(css.replace(/\s/g, '')),
    '按钮没有做成大按钮（应 >= 50px）');
});

check('评分用五角星且没有花哨配色（主色仅星星黄 + 黑白灰）', () => {
  const colors = [...css.matchAll(/#([0-9a-fA-F]{6})\b/g)].map((m) => m[1].toLowerCase());
  const uniq = [...new Set(colors)];
  assert.ok(uniq.length > 0, 'CSS 里没解析到颜色值，断言失效');
  // 允许的"彩色"只有星星黄、橙色分数、成功绿、错误红、前三名奖牌色
  const allowedColorish = new Set(['ffb300', 'ff8f00', '12b76a', 'e64a3b',
    'ffd54a', 'f0c9a8', '7a5200', '7a4a1e', '5b6470', 'dfe3e8']);
  const suspicious = uniq.filter((c) => {
    if (allowedColorish.has(c)) return false;
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    return Math.max(r, g, b) - Math.min(r, g, b) > 24;   // 明显有色相 = 花哨
  });
  assert.strictEqual(suspicious.length, 0, '出现了花哨配色: #' + suspicious.join(', #'));
});

/* ---------- 4. 前后端接口契约 ---------- */
console.log('\n【3】前后端接口契约');

check('app.js 调用的每个接口后端都实现了', () => {
  const called = new Set([...js.matchAll(/api\('(\/api\/[^'?]+)/g)].map((m) => m[1]));
  assert.ok(called.size >= 4, '前端调的接口太少，疑似没接后端: ' + [...called].join(','));
  const missing = [...called].filter((u) => !server.includes("'" + u + "'"));
  assert.strictEqual(missing.length, 0, '后端没有实现: ' + missing.join(', '));
});

check('提交打分用 POST，榜单用 GET', () => {
  assert.ok(/api\('\/api\/rate',\s*\{[\s\S]{0,80}method:\s*'POST'/.test(js), '打分必须是 POST');
  assert.ok(/\/api\/board\/canteen\?canteenId=/.test(js), '单食堂榜接口调用缺失');
  assert.ok(/\/api\/board\/all\?limit=20/.test(js), '全校总榜应取 Top20');
});

check('榜单请求带时间戳防缓存（保证排名实时）', () => {
  // 两个榜单接口都必须带 &t=Date.now()，否则会读到平台/CDN 缓存的旧排名
  const boardCalls = [...js.matchAll(/\/api\/board\/(all|canteen)\?[^\n]*/g)].map((m) => m[0]);
  assert.strictEqual(boardCalls.length, 2, '应该有 2 个榜单请求，实际 ' + boardCalls.length);
  boardCalls.forEach((line) => {
    assert.ok(/t=' \+ Date\.now\(\)/.test(line), '榜单请求缺少防缓存时间戳: ' + line.trim());
  });
  // 打分成功后必须重新拉榜单，否则用户看到的还是旧排名
  assert.ok(/refreshBoards\(\)/.test(js), '提交成功后没有刷新榜单');
});
check('前端不会出现飞书密钥（安全红线）', () => {
  const pub = ['index.html', 'app.js', 'style.css'].map((f) =>
    fs.readFileSync(path.join(ROOT, 'public', f), 'utf8')).join('\n');
  assert.ok(!/app_secret|AppSecret|FEISHU_APP_SECRET|tenant_access_token/i.test(pub),
    '前端文件里出现了飞书密钥相关字样，这是安全红线');
  assert.ok(!/open\.feishu\.cn/.test(pub), '前端不应直接请求飞书域名');
});

check('错误路径有中文提示，不会白屏', () => {
  assert.ok(/页面初始化失败/.test(js), '缺少初始化失败兜底提示');
  assert.ok(/榜单加载失败/.test(js), '缺少榜单加载失败兜底提示');
  assert.ok(/提交失败/.test(js), '缺少提交失败提示');
  assert.ok(/请检查网络后重试/.test(js), '缺少网络异常提示');
});

/* ---------- 5. 需求文档硬约束 ---------- */
console.log('\n【4】需求文档硬约束核对');

check('底部固定三个 Tab，名字与文档一致', () => {
  ['我要打分', '单食堂榜单', '全校总榜'].forEach((n) => {
    assert.ok(html.includes(n), '缺少 Tab 文案: ' + n);
  });
});

check('初期不做：手机号登录 / 晒图 / 评论区 / 头像', () => {
  const pub = html + js;
  const forbidden = ['手机号', '验证码', '登录', '上传图片', 'input type="file"', '头像', '评论回复'];
  const hit = forbidden.filter((f) => pub.includes(f));
  assert.strictEqual(hit.length, 0, '出现了超出范围的功能: ' + hit.join(', '));
});

check('零成本红线：没有引入任何外部资源/CDN/付费服务', () => {
  const externals = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(externals.length, 0, '引入了外部资源: ' + externals.join(', '));
  assert.ok(!/googleapis|cdn\.|unpkg|jsdelivr|bootcdn|pay|stripe|wechat/i.test(html),
    '出现疑似 CDN / 付费 / 微信 SDK 引用');
});

check('没有第三方 npm 依赖（不需要 npm install）', () => {
  const pkgPath = path.join(ROOT, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = Object.keys(pkg.dependencies || {}).concat(Object.keys(pkg.devDependencies || {}));
    assert.strictEqual(deps.length, 0, 'package.json 里有依赖: ' + deps.join(', '));
  }
  const reqs = [...server.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
  const external = reqs.filter((r) => !r.startsWith('.') && !r.startsWith('node:') &&
    !['fs', 'path', 'crypto', 'http', 'os', 'url', 'https'].includes(r));
  assert.strictEqual(external.length, 0, '后端引入了第三方包: ' + external.join(', '));
});

check('四级联动：校区默认锁定，只显示本校区食堂', () => {
  assert.ok(/active === true|c\.active/.test(js), '缺少"默认选中启用的校区"逻辑');
  assert.ok(/c\.campusId === active\.id/.test(server), '后端没有按校区过滤食堂');
});

check('防刷规则：IP + 菜品 + 日期 三者同才算重复', () => {
  assert.ok(/rateLimit\.reserve/.test(server), '缺少原子占坑，连点会重复加分');
  assert.ok(/'\|' \+ date \+ '\|' \+ dishId/.test(server) || /ip \+ '\|' \+ date/.test(server),
    '防刷 key 不是 IP+日期+菜品 组合');
  assert.ok(/beijingDate/.test(server), '缺少统一日期口径（跨天判定会出错）');
  assert.ok(/isRatedLocally/.test(js), '前端缺少本地兜底防刷');
});

check('≥5 人才进榜的门槛在前后端都体现', () => {
  const rankings = fs.readFileSync(path.join(ROOT, 'server', 'rankings.js'), 'utf8');
  assert.ok(/MIN_VOTES = 5/.test(rankings), '榜单算法里没有 5 人门槛');
  assert.ok(/MIN_VOTES/.test(server), '后端没把门槛暴露给接口');
  assert.ok(/至少.*人打分才进榜/.test(js) || /minVotes/.test(js), '前端没有提示 5 人门槛');
  const menu = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'menu.json'), 'utf8'));
  assert.strictEqual(menu.campuses.filter((c) => c.active).length, 1, '必须且只能有一个默认校区');
});

console.log('\n════════════════════════════════════════');
console.log('  通过 ' + passed + ' 项，失败 ' + failed + ' 项');
if (failed) {
  console.log('\n  失败明细：');
  failures.forEach((f) => console.log('   - ' + f));
}
console.log('════════════════════════════════════════\n');
process.exit(failed ? 1 : 0);
