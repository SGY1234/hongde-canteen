'use strict';
/**
 * 修正飞书表里「单选」字段的选项，让它和菜单数据里的真实名字对齐。
 *
 * 为什么需要这个脚本：
 *   飞书多维表格的「单选」字段只接受**选项列表里已有**的值。
 *   代码写进去的校区名来自 public/data/menu.json（实际是「鸿德主校区」），
 *   而表格建表时给的选项是「主校区」「东校区」——对不上，
 *   写入时会报 field validation failed，打分数据一条都存不进去。
 *
 * 这个脚本会把选项**补齐**（已有的保留，缺的加上），不会删除任何原有选项。
 *
 * 用法：
 *   node scripts/feishu-fix-options.js          只看当前选项和将要做的改动
 *   node scripts/feishu-fix-options.js --apply   真正写入
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://open.feishu.cn/open-apis';
const APPLY = process.argv.includes('--apply');

function loadEnv() {
  const out = {};
  for (const line of fs.readFileSync(path.join(ROOT, '.env.feishu'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return {
    appId: out.FEISHU_APP_ID, appSecret: out.FEISHU_APP_SECRET,
    appToken: out.FEISHU_APP_TOKEN, tableId: out.FEISHU_TABLE_ID
  };
}

async function call(method, url, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch (e) { /* 忽略 */ }
  return json;
}

const cfg = loadEnv();

/** 从菜单数据里算出每个字段真实会用到的值 */
function valuesFromMenu() {
  const menu = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'data', 'menu.json'), 'utf8'));
  const canteens = (menu.canteens || []).filter((c) => c && c.name).map((c) => c.name);
  const campuses = (menu.campuses || []).filter((c) => c && c.name).map((c) => c.name);
  return {
    '所属校区': Array.from(new Set(campuses.concat('主校区'))),
    '所属食堂': Array.from(new Set(canteens))
  };
}

(async () => {
  console.log('\n=== 飞书单选字段选项对齐 ===\n');
  const want = valuesFromMenu();
  console.log('  菜单数据里会写入的值：');
  for (const k of Object.keys(want)) console.log('    ' + k + ' → ' + want[k].join('、'));
  console.log('');

  const tk = await call('POST', '/auth/v3/tenant_access_token/internal', null, {
    app_id: cfg.appId, app_secret: cfg.appSecret
  });
  const token = tk.tenant_access_token;
  if (!token) { console.log('  ❌ 鉴权失败：' + JSON.stringify(tk).slice(0, 160)); return; }

  const fieldsRes = await call('GET',
    '/bitable/v1/apps/' + cfg.appToken + '/tables/' + cfg.tableId + '/fields?page_size=100', token);
  if (!fieldsRes || fieldsRes.code !== 0) {
    console.log('  ❌ 读字段失败：' + JSON.stringify(fieldsRes).slice(0, 200)); return;
  }

  const singleSelect = (fieldsRes.data.items || []).filter((f) => f.type === 3);
  if (!singleSelect.length) { console.log('  表里没有单选字段，无需处理。\n'); return; }

  for (const f of singleSelect) {
    const existing = ((f.property && f.property.options) || []).map((o) => o.name);
    const need = want[f.field_name];
    if (!need) {
      console.log('  「' + f.field_name + '」现有选项：' + existing.join('、') + '（菜单里没有这个字段，跳过）');
      continue;
    }
    const missing = need.filter((n) => existing.indexOf(n) === -1);
    console.log('  「' + f.field_name + '」现有选项：' + (existing.join('、') || '（空）'));
    if (!missing.length) { console.log('    ✅ 已经齐全，不需要改'); continue; }
    console.log('    缺少：' + missing.join('、') + ' → 需要补上');

    if (!APPLY) { console.log('    （预览模式，没写入。加 --apply 才会真正改）'); continue; }

    const options = existing.map((name) => ({ name })).concat(missing.map((name) => ({ name })));
    const r = await call('PUT',
      '/bitable/v1/apps/' + cfg.appToken + '/tables/' + cfg.tableId + '/fields/' + f.field_id,
      token, { field_name: f.field_name, type: 3, property: { options } });
    console.log('    写入 → code=' + (r && r.code) + '  ' + ((r && r.msg) || '').slice(0, 80));
  }

  // 复查
  if (APPLY) {
    const again = await call('GET',
      '/bitable/v1/apps/' + cfg.appToken + '/tables/' + cfg.tableId + '/fields?page_size=100', token);
    console.log('\n  复查结果：');
    for (const f of (again.data.items || []).filter((x) => x.type === 3)) {
      console.log('    「' + f.field_name + '」→ ' + ((f.property && f.property.options) || []).map((o) => o.name).join('、'));
    }
  }
  console.log('');
})().catch((e) => { console.error('出错：' + e.message); process.exit(1); });
