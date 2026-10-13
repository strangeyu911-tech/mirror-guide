#!/usr/bin/env node
/**
 * 给 patch.html 的补丁卡片补上批注锚点 id。
 * ------------------------------------------------------------
 * 背景：读者批注层（annotate.js）有两套章节模型——
 *   · 标题型：id 挂在 h1~h6 上（index.html 用）
 *   · 容器型：id 挂在包住整块内容的元素上，整棵子树都归它（patch.html 用）
 * 补丁卡片是"容器型"：每张 <article class="pcard"> 需要 id="pNN"，
 * NN 取卡片自己的序号 <span class="pc-no">NN</span>。
 *
 * 用法：
 *   node tools/add-card-ids.cjs patch.html
 *   node tools/add-card-ids.cjs patch.html --check   # 只报告，不写
 *
 * 幂等：已带 id 的卡片不动；重复执行结果一致。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const file = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!file) {
  console.error('用法: node tools/add-card-ids.cjs <patch.html> [--check]');
  process.exit(2);
}

const abs = path.resolve(file);
const html = fs.readFileSync(abs, 'utf8');

const MARK = '<article class="pcard"';
const parts = html.split(MARK);

if (parts.length < 2) {
  console.error('没找到任何 <article class="pcard">，文件结构可能变了：' + abs);
  process.exit(1);
}

let added = 0, already = 0, missed = [];
const seen = new Set();

for (let i = 1; i < parts.length; i++) {
  const chunk = parts[i];
  if (/^\s+id="/.test(chunk)) { already++; continue; }
  // chunk 形如： data-sec="cash" data-patch="up" ...>\n    <div class="pc-head"><span class="pc-no">01</span>
  const m = chunk.match(/^([^>]*>[\s\S]{0,400}?<span class="pc-no">(\d{1,3})<\/span>)/);
  if (!m) { missed.push(i); continue; }
  const no = String(m[2]).padStart(2, '0');
  const id = 'p' + no;
  if (seen.has(id)) { missed.push(i + '(dup ' + id + ')'); continue; }
  seen.add(id);
  parts[i] = ' id="' + id + '"' + chunk;
  added++;
}

const out = parts.join(MARK);

console.log('卡片总数      : ' + (parts.length - 1));
console.log('新加 id       : ' + added);
console.log('本来就有 id   : ' + already);
console.log('跳过（异常）  : ' + (missed.length ? missed.join(', ') : '无'));

if (missed.length) {
  console.error('有卡片没能定位到 pc-no，未写入。请先修好这些卡片。');
  process.exit(1);
}
if (checkOnly) process.exit(0);

fs.writeFileSync(abs, out, 'utf8');
console.log('已写入：' + abs);

// 复核：写回后再数一遍
const again = fs.readFileSync(abs, 'utf8');
const ids = again.match(/<article class="pcard" id="p\d{2}"/g) || [];
console.log('复核：带 id 的卡片 ' + ids.length + ' 张，序号 ' + (ids.length ? ids[0].match(/p\d{2}/)[0] + ' … ' + ids[ids.length - 1].match(/p\d{2}/)[0] : '-'));
