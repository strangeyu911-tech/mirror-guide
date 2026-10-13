/**
 * Worker 纯逻辑单元测试（不依赖 Cloudflare 运行时）
 * 运行：node test/unit.mjs
 */

import { validate, renderComment, fence } from '../src/index.js';

const cfg = {
  bodyMin: 5,
  bodyMax: 500,
  maxLinks: 2,
  minFillMs: 2500,
  allowedPages: ['index.html', 'patch.html'],
  siteBase: 'https://mirror.strangeyu.xyz/',
};

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
}

const base = {
  id: 'a1b2c3d4-1111-2222-3333-444455556666',
  page: 'index.html',
  sec: 's42',
  sel: {
    start: 10,
    end: 30,
    exact: '年租金先打 11/12 的折扣',
    prefix: '所以你自己算净回报时，',
    suffix: '，这一步会让很多看着 3% 以上的房子',
  },
  body: '这里最好给个例子算一遍，否则读者不知道打回原形是什么意思。',
};

console.log('\n[fence]');
ok('普通文本用三反引号', fence('abc') === '```\nabc\n```', fence('abc'));
ok('含三反引号时升到四个', fence('a```b') === '````\na```b\n````', fence('a```b'));
ok('含四反引号时升到五个', fence('a````b').startsWith('`````'));

console.log('\n[validate · 通过]');
const v = validate(base, cfg);
ok('正常批注通过', v.ok, v);
ok('返回章节正确', v.ok && v.sec === 's42');
ok('返回偏移正确', v.ok && v.sel_start === 10 && v.sel_end === 30);
ok('昵称缺省为 null', v.ok && v.name === null);
ok('非法 readerId 被丢弃', validate({ ...base, readerId: 'a b!' }, cfg).readerId === '');

console.log('\n[validate · 拒绝]');
ok('id 太短', validate({ ...base, id: 'x' }, cfg).error === 'bad_id');
ok('page 不在白名单', validate({ ...base, page: 'evil.html' }, cfg).error === 'bad_page');
ok('sec 含非法字符', validate({ ...base, sec: 's42; DROP' }, cfg).error === 'bad_sec');
ok('偏移不是整数', validate({ ...base, sel: { ...base.sel, start: 1.5 } }, cfg).error === 'bad_sel_offset');
ok('偏移方向反了', validate({ ...base, sel: { ...base.sel, start: 30, end: 10 } }, cfg).error === 'bad_sel_range');
ok('选区跨度过大', validate({ ...base, sel: { ...base.sel, end: 99999 } }, cfg).error === 'bad_sel_range');
ok('正文太短', validate({ ...base, body: '太短' }, cfg).error === 'body_too_short');
ok('正文超长', validate({ ...base, body: '啊'.repeat(501) }, cfg).error === 'body_too_long');
ok('中文按码点计数（500 字正好通过）', validate({ ...base, body: '啊'.repeat(500) }, cfg).ok);
ok('链接过多', validate({ ...base, body: 'http://a.com http://b.com http://c.com 看这三个' }, cfg).error === 'too_many_links');
ok('联系方式格式非法', validate({ ...base, contact: 'not-an-email' }, cfg).error === 'bad_contact');
ok('手机号可通过', validate({ ...base, contact: '13800138000' }, cfg).ok);

console.log('\n[反自动化 · 蜜罐与提交耗时]');
const past = Date.now() - 60000;
ok('蜜罐留空通过', validate({ ...base, hp: '', t0: past }, cfg).ok);
ok('蜜罐填了就拒', validate({ ...base, hp: 'http://spam.example', t0: past }, cfg).error === 'rejected');
ok('蜜罐缺省也不拦', validate({ ...base, t0: past }, cfg).ok);
ok('耗时充足通过', validate({ ...base, t0: past }, cfg).ok);
ok('提交过快被拒', validate({ ...base, t0: Date.now() }, cfg).error === 'too_fast');
ok('不给 t0 则不判耗时', validate({ ...base }, cfg).ok);
ok('minFillMs=0 时关闭判定', validate({ ...base, t0: Date.now() }, { ...cfg, minFillMs: 0 }).ok);

console.log('\n[renderComment · 防注入]');
const md = renderComment(v, cfg);
ok('正文被代码块包裹', md.includes('```\n' + base.body + '\n```'));
ok('原文被代码块包裹', md.includes('```\n' + base.sel.exact + '\n```'));
ok('含页码锚点链接', md.includes('https://mirror.strangeyu.xyz/index.html#s42'));
ok('标注读者标识', md.includes('匿名读者'));
ok('含批注 id', md.includes(base.id));

const inj = validate({
  ...base,
  body: '看到 #12 就 fixes #1 吧 @someone 再配 ![x](http://evil.example/x.png) 这条',
}, cfg);
const md2 = renderComment(inj, cfg);
const codeBlocks = md2.match(/```[\s\S]*?```/g) || [];
const injInside = codeBlocks.some((b) => b.includes('#12') && b.includes('@someone') && b.includes('fixes #1'));
ok('注入内容全部落在代码块内', injInside);
ok('代码块外没有裸的 #12', !/^#12/m.test(md2.replace(/```[\s\S]*?```/g, '')));
ok('readerId 出现在读者行', renderComment(validate({ ...base, readerId: 'x301' }, cfg), cfg).includes('· x301'));

console.log('\n[renderComment · 昵称与联系方式]');
const named = renderComment(validate({ ...base, name: '张三', contact: 'a@b.com' }, cfg), cfg);
ok('显示昵称', named.includes('张三'));
ok('显示联系方式', named.includes('a@b.com'));

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
