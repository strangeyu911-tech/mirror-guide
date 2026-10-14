/**
 * mirror-guide 读者批注层 —— 前端接入模块 v2（公开可见版）
 * ------------------------------------------------------------
 * 引入方式（就一行，不改动页面原有结构）：
 *   <script src="annotate.js" defer></script>
 *
 * 可选的覆盖配置（放在 annotate.js 之前）：
 *   <script>
 *   window.ANNO_CONFIG = {
 *     endpoint:     'https://anno.strangeyu.xyz/api/anno',   // 写：提交批注
 *     listEndpoint:   'https://anno.strangeyu.xyz/api/annos', // 读：这一页的公开批注
 *     reactEndpoint:'https://anno.strangeyu.xyz/api/react',  // 互动：emoji
 *     replyEndpoint: 'https://anno.strangeyu.xyz/api/reply',   // 互动：回复
 *     adminEndpoint:'https://anno.strangeyu.xyz/api/admin/hide',
 *     siteBase: 'https://mirror.strangeyu.xyz/',
 *     page: 'index.html',
 *     turnstileSiteKey: ''
 *   };
 *   </script>
 *
 * v2 相对档 1.5 的变化：
 *   1. 批注公开：启动时拉一次「这一页的全部批注」，所有人可见、可回应。
 *   2. 入口改为飞书式：划完字直接出现输入框，不用先选类型。
 *   3. 「认真的建议」从**就地**升级为**正式弹窗**（类型/15 字下限/改法必填/
 *      依据/署名）→ 生成独立 GitHub issue。轻批注不碰 GitHub，只落 KV。
 *   4. 互动：👍有用 / ❤️同感 / 🤔存疑 + 一层回复。
 *   5. 冷启动治理：没人回应的批注默认折叠，被顶起来才浮出。
 *
 * 沿用且不能丢的：
 *   - 读本地优先、写才走网络；失败进待发队列，恢复自动补发。
 *   - 高亮走 CSS Custom Highlight API，不改正文 DOM（不影响目录/锚点/scroll spy）。
 *   - 锚点 = 章节 id + 章节内偏移 + 原文片段 + 前后 40 字上下文，三级降级自愈。
 *   - z-index 全部 ≥1000，并用 placeRoot() 实测底栏高度避让。
 *   - 蜜罐 hp / 提交耗时 t0 / 幂等 id。
 */

(function () {
  'use strict';

  var CFG = window.ANNO_CONFIG || {};
  var SITE_BASE = CFG.siteBase || 'https://mirror.strangeyu.xyz/';
  var ENDPOINT = CFG.endpoint || 'https://anno.strangeyu.xyz/api/anno';
  var LIST_EP = CFG.listEndpoint || 'https://anno.strangeyu.xyz/api/annos';
  var REACT_EP = CFG.reactEndpoint || 'https://anno.strangeyu.xyz/api/react';
  var REPLY_EP = CFG.replyEndpoint || 'https://anno.strangeyu.xyz/api/reply';
  var ADMIN_EP = CFG.adminEndpoint || 'https://anno.strangeyu.xyz/api/admin/hide';
  var TS_KEY = CFG.turnstileSiteKey || '';
  var PAGE = CFG.page || (location.pathname.split('/').pop() || 'index.html') || 'index.html';
  var GH_ISSUE_BASE = (CFG.ghIssueBase || 'https://github.com/strangeyu911-tech/mirror-guide-feedback/issues/');
  var LS = 'anno-v2:' + PAGE;
  var LS_RC = LS + ':rc';          // 本地记我点过的反应（服务端只给计数）
  var CTX = 40;
  var BODY_MAX = 500;
  var SERIOUS_MIN = 15;            // 认真通道正文下限
  var FIX_MIN = 2;                 // 「建议改成什么样」下限
  var REPLY_MAX = 200;

  var SKIP = 'nav#toc, #toc-mask, #progress, script, style, noscript, .fab, .fabgroup, #anno-root';

  /* 两种章节模型，两页各用一种：
     · 标题型（index.html）—— id 挂在 h1~h6 上，区间 = 该标题之后、下一个同级或更高级标题之前。
     · 容器型（patch.html 的补丁卡片）—— id 挂在包住整块内容的元素上，整棵子树都归它。
     两种可以共存：容器内部的小标题不再参与标题模型，免得把卡片的正文切碎。 */
  var HEAD_ID_RE = /^s[0-9][0-9a-z_-]*$/i;
  var CARD_ID_RE = /^p[0-9]{1,3}$/i;

  var SUPPORT = !!(window.CSS && CSS.highlights && window.Highlight);
  var secIndex = null;          // { secs: {id:{el,text,nodes,starts}}, nodeSec: Map, nodeOff: Map }
  var annos = [];               // 我本机写的批注（含待发送）
  var others = [];              // 服务端来的公开批注
  var myRc = {};                // { annoId: {useful:1, same:1} }
  var showMarks = true;
  var pending = null;           // 当前待提交的选区锚点
  var isAdmin = false;

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
    t.innerHTML = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, ms || 3200);
  }

  function cp(s) { return [...String(s)].length; }

  function ago(ts) {
    var m = Math.max(1, Math.round((Date.now() - ts) / 60000));
    if (m < 60) return m + ' 分钟前';
    var h = Math.round(m / 60); if (h < 24) return h + ' 小时前';
    var d = Math.round(h / 24); if (d < 30) return d + ' 天前';
    return new Date(ts).toISOString().slice(0, 10);
  }

  /* ========================================================== 章节索引 */

  function buildIndex() {
    var root = document.body;
    var secs = Object.create(null);
    var nodeSec = new Map();
    var nodeOff = new Map();
    var stack = [];
    var headingCur = null;        // 当前标题区间所属章节
    var containerEl = null;       // 当前所在的容器型章节元素
    var containerCur = null;      // 其 id
    var cur = null;               // 生效中的章节 id

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
      // 容器型章节只覆盖自己的子树：走出去了立刻失效。
      // 否则卡片之后的页脚/公告文字会被错误地并进最后一张卡片里。
      if (containerEl && !containerEl.contains(n)) {
        containerEl = null;
        containerCur = null;
        cur = headingCur;
      }

      if (n.nodeType === 1) {
        var tag = n.tagName;

        if (tag && /^H[1-6]$/.test(tag)) {
          if (!containerCur) {   // 容器内部的小标题不参与标题模型
            var lvl = Number(tag[1]);
            while (stack.length && stack[stack.length - 1].lvl >= lvl) stack.pop();
            var hid = (n.id && HEAD_ID_RE.test(n.id)) ? n.id : null;
            stack.push({ lvl: lvl, id: hid });
            headingCur = null;
            for (var i = stack.length - 1; i >= 0; i--) { if (stack[i].id) { headingCur = stack[i].id; break; } }
            if (hid && !secs[hid]) secs[hid] = { el: n, text: '', nodes: [], starts: [] };
          }
          cur = containerCur || headingCur;
          continue;
        }

        // 容器型章节：整棵子树都归它
        if (n.id && CARD_ID_RE.test(n.id)) {
          if (!secs[n.id]) secs[n.id] = { el: n, text: '', nodes: [], starts: [] };
          containerEl = n;
          containerCur = n.id;
          cur = n.id;
          continue;
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

  /* 面板里显示章节时用可读标题，而不是 s41 / p05 这种内部 id。
     可用 data-anno-label 覆盖；否则取该章节元素自身（或其后代）的标题文字。 */
  function secLabel(id) {
    var s = index().secs[id];
    var e = s && s.el;
    if (!e) return id;
    if (e.getAttribute && e.getAttribute('data-anno-label')) return e.getAttribute('data-anno-label');
    var h = /^H[1-6]$/.test(e.tagName) ? e : e.querySelector('h1,h2,h3,h4,h5,h6');
    var t = (h ? h.textContent : e.textContent) || '';
    t = t.replace(/\s+/g, ' ').trim();
    return t ? (t.length > 26 ? t.slice(0, 26) + '…' : t) : id;
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
  function loadRc() {
    try { return JSON.parse(localStorage.getItem(LS_RC) || 'null') || {}; } catch (e) { return {}; }
  }
  function saveRc() {
    try { localStorage.setItem(LS_RC, JSON.stringify(myRc)); } catch (e) { }
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

  /* 管理凭据：只在 URL 带 ?admin=<token> 时启用，并记住到 localStorage，
       这样之后访问同一页也带着；普通读者永远拿不到这个 token。 */
  function initAdmin() {
    var m = location.search.match(/[?&]admin=([^&]+)/);
    if (m && m[1]) {
      try { localStorage.setItem('anno-admin-token', decodeURIComponent(m[1])); } catch (e) { }
      try { history.replaceState(null, '', location.pathname + location.hash); } catch (e) { }
    }
    var t = '';
    try { t = localStorage.getItem('anno-admin-token') || ''; } catch (e) { }
    isAdmin = !!t;
    return t;
  }
  var ADMIN_TOKEN = '';

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

    turnstileToken()
      .then(function (tok) {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            id: a.id,
            page: PAGE,
            sec: a.sec,
            type: a.type || 'casual',
            kind: a.kind || undefined,
            fix: a.fix || undefined,
            sel: { start: a.start, end: a.end, exact: a.exact, prefix: a.prefix, suffix: a.suffix },
            body: a.body,
            name: a.name || undefined,
            contact: a.contact || undefined,
            readerId: readerId(),
            device: deviceId(),
            turnstile: tok || undefined,
            hp: (document.getElementById('anno-hp') || {}).value || '',
            t0: Math.round(performance.timeOrigin || 0)
          })
        });
      })
      .then(function (r) {
        return r.json().then(function (j) { return { status: r.status, j: j }; });
      })
      .then(function (res) {
        if (res.j && res.j.ok) {
          a.sync = 'sent';
          a.issue = res.j.issue || null;
          delete a.retryAt; delete a.lastError;
        } else if (res.status === 429) {
          a.retryAt = Date.now() + 10 * 60 * 1000;
          a.lastError = 'rate_limited';
        } else {
          throw new Error((res.j && res.j.error) || ('http_' + res.status));
        }
      })
      .catch(function (e) {
        a.attempts = attempt;
        a.lastError = String((e && e.message) || e);
      })
      .then(function () {
        save(); paint(); renderList();
        flushing = false;
        setTimeout(flush, 60);
      });
  }

  /* ------------------------------------------------- 读：公开批注列表 */

  var othersLoaded = false, othersErr = '';

  function fetchOthers() {
    if (SUPPORT === undefined) { /* 无高亮也能看列表 */ }
    fetch(LIST_EP + '?page=' + encodeURIComponent(PAGE), { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok && Array.isArray(j.items)) {
          others = j.items.map(function (it) {
            return {
              id: it.id, sec: it.sec, type: it.type, kind: it.kind || null,
              exact: it.sel_exact, prefix: it.sel_prefix, suffix: it.sel_suffix,
              start: it.sel_start, end: it.sel_end,
              body: it.body, fix: it.fix || null, name: it.name || null,
              status: it.status, reactions: it.reactions || {},
              replies: it.replies || [], ts: Date.parse(it.created_at) || Date.now(),
              mine: false
            };
          });
          othersLoaded = true;
          paint(); renderList();
        } else {
          othersErr = (j && j.error) || 'load_failed';
          renderList();
        }
      })
      .catch(function () { othersErr = 'network_error'; renderList(); });
  }

  /* ------------------------------------------------- 互动：反应与回复 */

  function sendReact(a, k) {
    // 还没同步到服务端的批注，点上去了也无处可记 —— 直接说明，别让它静默失败
    if (a.mine && a.sync !== 'sent') { toast('这条还在同步中，稍后再回应'); return; }
    var me = myRc[a.id] || (myRc[a.id] = {});
    var on = !!me[k];
    // 乐观更新：先动本地计数，网络失败再回滚
    if (on) { me[k] = 0; a.reactions[k] = Math.max(0, (a.reactions[k] || 1) - 1); }
    else { me[k] = 1; a.reactions[k] = (a.reactions[k] || 0) + 1; }
    saveRc(); renderList();

    fetch(REACT_EP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: a.id, page: PAGE, k: k })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!(j && j.ok)) { // 回滚
          if (on) { me[k] = 1; a.reactions[k] = (a.reactions[k] || 0) + 1; }
          else { me[k] = 0; a.reactions[k] = Math.max(0, (a.reactions[k] || 1) - 1); }
          saveRc(); renderList();
        } else if (j && typeof j.count === 'number') {
          a.reactions[k] = j.count; renderList();
        }
      })
      .catch(function () {
        if (on) { me[k] = 1; a.reactions[k] = (a.reactions[k] || 0) + 1; }
        else { me[k] = 0; a.reactions[k] = Math.max(0, (a.reactions[k] || 1) - 1); }
        saveRc(); renderList();
        toast('没发出去 —— 网络不太顺，稍后再试');
      });
  }

  function sendReply(a, text) {
    var v = String(text || '').trim();
    if (!v) return;
    if (cp(v) > REPLY_MAX) { toast('回复太长了'); return; }
    if (/https?:\/\//i.test(v)) { toast('回复里不能带链接'); return; }
    if ((a.replies || []).length >= 20) { toast('这条下面已经很热闹了'); return; }

    a.replies = (a.replies || []).concat([{ name: '我', au: false, text: v, ts: Date.now() }]);
    renderList();
    fetch(REPLY_EP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: a.id, page: PAGE, text: v })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!(j && j.ok)) {
          a.replies = a.replies.filter(function (x) { return !(x.ts && x.text === v); });
          renderList(); toast('没发出去 —— 网络不太顺，稍后再试');
        }
      })
      .catch(function () {
        a.replies = a.replies.filter(function (x) { return !(x.ts && x.text === v); });
        renderList(); toast('没发出去 —— 网络不太顺，稍后再试');
      });
  }

  function adminHide(a, hidden) {
    fetch(ADMIN_EP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
      body: JSON.stringify({ id: a.id, page: PAGE, hidden: !!hidden })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          others = others.filter(function (x) { return x.id !== a.id; });
          renderList(); paint();
          toast(hidden ? '已删除 · 这条对所有读者不可见' : '已恢复');
        } else {
          toast('操作失败：' + ((j && j.error) || 'unknown'));
        }
      })
      .catch(function () { toast('操作失败：网络错误'); });
  }

  /* ========================================================== 绘制 */

  function paint() {
    if (!SUPPORT) return;
    CSS.highlights.delete('anno');
    CSS.highlights.delete('anno-ser');
    CSS.highlights.delete('anno-hover2');
    if (!showMarks) return;

    var mine = new Highlight();
    var ser = new Highlight();
    annos.forEach(function (a) {
      var r = resolve(a);
      a._ok = !!r;
      if (r) mine.add(r);
    });
    others.forEach(function (a) {
      var r = resolve(a);
      a._ok = !!r;
      if (!r) return;
      if (a.type === 'serious') ser.add(r); else mine.add(r);
    });
    CSS.highlights.set('anno', mine);
    CSS.highlights.set('anno-ser', ser);
  }

  function score(a) {
    var n = 0, r = a.reactions || {};
    ['useful', 'same', 'doubt'].forEach(function (k) { n += (r[k] || 0); });
    return n + (a.replies || []).length * 1.5;
  }

  /* ========================================================== UI */

  function injectStyle() {
    var css = [
      ':root{--anno-mark:rgba(227,194,107,.45);--anno-mark-line:rgba(160,120,20,.55);--anno-hover:rgba(111,176,173,.42);',
      '--anno-bg:#fffdf8;--anno-ink:#2e3338;--anno-ink2:#7a7368;--anno-line:#ded6c7;--anno-teal:#24565a;--anno-teal2:#4a8a86;',
      '--anno-blue:#2f5d8c;--anno-blue-bg:rgba(47,93,140,.12);}',
      '[data-theme="dark"]{--anno-mark:rgba(201,162,74,.30);--anno-mark-line:rgba(240,215,154,.5);--anno-hover:rgba(111,176,173,.28);',
      '--anno-bg:#1d2124;--anno-ink:#e8e4dc;--anno-ink2:#9a938a;--anno-line:#3a4046;--anno-teal:#8fd0c9;--anno-teal2:#6fb0ad;',
      '--anno-blue:#9cc3e8;--anno-blue-bg:rgba(156,195,232,.14);}',
      '::highlight(anno){background:var(--anno-mark);text-decoration:underline;text-decoration-color:var(--anno-mark-line);text-decoration-thickness:2px;text-underline-offset:3px;}',
      '::highlight(anno-ser){background:var(--anno-blue-bg);text-decoration:underline;text-decoration-color:var(--anno-blue);text-decoration-thickness:2px;text-underline-offset:3px;}',
      '::highlight(anno-hover2){background:var(--anno-hover);}',
      'body.anno-off ::highlight(anno),body.anno-off ::highlight(anno-ser){background:transparent;text-decoration:none;}',
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
      '#anno-panel{position:absolute;right:0;bottom:54px;width:340px;max-height:min(64vh,560px);overflow:auto;background:var(--anno-bg);',
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
      '.anno-item{border:1px solid var(--anno-line);border-radius:11px;padding:9px 11px;margin-bottom:9px;cursor:pointer;background:transparent;}',
      '.anno-item:hover{border-color:var(--anno-teal2);}',
      '.anno-item .hd{display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:5px;}',
      '.badge{font-size:10.5px;padding:1.5px 7px;border-radius:5px;font-weight:700;line-height:1.5;}',
      '.badge.ser{background:var(--anno-blue-bg);color:var(--anno-blue);}',
      '.badge.cas{background:var(--anno-bg);color:var(--anno-ink2);border:1px solid var(--anno-line);}',
      '.badge.st{background:rgba(201,162,74,.16);color:#8a6d21;}',
      '.badge.st.done{background:rgba(63,122,69,.14);color:#3f7a45;}',
      '.badge.au{background:rgba(168,69,59,.12);color:#a8453b;}',
      '.badge.iss{background:rgba(74,138,134,.14);color:var(--anno-teal);text-decoration:none;}',
      '.badge.iss:hover{text-decoration:underline;}',
      '.anno-item.dim{opacity:.6;}',
      '.foldbar{border:1px dashed var(--anno-line);border-radius:10px;background:rgba(0,0,0,.02);',
      'padding:8px 11px;font-size:11.5px;color:var(--anno-ink2);margin-bottom:9px;display:flex;align-items:center;gap:7px;}',
      '.foldbar button{margin-left:auto;border:0;background:none;color:var(--anno-teal);',
      'font-size:11.5px;font-weight:600;cursor:pointer;font-family:inherit;}',
      '.anno-item .ex{font-size:12.5px;color:var(--anno-ink2);border-left:2px solid #c9a24a;padding:2px 0 2px 8px;margin:0 0 5px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}',
      '.anno-item.ser .ex{border-left-color:var(--anno-blue);}',
      '.anno-item .bd{font-size:13px;margin:0 0 5px;line-height:1.6;white-space:pre-wrap;color:var(--anno-ink);word-break:break-word;}',
      '.anno-item .fix{margin:0 0 5px;background:rgba(0,0,0,.035);border-radius:7px;padding:6px 8px;font-size:12px;line-height:1.6;color:var(--anno-ink2);white-space:pre-wrap;word-break:break-word;}',
      '.anno-item .ft{display:flex;align-items:center;gap:5px;flex-wrap:wrap;}',
      '.rc{border:1px solid var(--anno-line);background:transparent;border-radius:99px;padding:2.5px 9px;font-size:12px;color:var(--anno-ink2);cursor:pointer;display:inline-flex;gap:4px;align-items:center;font-family:inherit;line-height:1.6;}',
      '.rc:hover{border-color:var(--anno-teal2);}',
      '.rc.on{background:rgba(201,162,74,.16);border-color:#c9a24a;color:#8a6d21;font-weight:600;}',
      '.lnk{border:0;background:none;color:var(--anno-ink2);font-size:11.5px;cursor:pointer;font-family:inherit;padding:2px 3px;}',
      '.lnk:hover{color:var(--anno-teal);}',
      '.lnk.danger:hover{color:#a8453b;}',
      '.anno-item .nm{font-size:10.5px;color:var(--anno-ink2);margin-left:auto;}',
      '.replys{margin-top:7px;border-top:1px dashed var(--anno-line);padding-top:7px;display:flex;flex-direction:column;gap:5px;}',
      '.rp{font-size:12.5px;line-height:1.6;display:flex;gap:5px;}',
      '.rp .rn{color:var(--anno-teal2);font-weight:600;flex:0 0 auto;}',
      '.rp .rn.au{color:var(--anno-red,#a8453b);}',
      '.rp .rt{flex:1;min-width:0;word-break:break-word;}',
      '.rpbox{display:flex;gap:6px;margin-top:7px;}',
      '.rpbox input{flex:1;border:1px solid var(--anno-line);border-radius:8px;padding:5px 9px;font-size:12.5px;background:var(--anno-bg);color:var(--anno-ink);outline:none;font-family:inherit;min-width:0;}',
      '.rpbox input:focus{border-color:var(--anno-teal2);}',
      '.rpbox button{border:1px solid var(--anno-line);background:transparent;color:var(--anno-ink2);border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer;font-family:inherit;}',
      '.rpbox button:hover{border-color:var(--anno-teal2);color:var(--anno-teal);}',
      '.anno-empty{font-size:12.5px;color:var(--anno-ink2);text-align:center;padding:18px 6px;line-height:1.8;}',
      '#anno-toolbar{position:fixed;z-index:1001;display:flex;gap:2px;padding:4px;background:#22303a;border-radius:10px;box-shadow:0 8px 26px rgba(0,0,0,.3);}',
      '#anno-toolbar[hidden]{display:none;}',
      '#anno-toolbar button{border:0;background:transparent;color:#eef3f2;font-size:13px;font-weight:600;padding:6px 11px;border-radius:7px;cursor:pointer;font-family:inherit;white-space:nowrap;}',
      '#anno-toolbar button:hover{background:rgba(255,255,255,.14);}',
      /* 正式表单（认真通道）—— 比就地输入框更郑重，这是刻意的 */
      '#anno-editor{position:fixed;z-index:1002;width:min(520px,calc(100vw - 24px));background:var(--anno-bg);border:1px solid var(--anno-line);',
      'border-radius:14px;box-shadow:0 14px 44px rgba(0,0,0,.24);padding:0;overflow:hidden;}',
      '#anno-editor[hidden]{display:none;}',
      /* 正式表单居中 + 遮罩：郑重感的一部分 */
      '#anno-mask{position:fixed;inset:0;background:rgba(46,51,56,.34);z-index:1002;}',
      '#anno-editor.modal-center{z-index:1003;left:50%;top:50%;transform:translate(-50%,-50%);}',
      '.ae-hd{padding:14px 17px 11px;border-bottom:1px solid var(--anno-line);display:flex;align-items:center;gap:9px;}',
      '.ae-hd .ic{width:26px;height:26px;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;background:var(--anno-blue-bg);color:var(--anno-blue);flex:0 0 auto;}',
      '.ae-hd h5{margin:0;font-size:15px;color:var(--anno-ink);font-weight:700;}',
      '.ae-hd .x{margin-left:auto;border:0;background:none;font-size:19px;color:var(--anno-ink2);cursor:pointer;line-height:1;padding:0 2px;font-family:inherit;}',
      '.ae-bd{padding:13px 17px;}',
      '.ae-bd label{display:block;font-size:12.5px;color:var(--anno-ink);font-weight:600;margin:0 0 5px;}',
      '.ae-bd .req{color:#a8453b;font-size:11px;font-weight:400;}',
      '.ae-bd .opt{color:var(--anno-ink2);font-size:11px;font-weight:400;}',
      '.ae-q{background:rgba(0,0,0,.03);border-left:2px solid var(--anno-blue);border-radius:0 7px 7px 0;padding:7px 10px;font-family:"Songti SC",Georgia,serif;font-size:13px;color:var(--anno-ink2);line-height:1.7;margin-bottom:12px;max-height:66px;overflow:hidden;}',
      '.ae-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;}',
      '.chip{border:1px solid var(--anno-line);background:transparent;border-radius:99px;padding:4px 12px;font-size:12.5px;color:var(--anno-ink2);cursor:pointer;font-family:inherit;}',
      '.chip.on{background:var(--anno-blue);border-color:var(--anno-blue);color:#fff;font-weight:600;}',
      '.ae-ta{width:100%;min-height:70px;resize:vertical;border:1px solid var(--anno-line);border-radius:9px;padding:9px 11px;',
      'font-size:13.5px;font-family:inherit;line-height:1.7;background:var(--anno-bg);color:var(--anno-ink);outline:none;box-sizing:border-box;}',
      '.ae-ta:focus{border-color:var(--anno-teal2);}',
      '.ae-in{width:100%;border:1px solid var(--anno-line);border-radius:9px;padding:8px 11px;font-size:13px;',
      'font-family:inherit;line-height:1.6;background:var(--anno-bg);color:var(--anno-ink);outline:none;box-sizing:border-box;}',
      '.ae-in:focus{border-color:var(--anno-teal2);}',
      '.ae-fld{margin-bottom:12px;}',
      '.ae-note{background:rgba(47,93,140,.07);border:1px solid rgba(47,93,140,.18);border-radius:9px;padding:8px 11px;',
      'font-size:11.5px;color:var(--anno-ink2);line-height:1.7;margin-bottom:12px;}',
      '.ae-ft{padding:11px 17px 14px;border-top:1px solid var(--anno-line);display:flex;align-items:center;gap:10px;background:rgba(0,0,0,.02);}',
      '.ae-ft .note{font-size:11.5px;color:var(--anno-ink2);line-height:1.6;flex:1;}',
      '.ae-ft .btn{border:0;background:var(--anno-teal);color:#fff;border-radius:9px;padding:9px 18px;font-size:13.5px;font-weight:600;cursor:pointer;font-family:inherit;}',
      '.ae-ft .btn:disabled{background:#c3bcae;cursor:not-allowed;}',
      '#anno-toast{position:fixed;left:50%;bottom:var(--anno-safe-b,26px);transform:translateX(-50%) translateY(10px);background:#22303a;color:#eef3f2;',
      'font-size:13px;padding:9px 16px;border-radius:9px;opacity:0;pointer-events:none;transition:all .22s;z-index:1003;max-width:86vw;text-align:center;}',
      '#anno-toast.on{opacity:1;transform:translateX(-50%) translateY(0);}',
      '#anno-ts-box{display:none;}',
      '@media (max-width:900px){#anno-root{right:14px;}#anno-panel{width:min(340px,calc(100vw - 28px));}}'
    ].join('');
    var st = el('style');
    st.id = 'anno-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------ 浮层：就地输入框 */

  var inline = null;             // 当前打开的就地输入浮层

  function closeInline() {
    if (inline && inline.parentNode) inline.parentNode.removeChild(inline);
    inline = null;
    pending = null;
    var sel = window.getSelection();
    if (sel) sel.removeAllRanges();
  }

  /**
   * 飞书式就地输入：划完字直接在旁边写。
   * 不先问类型 —— 人写完之前不知道自己在写什么。
   */
  function openInline() {
    // 顺序很要紧：closeInline() 会把 pending 置空，所以先取出来再补回去。
    var a = pending;
    closeInline();
    pending = a;
    if (!pending) return;
    var q = a.exact.length > 40 ? a.exact.slice(0, 40) + '…' : a.exact;

    var box = el('div', 'anno-inline');
    box.innerHTML =
      '<div class="ai-hd">批注：<q>' + esc(q) + '</q></div>' +
      '<textarea id="ai-ta" rows="3" maxlength="' + BODY_MAX + '" ' +
      'placeholder="像在文档边上写字一样，想到什么写什么"></textarea>' +
      '<div class="ai-row">' +
      '<span class="ai-note">公开可见 · 默认作者不一定看</span>' +
      '<button class="ai-cancel">取消</button>' +
      '<button class="ai-pub" disabled>发布</button>' +
      '</div>' +
      '<button class="ai-up">' +
      '<span class="ic">✎</span>' +
      '<span class="tx">让作者认真处理 · 生成 issue，作者会回复</span>' +
      '<span class="ar">正式表单 ▾</span>' +
      '</button>';

    document.body.appendChild(box);
    inline = box;

    var ta = box.querySelector('#ai-ta');
    var pub = box.querySelector('.ai-pub');
    var cancel = box.querySelector('.ai-cancel');
    var up = box.querySelector('.ai-up');

    ta.addEventListener('input', function () { pub.disabled = !ta.value.trim(); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); if (!pub.disabled) pub.click(); }
      if (e.key === 'Escape') closeInline();
    });
    cancel.addEventListener('click', closeInline);
    pub.addEventListener('click', function () {
      var v = ta.value.trim();
      if (!v) return;
      commit({ type: 'casual', body: v });
    });
    up.addEventListener('click', function () {
      var v = ta.value.trim();
      var keep = a;             // 直接从闭包取，closeInline() 之后 pending 就没了
      closeInline();
      openEditor(keep, v);      // 正式弹窗，把已写的字带过去
    });

    /* 落点：贴着选区下方，超界就翻到上方 / 夹到视口内 */
    var r = a._rect;
    box.style.visibility = 'hidden';
    var bw = box.offsetWidth, bh = box.offsetHeight;
    // .anno-inline 是 absolute（相对文档），而 rect 是视口坐标 —— 必须补 scrollY，
    // 否则页面一滚，浮层就会飞到别处。
    var vTop = r.bottom + 8;
    if (vTop + bh > window.innerHeight - 8) vTop = Math.max(8, r.top - bh - 8);
    var left = Math.max(8, Math.min(r.left, window.innerWidth - bw - 8));
    var top = vTop + window.scrollY;
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.visibility = 'visible';
    ta.focus();
  }

  function injectInlineStyle() {
    var css = [
      '.anno-inline{position:absolute;z-index:1004;width:min(320px,calc(100vw - 20px));background:var(--anno-bg);',
      'border:1px solid var(--anno-line);border-radius:12px;box-shadow:0 12px 34px rgba(0,0,0,.22);padding:10px;}',
      '.anno-inline .ai-hd{font-size:11px;color:var(--anno-ink2);padding:0 2px 7px;border-bottom:1px solid var(--anno-line);margin-bottom:7px;line-height:1.5;}',
      '.anno-inline .ai-hd q{color:var(--anno-ink2);font-family:"Songti SC",Georgia,serif;}',
      '.anno-inline textarea{width:100%;resize:vertical;border:1px solid var(--anno-line);border-radius:8px;padding:8px 10px;',
      'font-size:13.5px;font-family:inherit;line-height:1.65;background:var(--anno-bg);color:var(--anno-ink);outline:none;box-sizing:border-box;}',
      '.anno-inline textarea:focus{border-color:var(--anno-teal2);}',
      '.anno-inline .ai-row{display:flex;align-items:center;gap:7px;margin-top:8px;}',
      '.anno-inline .ai-note{font-size:10.5px;color:var(--anno-ink2);flex:1;line-height:1.5;}',
      '.anno-inline .ai-row button{border:1px solid var(--anno-line);background:transparent;color:var(--anno-ink2);border-radius:8px;',
      'padding:5px 13px;font-size:12.5px;cursor:pointer;font-family:inherit;}',
      '.anno-inline .ai-row button:hover{border-color:var(--anno-teal2);color:var(--anno-teal);}',
      '.anno-inline .ai-pub{background:var(--anno-teal);border-color:var(--anno-teal);color:#fff;font-weight:600;}',
      '.anno-inline .ai-pub:disabled{background:#c3bcae;border-color:#c3bcae;color:#fff;cursor:not-allowed;}',
      '.anno-inline .ai-up{margin-top:8px;width:100%;border:1px solid var(--anno-line);background:transparent;',
      'color:var(--anno-blue);border-radius:8px;padding:7px 10px;font-size:12px;cursor:pointer;font-family:inherit;',
      'display:flex;align-items:center;gap:7px;text-align:left;line-height:1.5;}',
      '.anno-inline .ai-up:hover{border-color:var(--anno-blue);background:var(--anno-blue-bg);}',
      '.anno-inline .ai-up .ic{flex:0 0 auto;font-size:12px;}',
      '.anno-inline .ai-up .tx{flex:1;min-width:0;}',
      '.anno-inline .ai-up .ar{flex:0 0 auto;font-size:10.5px;opacity:.7;}'
    ].join('');
    var st = el('style');
    st.id = 'anno-inline-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ------------------------------------------------ 正式表单（认真通道） */

  /**
   * 认真的建议 / 质疑数据 —— 走正式弹窗。
   * 仪式感在这里是 feature 不是 bug：它在告诉读者"这条会被认真对待"。
   */
  function openEditor(anchor, prefill) {
    if (!anchor) return;
    pending = anchor;
    var q = anchor.exact.length > 90 ? anchor.exact.slice(0, 90) + '…' : anchor.exact;

    var ed = document.getElementById('anno-editor');
    var kind = 'suggest';
    var mask = document.getElementById('anno-mask');
    if (!mask) { mask = el('div'); mask.id = 'anno-mask'; document.body.appendChild(mask); }
    mask.hidden = false;

    ed.innerHTML =
      '<div class="ae-hd"><span class="ic">✎</span><h5>认真的建议 / 质疑数据</h5>' +
      '<button class="x" title="关闭">&times;</button></div>' +
      '<div class="ae-bd">' +
      '<div class="ae-q">' + esc(q) + '</div>' +
      '<div class="ae-note">这条会<b>公开显示</b>给其他读者，同时在 GitHub 生成一个 issue <b>直达作者</b>。' +
      '请写出「该怎么改」，而不只是说「不对」。</div>' +
      '<div class="ae-fld"><label>类型</label>' +
      '<div class="ae-chips">' +
      '<button class="chip on" data-k="suggest">建议修改</button>' +
      '<button class="chip" data-k="data">质疑数据</button>' +
      '<button class="chip" data-k="evidence">补充证据</button>' +
      '</div></div>' +
      '<div class="ae-fld"><label>哪里不对 / 可以更好 <span class="req">* 必填，≥' + SERIOUS_MIN + ' 字</span></label>' +
      '<textarea class="ae-ta" id="ae-body" rows="3" maxlength="' + BODY_MAX + '" ' +
      'placeholder="说清楚：是哪一句话、哪个数字，问题在哪"></textarea></div>' +
      '<div class="ae-fld"><label>你建议改成什么样 / 正确数字应该是多少 <span class="req">* 必填</span></label>' +
      '<textarea class="ae-ta" id="ae-fix" rows="2" maxlength="500" ' +
      'placeholder="这一栏是认真通道的门槛 —— 写不出改法的话，退回普通批注也没关系"></textarea></div>' +
      '<div class="ae-fld"><label>依据或来源 <span class="opt">选填 · 填了作者处理会快很多</span></label>' +
      '<input class="ae-in" id="ae-src" type="text" maxlength="200" placeholder="报告名 / 链接 / 你自己的口径"></div>' +
      '<div class="ae-fld"><label>署名 <span class="opt">选填</span></label>' +
      '<input class="ae-in" id="ae-name" type="text" maxlength="40" placeholder="留空则为「匿名读者」"></div>' +
      '</div>' +
      '<div class="ae-ft"><div class="note">提交后生成 issue，<b>编号会回写在这条批注上</b>；' +
      '你在 GitHub 处理完，页面最迟约 10 分钟自动同步为「已处理」。</div>' +
      '<button class="btn" id="ae-save" disabled>提交给作者</button></div>';

    ed.hidden = false;
    ed.style.left = '';
    ed.style.top = '';
    ed.classList.add('modal-center');

    var body = ed.querySelector('#ae-body');
    var fix = ed.querySelector('#ae-fix');
    var src = ed.querySelector('#ae-src');
    var nm = ed.querySelector('#ae-name');
    var save = ed.querySelector('#ae-save');
    if (prefill) body.value = prefill;

    function check() {
      var nb = cp(body.value.trim());
      var nf = cp(fix.value.trim());
      save.disabled = !(nb >= SERIOUS_MIN && nf >= FIX_MIN);
    }
    body.addEventListener('input', check);
    fix.addEventListener('input', check);
    ed.querySelectorAll('.chip').forEach(function (c) {
      c.addEventListener('click', function () {
        ed.querySelectorAll('.chip').forEach(function (x) { x.classList.remove('on'); });
        c.classList.add('on');
        kind = c.getAttribute('data-k');
      });
    });
    ed.querySelector('.x').addEventListener('click', function () { ed.hidden = true; document.getElementById('anno-mask').hidden = true; });
    save.addEventListener('click', function () {
      var fx = fix.value.trim();
      var s = src.value.trim();
      commit({
        type: 'serious', kind: kind, body: body.value.trim(),
        fix: fx + (s ? '\n依据：' + s : ''), name: nm.value.trim() || null
      });
      ed.hidden = true; document.getElementById('anno-mask').hidden = true;
    });
    check();
    body.focus();
  }

  /* ------------------------------------------------------------ 提交 */

  function commit(o) {
    var a = {
      id: uid(), sec: pending.sec, start: pending.start, end: pending.end,
      exact: pending.exact, prefix: pending.prefix, suffix: pending.suffix,
      type: o.type || 'casual', kind: o.kind || null, fix: o.fix || null,
      body: o.body, name: o.name || null, ts: Date.now(), sync: 'pending'
    };
    annos.push(a);
    save();
    if (!showMarks) setShow(true);
    paint(); renderList();
    flush();
    toast(o.type === 'serious'
      ? '已提交 · 正在生成 issue，编号稍后回写'
      : '批注已发布 · 公开可见');
    pending = null;
  }

  /* ------------------------------------------------ 侧栏渲染 */

  var RC = [
    { k: 'useful', e: '👍', t: '有用' },
    { k: 'same', e: '❤️', t: '同感' },
    { k: 'doubt', e: '🤔', t: '存疑' }
  ];

  function unify() {
    var mineIds = {};
    others.forEach(function (o) { mineIds[o.id] = 1; });
    var out = others.slice();
    annos.forEach(function (a) {
      if (mineIds[a.id]) return;               // 服务端已收录，不重复显示
      out.push({
        id: a.id, sec: a.sec, type: a.type || 'casual', kind: a.kind || null,
        exact: a.exact, prefix: a.prefix, suffix: a.suffix, start: a.start, end: a.end,
        body: a.body, fix: a.fix || null, name: a.name || null,
        status: 'open', reactions: { useful: 0, same: 0, doubt: 0 },
        replies: [], ts: a.ts, mine: true, sync: a.sync
      });
    });
    return out;
  }

  function kindLabel(a) {
    if (a.type !== 'serious') return '批注';
    return { suggest: '建议修改', data: '质疑数据', evidence: '补充证据' }[a.kind] || '建议修改';
  }

  function renderList() {
    var list = document.getElementById('anno-list');
    if (!list) return;

    var all = unify().slice().sort(function (x, y) {
      var d = score(y) - score(x);
      return d !== 0 ? d : y.ts - x.ts;
    });
    var live = all.filter(function (a) { return !a._stale && resolve(a); });
    var shown = live.filter(function (a) { return score(a) > 0; });
    var quiet = live.filter(function (a) { return score(a) === 0; });

    document.getElementById('anno-cnt').textContent = all.length ? '/ ' + all.length + ' 条' : '';
    var fab = document.getElementById('anno-fab');
    fab.classList.toggle('has', all.length > 0);
    document.getElementById('anno-badge').textContent = all.length;

    if (!all.length) {
      list.innerHTML = '<div class="anno-empty">这一页还没有批注。<br>选中正文里的一句话就能写 ——<br>不用登录。</div>';
      return;
    }

    var h = '';
    shown.forEach(function (a) { h += cardHTML(a, false); });
    if (quiet.length) {
      h += '<div class="foldbar" id="anno-fold">🕓 还有 ' + quiet.length +
           ' 条批注还没有人回应<button data-unfold>展开看看</button></div>';
      h += '<div id="anno-quiet" style="display:none">';
      quiet.forEach(function (a) { h += cardHTML(a, true); });
      h += '</div>';
    }
    list.innerHTML = h;
  }

  function cardHTML(a, quiet) {
    var me = myRc[a.id] || {};
    var ser = a.type === 'serious';
    var st = '';
    if (a.status === 'done') st = '<span class="badge st done">已处理</span>';
    else if (a.status === 'ack') st = '<span class="badge st">作者已回应</span>';

    var h = '<div class="anno-item' + (ser ? ' ser' : '') + (quiet ? ' dim' : '') +
            '" data-id="' + esc(a.id) + '">';
    h += '<div class="hd">';
    h += ser
      ? '<span class="badge ser">' + esc(kindLabel(a)) + '</span>' +
        (a.issue ? '<a class="badge iss" href="' + esc(GH_ISSUE_BASE + a.issue) +
          '" target="_blank" rel="noopener">issue #' + esc(a.issue) + '</a>' : '') + st
      : '<span class="badge cas">批注</span>';
    h += '<span class="nm">' + esc(a.name || (a.mine ? '我' : '匿名读者')) + ' · ' + esc(ago(a.ts)) + '</span>';
    h += '</div>';

    if (!resolve(a)) {
      h += '<p class="ex" style="color:#a8453b">⚠ 原文已修改，这条批注的锚点失效了</p>';
    } else {
      h += '<p class="ex">' + esc(a.exact) + '</p>';
    }
    h += '<p class="bd">' + esc(a.body) + '</p>';
    if (a.fix) h += '<p class="fix"><b>建议改成：</b>' + esc(a.fix) + '</p>';

    h += '<div class="ft">';
    RC.forEach(function (r) {
      var n = (a.reactions && a.reactions[r.k]) || 0;
      h += '<button class="rc' + (me[r.k] ? ' on' : '') + '" data-rc="' + r.k + '">' +
           r.e + ' ' + r.t + (n ? ' <span>' + n + '</span>' : '') + '</button>';
    });
    h += '<button class="lnk" data-reply>回复</button>';
    if (a.mine && a.sync !== 'sent') {
      h += '<button class="lnk danger" data-del>删除</button>';
    }
    if (isAdmin && !a.mine) {
      h += '<button class="lnk danger" data-hide>删除</button>';
      if (ser && a.status !== 'done') h += '<button class="lnk" data-done>标记已处理</button>';
    }
    if (a.mine && a.sync && a.sync !== 'sent') h += '<span class="lnk">待同步</span>';
    h += '</div>';

    if ((a.replies || []).length) {
      h += '<div class="replys">';
      a.replies.forEach(function (r) {
        h += '<div class="rp"><span class="rn' + (r.au ? ' au' : '') + '">' + esc(r.name) +
             '</span><span class="rt">' + esc(r.text) + '</span></div>';
      });
      h += '</div>';
    }
    h += '<div class="rpbox" style="display:none"><input type="text" maxlength="' + REPLY_MAX +
         '" placeholder="回复这条批注（只一层）"><button data-send>发送</button></div>';
    h += '</div>';
    return h;
  }

  /* ========================================================== 交互 */

  function fabClick() {
    var p = document.getElementById('anno-panel');
    p.hidden = !p.hidden;
    if (!p.hidden) renderList();
  }

  function onSelect(e) {
    if (e && e.target && e.target.closest && e.target.closest('#anno-toolbar, #anno-editor, #anno-root, .anno-inline')) return;
    setTimeout(function () {
      var sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) { hideToolbar(); return; }
      var r = sel.getRangeAt(0);
      var a = anchorFromRange(r);
      if (!a) { hideToolbar(); return; }
      a._rect = r.getBoundingClientRect();
      pending = a;
      if (window.matchMedia && window.matchMedia('(hover: none)').matches) {
        // 触屏：先给一个按钮，点了才展开输入框，免得键盘和浮层抢位置
        showToolbar(r);
      } else {
        openInline();
      }
    }, 10);
  }

  function showToolbar(r) {
    var tb = document.getElementById('anno-toolbar');
    tb.hidden = false;
    var w = tb.offsetWidth, h = tb.offsetHeight;
    var left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
    var top = r.top - h - 8;
    if (top < 8) top = r.bottom + 8;
    tb.style.left = left + 'px';
    tb.style.top = top + 'px';
  }

  function hideToolbar() {
    var t = document.getElementById('anno-toolbar');
    if (t) t.hidden = true;
  }

  function buildUI() {
    var root = el('div');
    root.id = 'anno-root';
    root.innerHTML =
      '<button id="anno-fab" title="这一页的批注">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H9l-5 4z"/></svg>' +
      '<span class="badge" id="anno-badge">0</span></button>' +
      '<div id="anno-panel" hidden>' +
      '<h4>这一页的批注 <span id="anno-cnt" style="font-size:11px;font-weight:400;opacity:.7"></span></h4>' +
      '<p class="sub">选中正文任意一句就能划线写批注。<b>所有人的批注互相可见</b>，可以直接回应。</p>' +
      '<label class="sw" id="anno-sw" role="switch" aria-checked="true" tabindex="0">' +
      '<span class="track"><span class="knob"></span></span><span id="anno-sw-label">显示批注划线</span></label>' +
      '<div id="anno-list"></div>' +
      '</div>';
    document.body.appendChild(root);

    var tb = el('div');
    tb.id = 'anno-toolbar'; tb.hidden = true;
    tb.innerHTML = '<button data-act="comment">写批注</button>';
    document.body.appendChild(tb);

    var ed = el('div');
    ed.id = 'anno-editor'; ed.hidden = true;
    document.body.appendChild(ed);

    var ts = el('div', 'toast'); ts.id = 'anno-toast';
    document.body.appendChild(ts);

    document.getElementById('anno-fab').addEventListener('click', fabClick);

    var sw = document.getElementById('anno-sw');
    sw.addEventListener('click', function () { setShow(!showMarks); });
    sw.addEventListener('keydown', function (e) {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setShow(!showMarks); }
    });

    tb.addEventListener('mousedown', function (e) { e.preventDefault(); });
    tb.addEventListener('click', function (e) {
      if (e.target.dataset.act === 'comment') { hideToolbar(); openInline(); }
    });

    document.addEventListener('mousedown', function (e) {
      if (inline && !inline.contains(e.target)) closeInline();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeInline(); var ed2 = document.getElementById('anno-editor'); if (ed2) ed2.hidden = true; }
    });

    injectInlineStyle();
  }

  /* 只删本机记录：不碰服务端，也不影响别人看到的 */
  function removeLocal(id) {
    annos = annos.filter(function (a) { return a.id !== id; });
    save(); paint(); renderList();
    toast('已删除（仅删除你本机的记录）');
  }

  function hoverAnno(id) {
    if (!SUPPORT || !showMarks) return;
    var a = findAnno(id);
    if (!a) return;
    var r = resolve(a);
    if (r) CSS.highlights.set('anno-hover2', new Highlight(r));
  }

  function clearHover() {
    if (!SUPPORT) return;
    CSS.highlights.delete('anno-hover2');
  }

  function setShow(v) {
    showMarks = v;
    var sw = document.getElementById('anno-sw');
    if (sw) sw.setAttribute('aria-checked', v ? 'true' : 'false');
    var lb = document.getElementById('anno-sw-label');
    if (lb) lb.textContent = v ? '显示批注划线' : '划线已隐藏';
    document.body.classList.toggle('anno-off', !v);
    paint();
  }

  /* ------------------------------------------- 侧栏事件（委托） */

  function onListClick(e) {
    var fold = e.target.closest('#anno-fold');
    if (fold) {
      var z = document.getElementById('anno-quiet');
      if (z) { z.style.display = 'block'; fold.style.display = 'none'; }
      return;
    }
    var item = e.target.closest('.anno-item');
    if (!item) return;
    var id = item.getAttribute('data-id');
    var a = findAnno(id);
    if (!a) return;

    var rc = e.target.closest('[data-rc]');
    if (rc) { sendReact(a, rc.getAttribute('data-rc')); return; }

    if (e.target.closest('[data-del]')) { removeLocal(a.id); return; }
    if (e.target.closest('[data-hide]')) { adminHide(a, true); return; }
    if (e.target.closest('[data-done]')) { adminDone(a); return; }
    if (e.target.closest('[data-reply]')) {
      var box = item.querySelector('.rpbox');
      box.style.display = box.style.display === 'none' ? 'flex' : 'none';
      if (box.style.display === 'flex') box.querySelector('input').focus();
      return;
    }
    if (e.target.closest('[data-send]')) {
      var inp = item.querySelector('.rpbox input');
      sendReply(a, inp.value);
      return;
    }
    gotoAnchor(a);
  }

  /* 两条来源的数据结构不同（本地 / 服务端），统一成同一形状再渲染，
     否则 reactions / replies 在本地批次上会是 undefined，一点就崩。 */
  function findAnno(id) {
    var hit = null;
    others.forEach(function (o) { if (o.id === id) hit = o; });
    if (hit) return hit;
    annos.forEach(function (m) {
      if (m.id === id) {
        hit = {
          id: m.id, sec: m.sec, type: m.type || 'casual', kind: m.kind || null,
          exact: m.exact, prefix: m.prefix, suffix: m.suffix, start: m.start, end: m.end,
          body: m.body, fix: m.fix || null, name: m.name || null,
          status: 'open',
          reactions: { useful: 0, same: 0, doubt: 0 },
          replies: [], ts: m.ts, mine: true, sync: m.sync
        };
      }
    });
    return hit;
  }

  function gotoAnchor(a) {
    var r = resolve(a);
    if (!r) { toast('这条批注的原文找不到了'); return; }
    var box = r.getBoundingClientRect();
    // 被筛选藏起来的卡片 display:none，rect 全 0，照着跳会跳到页顶 —— 先说清原因
    if (!box.width && !box.height) {
      toast('这条现在被筛选条件藏起来了 —— 先点「清空筛选」，再点它');
      return;
    }
    window.scrollTo({ top: window.pageYOffset + box.top - window.innerHeight / 2, behavior: 'smooth' });
  }

  function adminDone(a) {
    fetch(ADMIN_EP, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
      body: JSON.stringify({ id: a.id, page: PAGE, done: true })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { a.status = 'done'; renderList(); toast('已标记为「已处理」'); }
        else toast('操作失败：' + ((j && j.error) || 'unknown'));
      })
      .catch(function () { toast('操作失败：网络错误'); });
  }

  /* ------------------------------------------------------------ 启动 */

  function init() {
    if (!document.body) return;
    ADMIN_TOKEN = initAdmin();
    injectStyle();
    buildUI();
    placeRoot();

    annos = load();
    myRc = loadRc();
    secIndex = buildIndex();

    if (!SUPPORT) toast('当前浏览器不支持高亮 API，批注仍可读写，但不显示划线', 5000);

    setShow(true);
    paint();
    renderList();
    initTurnstile();
    setTimeout(flush, 1200);
    fetchOthers();          // v2：公开批注

    document.addEventListener('mouseup', onSelect);
    document.addEventListener('touchend', function (e) { setTimeout(function () { onSelect(e); }, 30); }, { passive: true });
    document.addEventListener('scroll', hideToolbar, { passive: true });
    window.addEventListener('online', flush);
    window.addEventListener('focus', flush);
    window.addEventListener('resize', schedulePlace);
    window.addEventListener('load', schedulePlace);   // 图片/字体落位后底部栏高度可能变

    var lst = document.getElementById('anno-list');
    lst.addEventListener('click', onListClick);
    lst.addEventListener('mouseover', function (e) {
      var it = e.target.closest('.anno-item');
      if (it) hoverAnno(it.getAttribute('data-id'));
    });
    lst.addEventListener('mouseout', function (e) {
      var it = e.target.closest('.anno-item');
      if (it && !it.contains(e.relatedTarget)) clearHover();
    });

    // 仅本地调试时暴露内部状态，线上不挂
    if (/^(127\.0\.0\.1|localhost)$/.test(location.hostname)) {
      window.__anno = {
        reindex: function () { secIndex = buildIndex(); },
        paint: paint,
        resolve: resolve,
        openInline: openInline,
        openEditor: openEditor,
        pending: function () { return pending ? { sec: pending.sec, start: pending.start, end: pending.end } : null; },
        annos: function () { return annos; },
        others: function () { return others; },
        /* 调试：传入 CSS 选择器，检查该元素内第一个长文本节点能否被锚定 */
        tryPick: function (sel) {
          var host = document.querySelector(sel);
          if (!host) return 'nohost';
          var w = document.createTreeWalker(host, NodeFilter.SHOW_TEXT), n, t = null;
          while ((n = w.nextNode())) { if (n.nodeValue.trim().length > 20) { t = n; break; } }
          if (!t) return 'notext';
          var r = document.createRange();
          r.setStart(t, 2); r.setEnd(t, Math.min(24, t.nodeValue.length));
          var a = anchorFromRange(r);
          return a ? ('ok|sec=' + a.sec + '|' + a.exact.slice(0, 14)) : ('null|' + t.nodeValue.slice(0, 14));
        },
        stats: function () { return { mine: annos.length, others: others.length, secs: Object.keys(index().secs).length }; }
      };
    }
  }

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

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
