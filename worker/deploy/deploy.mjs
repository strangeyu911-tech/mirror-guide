/**
 * mirror-guide 批注 Worker · 部署脚本（走 Cloudflare 原生 API）
 * ------------------------------------------------------------------
 * 为什么不用 wrangler：本机 wrangler 跑不起来（缺 @cloudflare/workerd-windows-64，
 * 连 --help 都崩），所以这里直接复刻它的上传协议。
 *
 * 用法：
 *   CF_TOKEN=<api token> node deploy/deploy.mjs              # 部署（默认带 KV 绑定）
 *   CF_TOKEN=... node deploy/deploy.mjs --secrets            # 只补写 secret
 *   CF_TOKEN=... node deploy/deploy.mjs --dump 备份.json      # 导出全部批注（备份用）
 *   CF_TOKEN=... node deploy/deploy.mjs --kv=<namespace_id>  # 指定另一个 KV
 *
 * 环境变量：
 *   CF_TOKEN           必填，Cloudflare API Token
 *   CF_ACCOUNT_ID      可选，默认见下
 *   KV_ID              可选，KV namespace id，默认用已建好的那个
 *   GITHUB_TOKEN       可选，给了就顺手写入 Worker secret
 *   TURNSTILE_SECRET   可选，同上
 *   HASH_SALT          可选，同上
 *   CUSTOM_DOMAIN      可选，如 anno.strangeyu.xyz，给了就绑定自定义域
 *
 * 注意：PUT /workers/scripts/{name} 是**全量替换**，bindings 必须一次带全，
 *       否则已有的绑定会被静默抹掉。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const CF = 'https://api.cloudflare.com/client/v4';
const ACCOUNT = process.env.CF_ACCOUNT_ID || '320630a19eed9c18dc9371dd71d6f288';
const TOKEN = process.env.CF_TOKEN;
const NAME = process.env.WORKER_NAME || 'mirror-guide-anno';
const KV_ID = process.env.KV_ID || argVal('--kv') || '157f5a2bc56b417e93f5fb09d08cc799';
const CUSTOM_DOMAIN = process.env.CUSTOM_DOMAIN || '';

function argVal(flag) {
  const hit = process.argv.find((a) => a.startsWith(flag + '='));
  if (hit) return hit.slice(flag.length + 1);
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : '';
}

if (!TOKEN && !process.argv.includes('--help')) {
  console.error('缺少 CF_TOKEN 环境变量');
  process.exit(1);
}

async function api(method, url, body, isForm) {
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (!isForm && body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(CF + url, {
    method,
    headers,
    body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 400) }; }
  if (!res.ok || json.success === false) {
    const err = JSON.stringify(json.errors || json).slice(0, 500);
    throw new Error(`${method} ${url} → ${res.status} ${err}`);
  }
  return json.result;
}

const VARS = {
  ALLOWED_ORIGINS: 'https://mirror.strangeyu.xyz,https://strangeyu911-tech.github.io',
  SITE_BASE: 'https://mirror.strangeyu.xyz/',
  GH_OWNER: 'strangeyu911-tech',
  GH_REPO: 'mirror-guide-feedback',
  GH_ISSUE: '1',
  ALLOWED_PAGES: 'index.html,patch.html',
  LIMIT_PER_HOUR: '10',
  LIMIT_PER_DAY: '50',
  BODY_MIN: '5',
  BODY_MAX: '500',
  MAX_LINKS: '2',
  MIN_FILL_MS: '2500',
};

/* ------------------------------------------------------------ 部署 */

async function deploy() {
  const src = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');

  const bindings = Object.entries(VARS).map(([name, text]) => ({ type: 'plain_text', name, text }));
  if (KV_ID) bindings.push({ type: 'kv_namespace', name: 'KV', namespace_id: KV_ID });

  const metadata = {
    main_module: 'index.js',
    compatibility_date: '2026-10-01',
    bindings,
  };

  const fd = new FormData();
  fd.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  fd.append('index.js', new Blob([src], { type: 'application/javascript+module' }), 'index.js');

  console.log(`上传 Worker ${NAME}（${bindings.length} 个绑定${KV_ID ? '，含 KV' : '，无 KV'}）…`);
  const r = await api('PUT', `/accounts/${ACCOUNT}/workers/scripts/${NAME}`, fd, true);
  console.log('  ok  script id=' + (r.id || '(none)'));

  if (CUSTOM_DOMAIN) {
    console.log(`绑定自定义域 ${CUSTOM_DOMAIN} …`);
    try {
      await api('PUT', `/accounts/${ACCOUNT}/workers/domains`, {
        environment: 'production',
        hostname: CUSTOM_DOMAIN,
        service: NAME,
        zone_id: process.env.CF_ZONE_ID || '',
      });
      console.log('  ok');
    } catch (e) {
      console.log('  ! ' + e.message);
    }
  }

  console.log('\n健康检查：https://' + (CUSTOM_DOMAIN || NAME + '.workers.dev') + '/api/health');
}

/* ------------------------------------------------------------ secret */

async function secrets() {
  const list = [
    ['GITHUB_TOKEN', process.env.GITHUB_TOKEN],
    ['TURNSTILE_SECRET', process.env.TURNSTILE_SECRET],
    ['HASH_SALT', process.env.HASH_SALT],
  ].filter(([, v]) => v);

  if (!list.length) {
    console.log('没有提供任何 secret，跳过。');
    return;
  }
  console.log('写入 secret…');
  for (const [k, v] of list) {
    // type 必须显式给，否则 API 报 "unsupported type ''"
    await api('PUT', `/accounts/${ACCOUNT}/workers/scripts/${NAME}/secrets`, {
      name: k,
      type: 'secret_text',
      text: v,
    });
    console.log(`  ok  ${k}`);
  }
}

/* ------------------------------------------------------------ 导出备份 */

async function dump(outFile) {
  const page = await api('GET', `/accounts/${ACCOUNT}/storage/kv/namespaces/${KV_ID}/keys?limit=1000`);
  const keys = page.filter((k) => k.name.startsWith('anno:'));
  const records = [];
  for (const k of keys) {
    const raw = await api('GET', `/accounts/${ACCOUNT}/storage/kv/namespaces/${KV_ID}/values/${encodeURIComponent(k.name)}`);
    try { records.push(typeof raw === 'string' ? JSON.parse(raw) : raw); } catch { /* 跳过坏记录 */ }
  }
  records.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  fs.writeFileSync(outFile, JSON.stringify(records, null, 2), 'utf8');
  console.log(`已导出 ${records.length} 条批注 → ${outFile}`);
}

/* ------------------------------------------------------------ main */

const main = async () => {
  if (process.argv.includes('--help')) {
    console.log('用法见文件头部注释。');
    return;
  }
  const dumpIdx = process.argv.indexOf('--dump');
  if (dumpIdx >= 0) {
    await dump(process.argv[dumpIdx + 1] || 'annotations-dump.json');
    return;
  }
  if (process.argv.includes('--secrets')) {
    await secrets();
    return;
  }
  await deploy();
  await secrets();
};

main().catch((e) => {
  console.error('\n失败：' + e.message);
  process.exit(1);
});
