'use strict';
/**
 * 自动验收测试 —— 零依赖，直接 node test/smoke.js
 * 用临时数据目录启动一份服务，把需求文档里的规则逐条打钩。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');

/* ---------- 用临时目录 + 强制本地模式，绝不碰真实数据 ---------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hongde-test-'));
process.env.HD_DATA_DIR = TMP;
// ⚠️ 这个开关必须设！否则 server/local.js 会去读 .env.feishu，
//    测试就把数据写进用户真实的飞书表格了（这个坑已经踩过一次）
process.env.HD_FORCE_LOCAL = '1';
delete process.env.FEISHU_APP_ID;
delete process.env.FEISHU_APP_SECRET;
delete process.env.FEISHU_APP_TOKEN;
delete process.env.FEISHU_TABLE_ID;

// 先放一个"空的真实数据文件"，让本轮测试跑纯粹的真实数据流程
// （不这样做的话会先展示演示数据，后面的断言就都被演示数据干扰了）
fs.writeFileSync(path.join(TMP, 'ratings.json'), JSON.stringify({ records: {} }), 'utf8');

const app = require('../server/local.js');

const PORT = 5199;
const BASE = 'http://127.0.0.1:' + PORT;

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

async function req(method, url, body, ip) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (ip) headers['X-Forwarded-For'] = ip;
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/**
 * 打分助手。
 * 默认每次都换一个"手机 IP"——因为防刷规则是「同 IP + 同菜品 + 同一天」，
 * 想模拟 5 个不同同学打分，就必须来自 5 个不同 IP。
 * 要测重复提交时，显式传同一个 ip。
 */
let ipCounter = 0;
function rate(dishId, score, comment, ip) {
  const useIp = ip || ('10.' + (++ipCounter % 250) + '.' + (ipCounter % 250) + '.' + (ipCounter % 250));
  return req('POST', '/api/rate', { dishId, score, comment }, useIp);
}

/** 同一个 IP 打 5 次以上用这个批量造数据 */
async function rateTimes(dishId, score, times, ipPrefix) {
  const out = [];
  for (let i = 0; i < times; i++) {
    out.push(await rate(dishId, score, '', ipPrefix + '.' + i));
  }
  return out;
}

/* ---------- 从菜单里动态挑测试用的菜（不写死编号，以后改菜单不会坏） ---------- */
const MENU_JSON = require('../public/data/menu.json');
const TEST_CANTEEN = MENU_JSON.canteens[0];                              // 第一个食堂（金冠）
const TEST_STALL = MENU_JSON.stalls.find((s) => s.canteenId === TEST_CANTEEN.id);
const TEST_DISHES = MENU_JSON.dishes.filter((d) => d.stallId === TEST_STALL.id);
if (TEST_DISHES.length < 4) {
  throw new Error('测试前置失败：食堂 ' + TEST_CANTEEN.name + ' 的档口 ' + TEST_STALL.name + ' 至少要有 4 道菜，实际 ' + TEST_DISHES.length + ' 道');
}
const DISH_1 = TEST_DISHES[0].id;   // 攒 5 人，均分 4.0
const DISH_2 = TEST_DISHES[1].id;   // 只攒 3 人，不该进榜
const DISH_3 = TEST_DISHES[2].id;   // 防刷测试用
const DISH_4 = TEST_DISHES[3].id;   // 换 IP 测试用

/* ---------- 造数据：让第一道菜满 5 人、第二道只 3 人 ---------- */
async function seed() {
  // 第一道菜（' + TEST_DISHES[0].name + '）：：5 位不同同学打分 5,4,4,5,2 = 20/5 = 4.0
  for (const s of [5, 4, 4, 5, 2]) {
    const r = await rate(DISH_1, s);
    assert.strictEqual(r.status, 200, 'd001 打分应成功: ' + JSON.stringify(r.json));
  }
  // 第二道菜：3 人打分 5,5,5 = 15/3 = 5.0（只有 3 人，不该进榜）
  for (const s of [5, 5, 5]) {
    const r = await rate(DISH_2, s);
    assert.strictEqual(r.status, 200, 'd002 打分应成功: ' + JSON.stringify(r.json));
  }
  // d270 招牌烤鸭饭（小张餐厅二楼 4号窗口）：5 人 5 分 = 25/5 = 5.0（应拿全校第一）
  for (let i = 0; i < 5; i++) {
    const r = await rate('d270', 5);
    assert.strictEqual(r.status, 200, 'd270 打分应成功: ' + JSON.stringify(r.json));
  }
}

async function main() {
  const server = app.startServer(PORT);
  await new Promise((r) => setTimeout(r, 350));

  console.log('\n【1】基础接口与菜单数据');
  await check('GET /api/menu 返回 5 个食堂', async () => {
    const { status, json } = await req('GET', '/api/menu');
    assert.strictEqual(status, 200);
    assert.strictEqual(json.canteens.length, 5, '食堂数应为 5，实际 ' + json.canteens.length);
    assert.ok(json.dishes.length >= 100, '菜品应 >= 100 道，实际 ' + json.dishes.length);
    assert.strictEqual(json.campuses.find((c) => c.active).name, '鸿德主校区');
  });

  await check('每个档口都有菜品，没有空档口', async () => {
    const { json } = await req('GET', '/api/menu');
    const empty = json.stalls.filter((s) => !json.dishes.some((d) => d.stallId === s.id));
    assert.strictEqual(empty.length, 0, '空档口: ' + empty.map((s) => s.name).join(','));
  });

  await check('每道菜的 stallId 都能对上档口（联动不串数据）', async () => {
    const { json } = await req('GET', '/api/menu');
    const stallIds = new Set(json.stalls.map((s) => s.id));
    const bad = json.dishes.filter((d) => !stallIds.has(d.stallId));
    assert.strictEqual(bad.length, 0, '孤儿菜品: ' + bad.map((d) => d.name).join(','));
    // 档口必须归属本校区食堂
    const canteenIds = new Set(json.canteens.map((c) => c.id));
    const badStall = json.stalls.filter((s) => !canteenIds.has(s.canteenId));
    assert.strictEqual(badStall.length, 0, '档口串到了别的校区/食堂');
  });

  await check('「一家店一个菜单」的店只有一个档口（页面会自动跳过选窗口）', async () => {
    const { json } = await req('GET', '/api/menu');
    const singles = json.canteens.filter((c) => c.stallMode === 'single-menu');
    assert.ok(singles.length > 0, '至少应有一家 single-menu 的店');
    singles.forEach((c) => {
      const stalls = json.stalls.filter((s) => s.canteenId === c.id);
      assert.strictEqual(stalls.length, 1,
        c.name + ' 标了 single-menu 却有 ' + stalls.length + ' 个档口（页面跳过了选择框，同学会打不到分）');
      const dishes = json.dishes.filter((d) => d.stallId === stalls[0].id);
      assert.ok(dishes.length > 0, c.name + ' 的菜单是空的');
    });
  });

  await check('「里面还有好几个窗口」的店确实有多个档口', async () => {
    const { json } = await req('GET', '/api/menu');
    const multis = json.canteens.filter((c) => c.stallMode === 'multi-stall');
    assert.ok(multis.length > 0, '至少应有一家 multi-stall 的店（比如民族餐厅）');
    multis.forEach((c) => {
      const stalls = json.stalls.filter((s) => s.canteenId === c.id);
      assert.ok(stalls.length >= 2, c.name + ' 标了 multi-stall 却只有 ' + stalls.length + ' 个档口');
      stalls.forEach((s) => {
        assert.ok(json.dishes.some((d) => d.stallId === s.id),
          c.name + ' 的「' + s.name + '」没有菜品（选中后会打不到分）');
      });
    });
  });

  await check('食堂档口模式标记合法（只能是两种之一）', async () => {
    const { json } = await req('GET', '/api/menu');
    const bad = json.canteens.filter((c) => c.stallMode && !['single-menu', 'multi-stall'].includes(c.stallMode));
    assert.strictEqual(bad.length, 0, '非法 stallMode: ' + bad.map((c) => c.name + '=' + c.stallMode).join(','));
  });

  await check('菜单里带着价格和窗口号（照片实拍录入的数据）', async () => {
    const { json } = await req('GET', '/api/menu');
    const withPrice = json.dishes.filter((d) => d.price != null);
    assert.ok(withPrice.length >= 100, '带价格的菜品太少: ' + withPrice.length);
    const withCode = json.stalls.filter((s) => s.code);
    assert.ok(withCode.length >= 8, '带窗口号的档口太少: ' + withCode.length);
    // 抽查：小张餐厅二楼应该有 12 个窗口
    const c2 = json.canteens.find((c) => c.name === '小张餐厅二楼');
    assert.ok(c2, '应存在"小张餐厅二楼"');
    const c2Stalls = json.stalls.filter((s) => s.canteenId === c2.id);
    assert.strictEqual(c2Stalls.length, 12, '小张餐厅二楼应有 12 个窗口，实际 ' + c2Stalls.length);
    assert.strictEqual(c2.stallMode, 'multi-stall', '小张餐厅二楼里有多个窗口，应为 multi-stall');
    // 抽查具体数据
    const d = json.dishes.find((x) => x.name === '招牌花甲粉');
    assert.ok(d, '应有「招牌花甲粉」（照片上的招牌菜）');
    assert.strictEqual(d.price, 13.9, '招牌花甲粉价格应为 13.9');
  });

  console.log('\n【2】打分输入校验');
  await check('评 0 星 / 6 星 被拒绝', async () => {
    assert.strictEqual((await rate(DISH_1, 0)).status, 400);
    assert.strictEqual((await rate(DISH_1, 6)).status, 400);
    assert.strictEqual((await rate(DISH_1, 3.5)).status, 400);
  });

  await check('不存在的菜品被拒绝', async () => {
    const r = await rate('d999', 5);
    assert.strictEqual(r.status, 400);
    assert.ok(r.json.error.includes('菜品不存在'));
  });

  await check('缺参数被拒绝', async () => {
    assert.strictEqual((await req('POST', '/api/rate', { score: 5 })).status, 400);
    assert.strictEqual((await req('POST', '/api/rate', { dishId: DISH_1 })).status, 400);
  });

  console.log('\n【3】防刷：同 IP 同菜品同一天只能一次');
  await check('第一次成功，第二次 409，换 IP 又能成功', async () => {
    const ip = '172.16.9.9';
    const a = await rate(DISH_3, 4, '', ip);
    assert.strictEqual(a.status, 200, '第一次应成功，实际 ' + a.status + ' ' + JSON.stringify(a.json));
    const b = await rate(DISH_3, 4, '', ip);
    assert.strictEqual(b.status, 409, '同一 IP 第二次应被拦，实际 ' + b.status);
    assert.ok(b.json.error.includes('今天'));
    const c = await rate(DISH_3, 4, '', '172.16.9.10');   // 另一位同学
    assert.strictEqual(c.status, 200, '换 IP 应能打分');
  });

  await check('拦掉的那次没有污染分数（第三道菜 = 4.0 / 2 人）', async () => {
    const { json } = await req('GET', '/api/board/all?limit=50');
    const d = json.dishes.find((x) => x.dishId === DISH_3);
    if (d) assert.strictEqual(d.votes, 2, '重复提交不该被计入，实际人数 ' + d.votes);
  });

  await check('换一道菜不受影响（同一 IP）', async () => {
    assert.strictEqual((await rate(DISH_4, 5, '', '172.16.9.9')).status, 200);
  });

  await check('GET /api/rate/status 能查到已打分', async () => {
    const { json } = await req('GET', '/api/rate/status?dishId=' + DISH_3 + '', undefined, '172.16.9.9');
    assert.strictEqual(json.rated, true);
    const b = await req('GET', '/api/rate/status?dishId=' + DISH_1 + '', undefined, '172.16.9.9');
    assert.strictEqual(b.json.rated, false);
  });

  console.log('\n【4】榜单规则');

  await seed();

  await check('均分 = 累计总分 / 打分人数', async () => {
    const { json } = await req('GET', '/api/board/all?limit=50');
    const d = json.dishes.find((x) => x.dishId === DISH_1);
    assert.ok(d, '第一道菜应在榜');
    assert.strictEqual(d.votes, 5);
    assert.strictEqual(d.sum, 20);
    assert.strictEqual(d.average, 4);
  });

  await check('不足 5 人的菜品不进榜（d002 有 5.0 分但不出现）', async () => {
    const { json } = await req('GET', '/api/board/all?limit=50');
    assert.ok(!json.dishes.some((x) => x.dishId === DISH_2), 'd002 只有 3 人打分，不该进榜');
    assert.strictEqual(json.minVotes, 5);
  });

  await check('全校总榜按均分从高到低排序', async () => {
    const { json } = await req('GET', '/api/board/all?limit=50');
    assert.ok(json.dishes.length >= 2, '至少应有 2 道菜进榜');
    const top = json.dishes[0];
    assert.strictEqual(top.average, 5, '第一名应是 5.0 分的菜，实际 ' + top.dishName + ' ' + top.average);
    for (let i = 1; i < json.dishes.length; i++) {
      assert.ok(json.dishes[i - 1].average >= json.dishes[i].average,
        '排序错误: ' + json.dishes[i - 1].average + ' < ' + json.dishes[i].average);
    }
  });

  await check('总榜默认取 Top20', async () => {
    const { json } = await req('GET', '/api/board/all');
    assert.ok(json.dishes.length <= 20);
  });

  await check('单食堂档口榜：档口分 = 自家菜品平均分再平均', async () => {
    const { json } = await req('GET', '/api/board/canteen?canteenId=c1');
    assert.strictEqual(json.canteenId, 'c1');
    assert.ok(json.canteenName && json.canteenName.length > 0, '食堂名不能为空');
    const s1 = json.stalls.find((x) => x.stallId === TEST_STALL.id);   // 兰州拉面：d001=4.0，d002 未达门槛
    assert.ok(s1, 'c1s1 应在榜');
    assert.strictEqual(s1.qualifiedDishes, 1, 'c1s1 只有 1 道菜达标');
    assert.strictEqual(s1.average, 4, 'c1s1 档口分应为 4.0，实际 ' + s1.average);
    // 档口内菜品按均分排序
    const inside = json.stalls[0].dishes;
    for (let i = 1; i < inside.length; i++) {
      assert.ok(inside[i - 1].average >= inside[i].average);
    }
  });

  await check('单食堂榜只含本食堂档口，不串到别的食堂', async () => {
    const { json } = await req('GET', '/api/board/canteen?canteenId=c1');
    assert.ok(json.stalls.every((s) => s.canteenId === 'c1'), '混入了其它食堂的档口');
    const { json: b2 } = await req('GET', '/api/board/canteen?canteenId=c5');
    assert.ok(b2.stalls.every((s) => s.canteenId === 'c5'));
  });

  await check('主校区食堂榜：食堂分 = 所有档口平均分再平均', async () => {
    const { json } = await req('GET', '/api/board/all');
    const c1 = json.canteens.find((c) => c.canteenId === 'c1');
    assert.ok(c1, '第一个食堂应在食堂榜');
    // 该食堂：c1s1 达标菜品只有 d001(4.0) -> 档口分 4.0；其它档口无达标菜品 -> 不进榜
    assert.strictEqual(c1.average, 4, '食堂均分应为 4.0，实际 ' + c1.average);
    for (let i = 1; i < json.canteens.length; i++) {
      assert.ok(json.canteens[i - 1].average >= json.canteens[i].average, '食堂榜排序错误');
    }
  });

  await check('未达门槛的食堂榜单为空，并给出 pending 提示', async () => {
    // 三食堂（c3）本轮没有任何菜品攒够 5 人
    const { json } = await req('GET', '/api/board/canteen?canteenId=c3');
    assert.strictEqual(json.stalls.length, 0, 'c3 还没有 5 人打分的菜，档口榜应为空');
    assert.strictEqual(json.canteenAverage, null, '没有档口进榜时食堂均分应为 null');
    assert.ok(Array.isArray(json.pending), '应返回 pending 列表用于提示还差几人');
  });

  console.log('\n【5】健壮性');
  await check('不存在的接口返回 404 JSON', async () => {
    const r = await req('GET', '/api/nothing');
    assert.strictEqual(r.status, 404);
    assert.ok(r.json.error);
  });

  await check('非法 JSON body 返回 400 而不是崩服务', async () => {
    const res = await fetch(BASE + '/api/rate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json'
    });
    assert.strictEqual(res.status, 400);
  });

  await check('首页与前端资源可访问', async () => {
    for (const p of ['/', '/app.js', '/style.css', '/data/menu.json']) {
      const res = await fetch(BASE + p);
      assert.strictEqual(res.status, 200, p + ' 打不开');
    }
  });

  await check('目录穿越被挡住', async () => {
    const res = await fetch(BASE + '/../server/local.js');
    const text = await res.text();
    assert.ok(!text.includes('FEISHU_APP_SECRET'), '静态服务泄漏了服务端源码');
  });

  await check('并发 20 次提交不丢数据（串行队列 + 原子占坑生效）', async () => {
    const dish = 'd100';            // 小张餐厅二楼 · 花甲粉窗口的鲜花甲粉
    const sameIp = '10.99.99.99';
    const results = await Promise.all(
      Array.from({ length: 20 }, () => rate(dish, 4, '', sameIp))
    );
    const ok = results.filter((r) => r.status === 200).length;
    assert.strictEqual(ok, 1, '同 IP 并发应只成功 1 次，实际 ' + ok);
    const { json } = await req('GET', '/api/board/all?limit=50');
    const d = json.dishes.find((x) => x.dishId === dish);
    if (d) assert.strictEqual(d.votes, 1, '并发导致重复计数: ' + d.votes);
  });

  await check('多 IP 同时累加不互相覆盖（同一菜品）', async () => {
    const dish = 'd101';            // 鲜花甲粉
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => rate(dish, 5, '', '10.0.0.' + (i + 1)))
    );
    assert.strictEqual(results.filter((r) => r.status === 200).length, 6,
      '6 个不同 IP 都应成功: ' + JSON.stringify(results.map((r) => r.status)));
    const { json } = await req('GET', '/api/board/all?limit=50');
    const d = json.dishes.find((x) => x.dishId === dish);
    assert.ok(d, 'd101 攒够 6 票应进榜');
    assert.strictEqual(d.votes, 6, '应累计到 6 人，实际 ' + d.votes);
    assert.strictEqual(d.average, 5);
  });

  console.log('\n【6】统计接口');
  await check('GET /api/stats 数据自洽（真实数据模式）', async () => {
    // 本轮共投放：前四道菜分别是 5/3/2/1 票, d270=5, d100=1, d101=6 → 23 票
    // 进榜的 3 道菜是第一道菜(4.0) / d270(5.0) / d101(5.0)，分别落在 c1s1、c2s6、c2s1 三个窗口
    const { json } = await req('GET', '/api/stats');
    assert.strictEqual(json.isDemoData, false, '已写入真实数据，不该再是演示模式');
    assert.strictEqual(json.totalVotes, 23, '总票数应为 23，实际 ' + json.totalVotes);
    assert.strictEqual(json.qualifiedDishes, 3, '进榜菜品应为 3 道，实际 ' + json.qualifiedDishes);
    assert.strictEqual(json.activeStalls, 3, '进榜档口应为 3 家，实际 ' + json.activeStalls);
    assert.strictEqual(json.dishes, 7, '有打分记录的菜品应为 7 道，实际 ' + json.dishes);
    assert.strictEqual(json.minVotes, 5);
  });

  console.log('\n【7】演示数据回落（全新环境第一次打开不该是空榜单）');
  await new Promise((r) => server.close(r));
  const demoBefore = fs.readFileSync(path.join(__dirname, '..', 'demo', 'ratings.demo.json'), 'utf8');
  fs.rmSync(path.join(TMP, 'ratings.json'), { force: true });   // 模拟"全新环境"

  const server2 = app.startServer(PORT);
  await new Promise((r) => setTimeout(r, 350));

  await check('真实数据不存在时自动展示演示数据', async () => {
    const { json } = await req('GET', '/api/stats');
    assert.strictEqual(json.isDemoData, true, '全新环境应处于演示数据模式');
    assert.ok(json.totalVotes > 50, '演示数据票数异常: ' + json.totalVotes);
    assert.ok(json.qualifiedDishes >= 15, '演示数据进榜菜品太少: ' + json.qualifiedDishes);
    assert.ok(json.activeStalls >= 4, '演示数据应有多个档口进榜，实际 ' + json.activeStalls);
  });

  await check('演示数据下全校总榜填满 Top20 且顺序正确', async () => {
    const { json } = await req('GET', '/api/board/all');
    assert.strictEqual(json.dishes.length, 20, '应填满 Top20，实际 ' + json.dishes.length);
    for (let i = 1; i < json.dishes.length; i++) {
      assert.ok(json.dishes[i - 1].average >= json.dishes[i].average, '演示数据排序错误');
    }
    json.dishes.forEach((d) => {
      assert.ok(d.votes >= 5, '进榜菜品打分人数不足 5: ' + d.dishName + ' = ' + d.votes);
      assert.ok(d.stallName && d.canteenName, '榜单条目缺少档口/食堂名');
    });
  });

  await check('演示数据下主校区所有食堂都能看到档口榜', async () => {
    for (const cid of ['c1', 'c2', 'c3', 'c4', 'c5']) {
      const { json } = await req('GET', '/api/board/canteen?canteenId=' + cid);
      assert.ok(json.stalls.length >= 1, cid + ' 应有档口进榜');
      assert.ok(json.canteenAverage != null, cid + ' 食堂均分应有值');
      for (let i = 1; i < json.stalls.length; i++) {
        assert.ok(json.stalls[i - 1].average >= json.stalls[i].average, cid + ' 档口榜排序错误');
      }
    }
  });

  await check('榜单条目带价格和窗口号（页面要显示出来）', async () => {
    const { json } = await req('GET', '/api/board/canteen?canteenId=c2');
    assert.ok(json.stalls.length > 0, '小张餐厅二楼应有档口进榜');
    const dishes = json.stalls.reduce((acc, s) => acc.concat(s.dishes), []);
    assert.ok(dishes.length > 0, '档口下应有菜品');
    assert.ok(dishes.every((d) => d.price != null), '榜单菜品应带价格');
    assert.ok(dishes.every((d) => d.dishName && d.stallName && d.canteenName), '榜单条目名字不能缺');
    // 有窗口号的是大多数；干锅焖肉那家照片没拍到窗口号，属于正常缺失
    const withCode = dishes.filter((d) => d.stallCode);
    assert.ok(withCode.length >= dishes.length * 0.7,
      '带窗口号的菜品太少: ' + withCode.length + '/' + dishes.length);
    // 窗口号取自菜单（榜单里只含"已经进榜"的窗口，可能漏掉刚上线的）
    const { json: menu } = await req('GET', '/api/menu');
    const coded = menu.stalls.filter((s) => s.code).map((s) => s.code);
    assert.ok(coded.some((c) => c.includes('14号')), '应有 14号窗口（花甲粉）');
    assert.ok(coded.some((c) => c.includes('4号')), '应有 4号窗口（烤鸭饭）');
  });

  await check('第一条真实打分出现时，演示数据整体退场（不混进真实分数）', async () => {
    const { json: before } = await req('GET', '/api/stats');
    assert.ok(before.totalVotes > 100, '演示阶段应有大量演示票');
    // 挑一道演示数据里"已经攒够 5 人"的菜，最容易看出有没有被混进真实分数
    const { json: demoBoard } = await req('GET', '/api/board/all?limit=1');
    const hotDish = demoBoard.dishes[0];
    const r = await rate(hotDish.dishId, 4, '测试', '192.168.77.7');
    assert.strictEqual(r.status, 200, '真实打分应成功: ' + JSON.stringify(r.json));

    const { json } = await req('GET', '/api/stats');
    assert.strictEqual(json.isDemoData, false, '有真实数据后不该再显示"演示数据"标记');
    assert.strictEqual(json.totalVotes, 1, '演示票数不该带进真实数据，实际 ' + json.totalVotes);
    assert.strictEqual(json.dishes, 1, '应只有 1 道菜有真实记录，实际 ' + json.dishes);
    assert.strictEqual(json.qualifiedDishes, 0, '1 票不足以进榜');
    // 真实分数必须是干净的 4.0 而不是被演示数据抬高后的值
    const { json: board } = await req('GET', '/api/board/canteen?canteenId=' + hotDish.canteenId);
    assert.strictEqual(board.stalls.length, 0, '第一票不足以让档口进榜');
    // 真实数据文件必须已经落盘，重启也不会再回落到演示数据
    assert.ok(fs.existsSync(path.join(TMP, 'ratings.json')), '真实数据文件没有落盘');
    const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'ratings.json'), 'utf8'));
    assert.ok(saved.records[hotDish.dishId], '新增打分没写进文件');
    assert.strictEqual(saved.records[hotDish.dishId].votes, 1, '不该合并演示数据的人数');
    assert.strictEqual(saved.records[hotDish.dishId].sum, 4, '不该合并演示数据的分数');
    assert.strictEqual(Object.keys(saved.records).length, 1, '文件里应只有那一条真实打分');
  });

  await check('演示数据文件本身没有被写脏（下个新环境还能用）', async () => {
    const demoAfter = fs.readFileSync(path.join(__dirname, '..', 'demo', 'ratings.demo.json'), 'utf8');
    assert.strictEqual(demoAfter, demoBefore, '演示数据文件被改动了（真实打分不该污染它）');
  });

  /* ---------- 收尾 ---------- */
  await new Promise((r) => server2.close(r));
  await new Promise((r) => setTimeout(r, 80));

  console.log('\n════════════════════════════════════════');
  console.log('  通过 ' + passed + ' 项，失败 ' + failed + ' 项');
  if (failed) {
    console.log('\n  失败明细：');
    failures.forEach((f) => console.log('   - ' + f));
  }
  console.log('════════════════════════════════════════\n');

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('测试运行崩溃:', err);
  process.exit(1);
});
