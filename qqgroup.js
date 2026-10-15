/**
 * mirror-guide 读者联系入口（QQ 群 + 作者微信）—— 前端接入模块
 * ------------------------------------------------------------
 * 引入方式（一行）：
 *   <script src="qqgroup.js" defer></script>
 *
 * 页面上放一个占位容器即可，脚本会把它填成一块入口卡片：
 *   <div id="qq-entry"></div>
 *
 * 顶栏入口也是这个脚本建的（不需要改 HTML）：在「分享」按钮后面插一个图标按钮，
 * 点开是一个下拉栏，跟站点的分享菜单同一套视觉：
 *   ┌ 引导文案 ─────────────────────┐
 *   │ [Q] QQ：1130141971            │ ← 点整行才跳转加群
 *   │     点这一行加入读者交流群     │
 *   │ ─────────────────────────     │
 *   │ [微] 加作者微信交流            │ ← 点这行展开二维码
 *   │     扫码加我 · 备注「以日为鉴」│
 *   │      ┌────────────┐           │
 *   │      │  微信二维码 │           │
 *   │      └────────────┘           │
 *   └───────────────────────────────┘
 *
 * 可选覆盖配置（放在 qqgroup.js 之前）：
 *   <script>
 *   window.QQ_CONFIG = {
 *     groupNo: '1130141971',
 *     joinUrl: 'https://qun.qq.com/universal-share/share?...',
 *     qr: 'wechat-qr.png',  // 作者微信二维码图片，默认按脚本自身路径推断
 *     slot: '#qq-entry',
 *     topbar: true,         // 是否在顶栏加下拉入口，默认 true
 *     siteName: '以日为鉴',  // 引导语里怎么称呼本站（默认「以日为鉴」）
 *     wxNote: '以日为鉴'     // 加微信时的备注词
 *   };
 *
 * 两站共用：这个模块现在同时挂在 mirror-guide 与 justin-sun-corpus 上，
 * 差异只有 QQ_CONFIG 里的 siteName / wxNote（同一个作者，同一个群）。
 *   </script>
 *
 * 为什么不是一个裸链接就完事（三个真实约束）：
 *   1. 「一键加群」用的 universal-share 链接带着 authKey / data 两个签名参数，
 *      是会被换掉、会过期的。所以群号本身必须是页面上"永远可用"的入口：
 *      可选中、可复制、可拿去 QQ 里搜。
 *   2. 微信内置浏览器（以及企业微信）会拦 QQ 域名，点了大概率是"已停止访问"。
 *      检测到微信环境时，那一行改成"复制群号"，并说清原因，不让读者白点。
 *   3. 顶栏下拉是快捷键，真正把话说全的兜底文案在页面底部那块卡片上。
 */

(function () {
  'use strict';

  var CFG = window.QQ_CONFIG || {};
  var GROUP_NO = String(CFG.groupNo || '1130141971');
  var JOIN_URL = CFG.joinUrl || (
    'https://qun.qq.com/universal-share/share?ac=1&authKey=G5%2F29eeC5bBWTf3ExpyMuXHl1vO3ztZsfQ6T6%2FYN8kzFMnRcrtUApGrzO00i7ivr' +
    '&busi_data=eyJncm91cENvZGUiOiIxMTMwMTQxOTcxIiwidG9rZW4iOiJ3ejgzMzNlL0Zoc2FiRDUzOGUyV0pRT3VhK2g4UWE4Z3RDd0RsYjAvWG8zak1nMVFtRk8yTHZ6Q09sYWRQck4yIiwidWluIjoiMjMxNTkxNzgwNyJ9' +
    '&data=8KX_FL9Xg1-dfApNdZ18390GXEwlDB2H_EjZP70EiKU4jQ5ReFVFWbKQl9xnHyeklJyCeSgNTUOjWLw4Kx6UFA&svctype=4&tempid=h5_group_info'
  );
  var SLOT = CFG.slot || '#qq-entry';
  // 这份模块现在两个站共用，文案里怎么称呼本站是可配的（默认按「以日为镜」的口吻）。
  // siteName 用在两处引导语里，wxNote 是加微信时的备注词。
  var SITE_NAME = String(CFG.siteName || '以日为鉴');
  var WX_NOTE = String(CFG.wxNote || '以日为鉴');
  var WANT_TOPBAR = CFG.topbar !== false;
  // 二维码图片：默认按脚本自身的路径推断，这样模块被放到子目录也不会指错
  var QR_SRC = CFG.qr || (function () {
    var s = document.currentScript && document.currentScript.src;
    return s ? s.replace(/[^/]*$/, 'wechat-qr.png') : 'wechat-qr.png';
  })();

  var ua = navigator.userAgent || '';
  var IN_WX = /MicroMessenger/i.test(ua) || /wxwork/i.test(ua);
  var IN_QQ = /\bQQ\//i.test(ua) || /QQBrowser/i.test(ua);

  /* ---------------------------------------------------------- 小工具 */

  function toast(msg, ms) {
    var t = document.getElementById('qq-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'qq-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('on'); }, ms || 3200);
  }

  /* 同步复制：真实点击时几乎总能成，而且给了立刻的反馈。
     不依赖 Promise，所以不会出现"点了没反应"。 */
  function execCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  /* 先同步、再异步，并且给异步加超时 ——
     实测：没有用户手势（或被权限策略挡住）时，clipboard.writeText 返回的
     Promise 会一直 pending、既不 resolve 也不 reject，按钮看起来就是坏的。
     所以必须有兜底计时器，把"沉默失败"变成一句能看懂的话。 */
  function copyText(text, okMsg) {
    var settled = false;
    var ok = function () { if (settled) return; settled = true; toast(okMsg || ('已复制群号 ' + text)); };
    var fail = function () {
      if (settled) return; settled = true;
      toast('复制没成功 —— 请手动长按选中群号 ' + text);
    };

    if (execCopy(text)) { ok(); return; }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      var timer = setTimeout(fail, 1500);
      navigator.clipboard.writeText(text).then(
        function () { clearTimeout(timer); ok(); },
        function () { clearTimeout(timer); if (execCopy(text)) ok(); else fail(); }
      );
      return;
    }
    fail();
  }

  function svgQQ(size) {
    // 简洁的"群"意象：两个对话气泡叠在一起，跟站点其他图标一样是描边风格
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h9A1.5 1.5 0 0 1 15 6.5v5A1.5 1.5 0 0 1 13.5 13H7l-4 3z"/>' +
      '<path d="M15.5 8.2h4A1.5 1.5 0 0 1 21 9.7v4.3a1.5 1.5 0 0 1-1.5 1.5H18l-3.2 2.4V15"/></svg>';
  }

  /* ---------------------------------------------------------- 样式 */

  function injectStyle() {
    var css = [
      // 这里用的 CSS 变量（--card/--line/--teal/--ink…）两个页面都在 :root 里定义了，
      // 所以亮暗主题自动跟随，不需要额外写 [data-theme] 分支。
      '.qq-card{display:flex;gap:14px;align-items:flex-start;border:1px solid var(--line);border-radius:14px;',
      'background:var(--card);padding:16px 18px;margin:26px 0 0;box-shadow:0 1px 2px rgba(40,35,25,.05)}',
      '.qq-ic{flex:0 0 auto;width:42px;height:42px;border-radius:12px;background:var(--teal);color:#f5f1e8;',
      'display:flex;align-items:center;justify-content:center}',
      '.qq-main{flex:1;min-width:0}',
      '.qq-main h4{margin:0 0 5px;font-size:15px;color:var(--teal);font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.qq-main h4 .qq-tag{font-size:11px;font-weight:600;color:var(--ink2);border:1px solid var(--line);border-radius:99px;padding:1px 8px;letter-spacing:.3px}',
      '.qq-desc{margin:0 0 11px;font-size:13.5px;line-height:1.75;color:var(--ink2)}',
      '.qq-row{display:flex;align-items:center;gap:9px;flex-wrap:wrap}',
      '.qq-btn{display:inline-flex;align-items:center;gap:7px;background:var(--teal);color:#f5f1e8!important;border:1px solid var(--teal);',
      'border-radius:9px;padding:8px 15px;font-size:13.5px;font-weight:600;text-decoration:none!important;cursor:pointer;font-family:inherit}',
      '.qq-btn:hover{opacity:.9}',
      '.qq-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line);border-radius:9px;padding:7px 12px;',
      'font-size:13px;color:var(--ink2);background:var(--paper)}',
      '.qq-no{font-weight:700;letter-spacing:.6px;color:var(--teal)!important;text-decoration:none;font-variant-numeric:tabular-nums;cursor:pointer}',
      '.qq-no:hover{text-decoration:underline!important}',
      'span.qq-no{cursor:text}',
      '.qq-copy{border:1px solid var(--line);background:transparent;color:var(--ink2);border-radius:9px;padding:7px 12px;',
      'font-size:13px;cursor:pointer;font-family:inherit}',
      '.qq-copy:hover{border-color:var(--teal);color:var(--teal)}',
      '.qq-tip{margin:10px 0 0;font-size:12px;line-height:1.7;color:var(--ink2)}',
      '.qq-tip.warn{color:#b4553f}',
      '#qq-toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%) translateY(10px);background:#22303a;color:#eef3f2;',
      'font-size:13px;padding:9px 16px;border-radius:9px;opacity:0;pointer-events:none;transition:all .22s;z-index:1005;max-width:86vw;text-align:center}',
      '#qq-toast.on{opacity:1;transform:translateX(-50%) translateY(0)}',
      // ---- 顶栏下拉（复用站点 .share-menu / .sm-item 那套外观，只补差异部分）----
      '.qq-wrap{flex:0 0 auto;position:relative}',
      '.qq-menu{width:264px}',
      '.qq-menu .sm-item{text-decoration:none!important}',
      '.iconbtn.qq[aria-expanded="true"]{border-color:var(--teal);color:var(--teal);background:var(--paper2)}',
      '.qm-lead{margin:5px 9px 7px;font-size:12.5px;line-height:1.65;color:var(--ink2)}',
      '.qm-qrbox img{display:block;width:100%;max-width:232px;height:auto;margin:0 auto;border-radius:8px;',
      'box-shadow:0 0 0 1px var(--line)}',
      '.qm-qrbox .qr-hint{margin:9px 2px 4px}',
      '@media(max-width:420px){.qq-menu{width:min(300px,calc(100vw - 30px))}}',
      '@media(max-width:560px){.qq-card{flex-direction:column;gap:11px;padding:15px 16px}.qq-ic{width:38px;height:38px}}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'qq-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ---------------------------------------------------------- 入口卡片 */

  function buildCard(slot) {
    var card = document.createElement('section');
    card.className = 'qq-card';
    card.setAttribute('aria-label', '读者 QQ 交流群');
    // 批注层看到 data-anno-skip 会整棵子树跳过，避免把进群引导当成正文来划线
    card.setAttribute('data-anno-skip', '');

    var ic = document.createElement('div');
    ic.className = 'qq-ic';
    ic.innerHTML = svgQQ(22);

    var main = document.createElement('div');
    main.className = 'qq-main';

    var h4 = document.createElement('h4');
    h4.innerHTML = '读者交流群 <span class="qq-tag">QQ</span>';

    var desc = document.createElement('p');
    desc.className = 'qq-desc';
    desc.textContent = '读完有想法、发现哪条数据对不上、或者想聊聊自己那份情况，都欢迎进来说。' + SITE_NAME + '的增补与数据更新也会先在群里发。';

    var row = document.createElement('div');
    row.className = 'qq-row';

    var btn;
    if (IN_WX) {
      // 微信里不做无意义的跳转：直接把"复制群号"作为主按钮
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'qq-btn';
      btn.textContent = '复制群号';
      btn.addEventListener('click', function () {
        copyText(GROUP_NO, '已复制群号 ' + GROUP_NO + ' —— 打开 QQ，用「加好友/群」搜索即可');
      });
    } else {
      btn = document.createElement('a');
      btn.className = 'qq-btn';
      btn.href = JOIN_URL;
      btn.target = '_blank';
      btn.rel = 'noopener nofollow';
      btn.innerHTML = svgQQ(16) + '<span>一键加入 QQ 群</span>';
    }
    row.appendChild(btn);

    var pill = document.createElement('span');
    pill.className = 'qq-pill';
    pill.appendChild(document.createTextNode('群号 '));
    var noEl;
    if (IN_WX) {
      noEl = document.createElement('span');
      noEl.className = 'qq-no';
      noEl.textContent = GROUP_NO;
      noEl.title = '长按可选中复制';
    } else {
      noEl = document.createElement('a');
      noEl.className = 'qq-no';
      noEl.href = JOIN_URL;
      noEl.target = '_blank';
      noEl.rel = 'noopener nofollow';
      noEl.textContent = GROUP_NO;
      noEl.title = '点这里唤起 QQ 加群';
    }
    pill.appendChild(noEl);
    row.appendChild(pill);

    // 微信里主按钮已经是"复制群号"了，再挂一个复制按钮就是重复动作，不画。
    if (!IN_WX) {
      var cp = document.createElement('button');
      cp.type = 'button';
      cp.className = 'qq-copy';
      cp.textContent = '复制群号';
      cp.addEventListener('click', function () {
        copyText(GROUP_NO);
      });
      row.appendChild(cp);
    }

    var tip = document.createElement('p');
    if (IN_WX) {
      tip.className = 'qq-tip warn';
      tip.textContent = '微信内置浏览器打不开 QQ 的加群链接（会被拦）。上面点「复制群号」或长按群号选中复制，再打开 QQ 搜索群号加入。';
    } else if (IN_QQ) {
      tip.className = 'qq-tip';
      tip.textContent = '你在 QQ 里 —— 点上面任意一个群号都能直接进群。';
    } else {
      tip.className = 'qq-tip';
      tip.textContent = '在手机上点群号会唤起 QQ 直接加群；如果哪天提示链接失效（一键加群链接是有时效签名的），复制群号在 QQ 里搜一下就行 —— 群号一直有效。';
    }

    main.appendChild(h4);
    main.appendChild(desc);
    main.appendChild(row);
    main.appendChild(tip);
    card.appendChild(ic);
    card.appendChild(main);
    slot.appendChild(card);
  }

  /* ---------------------------------------------------------- 顶栏下拉入口 */

  function buildTopbarEntry() {
    var themeBtn = document.getElementById('themebtn');
    var col = themeBtn ? themeBtn.parentNode : null;
    if (!col || document.getElementById('qqwrap')) return;

    var wrap = document.createElement('div');
    wrap.className = 'qq-wrap';
    wrap.id = 'qqwrap';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'qqbtn';
    btn.className = 'iconbtn qq';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', '联系作者：加 QQ 群 / 加微信');
    btn.title = '联系作者 · QQ 群 / 微信';
    btn.innerHTML = svgQQ(18);

    var menu = document.createElement('div');
    menu.id = 'qqmenu';
    menu.className = 'share-menu qq-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '联系作者');
    // 批注层看到 data-anno-skip 会整棵子树跳过，免得把引导文案当成正文来划线
    menu.setAttribute('data-anno-skip', '');

    /* ---- 展开 / 收起 ---- */
    var isOpen = false;
    var qrBox, wxRow;
    function setOpen(v) {
      isOpen = v;
      menu.classList.toggle('open', v);
      btn.setAttribute('aria-expanded', v ? 'true' : 'false');
      if (!v && qrBox) {
        qrBox.hidden = true;
        wxRow.setAttribute('aria-expanded', 'false');
      }
    }

    /* ---- 顶部引导文案 ---- */
    var lead = document.createElement('p');
    lead.className = 'qm-lead';
    lead.textContent = '读完想聊两句？加 QQ 群或加作者微信交流都行 —— ' + SITE_NAME + '的增补与数据更新会先在群里发。';
    menu.appendChild(lead);

    /* ---- ① QQ 群：整行就是「QQ：群号」这行文字，点整行才跳转 ---- */
    var qqRow;
    if (IN_WX) {
      // 微信内置浏览器拦 QQ 域名，跳过去只会是"已停止访问" —— 换成复制群号
      qqRow = document.createElement('button');
      qqRow.type = 'button';
      qqRow.addEventListener('click', function () {
        setOpen(false);
        copyText(GROUP_NO, '已复制群号 ' + GROUP_NO + ' —— 打开 QQ，搜「加群」粘贴即可');
      });
    } else {
      qqRow = document.createElement('a');
      qqRow.href = JOIN_URL;
      qqRow.target = '_blank';
      qqRow.rel = 'noopener nofollow';
      qqRow.addEventListener('click', function () { setOpen(false); });
    }
    qqRow.className = 'sm-item qm-qq';
    qqRow.setAttribute('role', 'menuitem');
    qqRow.title = IN_WX ? ('复制群号 ' + GROUP_NO) : ('加入读者 QQ 群 ' + GROUP_NO);
    qqRow.innerHTML = '<span class="sm-ic">Q</span><span class="sm-tx">QQ：' + GROUP_NO +
      '<small>' + (IN_WX ? '微信里点这行＝复制群号' : '点这一行加入读者交流群') + '</small></span>';
    menu.appendChild(qqRow);

    var sep = document.createElement('div');
    sep.className = 'sm-sep';
    menu.appendChild(sep);

    /* ---- ② 微信：点这行展开二维码（不做跳转，二维码就显示在菜单里）---- */
    wxRow = document.createElement('button');
    wxRow.type = 'button';
    wxRow.className = 'sm-item qm-wx';
    wxRow.setAttribute('role', 'menuitem');
    wxRow.setAttribute('aria-expanded', 'false');
    wxRow.innerHTML = '<span class="sm-ic">微</span><span class="sm-tx">加作者微信交流' +
      '<small>扫码加我 · 备注「' + WX_NOTE + '」</small></span>';
    menu.appendChild(wxRow);

    qrBox = document.createElement('div');
    qrBox.className = 'qr-box qm-qrbox';
    qrBox.hidden = true;
    qrBox.innerHTML = '<img src="' + QR_SRC + '" alt="作者微信二维码" width="232" height="232">' +
      '<p class="qr-hint">微信「扫一扫」，或者长按图片识别。用电脑看的话，直接拿手机扫屏幕也行。</p>';
    menu.appendChild(qrBox);

    wxRow.addEventListener('click', function (e) {
      e.stopPropagation();
      var show = qrBox.hidden;
      qrBox.hidden = !show;
      wxRow.setAttribute('aria-expanded', show ? 'true' : 'false');
    });

    /* ---- 开关与关闭时机 ---- */
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      // 分享菜单可能开着，先收掉，免得两个浮层叠一起
      Array.prototype.forEach.call(document.querySelectorAll('.share-menu.open'), function (m) {
        if (m !== menu) m.classList.remove('open');
      });
      setOpen(!isOpen);
    });
    document.addEventListener('click', function (e) {
      if (isOpen && !wrap.contains(e.target)) setOpen(false);
    }, true);   // ← 捕获阶段：分享按钮的 onclick 里有 stopPropagation，
                //   挂在冒泡阶段的话「QQ 开着时点分享」收不掉这个浮层，两个会叠一起
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && isOpen) setOpen(false);
    });

    // 插在 GitHub 图标之前，跟分享键挨着，视觉上都是"对外入口"
    var gh = col.querySelector('.iconbtn.gh');
    wrap.appendChild(btn);
    wrap.appendChild(menu);
    col.insertBefore(wrap, gh || themeBtn);
  }

  /* ---------------------------------------------------------- 启动 */

  function init() {
    if (!document.body) return;
    injectStyle();
    var slot = document.querySelector(SLOT);
    if (slot) buildCard(slot);
    if (WANT_TOPBAR) buildTopbarEntry();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
