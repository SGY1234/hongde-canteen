'use strict';
/**
 * 问题反馈功能测试 —— 零依赖，直接 node test/feedback.js
 *
 * 这个功能的核心约束只有一条（用户原话）：
 *   「是他们提出错误的地方，然后你接收并修改，不是让他们能自己改」
 * 所以下面每一项都在验同一件事：**同学只能"说"，不能"改"**。
 *
 * 另外几条是防手滑、防刷屏、防隐私泄露的护栏。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

/* ---------- 临时目录 + 强制本地，绝不碰真实数据 ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hongde-fb-'));
process.env.HD_DATA_DIR = TMP;
process.env.HD_FORCE_LOCAL = '1';
delete process.env.FEISHU_APP_ID;
delete process.env.FEISHU_APP_SECRET;
delete process.env.FEISHU_APP_TOKEN;
delete process.env.FEISHU_TABLE_ID;
delete process.env.HD_ADMIN_KEY;

fs.writeFileSync(path.join(TMP, 'ratings.json'), JSON.stringify({ records: {} }), 'utf8');

const app = require('../server/local.js');

const PORT = 5198;
const BASE = 'http://127.0.0.1:' + PORT;
const FB_FILE = path.join(TMP, 'feedback.json');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log('  ✓ ' + name); })
    .catch((err) => {
      failed++;
      failures.push(name + '  →  ' + err.message);
      console.log('  ✗ ' + name + '\n      ' + err.message);
    });
}

async function req(method, url, body, ip, extraHeaders) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (ip) headers['X-Forwarded-For'] = ip;
  Object.assign(headers, extraHeaders || {});
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/**
 * 模拟"同学从公网进来"。
 *
 * 注意不能再用 X-Forwarded-For 来模拟了 —— 2026-10-19 修掉的那个漏洞正是
 * "服务端信了 XFF"，所以现在 XFF 根本不参与权限判定。
 * 真实公网请求长这样：经过 Cloudflare 隧道，带着边缘节点写的 cf-connecting-ip。
 * 这里就照着这个特征伪造（客户端能伪造 cf 头只是测试手段，真机上这个头由 Cloudflare 写）。
 */
function publicReq(method, url, body) {
  return req(method, url, body, null, { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': '8a1b2c3d4e5f-SJC' });
}

/** 读落盘文件（验证"真的存下来了"而不是只在内存） */
function readFileItems() {
  try {
    const data = JSON.parse(fs.readFileSync(FB_FILE, 'utf8'));
    return Array.isArray(data) ? data : (data.items || []);
  } catch (e) { return null; }
}

const MENU = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'data', 'menu.json'), 'utf8'));
const DISH = MENU.dishes[0];
const DISH_2 = MENU.dishes[1];

let ipCounter = 0;
function newIp() { return '198.51.100.' + (++ipCounter); }

(async function main() {
  const server = app.startServer(PORT);
  await new Promise((r) => setTimeout(r, 250));

  console.log('\n【1】同学能看到哪些问题类型');

  await check('GET /api/feedback/kinds 返回 6 种类型且都是中文', async () => {
    const r = await req('GET', '/api/feedback/kinds');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.kinds.length, 6, '类型数量不对: ' + r.json.kinds.length);
    const keys = r.json.kinds.map((k) => k.key);
    assert.deepStrictEqual(keys, ['price', 'name', 'extra', 'missing', 'stall', 'other']);
    r.json.kinds.forEach((k) => {
      assert.ok(/[\u4e00-\u9fa5]/.test(k.text), '类型文案不是中文: ' + k.text);
    });
  });

  console.log('\n【2】提交时的必填校验（防手滑）');

  await check('没选类型 → 400，提示中文', async () => {
    const r = await req('POST', '/api/feedback', { dishId: DISH.id, text: '写错了' }, newIp());
    assert.strictEqual(r.status, 400);
    assert.ok(/请选择问题类型/.test(r.json.error), '提示不对: ' + r.json.error);
  });

  await check('类型非法（乱传 key）→ 400', async () => {
    const r = await req('POST', '/api/feedback', { kind: 'hack', dishId: DISH.id, text: 'x' }, newIp());
    assert.strictEqual(r.status, 400);
  });

  await check('类型对但说明是空的 → 400', async () => {
    const r = await req('POST', '/api/feedback', { kind: 'price', dishId: DISH.id, text: '   ' }, newIp());
    assert.strictEqual(r.status, 400);
    assert.ok(/请简单写一句/.test(r.json.error), '提示不对: ' + r.json.error);
  });

  await check('菜品不存在 → 400（不能凭空报一道不存在的菜）', async () => {
    const r = await req('POST', '/api/feedback',
      { kind: 'price', dishId: 'dish_不存在_123', text: '价格错了' }, newIp());
    assert.strictEqual(r.status, 400);
    assert.ok(/菜品不存在/.test(r.json.error), '提示不对: ' + r.json.error);
  });

  await check('「价格不对」这类必须指明菜品，不能空着提交', async () => {
    const r = await req('POST', '/api/feedback', { kind: 'price', text: '贵了' }, newIp());
    assert.strictEqual(r.status, 400);
    assert.ok(/请先选择是哪道菜/.test(r.json.error), '提示不对: ' + r.json.error);
  });

  console.log('\n【3】正常提交（同学只"说"，不改数据）');

  let firstId = '';

  await check('提交成功，返回中文致谢并带编号', async () => {
    const r = await req('POST', '/api/feedback',
      { kind: 'price', dishId: DISH.id, text: '实际卖 12 元，不是 15' }, newIp());
    assert.strictEqual(r.status, 200);
    assert.ok(r.json.ok === true);
    assert.ok(r.json.id && r.json.id.startsWith('fb'), '编号格式不对: ' + r.json.id);
    assert.ok(/收到/.test(r.json.message), '没有中文致谢: ' + r.json.message);
    assert.strictEqual(r.json.kindText, '价格不对');
    firstId = r.json.id;
  });

  await check('落盘到 feedback.json，且带上了食堂/档口/菜名（方便我去改）', async () => {
    const items = readFileItems();
    assert.ok(items && items.length === 1, '文件里应该有 1 条，实际 ' + (items ? items.length : 'null'));
    const it = items[0];
    assert.strictEqual(it.id, firstId);
    assert.strictEqual(it.dishId, DISH.id);
    assert.strictEqual(it.dishName, DISH.name);
    assert.ok(it.stallName, '缺档口名');
    assert.ok(it.canteenName, '缺食堂名');
    assert.strictEqual(it.status, 'open');
    assert.ok(it.at && !isNaN(Date.parse(it.at)), '时间格式不对: ' + it.at);
  });

  await check('「还有菜没录进来」允许不带菜品（漏菜时本来就没这道菜可选）', async () => {
    const r = await req('POST', '/api/feedback',
      { kind: 'missing', text: '少了「红烧牛肉面」，15 元' }, newIp());
    assert.strictEqual(r.status, 200);
    const items = readFileItems();
    const it = items.find((x) => x.id === r.json.id);
    assert.strictEqual(it.dishId, '');
    assert.strictEqual(it.kind, 'missing');
  });

  await check('说明超长会被截断到 200 字（不让人塞一篇文章）', async () => {
    const long = '啊'.repeat(500);
    const r = await req('POST', '/api/feedback', { kind: 'other', text: long }, newIp());
    assert.strictEqual(r.status, 200);
    const items = readFileItems();
    const it = items.find((x) => x.id === r.json.id);
    assert.strictEqual(it.text.length, 200, '实际长度 ' + it.text.length);
  });

  console.log('\n【4】防刷：同一个人对同一道菜，一天最多报 2 次');

  await check('同一 IP 对同一道菜报第 3 次 → 429 并给中文说明', async () => {
    const ip = '203.0.113.77';
    const a = await req('POST', '/api/feedback', { kind: 'price', dishId: DISH_2.id, text: '应该是 9 元' }, ip);
    assert.strictEqual(a.status, 200, '第 1 次应该成功');
    const b = await req('POST', '/api/feedback', { kind: 'name', dishId: DISH_2.id, text: '名字错了' }, ip);
    assert.strictEqual(b.status, 200, '第 2 次应该成功');
    const c = await req('POST', '/api/feedback', { kind: 'extra', dishId: DISH_2.id, text: '没这菜' }, ip);
    assert.strictEqual(c.status, 429, '第 3 次应该被挡住，实际 ' + c.status);
    assert.ok(/已经报过/.test(c.json.error), '提示不对: ' + c.json.error);
  });

  await check('换个 IP 报同一道菜不受影响（不是全局封杀）', async () => {
    const r = await req('POST', '/api/feedback',
      { kind: 'price', dishId: DISH_2.id, text: '确实是 9 元' }, '203.0.113.78');
    assert.strictEqual(r.status, 200);
  });

  await check('同一 IP 报别的菜不受影响（只限同一道菜）', async () => {
    const r = await req('POST', '/api/feedback',
      { kind: 'price', dishId: MENU.dishes[2].id, text: '价格不对' }, '203.0.113.77');
    assert.strictEqual(r.status, 200);
  });

  console.log('\n【5】管理权限：同学从公网进不来');

  await check('公网 IP 看反馈列表 → 403', async () => {
    const r = await publicReq('GET', '/api/feedback/list');
    assert.strictEqual(r.status, 403, '公网应该被拒绝，实际 ' + r.status);
    assert.ok(/只能在这台电脑上打开/.test(r.json.error), '提示不对: ' + r.json.error);
  });

  await check('公网 IP 改状态 → 403（最关键：改不了任何东西）', async () => {
    const r = await publicReq('POST', '/api/feedback/resolve',
      { id: firstId, status: 'done' });
    assert.strictEqual(r.status, 403, '公网应该被拒绝，实际 ' + r.status);
    const items = readFileItems();
    const it = items.find((x) => x.id === firstId);
    assert.strictEqual(it.status, 'open', '状态被改掉了！');
  });

  await check('公网伪造 X-Forwarded-For: 127.0.0.1 也进不来（2026-10-19 修过的漏洞）', async () => {
    // 这是回归测试：以前服务端优先读 XFF，发这个头就能冒充本机管理员。
    // 现在权限只看 socket + Cloudflare 头，XFF 一律不作数。
    const r = await req('GET', '/api/feedback/list', null, '127.0.0.1',
      { 'cf-connecting-ip': '203.0.113.9', 'cf-ray': '8a1b2c3d4e5f-SJC' });
    assert.strictEqual(r.status, 403, '漏洞回来了！伪造 XFF 能看列表，HTTP ' + r.status);
  });

  await check('本机 127.0.0.1 可以看列表', async () => {
    const r = await req('GET', '/api/feedback/list?limit=200', null, '127.0.0.1');
    assert.strictEqual(r.status, 200);
    assert.ok(Array.isArray(r.json.items), 'items 不是数组');
    assert.ok(r.json.items.length >= 4, '应该有至少 4 条，实际 ' + r.json.items.length);
    assert.ok(r.json.counts && typeof r.json.counts.open === 'number', '缺 counts 统计');
  });

  await check('列表默认只给待处理的（免得已改好的淹没有用信息）', async () => {
    const r = await req('GET', '/api/feedback/list', null, '127.0.0.1');
    assert.ok(r.json.items.every((it) => it.status === 'open'), '默认列表里混进了非待处理项');
  });

  await check('列表按时间倒序（最新的在最上面）', async () => {
    const r = await req('GET', '/api/feedback/list', null, '127.0.0.1');
    const times = r.json.items.map((it) => Date.parse(it.at));
    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i - 1] >= times[i], '第 ' + i + ' 条比上一条还新，排序反了');
    }
  });

  await check('列表带中文类型名和状态名（前端不用再维护映射）', async () => {
    const r = await req('GET', '/api/feedback/list', null, '127.0.0.1');
    const it = r.json.items[0];
    assert.ok(/[\u4e00-\u9fa5]/.test(it.kindText), 'kindText 不是中文: ' + it.kindText);
    assert.ok(/[\u4e00-\u9fa5]/.test(it.statusText), 'statusText 不是中文: ' + it.statusText);
  });

  console.log('\n【6】管理员处理：标记已处理 / 忽略 / 撤回');

  await check('本机标记「已改好」→ 200，落盘状态变 done', async () => {
    const r = await req('POST', '/api/feedback/resolve',
      { id: firstId, status: 'done', note: '已把价格改成 12' }, '127.0.0.1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'done');
    assert.strictEqual(r.json.statusText, '已处理');
    const it = readFileItems().find((x) => x.id === firstId);
    assert.strictEqual(it.status, 'done');
    assert.ok(it.resolvedAt, '没记处理时间');
    assert.strictEqual(it.resolveNote, '已把价格改成 12');
  });

  await check('标记后默认列表里不再出现，但 all=1 能看到', async () => {
    const only = await req('GET', '/api/feedback/list', null, '127.0.0.1');
    assert.ok(!only.json.items.some((x) => x.id === firstId), '待处理列表里还有它');
    const all = await req('GET', '/api/feedback/list?all=1', null, '127.0.0.1');
    assert.ok(all.json.items.some((x) => x.id === firstId), '全部列表里找不到它');
  });

  await check('可以撤回成待处理（标错了能改回来）', async () => {
    const r = await req('POST', '/api/feedback/resolve',
      { id: firstId, status: 'open' }, '127.0.0.1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.status, 'open');
    const it = readFileItems().find((x) => x.id === firstId);
    assert.strictEqual(it.status, 'open');
    assert.ok(!it.resolvedAt, '撤回后还留着处理时间');
  });

  await check('非法状态值 → 400（不能瞎传）', async () => {
    const r = await req('POST', '/api/feedback/resolve',
      { id: firstId, status: 'deleted' }, '127.0.0.1');
    assert.strictEqual(r.status, 400);
  });

  await check('不存在的编号 → 400', async () => {
    const r = await req('POST', '/api/feedback/resolve',
      { id: 'fb不存在', status: 'done' }, '127.0.0.1');
    assert.strictEqual(r.status, 400);
  });

  console.log('\n【7】安全与隐私红线');

  await check('落盘文件里没有原始 IP（只存哈希）', async () => {
    const raw = fs.readFileSync(FB_FILE, 'utf8');
    ['203.0.113.77', '203.0.113.78', '198.51.100.'].forEach((ip) => {
      assert.ok(!raw.includes(ip), '文件里出现了明文 IP: ' + ip);
    });
    const items = readFileItems();
    items.forEach((it) => {
      assert.ok(/^[0-9a-f]{12}$/.test(it.ipHash), 'ipHash 格式不对: ' + it.ipHash);
    });
  });

  await check('没有"同学自己改菜单"的接口（这是需求红线）', async () => {
    // 菜单只读：任何想改菜单的请求都不该存在
    const r1 = await req('POST', '/api/menu', { dishes: [] }, '127.0.0.1');
    assert.ok(r1.status === 404 || r1.status === 405, '竟然有能改菜单的接口！HTTP ' + r1.status);
    const r2 = await req('POST', '/api/feedback/list', {}, '127.0.0.1');
    assert.ok(r2.status === 404 || r2.status === 405, '列表接口不该接受 POST，实际 ' + r2.status);
  });

  await check('反馈内容里的 HTML 会被原样保存，前端负责转义（不在这里瞎改数据）', async () => {
    const evil = '<script>alert(1)</script>';
    const r = await req('POST', '/api/feedback', { kind: 'other', text: evil }, newIp());
    assert.strictEqual(r.status, 200);
    const it = readFileItems().find((x) => x.id === r.json.id);
    assert.strictEqual(it.text, evil, '内容被改坏了，管理员就看不到同学到底写了什么');
  });

  await check('前端页面里确实做了转义（esc 函数用在反馈内容上）', async () => {
    const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
    assert.ok(/esc\(it\.text\)/.test(adminJs), '管理页没有转义反馈内容，存在 XSS 风险');
    assert.ok(/esc\(it\.kindText\)/.test(adminJs), '管理页没有转义类型名');
  });

  console.log('\n【8】文件存储的健壮性');

  await check('并发提交 10 条，一条都不丢（串行队列 + 原子写）', async () => {
    const before = readFileItems().length;
    const ip = '192.0.2.200';
    const jobs = [];
    for (let i = 0; i < 10; i++) {
      // 故意用不同的菜，避开同菜防刷
      jobs.push(req('POST', '/api/feedback',
        { kind: 'other', dishId: MENU.dishes[i].id, text: '并发测试第 ' + i + ' 条' }, ip));
    }
    const rs = await Promise.all(jobs);
    rs.forEach((r) => assert.strictEqual(r.status, 200, '有提交失败了'));
    const after = readFileItems().length;
    assert.strictEqual(after, before + 10, '丢了 ' + (before + 10 - after) + ' 条');
  });

  await check('文件被写坏（不是合法 JSON）时不会崩溃，当成空处理', async () => {
    const broken = path.join(TMP, 'feedback.json');
    const backup = fs.readFileSync(broken, 'utf8');
    fs.writeFileSync(broken, '这不是 JSON{{{', 'utf8');
    const r = await req('GET', '/api/feedback/list', null, '127.0.0.1');
    assert.strictEqual(r.status, 200, '文件坏了应该降级成空列表，实际 ' + r.status);
    assert.strictEqual(r.json.items.length, 0);
    fs.writeFileSync(broken, backup, 'utf8');   // 复原，不影响后续
  });

  console.log('\n════════════════════════════════════════');
  console.log('  通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) {
    console.log('\n失败明细：');
    failures.forEach((f) => console.log('  · ' + f));
  }
  console.log('════════════════════════════════════════\n');

  server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本本身出错：', e);
  process.exit(1);
});
