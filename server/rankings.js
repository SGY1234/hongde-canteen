'use strict';
/**
 * 榜单算法 —— 纯函数，不碰文件/网络，方便自动测试
 * 规则严格按需求文档：
 *   1. 单菜品评分      = 累计总分 / 打分人数        （打分人数 >= 5 才进榜）
 *   2. 单食堂档口榜    = 档口下所有进榜菜品的平均分再取平均
 *   3. 主校区食堂榜    = 食堂下所有进榜档口的平均分再取平均
 *   4. 全校总榜        = 所有进榜菜品混排 Top20
 *
 * 排序并列时的处理：均分 → 打分人数 → 菜名，保证结果稳定可复现。
 */

const MIN_VOTES = 5;          // 至少 5 个人打分才进入榜单
const BAYES_M = 5;            // 贝叶斯平滑强度（仅用于"综合推荐分"展示）
const BAYES_PRIOR = 4.0;      // 平滑先验分

function round1(n) {
  return Math.round(n * 10) / 10;
}

/** 综合推荐分：把 5 人门槛做成平滑先验，避免"1 个人打 5 星就压过 100 人打 4.8 星" */
function bayesScore(sum, votes) {
  return round1((sum + BAYES_M * BAYES_PRIOR) / (votes + BAYES_M));
}

function rawAverage(sum, votes) {
  return votes > 0 ? round1(sum / votes) : null;
}

/** 把一条记录补全成带名字、均分、价格的对象 */
function decorate(record, ctx) {
  const votes = Number(record.votes) || 0;
  const sum = Number(record.sum) || 0;
  const meta = (ctx.metaOf && ctx.metaOf(record.dishId)) || {};
  const stallMeta = (ctx.stallMetaOf && ctx.stallMetaOf(record.stallId)) || {};
  return {
    dishId: record.dishId,
    dishName: record.dishName || (ctx.dishNameOf ? ctx.dishNameOf(record.dishId) : '') || record.dishName,
    price: meta.price != null ? meta.price : null,
    unit: meta.unit || '元',
    stallId: record.stallId,
    stallName: (ctx.stallNameOf && ctx.stallNameOf(record.stallId)) || record.stallName || '',
    stallCode: stallMeta.code || '',
    canteenId: record.canteenId,
    canteenName: (ctx.canteenNameOf && ctx.canteenNameOf(record.canteenId)) || record.canteenName || '',
    sum: sum,
    votes: votes,
    average: rawAverage(sum, votes),
    bayes: bayesScore(sum, votes),
    qualified: votes >= MIN_VOTES
  };
}

function byScoreDesc(a, b) {
  if (b.average !== a.average) return b.average - a.average;
  if (b.votes !== a.votes) return b.votes - a.votes;
  return String(a.dishName).localeCompare(String(b.dishName), 'zh-Hans-CN');
}

function mean(values) {
  if (!values.length) return null;
  let s = 0;
  for (const v of values) s += v;
  return round1(s / values.length);
}

/**
 * 主入口
 * @param {Array} records 打分聚合记录 [{dishId,stallId,canteenId,dishName,sum,votes}]
 * @param {object} ctx     名称解析上下文 {stallNameOf, canteenNameOf, dishNameOf}
 * @returns {{dishes:Array, stalls:Array, canteens:Array, minVotes:number}}
 */
function computeBoards(records, ctx = {}) {
  const all = records.map((r) => decorate(r, ctx));
  const qualified = all.filter((d) => d.qualified).sort(byScoreDesc);

  /* ---- 档口聚合 ---- */
  const stallMap = new Map();
  for (const d of qualified) {
    if (!stallMap.has(d.stallId)) {
      stallMap.set(d.stallId, {
        stallId: d.stallId,
        stallName: d.stallName,
        stallCode: d.stallCode || '',
        canteenId: d.canteenId,
        canteenName: d.canteenName,
        dishes: [],
        votes: 0
      });
    }
    const s = stallMap.get(d.stallId);
    s.dishes.push(d);
    s.votes += d.votes;
  }
  const stalls = [...stallMap.values()].map((s) => {
    s.dishes.sort(byScoreDesc);
    s.qualifiedDishes = s.dishes.length;
    s.average = mean(s.dishes.map((d) => d.average));   // 档口 = 自家菜品平均分再平均
    return s;
  }).sort((a, b) => (b.average - a.average) || (b.votes - a.votes)
    || String(a.stallName).localeCompare(String(b.stallName), 'zh-Hans-CN'));

  /* ---- 食堂聚合 ---- */
  const canteenMap = new Map();
  for (const s of stalls) {
    if (!canteenMap.has(s.canteenId)) {
      canteenMap.set(s.canteenId, {
        canteenId: s.canteenId,
        canteenName: s.canteenName,
        stalls: [],
        votes: 0
      });
    }
    const c = canteenMap.get(s.canteenId);
    c.stalls.push(s);
    c.votes += s.votes;
  }
  const canteens = [...canteenMap.values()].map((c) => {
    c.stallCount = c.stalls.length;
    c.average = mean(c.stalls.map((s) => s.average));   // 食堂 = 所有档口平均分再平均
    c.dishes = c.stalls.reduce((acc, s) => acc.concat(s.dishes), []).sort(byScoreDesc).slice(0, 10);
    return c;
  }).sort((a, b) => (b.average - a.average) || (b.votes - a.votes)
    || String(a.canteenName).localeCompare(String(b.canteenName), 'zh-Hans-CN'));

  return { dishes: qualified, stalls, canteens, minVotes: MIN_VOTES };
}

/** 单食堂页面数据 */
function canteenBoard(records, ctx, canteenId, canteenName) {
  const boards = computeBoards(records, ctx);
  const stalls = boards.stalls.filter((s) => s.canteenId === canteenId);
  const canteen = boards.canteens.find((c) => c.canteenId === canteenId);
  // 该食堂里"还没凑够5人"的菜品，给个提示，激励投票
  const pending = records
    .map((r) => decorate(r, ctx))
    .filter((d) => d.canteenId === canteenId && !d.qualified)
    .sort((a, b) => b.votes - a.votes);

  return {
    canteenId,
    canteenName: canteenName || (canteen && canteen.canteenName) || '',
    canteenAverage: canteen ? canteen.average : null,
    stalls,
    pending: pending.slice(0, 8),
    minVotes: MIN_VOTES
  };
}

/** 全校总榜数据 */
function allBoard(records, ctx, limit = 20) {
  const boards = computeBoards(records, ctx);
  return {
    campusName: ctx.campusName || '主校区',
    dishes: boards.dishes.slice(0, limit),
    canteens: boards.canteens,
    minVotes: MIN_VOTES,
    totalQualified: boards.dishes.length
  };
}

module.exports = {
  MIN_VOTES,
  BAYES_M,
  BAYES_PRIOR,
  round1,
  rawAverage,
  bayesScore,
  computeBoards,
  canteenBoard,
  allBoard
};
