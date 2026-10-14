/**
 * mirror-guide 读者批注 Worker —— v2（公开可见版）
 * ------------------------------------------------------------
 * 相对档 1.5 的两处结构性变化（2026-10-14 拍板）：
 *
 *   1. 【可见性】批注公开：任何人可以读到这一页的全部批注。
 *      ⇒ 反馈仓库由 private 转 public；输出必须走**字段白名单**，
 *        绝不能把 ip_hash / contact / gh_comment_id / reader_id 吐出去。
 *
 *   2. 【状态回流】「已处理」= GitHub issue 关闭，自动同步，不需要作者手动点。
 *      ⇒ 每条「认真的建议」生成一个**独立 issue**（不再聚合到 issue #1 的 comment）。
 *        这是自动同步的前提：聚合 comment 无法表达 per-批注 的关闭状态。
 *      ⇒ 同步方式 = **懒刷新**：读列表时检查状态缓存是否过期（STATUS_TTL_SEC），
 *        过期才去 GitHub 拉一次 issues 列表写回 KV。零新增组件，无 cron/webhook。
 *
 * 沿用档 1.5 的防线（均已实测）：
 *   - 读者零账号：Worker 持维护者凭据代发，读者在 GitHub 上不出场。
 *   - 蜜罐 hp / 提交耗时 t0 / IP hash 限流 / 同 id 幂等。
 *   - 读者原文一律 fence() 代码块包裹后写入，防 #12 / fixes #1 / @someone / ![](url) 被渲染。
 *   - GITHUB_TOKEN 只存服务端 secret，任何情况下不返回前端。
 */

const DEFAULTS = {
  LIMIT_PER_HOUR: '10',
  LIMIT_PER_DAY: '50',
  LIMIT_READ_PER_MIN: '60',
  BODY_MIN: '15',        // 认真通道：说清"哪里不对"的下限
  BODY_MIN_CASUAL: '1',  // 批注通道：只要非空
  BODY_MAX: '500',
  FIX_MIN: '2',
  FIX_MAX: '500',
  REPLY_MAX: '200',
  NAME_MAX: '40',
  MAX_LINKS: '2',
  MIN_FILL_MS: '2500',
  ALLOWED_PAGES: 'index.html,patch.html',
  SITE_BASE: 'https://mirror.strangeyu.xyz/',
  GH_OWNER: 'strangeyu911-tech',
  GH_REPO: 'mirror-guide-feedback',
  GH_ISSUE: '1',
  GH_LABEL: 'anno',
  STATUS_TTL_SEC: '600',
  PUBLIC_READ: '1',
  ALLOWED_ORIGINS: 'https://mirror.strangeyu.xyz,https://strangeyu911-tech.github.io',
};

const KINDS = {
  suggest: { label: '建议修改', gh: 'kind:suggestion' },
  data: { label: '质疑数据', gh: 'kind:data' },
  evidence: { label: '补充证据', gh: 'kind:evidence' },
};

const REACTIONS = ['useful', 'same', 'doubt'];

export default {
  async fetch(request, env, ctx) {
    const cfg = new Config(env);
    const origin = request.headers.get('Origin') || '';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cfg.cors(origin) });
    }

    if (url.pathname === '/api/health') {
      return reply({
        ok: true,
        ts: Date.now(),
        store: env.KV ? 'kv' : 'none',
        publicRead: cfg.publicRead,
        turnstile: !!env.TURNSTILE_SECRET,
        github: !!env.GITHUB_TOKEN,
        admin: !!env.ADMIN_TOKEN,
      }, 200, cfg, origin);
    }

    /* ---------- 写：提交批注 ---------- */
    if (url.pathname === '/api/anno' && request.method === 'POST') {
      return handleAnno(request, env, cfg, origin);
    }

    /* ---------- 读：某一页的公开批注（带状态懒刷新） ---------- */
    if (url.pathname === '/api/annos' && request.method === 'GET') {
      return handleList(request, env, cfg, origin, url);
    }

    /* ---------- 互动：emoji 反应 / 回复 ---------- */
    if (url.pathname === '/api/react' && request.method === 'POST') {
      return handleReact(request, env, cfg, origin);
    }
    if (url.pathname === '/api/reply' && request.method === 'POST') {
      return handleReply(request, env, cfg, origin);
    }

    /* ---------- 管理：隐藏 / 取消隐藏 / 标记已处理（需 ADMIN_TOKEN） ---------- */
    if (url.pathname === '/api/admin/hide' && request.method === 'POST') {
      return handleAdmin(request, env, cfg, origin);
    }

    return reply({ ok: false, error: 'not_found' }, 404, cfg, origin);
  },
};

/* ---------------------------------------------------------------- config */

class Config {
  constructor(env) {
    const v = (k) => env[k] ?? DEFAULTS[k];
    this.limitPerHour = Number(v('LIMIT_PER_HOUR'));
    this.limitPerDay = Number(v('LIMIT_PER_DAY'));
    this.limitReadPerMin = Number(v('LIMIT_READ_PER_MIN'));
    this.bodyMin = Number(v('BODY_MIN'));
    this.bodyMinCasual = Number(v('BODY_MIN_CASUAL'));
    this.bodyMax = Number(v('BODY_MAX'));
    this.fixMin = Number(v('FIX_MIN'));
    this.fixMax = Number(v('FIX_MAX'));
    this.replyMax = Number(v('REPLY_MAX'));
    this.nameMax = Number(v('NAME_MAX'));
    this.maxLinks = Number(v('MAX_LINKS'));
    this.minFillMs = Number(v('MIN_FILL_MS'));
    this.allowedPages = String(v('ALLOWED_PAGES')).split(',').map((s) => s.trim()).filter(Boolean);
    this.siteBase = String(v('SITE_BASE'));
    this.ghOwner = v('GH_OWNER');
    this.ghRepo = v('GH_REPO');
    this.ghIssue = v('GH_ISSUE');
    this.ghLabel = String(v('GH_LABEL'));
    this.statusTtlSec = Number(v('STATUS_TTL_SEC'));
    this.publicRead = String(v('PUBLIC_READ')) !== '0';
    this.origins = String(v('ALLOWED_ORIGINS')).split(',').map((s) => s.trim()).filter(Boolean);
    this.salt = env.HASH_SALT || '';
  }

  originAllowed(origin) {
    return !!origin && this.origins.includes(origin);
  }

  cors(origin) {
    const h = {
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Token',
      'Access-Control-Max-Age': '86400',
    };
    if (this.originAllowed(origin)) h['Access-Control-Allow-Origin'] = origin;
    return h;
  }
}

function reply(obj, status, cfg, origin, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...cfg.cors(origin),
      ...extra,
    },
  });
}

function json(data, cfg, origin, cacheSec = 0) {
  const extra = {};
  if (cacheSec > 0) extra['Cache-Control'] = `public, max-age=${cacheSec}`;
  return reply(data, 200, cfg, origin, extra);
}

/* ------------------------------------------------------------------ main */

async function handleAnno(request, env, cfg, origin) {
  if (!cfg.originAllowed(origin)) {
    return reply({ ok: false, error: 'origin_not_allowed' }, 403, cfg, origin);
  }
  if (!env.KV) {
    return reply({ ok: false, error: 'storage_not_bound' }, 503, cfg, origin);
  }

  let data;
  try {
    data = await request.json();
  } catch {
    return reply({ ok: false, error: 'bad_json' }, 400, cfg, origin);
  }

  const v = validate(data, cfg);
  if (!v.ok) return reply({ ok: false, error: v.error }, 400, cfg, origin);

  const turnstile = await verifyTurnstile(data.turnstile, request, env);
  if (!turnstile.ok) {
    return reply({ ok: false, error: 'turnstile_failed', detail: turnstile.error }, 403, cfg, origin);
  }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = await sha256(`${ip}|${cfg.salt}`);

  const limited = await rateLimited(env, cfg, ipHash);
  if (limited) {
    return reply({ ok: false, error: 'rate_limited', scope: limited }, 429, cfg, origin, { 'Retry-After': '600' });
  }

  const dup = await env.KV.get(annoKey(v.page, v.id));
  if (dup) {
    return reply({ ok: true, id: v.id, deduped: true }, 200, cfg, origin);
  }

  /* 只有认真通道才碰 GitHub；轻批注只落 KV */
  let gh = { ok: false, error: 'not_needed', commentId: null, number: null };
  if (v.type === 'serious') {
    gh = await createGitHubIssue(env, cfg, v);
  }

  const record = {
    id: v.id,
    page: v.page,
    sec: v.sec,
    type: v.type,
    kind: v.kind || null,
    sel_start: v.sel_start,
    sel_end: v.sel_end,
    sel_exact: v.sel_exact,
    sel_prefix: v.sel_prefix,
    sel_suffix: v.sel_suffix,
    body: v.body,
    fix: v.fix || null,
    name: v.name,
    contact: v.contact,
    reader_id: v.readerId,
    ip_hash: ipHash,
    status: 'open',
    gh_issue: gh.number ?? null,
    gh_error: gh.error ? String(gh.error).slice(0, 500) : null,
    reactions: { useful: [], same: [], doubt: [] },
    replies: [],
    hidden: false,
    created_at: new Date().toISOString(),
  };

  await env.KV.put(annoKey(v.page, v.id), JSON.stringify(record), {
    metadata: { ts: Date.now(), sec: v.sec, page: v.page, type: v.type, gh: gh.ok ? 1 : 0 },
  });

  return reply({
    ok: true,
    id: v.id,
    issue: gh.number ?? null,
    gh: v.type === 'serious' ? (gh.ok ? 'posted' : 'deferred') : 'local',
  }, 200, cfg, origin);
}

function annoKey(page, id) {
  return `anno:${page}:${id}`;
}

/* ------------------------------------------------------------------ 读 */

async function handleList(request, env, cfg, origin, url) {
  if (!cfg.publicRead) {
    return reply({ ok: false, error: 'read_disabled' }, 403, cfg, origin);
  }
  if (!cfg.originAllowed(origin)) {
    return reply({ ok: false, error: 'origin_not_allowed' }, 403, cfg, origin);
  }
  if (!env.KV) {
    return reply({ ok: false, error: 'storage_not_bound' }, 503, cfg, origin);
  }

  const page = url.searchParams.get('page') || '';
  if (!cfg.allowedPages.includes(page)) {
    return reply({ ok: false, error: 'bad_page' }, 400, cfg, origin);
  }

  /* 读路径也限流：GET 是公开的，不设闸会被刷爆 KV 读配额 */
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = await sha256(`${ip}|${cfg.salt}`);
  if (await readRateLimited(env, cfg, ipHash)) {
    return reply({ ok: false, error: 'rate_limited', scope: 'read' }, 429, cfg, origin, { 'Retry-After': '60' });
  }

  const raws = await listByPrefix(env, `anno:${page}:`);
  const items = [];
  for (const raw of raws) {
    let r;
    try { r = JSON.parse(raw); } catch { continue; }
    if (!r || r.hidden) continue;
    items.push(r);
  }

  /* 懒刷新：状态缓存过期才去 GitHub 拉一次，写回 KV 供后续请求直接用 */
  const states = await syncIssueStates(env, cfg);
  let syncedAt = 0;
  if (states) {
    syncedAt = states.__ts || 0;
    for (const it of items) {
      if (it.type === 'serious' && it.gh_issue) {
        const s = states.map[it.gh_issue];
        if (s && s.state === 'closed') it.status = 'done'; /* 回流：issue 关闭 ⇒ 已处理 */
      }
    }
  }
  /* 「作者已回应」由内容推导（publicView 里）：该批注下有带作者标记的回复 —— 零成本，无需回流 */

  items.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

  return json({ ok: true, page, syncedAt, items: items.map(publicView) }, cfg, origin, 30);
}

/**
 * 输出白名单 —— 公开可见之后这是**唯一**允许外泄的字段集合。
 * 任何新字段要先在这里登记，否则一律不输出。
 */
function publicView(r) {
  const rs = r.reactions || {};
  const replies = (Array.isArray(r.replies) ? r.replies : []).map((x) => ({
    name: String((x && x.name) || '匿名'),
    au: !!(x && x.au),
    text: String((x && x.text) || ''),
  }));
  let status = r.status === 'done' ? 'done' : r.status === 'ack' ? 'ack' : 'open';
  /* 「作者已回应」由内容推导 —— 该批注下有带作者标记的回复。零成本，不需要任何外部同步 */
  if (status === 'open' && replies.some((x) => x.au)) status = 'ack';

  const out = {
    id: String(r.id || ''),
    sec: String(r.sec || ''),
    type: r.type === 'serious' ? 'serious' : 'casual',
    sel_exact: String(r.sel_exact || ''),
    sel_prefix: String(r.sel_prefix || '').slice(0, 40),
    sel_suffix: String(r.sel_suffix || '').slice(0, 40),
    sel_start: Number(r.sel_start) || 0,
    sel_end: Number(r.sel_end) || 0,
    body: String(r.body || ''),
    name: r.name ? String(r.name) : null,
    status: status,
    reactions: {},
    replies: replies,
    replyCount: replies.length,
    created_at: String(r.created_at || ''),
  };
  if (r.type === 'serious') {
    out.kind = r.kind && KINDS[r.kind] ? r.kind : 'suggest';
    out.fix = r.fix ? String(r.fix) : null;
    out.issue = r.gh_issue ? Number(r.gh_issue) : null;
  }
  for (const k of REACTIONS) out.reactions[k] = Array.isArray(rs[k]) ? rs[k].length : 0;
  return out;
}

async function listByPrefix(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix, cursor, limit: 1000 });
    for (const k of page.keys || []) {
      const raw = await env.KV.get(k.name);
      if (raw) out.push(raw);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

/**
 * 状态懒刷新：缓存 TTL 内直接用 KV 里的旧 map，过期才打一次 GitHub。
 * 拉失败不影响主流程 —— 退回旧缓存，页面照常渲染，只是状态可能旧一点。
 */
async function syncIssueStates(env, cfg) {
  if (!env.GITHUB_TOKEN) return null;
  const tsKey = 'issuestate:ts';
  const mapKey = 'issuestate:map';
  const now = Date.now();

  const [tsRaw, mapRaw] = await Promise.all([env.KV.get(tsKey), env.KV.get(mapKey)]);
  const ts = Number(tsRaw || 0);
  let map = {};
  try { map = mapRaw ? JSON.parse(mapRaw) : {}; } catch { map = {}; }

  if (now - ts < cfg.statusTtlSec * 1000) return { map, __ts: ts };

  const url = `https://api.github.com/repos/${cfg.ghOwner}/${cfg.ghRepo}/issues` +
              `?labels=${encodeURIComponent(cfg.ghLabel)}&state=all&per_page=100&sort=updated`;
  try {
    const r = await fetch(url, { headers: ghHeaders(env) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const next = {};
    for (const it of j || []) {
      if (it.pull_request) continue;
      next[it.number] = { state: it.state, closed_at: it.closed_at || null, comments: it.comments || 0 };
    }
    await Promise.all([
      env.KV.put(mapKey, JSON.stringify(next)),
      env.KV.put(tsKey, String(now)),
    ]);
    return { map: next, __ts: now };
  } catch {
    /* GitHub 挂了/限流 → 沿用旧缓存，本轮不更新 */
    return { map, __ts: ts };
  }
}

/* ------------------------------------------------------------- 互动 */

async function handleReact(request, env, cfg, origin) {
  if (!cfg.originAllowed(origin)) return reply({ ok: false, error: 'origin_not_allowed' }, 403, cfg, origin);
  if (!env.KV) return reply({ ok: false, error: 'storage_not_bound' }, 503, cfg, origin);

  let d;
  try { d = await request.json(); } catch { return reply({ ok: false, error: 'bad_json' }, 400, cfg, origin); }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = await sha256(`${ip}|${cfg.salt}`);
  if (await reactRateLimited(env, cfg, ipHash)) {
    return reply({ ok: false, error: 'rate_limited', scope: 'react' }, 429, cfg, origin, { 'Retry-After': '60' });
  }

  const id = str(d.id), page = str(d.page), k = str(d.k);
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/i.test(id)) return reply({ ok: false, error: 'bad_id' }, 400, cfg, origin);
  if (!cfg.allowedPages.includes(page)) return reply({ ok: false, error: 'bad_page' }, 400, cfg, origin);
  if (REACTIONS.indexOf(k) < 0) return reply({ ok: false, error: 'bad_reaction' }, 400, cfg, origin);

  const key = annoKey(page, id);
  const raw = await env.KV.get(key);
  if (!raw) return reply({ ok: false, error: 'not_found' }, 404, cfg, origin);
  let rec;
  try { rec = JSON.parse(raw); } catch { return reply({ ok: false, error: 'corrupt' }, 500, cfg, origin); }

  rec.reactions = rec.reactions || {};
  rec.reactions[k] = Array.isArray(rec.reactions[k]) ? rec.reactions[k] : [];
  const i = rec.reactions[k].indexOf(ipHash);
  const mine = i >= 0;
  if (mine) rec.reactions[k].splice(i, 1); else rec.reactions[k].push(ipHash);

  await env.KV.put(key, JSON.stringify(rec));
  return json({ ok: true, k, on: !mine, count: rec.reactions[k].length }, cfg, origin);
}

async function handleReply(request, env, cfg, origin) {
  if (!cfg.originAllowed(origin)) return reply({ ok: false, error: 'origin_not_allowed' }, 403, cfg, origin);
  if (!env.KV) return reply({ ok: false, error: 'storage_not_bound' }, 503, cfg, origin);

  let d;
  try { d = await request.json(); } catch { return reply({ ok: false, error: 'bad_json' }, 400, cfg, origin); }

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ipHash = await sha256(`${ip}|${cfg.salt}`);
  if (await reactRateLimited(env, cfg, ipHash)) {
    return reply({ ok: false, error: 'rate_limited', scope: 'reply' }, 429, cfg, origin, { 'Retry-After': '60' });
  }

  const id = str(d.id), page = str(d.page);
  const text = str(d.text).trim();
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/i.test(id)) return reply({ ok: false, error: 'bad_id' }, 400, cfg, origin);
  if (!cfg.allowedPages.includes(page)) return reply({ ok: false, error: 'bad_page' }, 400, cfg, origin);
  if (cp(text) < 1) return reply({ ok: false, error: 'reply_empty' }, 400, cfg, origin);
  if (cp(text) > cfg.replyMax) return reply({ ok: false, error: 'reply_too_long' }, 400, cfg, origin);
  if ((text.match(/https?:\/\//gi) || []).length > 0) {
    return reply({ ok: false, error: 'no_links_in_reply' }, 400, cfg, origin);
  }

  /* 带作者标记的回复必须持 ADMIN_TOKEN，否则任何人都能冒充作者 */
  const wantAu = !!d.au;
  if (wantAu && !adminOk(request, env)) {
    return reply({ ok: false, error: 'admin_required' }, 403, cfg, origin);
  }

  const key = annoKey(page, id);
  const raw = await env.KV.get(key);
  if (!raw) return reply({ ok: false, error: 'not_found' }, 404, cfg, origin);
  let rec;
  try { rec = JSON.parse(raw); } catch { return reply({ ok: false, error: 'corrupt' }, 500, cfg, origin); }

  rec.replies = Array.isArray(rec.replies) ? rec.replies : [];
  if (rec.replies.length >= 20) return reply({ ok: false, error: 'reply_limit' }, 400, cfg, origin);
  const name = wantAu ? '作者' : str(d.name).trim().slice(0, cfg.nameMax) || '匿名读者';
  rec.replies.push({ name, au: wantAu, text, ts: Date.now() });

  if (rec.type === 'serious' && rec.status === 'open') rec.status = 'ack';

  await env.KV.put(key, JSON.stringify(rec));
  return json({ ok: true, count: rec.replies.length }, cfg, origin);
}

/* ------------------------------------------------------------- 管理 */

function adminOk(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const got = request.headers.get('X-Admin-Token') || '';
  return got.length > 0 && got === env.ADMIN_TOKEN;
}

async function handleAdmin(request, env, cfg, origin) {
  if (!env.ADMIN_TOKEN) return reply({ ok: false, error: 'admin_not_configured' }, 503, cfg, origin);
  if (!adminOk(request, env)) return reply({ ok: false, error: 'admin_required' }, 403, cfg, origin);
  if (!env.KV) return reply({ ok: false, error: 'storage_not_bound' }, 503, cfg, origin);

  let d;
  try { d = await request.json(); } catch { return reply({ ok: false, error: 'bad_json' }, 400, cfg, origin); }

  const id = str(d.id), page = str(d.page);
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/i.test(id)) return reply({ ok: false, error: 'bad_id' }, 400, cfg, origin);
  if (!cfg.allowedPages.includes(page)) return reply({ ok: false, error: 'bad_page' }, 400, cfg, origin);

  const key = annoKey(page, id);
  const raw = await env.KV.get(key);
  if (!raw) return reply({ ok: false, error: 'not_found' }, 404, cfg, origin);
  const rec = JSON.parse(raw);

  if ('hidden' in d) rec.hidden = !!d.hidden;
  if ('done' in d) rec.status = d.done ? 'done' : (rec.replies || []).some((x) => x.au) ? 'ack' : 'open';

  await env.KV.put(key, JSON.stringify(rec));
  return json({ ok: true, hidden: rec.hidden, status: rec.status }, cfg, origin);
}

/* -------------------------------------------------------------- validate */

function validate(d, cfg) {
  // 蜜罐：前端有一个对用户不可见的字段，正常读者永远留空，自动化脚本常会填
  if (d.hp != null && String(d.hp).trim() !== '') return { ok: false, error: 'rejected' };

  // 填写耗时：太快提交的当作脚本（前端传页面可见时间戳，缺失则不判）
  if (cfg.minFillMs > 0 && d.t0 != null) {
    const elapsed = Date.now() - Number(d.t0);
    if (Number.isFinite(elapsed) && elapsed >= 0 && elapsed < cfg.minFillMs) {
      return { ok: false, error: 'too_fast' };
    }
  }

  const id = typeof d.id === 'string' ? d.id : '';
  if (!/^[a-z0-9][a-z0-9-]{7,63}$/i.test(id)) return { ok: false, error: 'bad_id' };

  const page = typeof d.page === 'string' ? d.page : '';
  if (!cfg.allowedPages.includes(page)) return { ok: false, error: 'bad_page' };

  const sec = typeof d.sec === 'string' ? d.sec : '';
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(sec)) return { ok: false, error: 'bad_sec' };

  const sel = d.sel && typeof d.sel === 'object' ? d.sel : {};
  const selStart = Number(sel.start);
  const selEnd = Number(sel.end);
  if (!Number.isInteger(selStart) || !Number.isInteger(selEnd)) return { ok: false, error: 'bad_sel_offset' };
  if (selStart < 0 || selEnd <= selStart || selEnd - selStart > 2000) return { ok: false, error: 'bad_sel_range' };

  const selExact = str(sel.exact);
  if (!selExact || cp(selExact) > 800) return { ok: false, error: 'bad_sel_exact' };

  const type = d.type === 'serious' ? 'serious' : 'casual';
  let kind = null;
  let fix = null;

  const body = str(d.body).trim();
  if (cp(body) < 1) return { ok: false, error: 'body_too_short' };

  if (type === 'serious') {
    // 认真通道的两道闸：
    //   ① 正文 ≥ BODY_MIN（现 15）—— 写不够说明没说清问题在哪
    //   ② 必填「建议改成什么样」—— 写不出改法的人应当退回批注通道
    if (cp(body) < cfg.bodyMin) return { ok: false, error: 'body_too_short' };
    kind = KINDS[str(d.kind)] ? str(d.kind) : 'suggest';
    const fx = str(d.fix).trim();
    if (cp(fx) < cfg.fixMin) return { ok: false, error: 'fix_required' };
    if (cp(fx) > cfg.fixMax) return { ok: false, error: 'fix_too_long' };
    fix = fx;
  }

  if (cp(body) > cfg.bodyMax) return { ok: false, error: 'body_too_long' };

  const links = (body.match(/https?:\/\//gi) || []).length + (selExact.match(/https?:\/\//gi) || []).length;
  if (links > cfg.maxLinks) return { ok: false, error: 'too_many_links' };

  const name = str(d.name).trim().slice(0, cfg.nameMax);
  const contact = str(d.contact).trim().slice(0, 120);
  if (contact && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact) && !/^[+\d][\d\s-]{4,20}$/.test(contact)) {
    return { ok: false, error: 'bad_contact' };
  }

  const readerId = typeof d.readerId === 'string' && /^[a-z0-9]{2,12}$/i.test(d.readerId) ? d.readerId : '';

  return {
    ok: true,
    id,
    page,
    sec,
    type,
    kind,
    fix,
    sel_start: selStart,
    sel_end: selEnd,
    sel_exact: selExact,
    sel_prefix: str(sel.prefix).slice(0, 40),
    sel_suffix: str(sel.suffix).slice(0, 40),
    body,
    name: name || null,
    contact: contact || null,
    readerId,
  };
}

function str(x) {
  return typeof x === 'string' ? x : '';
}

function cp(s) {
  return [...s].length;
}

/* ------------------------------------------------------------ rate limit */

/**
 * 用 KV 计数器做限流。
 * 注意：KV 是最终一致的，高并发下计数可能少算（竞态）；对本站的批注量级无所谓——
 * 真正的门槛是"每条都要人工看"，被多塞几条也不致命。若日后要精确限流，换 D1 即可。
 */
async function rateLimited(env, cfg, ipHash) {
  const now = Date.now();
  const hour = Math.floor(now / 3600000);
  const day = Math.floor(now / 86400000);
  const hKey = `rl:h:${ipHash}:${hour}`;
  const dKey = `rl:d:${ipHash}:${day}`;

  const [hRaw, dRaw] = await Promise.all([env.KV.get(hKey), env.KV.get(dKey)]);
  const h = Number(hRaw || 0);
  const d = Number(dRaw || 0);

  if (h >= cfg.limitPerHour) return 'hour';
  if (d >= cfg.limitPerDay) return 'day';

  await Promise.all([
    env.KV.put(hKey, String(h + 1), { expirationTtl: 7200 }),
    env.KV.put(dKey, String(d + 1), { expirationTtl: 172800 }),
  ]);

  return null;
}

async function bump(env, key, ttl, cap) {
  const raw = await env.KV.get(key);
  const n = Number(raw || 0);
  if (n >= cap) return true;
  await env.KV.put(key, String(n + 1), { expirationTtl: ttl });
  return false;
}

async function readRateLimited(env, cfg, ipHash) {
  return bump(env, `rl:r:${ipHash}:${Math.floor(Date.now() / 60000)}`, 120, cfg.limitReadPerMin);
}

async function reactRateLimited(env, cfg, ipHash) {
  return bump(env, `rl:a:${ipHash}:${Math.floor(Date.now() / 60000)}`, 120, 30);
}

/* ------------------------------------------------------------- turnstile */

async function verifyTurnstile(token, request, env) {
  if (!env.TURNSTILE_SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: false, error: 'missing_token' };

  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', String(token));
  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);

  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: form,
    });
    const j = await r.json();
    return { ok: !!j.success, error: (j['error-codes'] || []).join(',') };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/* ------------------------------------------------------------ github */

function ghHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'mirror-guide-anno-worker',
    'Content-Type': 'application/json',
  };
}

/**
 * 每条「认真的建议」开一个**独立 issue** —— 这是状态能自动回流的前提：
 * 聚合 comment 无法表达 per-批注 的关闭状态（关 #1 等于关全部）。
 */
async function createGitHubIssue(env, cfg, v) {
  if (!env.GITHUB_TOKEN) return { ok: false, error: 'no_token_configured', number: null };

  const kind = KINDS[v.kind] || KINDS.suggest;
  const head = [...v.sel_exact].slice(0, 18).join('');
  const title = `[${kind.label}] ${v.page}#${v.sec} · ${head}${cp(v.sel_exact) > 18 ? '…' : ''}`;

  try {
    const r = await fetch(`https://api.github.com/repos/${cfg.ghOwner}/${cfg.ghRepo}/issues`, {
      method: 'POST',
      headers: ghHeaders(env),
      body: JSON.stringify({ title, body: renderComment(v, cfg), labels: [cfg.ghLabel, kind.gh] }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, error: `HTTP ${r.status}: ${t.slice(0, 300)}`, number: null };
    }
    const j = await r.json();
    return { ok: true, number: j.number ?? null };
  } catch (e) {
    return { ok: false, error: String(e), number: null };
  }
}

/* ------------------------------------------------ comment 正文（防注入） */

/**
 * 选择不与内容冲突的反引号围栏长度。
 * 读者原文里的 #12 / fixes #1 / @someone / ![](url) 只要进了代码块就不会被 GitHub 解析。
 */
function fence(text) {
  let n = 3;
  while (text.includes('`'.repeat(n))) n++;
  const f = '`'.repeat(n);
  return `${f}\n${text}\n${f}`;
}

function renderComment(v, cfg) {
  const who = v.name ? v.name : '匿名读者';
  const tag = v.readerId ? ` · ${v.readerId}` : '';
  const pageUrl = `${cfg.siteBase}${v.page}#${v.sec}`;
  const kind = KINDS[v.kind] || (v.type === 'serious' ? KINDS.suggest : null);

  const lines = [
    `**原文位置**：\`${v.page}#${v.sec}\`（文本偏移 ${v.sel_start}–${v.sel_end}）`,
    '',
    '**划中片段**：',
    '',
    fence(v.sel_exact),
  ];

  if (v.sel_prefix || v.sel_suffix) {
    lines.push('', `**上下文**：\`${v.sel_prefix}[…]${v.sel_suffix}\``);
  }

  if (kind) lines.push('', `**类型**：${kind.label}`);

  lines.push(
    '',
    `**读者**：${who}${tag}${v.contact ? ` · 联系方式：${v.contact}` : ''}`,
    '',
    `**页面**：${pageUrl}`,
    '',
    '**批注**：',
    '',
    fence(v.body),
  );

  if (v.fix) lines.push('', '**建议改成**：', '', fence(v.fix));

  lines.push('', '---', `<sub>id \`${v.id}\` · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</sub>`);

  return lines.join('\n');
}

/* ------------------------------------------------------------------ util */

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 供本地单元测试使用（Workers 运行时忽略多余导出）
export { validate, renderComment, fence, publicView, syncIssueStates };
