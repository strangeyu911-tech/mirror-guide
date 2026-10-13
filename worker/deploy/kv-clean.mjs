// mirror-guide 批注 KV 清理工具
// 用法：
//   node kv-clean.mjs            # 只列出（dry-run）
//   node kv-clean.mjs --apply    # 真删
// 说明：token 只从环境变量 CF_TOKEN 读，绝不落盘、绝不提交。
import { readFileSync } from 'node:fs';

const ACCOUNT = '320630a19eed9c18dc9371dd71d6f288';
const NS = '157f5a2bc56b417e93f5fb09d08cc799';

const TOKEN = process.env.CF_TOKEN
  || (process.env.CF_TOKEN_FILE ? readFileSync(process.env.CF_TOKEN_FILE, 'utf8').trim() : '');
if (!TOKEN) {
  console.error('缺少 token：请设 CF_TOKEN 或 CF_TOKEN_FILE 环境变量');
  process.exit(1);
}
const APPLY = process.argv.includes('--apply');
const BASE = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/storage/kv/namespaces/${NS}`;
const H = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

// 列出全部 key（分页）
async function listKeys() {
  const out = [];
  let cursor = '';
  for (let i = 0; i < 50; i++) {
    const u = `${BASE}/keys?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const r = await fetch(u, { headers: H });
    const j = await r.json();
    if (!j.success) throw new Error('list failed: ' + JSON.stringify(j.errors));
    for (const k of j.result) out.push(k.name);
    cursor = j.result_info?.cursor || '';
    if (!cursor) break;
  }
  return out;
}

const keys = await listKeys();
console.log(`KV 中共 ${keys.length} 个 key`);
if (keys.length) console.log(keys.map((k) => '  ' + k).join('\n'));

if (!APPLY) {
  console.log('\n(dry-run) 加 --apply 才会真删');
} else if (keys.length) {
  // bulk 删除：一次最多 10000 个
  const r = await fetch(`${BASE}/bulk`, { method: 'DELETE', headers: H, body: JSON.stringify(keys) });
  const j = await r.json();
  console.log(`\n删除结果 success=${j.success}`, JSON.stringify(j.errors));
  const left = await listKeys();
  console.log(`剩余 ${left.length} 个 key`);
} else {
  console.log('\n无需删除');
}
