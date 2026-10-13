/**
 * mirror-guide 读者批注层 —— 前端接入模块
 * ------------------------------------------------------------
 * 引入方式（就一行，不改动页面原有结构）：
 *   <script src="annotate.js" defer></script>
 *
 * 可选的覆盖配置（放在 annotate.js 之前）：
 *   <script>
 *   window.ANNO_CONFIG = {
 *     endpoint: 'https://anno.strangeyu.xyz/api/anno',
 *     siteBase: 'https://mirror.strangeyu.xyz/',
 *     page: 'index.html',
 *     turnstileSiteKey: ''
 *   };
 *   </script>
 *
 * 设计要点：
 *   1. 读走本地、写才走网络。批注先落 localStorage 立刻可见，
 *      再异步 POST；失败进待发队列，恢复后自动补发，全程不打断阅读。
 *   2. 高亮走 CSS Custom Highlight API，不改动正文 DOM
 *      —— 因此不影响站点的目录、锚点跳转、scroll spy。
 *   3. 锚点存"章节 id + 章节内文本偏移 + 原文片段 + 前后 40 字上下文"，
 *      正文被改动后靠上下文匹配自愈，三级降级。
 *   4. 私有模式：页面只回显读者自己划过的内容，不展示他人的批注。
 */

(function () {
  'use strict';

  var CFG = window.ANNO_CONFIG || {};
  var ENDPOINT = CFG.endpoint || 'https://anno.strangeyu.xyz/api/anno';
  var SITE_BASE = CFG.siteBase || 'https://mirror.strangeyu.xyz/';
  var PAGE = CFG.page || (location.pathname.split('/').pop() || 'index.html') || 'index.html';
  var TS_KEY = CFG.turnstileSiteKey || '';
  var LS = 'anno-v1:' + PAGE;
  var CTX = 40;
  var BODY_MAX = 500;

  var SKIP = 'nav#toc, #toc-mask, #progress, script, style, noscript, .fab, .fabgroup, #anno-root';

  var SUPPORT = !!(window.CSS && CSS.highlights && window.Highlight);
  var secIndex = null;          // { secs: {id:{el,text,nodes,starts}}, nodeSec: Map, nodeOff: Map }
  var annos = [];               // 本地批注
  var showMarks = true;
  var pending = null;           // 当前待提交的选区锚点

  /* ================================================================ 工具 */

  function uid() {
    var a = new Uint8Array(16);
    (crypto.getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256 | 0; }));
    return [].map.call(a, function (b) { return b.toString(16).padStart(2, '0'); }).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
  }

  function shortId() {
    var s = '';
    var a = new Uint8Array(3);
    (crypto.getRandomValues ? crypto.getRandomValues(a) : a.forEach(function (_, i) { a[i] = Math.random() * 256 | 0; }));
    for (var i = 0; i < a.length; i++) s += a[i].toString(36).slice(0, 2);
    return s.slice(0, 5);
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }

  var toastTimer;
  function toast(msg, ms) {
    var t = document.getElementById('anno-toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, ms || 3000);
  }

  /* ========================================================== 章节索引 */

  function buildIndex() {
    var root = document.body;
    var secs = Object.create(null);
    var nodeSec = new Map();
    var nodeOff = new Map();
    var stack = [];
    var cur = null;

    var walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 1) {
          if (n.hasAttribute && n.hasAttribute('data-anno-skip')) return NodeFilter.FILTER_REJECT;
          try { if (n.matches && n.matches(SKIP)) return NodeFilter.FILTER_REJECT; } catch (e) { }
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 1) {
        var tag = n.tagName;
        if (tag && /^H[1-6]$/.test(tag)) {
          var lvl = Number(tag[1]);
          while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
          var id = (n.id && /^s[0-9][0-9a-z_-]*$/i.test(n.id)) ? n.id : null;
          stack.push({ lvl: lvl, id: id });
          cur = null;
          for (var i = stack.length - 1; i >= 0; i--) { if (stack[i].id) { cur = stack[i].id; break; } }
          if (id && !secs[id]) secs[id] = { el: n, text: '', nodes: [], starts: [] };
        }
        continue;
      }
      if (!cur) continue;
      var s = secs[cur];
      if (!s) continue;
      var t = n.nodeValue;
      if (!t) continue;
      s.starts.push(s.text.length);
      s.nodes.push(n);
      s.text += t;
      nodeSec.set(n, cur);
      nodeOff.set(n, s.starts[s.starts.length - 1]);
    }

    return { secs: secs, nodeSec: nodeSec, nodeOff: nodeOff };
  }

  function index() {
    if (!secIndex) secIndex = buildIndex();
    return secIndex;
  }

  /* ============================================== Range ⇄ 锚点 */

  function anchorFromRange(range) {
    var idx = index();
    var sc = range.startContainer, ec = range.endContainer;
    if (sc.nodeType !== 3 || ec.nodeType !== 3) return null;
    var s1 = idx.nodeSec.get(sc), s2 = idx.nodeSec.get(ec);
    if (!s1 || !s2 || s1 !== s2) return null;

    var sec = idx.secs[s1];
    var start = idx.nodeOff.get(sc) + range.startOffset;
    var end = idx.nodeOff.get(ec) + range.endOffset;
    if (end <= start) return null;

    var exact = sec.text.slice(start, end);
    if (!exact.trim()) return null;

    return {
      sec: s1,
      start: start,
      end: end,
      exact: exact,
      prefix: sec.text.slice(Math.max(0, start - CTX), start),
      suffix: sec.text.slice(end, end + CTX)
    };
  }

  function rangeFromOffsets(sec, start, end) {
    var s = index().secs[sec];
    if (!s) return null;
    var pick = function (off) {
      for (var i = s.nodes.length - 1; i >= 0; i--) {
        if (s.starts[i] <= off) return [s.nodes[i], off - s.starts[i]];
      }
      return null;
    };
    var a = pick(start), b = pick(end);
    if (!a || !b) return null;
    try {
      var r = document.createRange();
      r.setStart(a[0], Math.min(a[1], a[0].nodeValue.length));
      r.setEnd(b[0], Math.min(b[1], b[0].nodeValue.length));
      return r;
    } catch (e) { return null; }
  }

  /* 三级降级：精确偏移 → 上下文匹配 → 仅片段匹配 */
  function resolve(a) {
    var s = index().secs[a.sec];
    if (!s) return null;
    var full = s.text, st = -1, en = -1;

    if (a.start != null && full.slice(a.start, a.end) === a.exact) {
      st = a.start; en = a.end;
    } else {
      var i = (a.prefix || '') + a.exact + (a.suffix || '');
      var k = full.indexOf(i);
      if (k >= 0 && (a.prefix || a.suffix)) {
        st = k + (a.prefix || '').length; en = st + a.exact.length;
      } else {
        var j = full.indexOf(a.exact);
        if (j >= 0) { st = j; en = j + a.exact.length; }
      }
    }
    if (st < 0) return null;
    return rangeFromOffsets(a.sec, st, en);
  }

  /* ========================================================== 存储 */

  function load() {
    try { return JSON.parse(localStorage.getItem(LS) || 'null') || []; } catch (e) { return []; }
  }
  function save() {
    try { localStorage.setItem(LS, JSON.stringify(annos)); } catch (e) { }
  }
  function deviceId() {
    var k = LS + ':dev', d = localStorage.getItem(k);
    if (!d) {
      var parts = [navigator.userAgent, screen.width + 'x' + screen.height, navigator.language,
        (new Date()).getTimezoneOffset()];
      d = parts.join('|') + '|' + shortId() + shortId();
      try { localStorage.setItem(k, d); } catch (e) { }
    }
    return d;
  }
  function readerId() {
    var k = LS + ':rid', r = localStorage.getItem(k);
    if (!r) { r = shortId(); try { localStorage.setItem(k, r); } catch (e) { } }
    return r;
  }

  /* ========================================================== 网络 */

  var flushing = false;
  var tsWidget = null, tsPending = null;

  function initTurnstile() {
    if (!TS_KEY) return;
    window.__annoTsReady = function () {
      var box = el('div'); box.id = 'anno-ts-box';
      document.body.appendChild(box);
      try {
        tsWidget = window.turnstile.render(box, {
          sitekey: TS_KEY,
          size: 'invisible',
          callback: function (tok) { if (tsPending) { tsPending(tok); tsPending = null; } },
          'error-callback': function () { if (tsPending) { tsPending(''); tsPending = null; } }
        });
      } catch (e) { tsWidget = null; }
    };
    var s = el('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=__annoTsReady';
    s.async = true; s.defer = true;
    document.head.appendChild(s);
  }

  function turnstileToken() {
    if (!TS_KEY || !window.turnstile || tsWidget == null) return Promise.resolve('');
    return new Promise(function (resolve) {
      var done = false;
      tsPending = function (t) { if (!done) { done = true; resolve(t); } };
      try { window.turnstile.execute(tsWidget); } catch (e) { done = true; resolve(''); }
      setTimeout(function () { if (!done) { done = true; tsPending = null; resolve(''); } }, 8000);
    });
  }

  function flush() {
    if (flushing) return;
    var queue = annos.filter(function (a) { return a.sync === 'pending'; })
      .filter(function (a) { return !a.retryAt || a.retryAt <= Date.now(); });
    if (!queue.length) return;
    flushing = true;

    var a = queue[0];
    var attempt = (a.attempts || 0) + 1;

    turnstileToken().then(function (tok) {
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: a.id, page: PAGE, sec: a.sec,
          sel: { start: a.start, end: a.end, exact: a.exact, prefix: a.prefix, suffix: a.suffix },
          body: a.body, name: a.name || undefined, contact: a.contact || undefined,
          readerId: readerId(), device: deviceId(), turnstile: tok || undefined,
          hp: (document.getElementById('anno-hp') || {}).value || '',
          t0: Math.round(performance.timeOrigin || 0)
        })
      });
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, j: j }; });
    }).then(function (res) {
      if (res.j && res.j.ok) {
        a.sync = 'sent'; delete a.retryAt; delete a.lastError;
      } else if (res.status === 429) {
        a.retryAt = Date.now() + 10 * 60 * 1000;
        a.lastError = 'rate_limited';
      } else {
        throw new Error((res.j && res.j.error) || ('http_' + res.status));
      }
    }).catch(function (e) {
      a.attempts = attempt;
      a.lastError = String(e && e.message || e);
      a.retryAt = Date.now() + Math.min(30 * 60 * 1000, 15000 * Math.pow(2, Math.min(attempt - 1, 7)));
    }).then(function () {
      save(); paint();
      flushing = false;
      setTimeout(flush, 60);
    });
  }

  /* ========================================================== 绘制 */

  function paint() {
    if (!SUPPORT) return;
    CSS.highlights.delete('anno');
    CSS.highlights.delete('anno-hover2');
    if (!showMarks) return;
    var hl = new Highlight();
    annos.forEach(function (a) {
      var r = resolve(a);
      a._ok = !!r;
      if (r) hl.add(r);
    });
    CSS.highlights.set('anno', hl);
  }

  /* ========================================================== UI */

  function injectStyle() {
    var css = [
      ':root{--anno-mark:rgba(227,194,107,.45);--anno-mark-line:rgba(160,120,20,.55);--anno-hover:rgba(111,176,173,.42);',
      '--anno-bg:#fffdf8;--anno-ink:#2e3338;--anno-ink2:#7a7368;--anno-line:#ded6c7;--anno-teal:#24565a;--anno-teal2:#4a8a86;}',
      '[data-theme="dark"]{--anno-mark:rgba(201,162,74,.30);--anno-mark-line:rgba(240,215,154,.5);--anno-hover:rgba(111,176,173,.28);',
      '--anno-bg:#1d2124;--anno-ink:#e8e4dc;--anno-ink2:#9a938a;--anno-line:#3a4046;--anno-teal:#8fd0c9;--anno-teal2:#6fb0ad;}',
      '::highlight(anno){background:var(--anno-mark);text-decoration:underline;text-decoration-color:var(--anno-mark-line);text-decoration-thickness:2px;text-underline-offset:3px;}',
      '::highlight(anno-hover2){background:var(--anno-hover);}',
      'body.anno-off ::highlight(anno){background:transparent;text-decoration:none;}',
      // z-index 必须高于站点自身最高层（#progress 999 / #toc 950 / .bottomnav 800），
      // 否则整块 UI 会被目录栏和底部导航压在下面，读者根本点不到。
      // 位置用 CSS 变量 --anno-safe-b 承载，由 placeRoot() 实测底部固定栏高度后设定。
      '#anno-root{position:fixed;right:18px;bottom:var(--anno-safe-b,18px);z-index:1000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",system-ui,sans-serif;}',
      '#anno-fab{width:44px;height:44px;border-radius:50%;border:1px solid var(--anno-line);background:var(--anno-bg);color:var(--anno-teal);',
      'cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.16);display:flex;align-items:center;justify-content:center;position:relative;}',
      '#anno-fab:hover{border-color:var(--anno-teal2);}',
      '#anno-fab .badge{position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;border-radius:99px;background:var(--anno-teal);color:#fff;',
      'font-size:10.5px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 4px;}',
      '#anno-fab.has .badge{display:flex;}',
      '#anno-panel{position:absolute;right:0;bottom:54px;width:320px;max-height:min(62vh,520px);overflow:auto;background:var(--anno-bg);',
      'border:1px solid var(--anno-line);border-radius:14px;box-shadow:0 10px 34px rgba(0,0,0,.2);padding:13px 14px 15px;}',
      '#anno-panel[hidden]{display:none;}',
      '#anno-panel h4{margin:0 0 3px;font-size:13px;color:var(--anno-teal);font-weight:700;display:flex;align-items:center;gap:7px;}',
      '#anno-panel .sub{font-size:11.5px;color:var(--anno-ink2);line-height:1.65;margin:0 0 10px;}',
      '#anno-panel .sw{display:inline-flex;align-items:center;gap:7px;cursor:pointer;user-select:none;font-size:12px;color:var(--anno-ink);',
      'background:var(--anno-bg);border:1px solid var(--anno-line);border-radius:99px;padding:4px 10px 4px 5px;margin-bottom:10px;}',
      '#anno-panel .track{width:32px;height:18px;border-radius:99px;background:#cfc7b6;position:relative;transition:background .2s;flex:0 0 auto;}',
      '#anno-panel .knob{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:transform .2s;}',
      '#anno-panel .sw[aria-checked="true"] .track{background:var(--anno-teal2);}',
      '#anno-panel .sw[aria-checked="true"] .knob{transform:translateX(14px);}',
      '.anno-item{border:1px solid var(--anno-line);border-radius:10px;padding:8px 10px;margin-bottom:8px;cursor:pointer;background:transparent;}',
      '.anno-item:hover{border-color:var(--anno-teal2);}',
      '.anno-item .ex{font-size:12.5px;color:var(--anno-ink2);margin:0 0 4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.anno-item .bd{font-size:13px;margin:0 0 5px;line-height:1.6;white-space:pre-wrap;color:var(--anno-ink);}',
      '.anno-item .mt{font-size:10.5px;color:var(--anno-ink2);display:flex;gap:7px;align-items:center;flex-wrap:wrap;}',
      '.anno-item .mt .warn{color:#b4553f;font-weight:600;}',
      '.anno-item .mt .del{margin-left:auto;cursor:pointer;}',
      '.anno-item .mt .del:hover{color:#b4553f;}',
      '.anno-empty{font-size:12.5px;color:var(--anno-ink2);text-align:center;padding:18px 6px;line-height:1.8;}',
      '#anno-toolbar{position:fixed;z-index:1001;display:flex;gap:2px;padding:4px;background:#22303a;border-radius:10px;box-shadow:0 8px 26px rgba(0,0,0,.3);}',
      '#anno-toolbar[hidden]{display:none;}',
      '#anno-toolbar button{border:0;background:transparent;color:#eef3f2;font-size:13px;font-weight:600;padding:6px 11px;border-radius:7px;cursor:pointer;font-family:inherit;white-space:nowrap;}',
      '#anno-toolbar button:hover{background:rgba(255,255,255,.14);}',
      '#anno-editor{position:fixed;z-index:1002;width:330px;background:var(--anno-bg);border:1px solid var(--anno-line);border-radius:12px;',
      'box-shadow:0 10px 34px rgba(0,0,0,.2);padding:12px;}',
      '#anno-editor[hidden]{display:none;}',
      '#anno-editor .q{font-size:12.5px;color:var(--anno-ink2);border-left:3px solid #c9a24a;padding:2px 0 2px 9px;margin:0 0 9px;max-height:60px;overflow:hidden;}',
      '#anno-editor textarea{width:100%;min-height:78px;resize:vertical;border:1px solid var(--anno-line);border-radius:8px;padding:9px 10px;',
      'font-size:14px;font-family:inherit;line-height:1.65;background:var(--anno-bg);color:var(--anno-ink);outline:none;box-sizing:border-box;}',
      '#anno-editor textarea:focus{border-color:var(--anno-teal2);}',
      '#anno-editor .row{display:flex;align-items:center;gap:8px;margin-top:9px;}',
      '#anno-editor .hint{font-size:11px;color:var(--anno-ink2);flex:1;line-height:1.5;}',
      '#anno-editor button{border:1px solid var(--anno-line);background:transparent;color:var(--anno-ink);border-radius:8px;padding:5px 12px;',
      'font-size:13px;font-weight:600;cursor:pointer;font-family:inherit;}',
      '#anno-editor button.p{background:var(--anno-teal);border-color:var(--anno-teal);color:#fff;}',
      '#anno-editor button:disabled{opacity:.45;cursor:not-allowed;}',
      '#anno-toast{position:fixed;left:50%;bottom:var(--anno-safe-b,26px);transform:translateX(-50%) translateY(10px);background:#22303a;color:#eef3f2;',
      'font-size:13px;padding:9px 16px;border-radius:9px;opacity:0;pointer-events:none;transition:all .22s;z-index:1003;max-width:86vw;text-align:center;}',
      '#anno-toast.on{opacity:1;transform:translateX(-50%) translateY(0);}',
      '#anno-ts-box{display:none;}',
      '@media (max-width:900px){#anno-root{right:14px;}#anno-panel{width:min(320px,calc(100vw - 28px));}#anno-editor{width:min(330px,calc(100vw - 24px));}}'
    ].join('');
    var st = el('style');
    st.id = 'anno-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function buildUI() {
    var root = el('div');
    root.id = 'anno-root';
    root.innerHTML =
      '<button id="anno-fab" title="我的批注">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"/></svg>' +
      '<span class="badge" id="anno-badge">0</span></button>' +
      '<div id="anno-panel" hidden>' +
      '<h4>我的批注 <span id="anno-cnt" style="font-size:11px;font-weight:400;opacity:.7"></span></h4>' +
      '<p class="sub">选中正文任意一句就能划线写批注。<b>只有作者能看到你写的内容</b>，页面只回显你自己划过的。</p>' +
      '<label class="sw" id="anno-sw" role="switch" aria-checked="true" tabindex="0">' +
      '<span class="track"><span class="knob"></span></span><span id="anno-sw-label">显示我的批注</span></label>' +
      '<div id="anno-list"></div>' +
      '</div>';
    document.body.appendChild(root);

    var tb = el('div');
    tb.id = 'anno-toolbar'; tb.hidden = true;
    tb.innerHTML = '<button data-act="comment">写批注</button>';
    document.body.appendChild(tb);

    var ed = el('div');
    ed.id = 'anno-editor'; ed.hidden = true;
    ed.innerHTML =
      '<p class="q" id="anno-q"></p>' +
      '<textarea id="anno-text" maxlength="' + BODY_MAX + '" placeholder="这里哪里写得不对、不清楚，或者你有反例？"></textarea>' +
      '<input id="anno-hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" ' +
      'style="position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none">' +
      '<div class="row"><span class="hint">匿名提交 · 不收集账号</span>' +
      '<button id="anno-cancel">取消</button><button class="p" id="anno-save">提交</button></div>';
    document.body.appendChild(ed);

    var ts = el('div', 'toast'); ts.id = 'anno-toast';
    document.body.appendChild(ts);

    document.getElementById('anno-fab').addEventListener('click', function () {
      var p = document.getElementById('anno-panel');
      p.hidden = !p.hidden;
      if (!p.hidden) renderList();
    });

    var sw = document.getElementById('anno-sw');
    sw.addEventListener('click', function () { setShow(!showMarks); });
    sw.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setShow(!showMarks); }
    });

    tb.addEventListener('mousedown', function (e) { e.preventDefault(); });
    tb.addEventListener('click', function (e) {
      if (e.target.dataset.act === 'comment') openEditor();
    });

    document.getElementById('anno-cancel').addEventListener('click', closeEditor);
    document.getElementById('anno-save').addEventListener('click', function () {
      var ta = document.getElementById('anno-text');
      var v = ta.value.trim();
      if (!v) { ta.focus(); return; }
      if ([...v].length < 5) { toast('批注太短了，再多写几个字'); ta.focus(); return; }
      commit(v);
    });
  }

  function renderList() {
    var list = document.getElementById('anno-list');
    if (!list) return;
    document.getElementById('anno-cnt').textContent = annos.length ? '/ ' + annos.length + ' 条' : '';
    var fab = document.getElementById('anno-fab');
    fab.classList.toggle('has', annos.length > 0);
    document.getElementById('anno-badge').textContent = annos.length;

    if (!annos.length) {
      list.innerHTML = '<div class="anno-empty">还没有批注。<br>选中正文里的任意一句话试试 ——<br>不用登录，直接就能划。</div>';
      return;
    }
    list.innerHTML = '';
    annos.slice().sort(function (x, y) { return y.ts - x.ts; }).forEach(function (a) {
      var ok = !!resolve(a);
      var it = el('div', 'anno-item');
      var syncTxt = a.sync === 'sent' ? '' : '<span class="warn">待发送</span>';
      it.innerHTML =
        '<p class="ex">' + esc(a.exact) + '</p>' +
        '<p class="bd">' + esc(a.body) + '</p>' +
        '<div class="mt"><span>' + esc(a.sec) + '</span>' + syncTxt +
        (ok ? '' : '<span class="warn">待重定位</span>') +
        '<span class="del" data-del="' + a.id + '">删除</span></div>';
      it.addEventListener('mouseenter', function () { hover(a, true); });
      it.addEventListener('mouseleave', function () { hover(a, false); });
      it.addEventListener('click', function (e) {
        if (e.target.dataset.del) { remove(a.id); return; }
        var r = resolve(a);
        if (r) {
          var box = r.getBoundingClientRect();
          window.scrollTo({ top: window.pageYOffset + box.top - window.innerHeight / 2, behavior: 'smooth' });
        }
      });
      list.appendChild(it);
    });
  }

  function hover(a, on) {
    if (!SUPPORT || !showMarks) return;
    CSS.highlights.delete('anno-hover2');
    if (!on) return;
    var r = resolve(a);
    if (r) CSS.highlights.set('anno-hover2', new Highlight(r));
  }

  function remove(id) {
    annos = annos.filter(function (a) { return a.id !== id; });
    save(); paint(); renderList();
    toast('已删除（仅删除你本机的记录）');
  }

  function setShow(v) {
    showMarks = v;
    var sw = document.getElementById('anno-sw');
    if (sw) sw.setAttribute('aria-checked', v ? 'true' : 'false');
    var lb = document.getElementById('anno-sw-label');
    if (lb) lb.textContent = v ? '显示我的批注' : '批注已隐藏';
    document.body.classList.toggle('anno-off', !v);
    paint();
  }

  /* ====================================================== 选区与提交 */

  function hideToolbar() { var t = document.getElementById('anno-toolbar'); if (t) t.hidden = true; }

  function onSelect(e) {
    if (e && e.target && e.target.closest && e.target.closest('#anno-toolbar, #anno-editor, #anno-root')) return;
    setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { hideToolbar(); return; }
      var r = sel.getRangeAt(0);
      var a = anchorFromRange(r);
      if (!a) { hideToolbar(); return; }
      pending = a;
      var tb = document.getElementById('anno-toolbar');
      tb.hidden = false;
      var rect = r.getBoundingClientRect();
      var w = tb.offsetWidth, h = tb.offsetHeight;
      var left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, window.innerWidth - w - 8));
      var top = rect.top - h - 8;
      if (top < 8) top = rect.bottom + 8;
      tb.style.left = left + 'px';
      tb.style.top = top + 'px';
    }, 10);
  }

  function openEditor() {
    if (!pending) return;
    var ed = document.getElementById('anno-editor');
    document.getElementById('anno-q').textContent = '「' + pending.exact.slice(0, 90) + (pending.exact.length > 90 ? '…' : '') + '」';
    var ta = document.getElementById('anno-text');
    ta.value = '';
    ed.hidden = false;
    var tb = document.getElementById('anno-toolbar');
    var left = parseFloat(tb.style.left) || 20, top = parseFloat(tb.style.top) || 20;
    ed.style.left = Math.max(8, Math.min(left, window.innerWidth - ed.offsetWidth - 8)) + 'px';
    ed.style.top = Math.max(8, top + 40) + 'px';
    ta.focus();
  }

  function closeEditor() {
    var ed = document.getElementById('anno-editor');
    if (ed) ed.hidden = true;
    pending = null;
    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    hideToolbar();
  }

  function commit(body) {
    var a = {
      id: uid(), sec: pending.sec, start: pending.start, end: pending.end,
      exact: pending.exact, prefix: pending.prefix, suffix: pending.suffix,
      body: body, ts: Date.now(), sync: 'pending'
    };
    annos.push(a);
    save();
    if (!showMarks) setShow(true);
    paint(); renderList();
    closeEditor();
    toast('已收到，感谢 —— 你的批注只有作者能看到');
    flush();
  }

  /* ========================================================== 启动 */

  /* ---------------------------------------------- 悬浮按钮的落点
     站点自己有几层不透明的固定/粘性元素：#progress(999)、#toc(950)、div.bottomnav(800)。
     按钮如果压在它们下面，读者既看不见也点不到；如果只是把 z-index 抬高，又会盖住
     "下一篇"这类可点区域。折中做法：从右下角往上逐格试，找到第一个"按钮底边之下
     没有被固定层覆盖"的位置，把偏移写进 --anno-safe-b。 */
  function placeRoot() {
    var pad = window.innerWidth <= 900 ? 14 : 18;
    var vw = window.innerWidth, vh = window.innerHeight;
    var cx = vw - pad - 22;                       // 按钮(44×44)的水平中心

    // 判定"这个元素会不会挡住按钮"：必须是固定/粘性层，而且视觉上不透明。
    // 全透明的覆盖层（rgba(...,0) 且无背景图/无滤镜/无阴影）不算遮挡 —— 它不挡视线，
    // 只是某些浏览器扩展会往页面里塞这种整屏透明层，按它来避让会把按钮顶到页面中间。
    var alphaOf = function (bg) {
      if (!bg || bg === 'transparent') return 0;
      if (bg.indexOf('rgb(') === 0) return 1;
      var i = bg.lastIndexOf(',');
      if (i < 0) return 1;
      var a = parseFloat(bg.slice(i + 1));
      return isNaN(a) ? 1 : a;
    };
    var isOpaque = function (c) {
      if (alphaOf(c.backgroundColor) > 0) return true;
      if (c.backgroundImage && c.backgroundImage !== 'none') return true;
      if (c.backdropFilter && c.backdropFilter !== 'none') return true;
      if (c.boxShadow && c.boxShadow !== 'none') return true;
      return false;
    };

    var blockedAt = function (y) {
      var stack = document.elementsFromPoint(cx, y) || [];
      // 注意必须扫完整个堆叠，不能只看栈顶 —— 底栏通常是 sticky 容器里面套
      // 一堆 position:relative 的链接/按钮，只看栈顶会漏判成"没被挡"。
      for (var i = 0; i < stack.length; i++) {
        var e = stack[i];
        if (e.id === 'anno-root' || (e.closest && e.closest('#anno-root'))) continue;
        if (e === document.body || e === document.documentElement) return false;
        var c = window.getComputedStyle(e);
        if (c.position !== 'fixed' && c.position !== 'sticky') continue;
        if (c.display === 'none' || c.visibility === 'hidden' || Number(c.opacity) === 0) continue;
        if (!isOpaque(c)) continue;
        return true;
      }
      return false;
    };

    // 从右下角往上找第一个"按钮下沿下方没有不透明固定层"的位置。
    // 整屏都被盖住（理论上不该发生）时退回原位，免得把按钮顶到页面中间。
    var bottom = pad, found = false;
    for (var k = 0; k < 80; k++) {
      var probe = vh - bottom;                    // 按钮下沿所在的纵坐标
      if (probe < 8) break;
      if (!blockedAt(probe)) { found = true; break; }
      bottom += 6;
    }
    if (!found) bottom = pad;
    document.documentElement.style.setProperty('--anno-safe-b', bottom + 'px');
  }

  var placeTimer = null;
  function schedulePlace() {
    if (placeTimer) clearTimeout(placeTimer);
    placeTimer = setTimeout(function () { placeTimer = null; placeRoot(); }, 150);
  }

  function init() {
    if (!document.body) return;
    injectStyle();
    buildUI();
    placeRoot();
    annos = load();
    secIndex = buildIndex();

    if (!SUPPORT) toast('当前浏览器不支持高亮 API，批注仍可提交但不显示划线', 5000);

    setShow(true);
    paint();
    renderList();
    initTurnstile();
    setTimeout(flush, 1200);

    document.addEventListener('mouseup', onSelect);
    document.addEventListener('touchend', function (e) { setTimeout(function () { onSelect(e); }, 30); }, { passive: true });
    document.addEventListener('scroll', hideToolbar, { passive: true });
    window.addEventListener('online', flush);
    window.addEventListener('focus', flush);
    window.addEventListener('resize', schedulePlace);
    window.addEventListener('load', schedulePlace);   // 图片/字体落位后底部栏高度可能变

    // 仅本地调试时暴露内部状态，线上不挂
    if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
      window.__anno = {
        reindex: function () { secIndex = buildIndex(); },
        paint: paint,
        resolve: resolve,
        show: setShow,
        stats: function () { return { count: annos.length, secs: Object.keys(index().secs).length }; }
      };
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
