'use strict';
/**
 * 生成演示数据 demo/ratings.demo.json
 *
 * 目的：第一次打开页面时四个榜单是空的，看不出效果。
 * 这份演示数据会在「真实打分文件不存在」时被自动展示，
 * 而且一旦有任何一条真实打分，就立刻切回真实数据（演示数据不再出现）。
 *
 * 用固定随机种子，保证每次生成结果一致，便于复查。
 * 重新生成：node scripts/make-demo.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const menu = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'menu.json'), 'utf8'));

/* ---------- 可复现的伪随机数（mulberry32） ---------- */
function rng(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261014);

const stallById = new Map(menu.stalls.map((s) => [s.id, s]));
const canteenById = new Map(menu.canteens.map((c) => [c.id, c]));

/** 给一道菜编一个"真实感"的分数分布，返回 {sum, votes} */
function fakeVotes(isQualified) {
  // 达到进榜门槛的菜：5~9 人（票数故意压低，免得演示数据大得离谱）
  // 没达标的菜：1~3 人（用来演示"再攒 N 人打分就能进榜"）
  const votes = isQualified
    ? 5 + Math.floor(rand() * 5)
    : 1 + Math.floor(rand() * 3);

  // 真实均分大致落在 3.2 ~ 4.9
  const target = 3.2 + rand() * 1.7;
  let sum = 0;
  for (let i = 0; i < votes; i++) {
    let s = Math.round(target + (rand() - 0.5) * 1.2);
    s = Math.max(1, Math.min(5, s));
    sum += s;
  }
  return { sum, votes };
}

/* 演示数据覆盖范围：
   每个窗口最多取前 7 道菜（菜品太多的窗口不必全铺），
   其中每个窗口留最后 1 道"没攒够人"，用来演示"再攒 N 人打分就能进榜"。
   其余全部保证进榜 → Top20 一定是满的，每个窗口也都有内容。 */
const demoMaxDishesPerStall = 7;
const dishesByStall = new Map();
menu.dishes.forEach((d) => {
  if (!dishesByStall.has(d.stallId)) dishesByStall.set(d.stallId, []);
  dishesByStall.get(d.stallId).push(d.id);
});

const keepPending = new Set();
const demoDishSet = new Set();
dishesByStall.forEach((ids) => {
  const picked = ids.slice(0, demoMaxDishesPerStall);
  const last = picked[picked.length - 1];
  if (last) keepPending.add(last);
  picked.forEach((id) => demoDishSet.add(id));
});

const records = {};
menu.dishes.forEach((d) => {
  if (!demoDishSet.has(d.id)) return;
  const stall = stallById.get(d.stallId) || {};
  const canteen = canteenById.get(stall.canteenId) || {};
  const { sum, votes } = fakeVotes(!keepPending.has(d.id));
  records[d.id] = {
    dishId: d.id,
    stallId: stall.id,
    canteenId: canteen.id,
    dishName: d.name,
    stallName: stall.name,
    canteenName: canteen.name,
    sum: sum,
    votes: votes
  };
});

const outPath = path.join(ROOT, 'demo', 'ratings.demo.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({
  _说明: '演示数据：真实打分文件不存在时自动展示。任何一条真实打分写入后，这份数据自动失效。',
  records: records
}, null, 2), 'utf8');

const qualified = Object.values(records).filter((r) => r.votes >= 5).length;
const totalVotes = Object.values(records).reduce((a, r) => a + r.votes, 0);
console.log('已生成 ' + outPath);
console.log('  菜品 ' + Object.keys(records).length + ' 道，其中 ' + qualified + ' 道进榜（≥5人）');
console.log('  累计 ' + totalVotes + ' 票');
