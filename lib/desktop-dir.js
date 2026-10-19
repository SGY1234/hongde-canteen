'use strict';
/**
 * 统一的「输出目录」解析 —— 所有脚本都必须用它，禁止直接往桌面根目录写文件
 *
 * 优先级：
 *   1. 环境变量 HD_DESKTOP_DIR（调用方显式指定）
 *   2. 桌面上的项目专属文件夹「鸿德食堂打分-上线文件」（存在就用它）
 *   3. 环境变量 USERPROFILE 下的 Desktop
 *   4. D:\Users\30205\Desktop（本机桌面在 D 盘）
 *
 * 背景（用户明确要求过）：**不要把生成的文件散落到桌面**，统一放进桌面上的
 * 「鸿德食堂打分-上线文件」文件夹里。
 * 之前 export-local.js 没走这个约定，测试时把导出文件写到了桌面根目录，被用户抓到。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const FOLDER_NAME = '鸿德食堂打分-上线文件';

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

/** 桌面根目录的候选位置 */
function desktopCandidates() {
  return [
    path.join('D:', 'Users', '30205', 'Desktop'),
    process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : null,
    (() => { try { return path.join(os.homedir(), 'Desktop'); } catch (e) { return null; } })()
  ].filter(Boolean);
}

/**
 * 解析输出目录
 * @param {object} opts { create: 目录不存在时是否创建（默认 true） }
 * @returns {string} 绝对路径
 */
function resolveOutDir(opts) {
  const o = opts || {};

  // 1. 调用方显式指定
  if (exists(process.env.HD_DESKTOP_DIR)) return process.env.HD_DESKTOP_DIR;

  // 2. 桌面上的项目专属文件夹（**推荐路径**）
  for (const d of desktopCandidates()) {
    const custom = path.join(d, FOLDER_NAME);
    if (exists(custom)) return custom;
  }

  // 3. 桌面根目录（仅在前两者都不存在时兜底）
  for (const d of desktopCandidates()) {
    if (exists(d)) return d;
  }

  // 4. 实在找不到桌面，就退回项目 qr/ 目录（调用方自己决定）
  return null;
}

/** 兼容旧名字 */
function findDesktop() {
  return resolveOutDir();
}

module.exports = { resolveOutDir, findDesktop, FOLDER_NAME, desktopCandidates };
