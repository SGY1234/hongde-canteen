'use strict';
/**
 * 把指定用户（用邮箱或手机号识别）加为飞书表格的协作者，让他能自己在浏览器里打开表格看数据。
 *
 * 为什么需要：表格是**应用**建的，所有权在应用手里，
 * 用户自己的飞书账号默认不在协作者名单里 → 打开表格会显示「没有权限访问」。
 *
 * 前置条件（应用需要这些权限，缺了脚本会明确告诉你去开哪个）：
 *   - drive:drive                （修改协作者、设置权限）
 *   - contact:user.id:readonly   （用邮箱/手机号查用户的 open_id）
 *
 * 用法：
 *   node scripts/feishu-share-table.js                         # 只看当前协作者
 *   node scripts/feishu-share-table.js --email a@b.com --apply
 *   node scripts/feishu-share-table.js --email a@b.com --apply --perm full_access
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://open.feishu.cn/open-apis';
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

function argValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

const EMAIL = argValue('--email');
const MOBILE = argValue('--mobile');
const PERM = argValue('--perm') || 'full_access';   // view / edit / full_access

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
  return { status: res.status, json };
}

/** 把飞书的权限不足错误翻译成人话 */
function explainScope(json) {
  const msg = (json && json.msg) || '';
  const m = msg.match(/\[([a-z_:.,\s]+)\]/);
  if ((json && json.code) === 99991672 && m) {
    console.log('\n  ⚠️ 应用缺少权限：' + m[1]);
    console.log('  去这里勾上（和上次开 bitable 一样的操作），然后重新发布版本：');
    console.log('  https://open.feishu.cn/app/' + loadEnv().appId + '/auth');
    return true;
  }
  return false;
}

const cfg = loadEnv();

(async () => {
  console.log('\n=== 飞书表格协作者管理 ===\n');
  const tk = await call('POST', '/auth/v3/tenant_access_token/internal', null, {
    app_id: cfg.appId, app_secret: cfg.appSecret
  });
  const token = tk.json && tk.json.tenant_access_token;
  if (!token) { console.log('  ❌ 鉴权失败：' + JSON.stringify(tk.json).slice(0, 160)); return; }

  console.log('  表格 app_token：' + cfg.appToken);
  console.log('  所有者（owner）需要把用户加为协作者，用户才能打开。\n');

  // 1. 当前协作者
  const cur = await call('GET', '/drive/v1/permissions/' + cfg.appToken + '/members?type=bitable', token);
  if (cur.json && cur.json.code === 0) {
    console.log('  当前协作者：');
    for (const it of (cur.json.data.items || [])) {
      console.log('    - ' + it.member_type + ' : ' + it.member_id + '  (' + it.perm + ')');
    }
    const hasUser = (cur.json.data.items || []).some((x) => x.member_type !== 'appid');
    if (!hasUser) console.log('    ⚠️ 名单里**没有任何人类用户** → 所以用户打开表格会说"没有权限访问"');
  } else {
    console.log('  读协作者失败：' + JSON.stringify(cur.json).slice(0, 200));
    if (explainScope(cur.json)) return;
  }

  if (!EMAIL && !MOBILE) {
    console.log('\n  想加人请在命令里带上邮箱或手机号，例如：');
    console.log('    node scripts\\feishu-share-table.js --email 你的邮箱@example.com --apply\n');
    return;
  }

  // 2. 查 open_id
  console.log('\n  查询用户 ID（' + (EMAIL ? '邮箱 ' + EMAIL : '手机号 ' + MOBILE) + '）…');
  const body = EMAIL ? { emails: [EMAIL] } : { mobiles: [MOBILE] };
  const idr = await call('POST', '/contact/v3/users/batch_get_id?user_id_type=open_id', token, body);
  if (idr.json && idr.json.code === 0) {
    console.log('    返回：' + JSON.stringify(idr.json.data).slice(0, 400));
  } else {
    console.log('    查不到（code=' + (idr.json && idr.json.code) + '）：' + ((idr.json && idr.json.msg) || '').slice(0, 120));
    if (explainScope(idr.json)) return;
  }

  const users = (idr.json && idr.json.data && idr.json.data.user_list) || [];
  const hit = users.find((u) => u.user_id) || {};
  const openId = hit.user_id;
  if (!openId) {
    console.log('\n  ❌ 没解析出 open_id，无法自动添加。');
    console.log('     替代办法：让用户直接在表格页面点「申请阅读权限」，');
    console.log('     或者用创建应用的那个飞书账号登录后重试。\n');
    return;
  }
  console.log('    open_id = ' + openId);

  if (!APPLY) { console.log('\n  （预览模式，没有真的添加。加 --apply 才会写入）\n'); return; }

  // 3. 加为协作者
  console.log('\n  添加为协作者（perm=' + PERM + '）…');
  const add = await call('POST', '/drive/v1/permissions/' + cfg.appToken + '/members?type=bitable&need_notification=true', token, {
    member_type: 'openid',
    member_id: openId,
    perm: PERM,
    perm_type: 'container'
  });
  console.log('    → code=' + (add.json && add.json.code) + '  ' + ((add.json && add.json.msg) || '').slice(0, 120));
  if (add.json && add.json.code !== 0) { explainScope(add.json); return; }

  // 4. 复查
  const again = await call('GET', '/drive/v1/permissions/' + cfg.appToken + '/members?type=bitable', token);
  console.log('\n  复查协作者名单：');
  for (const it of ((again.json && again.json.data && again.json.data.items) || [])) {
    console.log('    - ' + it.member_type + ' : ' + it.member_id + '  (' + it.perm + ')');
  }
  console.log('\n  ✅ 完成。让用户重新打开表格链接即可。\n');
})().catch((e) => { console.error('出错：' + e.message); process.exit(1); });
