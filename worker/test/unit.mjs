/**
 * Worker 纯逻辑单元测试（不依赖 Cloudflare 运行时）
 * 运行：node test/unit.mjs
 *
 * v2 新增覆盖：
 *   - publicView 字段白名单（公开可见后，这是唯一的安全边界）
 *   - 认真通道的两道闸（正文下限 / 改法必填）
 *   - syncIssueStates 懒刷新的 TTL 命中与失败回退
 */

import { validate, renderComment, fence, publicView, syncIssueStates } from '../src/index.js';

const cfg = {
  bodyMin: 15,
  bodyMinCasual: 1,
  bodyMax: 500,
  fixMin: 2,
  fixMax: 500,
  replyMax: 200,
  nameMax: 40,
  maxLinks: 2,
  minFillMs: 2500,
  allowedPages: ['index.html', 'patch.html'],
  siteBase: 'https://mirror.strangeyu.xyz/',
  ghOwner: 'strangeyu911-tech',
  ghRepo: 'mirror-guide-feedback',
  ghLabel: 'anno',
  statusTtlSec: 600,
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
ok('默认类型是 casual', v.ok && v.type === 'casual');

console.log('\n[validate · 拒绝]');
ok('id 太短', validate({ ...base, id: 'x' }, cfg).error === 'bad_id');
ok('page 不在白名单', validate({ ...base, page: 'evil.html' }, cfg).error === 'bad_page');
ok('sec 含非法字符', validate({ ...base, sec: 's42; DROP' }, cfg).error === 'bad_sec');
ok('偏移不是整数', validate({ ...base, sel: { ...base.sel, start: 1.5 } }, cfg).error === 'bad_sel_offset');
ok('偏移方向反了', validate({ ...base, sel: { ...base.sel, start: 30, end: 10 } }, cfg).error === 'bad_sel_range');
ok('选区跨度过大', validate({ ...base, sel: { ...base.sel, end: 99999 } }, cfg).error === 'bad_sel_range');
ok('正文超长', validate({ ...base, body: '啊'.repeat(501) }, cfg).error === 'body_too_long');
ok('中文按码点计数（500 字正好通过）', validate({ ...base, body: '啊'.repeat(500) }, cfg).ok);
ok('链接过多', validate({ ...base, body: 'http://a.com http://b.com http://c.com 看这三个' }, cfg).error === 'too_many_links');
ok('联系方式格式非法', validate({ ...base, contact: 'not-an-email' }, cfg).error === 'bad_contact');
ok('手机号可通过', validate({ ...base, contact: '13800138000' }, cfg).ok);
ok('批注通道允许一句话（1 字）', validate({ ...base, body: '好' }, cfg).ok);

console.log('\n[validate · v2 认真通道两道闸]');
const ser = { ...base, type: 'serious', kind: 'data' };
ok('认真通道缺「建议改成什么样」被拒', validate(ser, cfg).error === 'fix_required');
ok('认真通道正文不足 15 字被拒',
  validate({ ...ser, fix: '应改成 2.26%（中指口径）', body: '数据不对吧' }, cfg).error === 'body_too_short');
ok('认真通道合格通过',
  validate({ ...ser, fix: '应改成 2.26%（中指口径）' }, cfg).ok);
ok('无效 kind 回落到 suggest',
  validate({ ...ser, kind: 'hack', fix: '改成 X' }, cfg).kind === 'suggest');

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

console.log('\n[renderComment · v2 认真通道正文]');
const mdSer = renderComment(validate({ ...ser, fix: '应改成 2.26%' }, cfg), cfg);
ok('带类型行', mdSer.includes('**类型**：质疑数据'));
ok('带「建议改成」段', mdSer.includes('**建议改成**：'));
ok('带上下文行', mdSer.includes('**上下文**'));

console.log('\n[renderComment · 昵称与联系方式]');
const named = renderComment(validate({ ...base, name: '张三', contact: 'a@b.com' }, cfg), cfg);
ok('显示昵称', named.includes('张三'));
ok('显示联系方式', named.includes('a@b.com'));

/* ------------------------------------------------ v2 · publicView 白名单 */

const SECRET_FIELDS = ['ip_hash', 'contact', 'reader_id', 'gh_comment_id', 'gh_error', 'hidden'];

console.log('\n[publicView · 敏感字段一律不外泄]');
const secretRec = {
  id: 'a1b2c3d4-1111-2222-3333-444455556666',
  page: 'index.html',
  sec: 's42',
  type: 'serious',
  kind: 'data',
  sel_start: 10,
  sel_end: 30,
  sel_exact: '年租金先打 11/12 的折扣',
  sel_prefix: '所以你自己算净回报时，',
  sel_suffix: '，这一步会让很多房子',
  body: '这个 2.86% 的口径和贝壳的不可直接相减。',
  fix: '补一句口径说明',
  name: '一枚硬币',
  contact: 'coin@example.com',
  reader_id: 'x301',
  ip_hash: 'deadbeefdeadbeef',
  status: 'open',
  gh_issue: 12,
  gh_error: null,
  reactions: { useful: ['a', 'b'], same: [], doubt: ['x'] },
  replies: [{ name: '作者', au: true, text: '已收到' }],
  hidden: false,
  created_at: '2026-10-14T00:00:00.000Z',
};
const pv = publicView(secretRec);
SECRET_FIELDS.forEach((f) => ok('不外泄 ' + f, !(f in pv), Object.keys(pv)));
ok('保留 id', pv.id === secretRec.id);
ok('保留 sec', pv.sec === 's42');
ok('保留 body', pv.body === secretRec.body);
ok('保留 fix', pv.fix === '补一句口径说明');
ok('保留 kind', pv.kind === 'data');
ok('保留 issue 号', pv.issue === 12);
ok('reactions 出计数不出名单', pv.reactions.useful === 2 && pv.reactions.doubt === 1);
ok('replies 不出名单但保留内容', Array.isArray(pv.replies) && pv.replies.length === 1);
ok('有作者回复 ⇒ status 变 ack', pv.status === 'ack');

console.log('\n[publicView · 轻批注不带 fix/kind]');
const pvCas = publicView({ ...secretRec, type: 'casual', kind: null, fix: null, replies: [] });
ok('无 kind', !('kind' in pvCas));
ok('无 fix', !('fix' in pvCas));
ok('无 issue', !('issue' in pvCas));
ok('status 保持 open', pvCas.status === 'open');

/* ------------------------------------------- v2 · 状态懒刷新（mock） */

function mkKV(init = {}) {
  const m = new Map(Object.entries(init));
  return {
    get: (k) => Promise.resolve(m.has(k) ? m.get(k) : null),
    put: (k, v) => { m.set(k, v); return Promise.resolve(); },
    list: () => Promise.resolve({ keys: [], list_complete: true }),
    _m: m,
  };
}
function withFetch(impl) {
  const orig = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = orig; };
}

const syncCfg = { ...cfg };

console.log('\n[syncIssueStates · TTL 命中则不打 GitHub]');
const kv1 = mkKV({ 'issuestate:ts': String(Date.now()), 'issuestate:map': JSON.stringify({ 12: { state: 'open' } }) });
let calls = 0;
const restore1 = withFetch(async () => { calls++; throw new Error('不该被调用'); });
const s1 = await syncIssueStates({ KV: kv1, GITHUB_TOKEN: 't' }, syncCfg);
restore1();
ok('未发起请求', calls === 0);
ok('返回缓存中的状态', s1 && s1.map && s1.map[12] && s1.map[12].state === 'open');

console.log('\n[syncIssueStates · 过期才拉一次]');
const kv2 = mkKV({ 'issuestate:ts': String(Date.now() - 3600_000), 'issuestate:map': JSON.stringify({ 12: { state: 'open' } }) });
let calls2 = 0;
const restore2 = withFetch(async () => {
  calls2++;
  return {
    ok: true,
    status: 200,
    json: async () => ([
      { number: 12, state: 'closed', closed_at: '2026-10-14T01:00:00Z', comments: 2 },
      { number: 13, state: 'open', comments: 0 },
      { number: 14, state: 'open', comments: 0, pull_request: { url: 'x' } },
    ]),
  };
});
const s2 = await syncIssueStates({ KV: kv2, GITHUB_TOKEN: 't' }, syncCfg);
restore2();
ok('只打了一次', calls2 === 1);
ok('拿到关闭状态', s2.map[12].state === 'closed');
ok('PR 被排除', !(14 in s2.map));
ok('写回了 KV 时间戳', Number(kv2._m.get('issuestate:ts')) > Date.now() - 5000);

console.log('\n[syncIssueStates · GitHub 挂了就退回旧缓存]');
const oldMap = JSON.stringify({ 12: { state: 'open' } });
const kv3 = mkKV({ 'issuestate:ts': String(Date.now() - 3600_000), 'issuestate:map': oldMap });
const restore3 = withFetch(async () => { throw new Error('network down'); });
const s3 = await syncIssueStates({ KV: kv3, GITHUB_TOKEN: 't' }, syncCfg);
restore3();
ok('不抛异常', !!s3);
ok('沿用旧状态', s3.map[12].state === 'open');
ok('时间戳未被刷新', Number(kv3._m.get('issuestate:ts')) < Date.now() - 3500_000);

console.log('\n[syncIssueStates · 没配 token 就不同步]');
ok('返回 null', (await syncIssueStates({ KV: mkKV() }, syncCfg)) === null);

console.log('\n结果：' + pass + ' 通过，' + fail + ' 失败\n');
process.exit(fail ? 1 : 0);
