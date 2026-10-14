'use strict';
/**
 * 数据存储层 —— 两种后端，同一套接口
 *   FileStore   : 本地/测试用，数据落在 data/ratings.json（原子写 + 串行队列，绝不丢数据）
 *   FeishuStore : 线上用，对接飞书多维表格（严格按需求文档的 7 个字段）
 *
 * 统一接口：
 *   list()             -> [{dishId,stallId,canteenId,dishName,stallName,canteenName,sum,votes}]
 *   applyRating(input) -> {record, isNew}
 *
 * 为什么要串行队列：需求文档的表结构是"一条菜品一行"的聚合表，
 * 「读出来 → 加上本次分数 → 写回去」这个动作如果并发执行会互相覆盖，所以全部排队。
 */

const fs = require('fs');
const path = require('path');

/* ============================ 本地文件存储 ============================ */
class FileStore {
  /**
   * @param {string|object} fileOrOpts
   *   string  -> 数据文件路径（简单用法）
   *   object  -> { file, detailsFile, fallbackFile }
   *     fallbackFile: 真实数据还不存在时用来展示的演示数据（只读）。
   *                   一旦有任何一条真实打分，就自动切回真实数据，演示数据不再出现。
   */
  constructor(fileOrOpts) {
    const opts = typeof fileOrOpts === 'string' ? { file: fileOrOpts } : (fileOrOpts || {});
    this.file = opts.file;
    this.detailsFile = opts.detailsFile || path.join(path.dirname(opts.file), 'details.json');
    this.fallbackFile = opts.fallbackFile || null;
    this.queue = Promise.resolve();   // 串行队列
    this._usedFallback = false;       // 本次读取是否用了演示数据
  }

  /**
   * 读取原始数据；真实文件不存在时回落到演示数据。
   * 注意：用演示数据时只会「读」，不会把它写进真实文件 ——
   * 第一条真实打分写入时，演示数据整体退场，真实榜单从零开始，
   * 这样同学看到的分数永远是真的，不会混进假分数。
   */
  _read() {
    const empty = { records: {} };
    this._usedFallback = false;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (data && data.records) return data;
    } catch (e) { /* 文件不存在或损坏，继续往下试 */ }
    if (this.fallbackFile) {
      try {
        const demo = JSON.parse(fs.readFileSync(this.fallbackFile, 'utf8'));
        if (demo && demo.records && Object.keys(demo.records).length) {
          this._usedFallback = true;
          return demo;
        }
      } catch (e) { /* 没有演示数据也正常 */ }
    }
    return empty;
  }

  /** 是否正在展示演示数据（供接口/页面提示用） */
  isShowingDemo() {
    if (fs.existsSync(this.file)) return false;
    if (!this.fallbackFile || !fs.existsSync(this.fallbackFile)) return false;
    try {
      const demo = JSON.parse(fs.readFileSync(this.fallbackFile, 'utf8'));
      return !!(demo && demo.records && Object.keys(demo.records).length);
    } catch (e) {
      return false;
    }
  }

  _write(data) {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);      // 原子替换，断电不会写出半个坏 JSON
  }

  _serial(task) {
    const run = this.queue.then(() => task());
    this.queue = run.catch(() => {});   // 单次失败不阻塞后续排队
    return run;
  }

  list() {
    return this._serial(() => Object.values(this._read().records || {}));
  }

  applyRating(input) {
    return this._serial(() => {
      const data = this._read();
      const wasDemo = this._usedFallback;
      // 演示数据不参与真实计分：第一条真实打分让演示数据整体退场
      if (wasDemo) data.records = {};
      data.records = data.records || {};
      const existing = data.records[input.dishId];
      const isNew = !existing;
      const rec = existing || {
        dishId: input.dishId,
        stallId: input.stallId,
        canteenId: input.canteenId,
        dishName: input.dishName,
        stallName: input.stallName,
        canteenName: input.canteenName,
        sum: 0,
        votes: 0
      };
      rec.sum = Number(rec.sum || 0) + input.score;
      rec.votes = Number(rec.votes || 0) + 1;
      rec.dishName = input.dishName || rec.dishName;
      rec.stallName = input.stallName || rec.stallName;
      rec.canteenName = input.canteenName || rec.canteenName;
      data.records[input.dishId] = rec;
      this._write(data);
      return { record: rec, isNew, demoDiscarded: wasDemo };
    });
  }

  /** 每条打分的明细留档（独立文件，不污染 7 字段主表） */
  appendDetail(detail) {
    return this._serial(() => {
      const f = this.detailsFile;
      let list = [];
      try {
        list = JSON.parse(fs.readFileSync(f, 'utf8'));
      } catch (e) { list = []; }
      if (!Array.isArray(list)) list = [];
      list.push(detail);
      if (list.length > 5000) list = list.slice(-5000);
      if (!fs.existsSync(path.dirname(f))) fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(list), 'utf8');
      return detail;
    });
  }
}

/* ============================ 飞书多维表格存储 ============================ */
/**
 * 需要的环境变量（配在云函数后台，永远不要写进前端代码）：
 *   FEISHU_APP_ID        应用 App ID
 *   FEISHU_APP_SECRET    应用 App Secret
 *   FEISHU_APP_TOKEN     多维表格 app_token（表格 URL 里 /base/xxxxx 那段）
 *   FEISHU_TABLE_ID      数据表 table_id（URL 里 ?table=tblxxxx 那段）
 */
class FeishuStore {
  constructor(cfg) {
    this.cfg = cfg;
    this.base = 'https://open.feishu.cn/open-apis';
    this._token = null;
    this._tokenExpire = 0;
    this.queue = Promise.resolve();
  }

  _serial(task) {
    const run = this.queue.then(() => task());
    this.queue = run.catch(() => {});
    return run;
  }

  async _tenantToken() {
    const now = Date.now();
    if (this._token && now < this._tokenExpire) return this._token;
    const res = await fetch(this.base + '/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.cfg.appId, app_secret: this.cfg.appSecret })
    });
    const json = await res.json();
    if (json.code !== 0) {
      throw new Error('飞书鉴权失败: ' + json.msg + '（请检查 App ID / App Secret 是否填对）');
    }
    this._token = json.tenant_access_token;
    this._tokenExpire = now + (json.expire - 120) * 1000;
    return this._token;
  }

  async _req(method, url, body) {
    const token = await this._tenantToken();
    const res = await fetch(this.base + url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: body ? JSON.stringify(body) : undefined
    });
    const json = await res.json();
    if (json.code !== 0) {
      const err = new Error('飞书接口错误: ' + json.msg + ' (code ' + json.code + ')');
      err.feishu = json;
      throw err;
    }
    return json.data;
  }

  _tablePath() {
    return '/bitable/v1/apps/' + this.cfg.appToken + '/tables/' + this.cfg.tableId;
  }

  /** 拉全表（自动翻页） */
  list() {
    return this._serial(async () => {
      const out = [];
      let pageToken = '';
      for (let i = 0; i < 50; i++) {          // 最多 50 页 ≈ 25000 行，够用
        const q = '?page_size=500' + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '');
        const data = await this._req('GET', this._tablePath() + '/records' + q);
        for (const item of data.items || []) out.push(this._fromFeishu(item));
        if (!data.has_more) break;
        pageToken = data.page_token;
      }
      return out;
    });
  }

  /** 飞书记录 -> 统一格式 */
  _fromFeishu(item) {
    const f = item.fields || {};
    const txt = (v) => {
      if (v == null) return '';
      if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('');
      if (typeof v === 'object') return v.text || v.name || '';
      return String(v);
    };
    const num = (v) => {
      if (v == null) return 0;
      if (Array.isArray(v)) return Number((v[0] && v[0].text) || 0) || 0;
      return Number(v) || 0;
    };
    const dishName = txt(f['菜品名称']);
    const stallName = txt(f['所属档口']);
    // 7 字段结构里没有 dishId（靠 档口+菜名 也能跑）。
    // 如果表里额外加了「菜品ID」这一列（推荐），就优先用它匹配菜单，联动更稳。
    const storedId = txt(f['菜品ID']);
    return {
      recordId: item.record_id,
      dishId: storedId || makeKey(stallName, dishName),
      dishName: dishName,
      stallName: stallName,
      canteenName: txt(f['所属食堂']),
      campusName: txt(f['所属校区']),
      sum: num(f['累计总分']),
      votes: num(f['打分人数'])
    };
  }

  /** 查到就累加，查不到就新建（全程串行） */
  applyRating(input) {
    return this._serial(async () => {
      const path0 = this._tablePath() + '/records';
      const token = await this._tenantToken();
      const res = await fetch(this.base + path0 + '/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({
          filter: {
            conjunction: 'and',
            conditions: [
              { field_name: '菜品名称', operator: 'is', value: [input.dishName] },
              { field_name: '所属档口', operator: 'is', value: [input.stallName] }
            ]
          },
          automatic_fields: false
        })
      });
      const sr = await res.json();
      // 1254005 = 没有匹配数据，属于正常情况
      if (sr.code !== 0 && sr.code !== 1254005) {
        const e = new Error('飞书查询失败: ' + sr.msg + ' (code ' + sr.code + ')');
        e.feishu = sr;
        throw e;
      }
      const items = (sr.data && sr.data.items) || [];

      if (!items.length) {
        const fields = {
          '所属校区': input.campusName || '主校区',
          '所属食堂': input.canteenName,
          '所属档口': input.stallName,
          '菜品名称': input.dishName,
          '累计总分': input.score,
          '打分人数': 1
        };
        if (this.cfg.hasDishIdField) fields['菜品ID'] = input.dishId;
        const created = await this._req('POST', path0, { fields });
        const rec = created && created.record;
        return {
          isNew: true,
          record: {
            recordId: rec && rec.record_id,
            dishId: makeKey(input.stallName, input.dishName),
            dishName: input.dishName,
            stallName: input.stallName,
            canteenName: input.canteenName,
            sum: input.score,
            votes: 1
          }
        };
      }

      const item = items[0];
      const cur = this._fromFeishu(item);
      const nextSum = cur.sum + input.score;
      const nextVotes = cur.votes + 1;
      await this._req('PUT', path0 + '/' + item.record_id, {
        fields: { '累计总分': nextSum, '打分人数': nextVotes }
      });
      return {
        isNew: false,
        record: {
          recordId: item.record_id,
          dishId: cur.dishId,
          dishName: cur.dishName,
          stallName: cur.stallName,
          canteenName: cur.canteenName,
          sum: nextSum,
          votes: nextVotes
        }
      };
    });
  }
}

/** 飞书表里没存 dishId，用 档口+菜名 造一个稳定 key，用于跨记录合并 */
function makeKey(stallName, dishName) {
  return String(stallName || '').trim() + '||' + String(dishName || '').trim();
}

module.exports = { FileStore, FeishuStore, makeKey };
