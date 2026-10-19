'use strict';
/**
 * 问题反馈存储 —— 同学报错，管理员（用户/我）改菜单
 *
 * 为什么要这个：菜单是拍照识别的，一定有认错的（菜名、价格、漏菜、已下架）。
 * 让同学自己改数据 = 谁都能篡改榜单，绝对不行。
 * 所以这里只做"收集"：同学提交 -> 落盘 -> 管理员看了去改菜单 -> 标记已处理。
 *
 * 设计要点（都踩过坑）：
 *   1. 原子写 + 串行队列：和 ratings.json 一样，并发提交不会互相覆盖
 *   2. 最多留 2000 条：避免文件无限长大（同学手滑刷屏也不会撑爆）
 *   3. 不存原始 IP，只存哈希：和打分明细一个口径，不泄露隐私
 *   4. 零依赖：不引数据库，一个 JSON 文件搞定
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 反馈类型白名单（前端按钮的 key，中文在 KIND_TEXT 里） */
const KINDS = ['price', 'name', 'extra', 'missing', 'stall', 'other'];

/** 类型 -> 中文名（后端存 key，展示用中文，改文案只改这里） */
const KIND_TEXT = {
  price: '价格不对',
  name: '菜名写错了',
  extra: '这家没这道菜',
  missing: '还有菜没录进来',
  stall: '档口/窗口写错了',
  other: '其他问题'
};

/** 状态：open=待处理，done=已改好，ignored=不用改 */
const STATUS_TEXT = { open: '待处理', done: '已处理', ignored: '已忽略' };

function sha12(s) {
  return crypto.createHash('sha256').update(String(s) + '|hongde-fb').digest('hex').slice(0, 12);
}

class FeedbackStore {
  /**
   * @param {string|object} fileOrOpts 字符串=文件路径；对象={file, max}
   */
  constructor(fileOrOpts) {
    const opts = typeof fileOrOpts === 'string' ? { file: fileOrOpts } : (fileOrOpts || {});
    this.file = opts.file;
    this.max = opts.max || 2000;
    this.queue = Promise.resolve();   // 串行队列，和 FileStore 一个思路
  }

  /** 排队执行，保证并发提交不互相覆盖 */
  _serial(fn) {
    const run = this.queue.then(fn, fn);
    // 无论成功失败都要把队列推进下去，否则一次报错就永久卡死
    this.queue = run.then(() => {}, () => {});
    return run;
  }

  _read() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(data)) return data;             // 兼容直接存数组的老格式
      if (data && Array.isArray(data.items)) return data.items;
    } catch (e) { /* 文件不存在或坏了，当空处理 */ }
    return [];
  }

  _write(items) {
    const dir = path.dirname(this.file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = this.file + '.tmp' + process.pid;
    // 存成 {items:[...]} 而不是裸数组，将来加字段（比如统计信息）不用改结构
    fs.writeFileSync(tmp, JSON.stringify({ items }, null, 2), 'utf8');
    fs.renameSync(tmp, this.file);   // 原子替换，断电不会写出半个坏 JSON
  }

  /**
   * 新增一条反馈
   * @param {{kind:string, dishId?:string, dishName?:string, stallId?:string,
   *          stallName?:string, canteenId?:string, canteenName?:string,
   *          text?:string, ip?:string}} input
   */
  add(input) {
    return this._serial(() => {
      const items = this._read();
      const now = new Date();
      const item = {
        id: 'fb' + now.getTime().toString(36) + Math.random().toString(36).slice(2, 6),
        at: now.toISOString(),
        kind: KINDS.indexOf(input.kind) >= 0 ? input.kind : 'other',
        dishId: String(input.dishId || '').slice(0, 64),
        dishName: String(input.dishName || '').slice(0, 60),
        stallId: String(input.stallId || '').slice(0, 64),
        stallName: String(input.stallName || '').slice(0, 60),
        canteenId: String(input.canteenId || '').slice(0, 64),
        canteenName: String(input.canteenName || '').slice(0, 60),
        text: String(input.text || '').trim().slice(0, 200),
        ipHash: input.ip ? sha12(input.ip) : '',
        status: 'open'
      };
      items.push(item);
      // 超上限从最旧的删，但**绝不删未处理的**：先删已处理的旧记录
      if (items.length > this.max) {
        const keep = [];
        let over = items.length - this.max;
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (over > 0 && it.status !== 'open') { over--; continue; }
          keep.push(it);
        }
        // 已处理的删完了还超，就只能从头砍（极端情况）
        const final = keep.length > this.max ? keep.slice(keep.length - this.max) : keep;
        this._write(final);
        return { item, total: final.length };
      }
      this._write(items);
      return { item, total: items.length };
    });
  }

  /** 列表（管理员用）：默认只给待处理的，all=1 给全部 */
  list(opts) {
    const o = opts || {};
    return this._serial(() => {
      let items = this._read();
      if (!o.all) items = items.filter((it) => it.status === 'open');
      // 新的排前面：管理员最先看到最新报的
      items = items.slice().reverse();
      if (o.limit) items = items.slice(0, o.limit);
      const counts = { open: 0, done: 0, ignored: 0 };
      this._read().forEach((it) => { counts[it.status] = (counts[it.status] || 0) + 1; });
      return { items, counts, total: counts.open + counts.done + counts.ignored };
    });
  }

  /** 改状态：done / ignored / open（撤回） */
  setStatus(id, status, note) {
    return this._serial(() => {
      const items = this._read();
      const it = items.find((x) => x.id === id);
      if (!it) return null;
      if (['open', 'done', 'ignored'].indexOf(status) < 0) return null;
      it.status = status;
      if (status === 'open') {
        delete it.resolvedAt;
        delete it.resolveNote;
      } else {
        it.resolvedAt = new Date().toISOString();
        it.resolveNote = String(note || '').slice(0, 200);
      }
      this._write(items);
      return it;
    });
  }

  /** 同一个人对同一道菜，一天最多报 2 次（防止手滑连点） */
  countTodayByIpDish(ipHash, dishId, date) {
    return this._serial(() => {
      const prefix = String(date || '').slice(0, 10);
      return this._read().filter((it) =>
        it.ipHash === ipHash && it.dishId === dishId && String(it.at).slice(0, 10) === prefix
      ).length;
    });
  }
}

module.exports = { FeedbackStore, KINDS, KIND_TEXT, STATUS_TEXT, sha12 };
