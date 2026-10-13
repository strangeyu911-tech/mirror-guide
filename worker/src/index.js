/**
 * mirror-guide 读者批注 Worker —— 档 1.5
 * ------------------------------------------------------------
 * 职责：接收读者批注 → 校验 → 限流 → Turnstile → 落 KV → 代发到私有仓库 issue
 *
 * 存储说明（2026-10-13）：
 *   原本设计用 D1，但当时手上的 CF token 没有 D1 权限（也不是必须的），改用 **KV**。
 *   批注是"写得少、读得极少、只按 id 取"的场景，KV 完全够用，还省掉建表与迁移。
 *   若日后想换回 D1，见 README 的「换成 D1」一节。
 *
 * 设计要点：
 *   1. 读者零账号。Worker 用维护者的 token 代发 comment，读者在 GitHub 上不出场。
 *   2. GITHUB_TOKEN 只存服务端 secret，任何情况下都不返回给前端。
 *   3. 读者原文（划中片段与批注正文）一律用代码块包裹后再写进 comment，
 *      否则其中的 #12 / fixes #1 / @someone / ![](url) 会被 GitHub 渲染成
 *      关联、提及、外链，既会误关联也可能被用来注入。
 */

const DEFAULTS = {
  LIMIT_PER_HOUR: '10',
  LIMIT_PER_DAY: '50',
  BODY_MIN: '5',
  BODY_MAX: '500',
  MAX_LINKS: '2',
  MIN_FILL_MS: '2500',
  ALLOWED_PAGES: 'index.html,patch.html',
  SITE_BASE: 'https://mirror.strangeyu.xyz/',
  GH_OWNER: 'strangeyu911-tech',
  GH_REPO: 'mirror-guide-feedback',
  GH_ISSUE: '1',
  ALLOWED_ORIGINS: 'https://mirror.strangeyu.xyz,https://strangeyu911-tech.github.io',
};

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
        turnstile: !!env.TURNSTILE_SECRET,
        github: !!env.GITHUB_TOKEN,
      }, 200, cfg, origin);
    }

    if (url.pathname === '/api/anno' && request.method === 'POST') {
      return handleAnno(request, env, cfg, origin);
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
    this.bodyMin = Number(v('BODY_MIN'));
    this.bodyMax = Number(v('BODY_MAX'));
    this.maxLinks = Number(v('MAX_LINKS'));
    this.minFillMs = Number(v('MIN_FILL_MS'));
    this.allowedPages = String(v('ALLOWED_PAGES')).split(',').map((s) => s.trim()).filter(Boolean);
    this.siteBase = String(v('SITE_BASE'));
    this.ghOwner = v('GH_OWNER');
    this.ghRepo = v('GH_REPO');
    this.ghIssue = v('GH_ISSUE');
    this.origins = String(v('ALLOWED_ORIGINS')).split(',').map((s) => s.trim()).filter(Boolean);
    this.salt = env.HASH_SALT || '';
  }

  originAllowed(origin) {
    return !!origin && this.origins.includes(origin);
  }

  cors(origin) {
    const h = {
      Vary: 'Origin',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
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

  const dup = await env.KV.get(annoKey(v.id));
  if (dup) {
    return reply({ ok: true, id: v.id, deduped: true }, 200, cfg, origin);
  }

  const markdown = renderComment(v, cfg);
  const gh = await postGitHubComment(env, cfg, markdown);

  const record = {
    id: v.id,
    page: v.page,
    sec: v.sec,
    sel_start: v.sel_start,
    sel_end: v.sel_end,
    sel_exact: v.sel_exact,
    body: v.body,
    name: v.name,
    contact: v.contact,
    reader_id: v.readerId,
    ip_hash: ipHash,
    status: 'new',
    gh_comment_id: gh.commentId ?? null,
    gh_error: gh.ok ? null : String(gh.error).slice(0, 500),
    created_at: new Date().toISOString(),
  };

  await env.KV.put(annoKey(v.id), JSON.stringify(record), {
    metadata: { ts: Date.now(), sec: v.sec, page: v.page, gh: gh.ok ? 1 : 0 },
  });

  return reply({ ok: true, id: v.id, gh: gh.ok ? 'posted' : 'deferred' }, 200, cfg, origin);
}

function annoKey(id) {
  return `anno:${id}`;
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

  const body = str(d.body).trim();
  if (cp(body) < cfg.bodyMin) return { ok: false, error: 'body_too_short' };
  if (cp(body) > cfg.bodyMax) return { ok: false, error: 'body_too_long' };

  const links = (body.match(/https?:\/\//gi) || []).length + (selExact.match(/https?:\/\//gi) || []).length;
  if (links > cfg.maxLinks) return { ok: false, error: 'too_many_links' };

  const name = str(d.name).trim().slice(0, 40);
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

/* ------------------------------------------------------------ github 代发 */

async function postGitHubComment(env, cfg, markdown) {
  if (!env.GITHUB_TOKEN) return { ok: false, error: 'no_token_configured' };

  const url = `https://api.github.com/repos/${cfg.ghOwner}/${cfg.ghRepo}/issues/${cfg.ghIssue}/comments`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'mirror-guide-anno-worker',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body: markdown }),
    });
    if (!r.ok) {
      const t = await r.text();
      return { ok: false, error: `HTTP ${r.status}: ${t.slice(0, 300)}` };
    }
    const j = await r.json();
    return { ok: true, commentId: j.id };
  } catch (e) {
    return { ok: false, error: String(e) };
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

  const lines = [
    `**原文位置**：\`${v.page}#${v.sec}\`（文本偏移 ${v.sel_start}–${v.sel_end}）`,
    '',
    '**划中片段**：',
    '',
    fence(v.sel_exact),
    '',
    `**读者**：${who}${tag}${v.contact ? ` · 联系方式：${v.contact}` : ''}`,
    '',
    `**页面**：${pageUrl}`,
    '',
    '**批注**：',
    '',
    fence(v.body),
    '',
    '---',
    `<sub>id \`${v.id}\` · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC</sub>`,
  ];

  return lines.join('\n');
}

/* ------------------------------------------------------------------ util */

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 供本地单元测试使用（Workers 运行时忽略多余导出）
export { validate, renderComment, fence };
