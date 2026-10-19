/**
 * 生成「附录 · 数据图」区块（5 张图）并注入 index.html。
 *
 * 与 tools/gen_charts.mjs 的关系：
 *   那支是给正文里 8 张图做静态化的，标记块（CSS_MARK_*）和图表 id 都是它自己的。
 *   这支**完全独立**：自己的 CSS 标记、自己的区块标记、自己的类名前缀 ap-，
 *   互不覆盖 —— 重跑任何一支都不会动到另一支的产物。
 *
 * 口径纪律（写死在本文件里，改图前先读）：
 *   1. 官方序列一律不插值、不外推、不补点；官方没发的年份就停在那儿。
 *   2. 推算只出现在图 3，且必须与实测段在视觉上分开（虚线 + 阴影带 + 竖向分界）。
 *   3. 两条不同口径的序列不做加总（统计局答问原文明确「不能直接相加或替代」）。
 *   4. 每个数值都能在 tools/appendix-charts-data.json 里找到来源；本文件不做任何"微调"。
 *
 * 用法：
 *   node tools/gen_appendix_charts.mjs          改写 index.html
 *   node tools/gen_appendix_charts.mjs --dry    只打印，不落盘
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, 'index.html');
const DATA = path.join(ROOT, 'tools', 'appendix-charts-data.json');
const DRY = process.argv.includes('--dry');

const D = JSON.parse(fs.readFileSync(DATA, 'utf8'));

/* ── 配色：全部走 CSS 变量，深色主题靠 :root / html[data-theme=dark] 两套值自动切换 ── */
const C = {
  teal: 'var(--ch-teal)', taupe: 'var(--ch-taupe)', gold: 'var(--ch-gold)',
  clay: 'var(--ch-clay)', sand: 'var(--ch-sand)', green: 'var(--ch-green)',
};

/* ── 几何工具 ─────────────────────────────────────────── */
const r2 = (n) => Math.round(n * 100) / 100;
const pct = (n) => r2(n) + '%';
/** 类目轴：第 i 个柱的中心 */
const xB = (i, n) => ((i + 0.5) / n) * 100;
/** 连续轴：第 i 个点的位置（首尾贴边） */
const xL = (i, n) => (n === 1 ? 50 : (i / (n - 1)) * 100);
/** 值 → 自下而上的百分比 */
const yP = (v, min, max) => ((v - min) / (max - min)) * 100;
/** 贴边标签向内锚定，否则最左/最右那个被裁掉 */
const edge = (x) => (x >= 92 ? 'er' : x <= 8 ? 'el' : '');

/** 从 0 起的"好看"刻度：返回 { max, ticks } */
function niceScale(top, div = 4) {
  const raw = top / div;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]
    .map((k) => k * mag)
    .find((s) => s >= raw) || 10 * mag;
  const max = Math.ceil(top / step) * step;
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return { max, ticks };
}

/**
 * 画一帧：左轴文字 + 绘图区（网格 + 内容）+ 可选 X 轴标签行。
 * 文字全部是 HTML（不放进 SVG），这样手机 350px 和桌面 980px 上字号都不变 ——
 * 这是 gen_charts.mjs 定下的规矩，这里照办。
 */
function frame({ ph = 220, ybw = 42, min, max, ticks, fmt = String, inner = '', xlabels = [], xh = 18, hover = '' }) {
  const axl = `<div class="ap-axl">` +
    ticks.map((t) => `<span style="bottom:${pct(yP(t, min, max))}">${fmt(t)}</span>`).join('') +
    `</div>`;
  const grid = ticks.map((t) => `<span class="ap-gl" style="bottom:${pct(yP(t, min, max))}"></span>`).join('');
  /* hover 层必须排在 inner 之后：透明列要盖在柱子/折线上面接指针 */
  const plot = `<div class="ap-plot">${grid}${inner}${hover}</div>`;
  const xl = xlabels.length
    ? `<div class="ap-xl"><div></div><div class="ap-xrow" style="height:${xh}px">` +
      xlabels.map((l) => `<span class="${edge(l.x)}" style="left:${pct(l.x)}">${l.t}</span>`).join('') +
      `</div></div>`
    : '';
  return `<div class="ap-frame" style="--ph:${ph}px;--ybw:${ybw}px">${axl}${plot}</div>${xl}`;
}

/** 折线（SVG，viewBox 100×100 + non-scaling-stroke，线宽不随容器缩放变形） */
function poly(pts, color, { w = 2.5, dash = '', op = 1 } = {}) {
  const s = pts.map((p) => `${r2(p.x)},${r2(100 - p.y)}`).join(' ');
  return `<polyline points="${s}" fill="none" stroke="${color}" stroke-width="${w}" ` +
    `stroke-opacity="${op}"${dash ? ` stroke-dasharray="${dash}"` : ''} ` +
    `vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>`;
}

/** 两条折线之间的带（上界 top、下界 bot） */
function bandPoly(top, bot, color, op = 0.16) {
  const up = top.map((p) => `${r2(p.x)},${r2(100 - p.y)}`);
  const dn = bot.slice().reverse().map((p) => `${r2(p.x)},${r2(100 - p.y)}`);
  return `<polygon points="${up.concat(dn).join(' ')}" fill="${color}" fill-opacity="${op}" stroke="none"/>`;
}

/** 折线下方到底部的面积（基线 atBottom=true 时填到图底） */
function areaPoly(pts, color, op = 0.1) {
  if (!pts.length) return '';
  const s = pts.map((p) => `${r2(p.x)},${r2(100 - p.y)}`).join(' ');
  return `<polygon points="${s} ${r2(pts[pts.length - 1].x)},100 ${r2(pts[0].x)},100" ` +
    `fill="${color}" fill-opacity="${op}" stroke="none"/>`;
}

const dot = (x, y, color, size = 7) =>
  `<span class="ap-dot" style="left:${pct(x)};bottom:${pct(y)};width:${size}px;height:${size}px;background:${color}"></span>`;

const tag = (x, y, text, color) =>
  `<span class="ap-tag ${edge(x)}" style="left:${pct(x)};bottom:${pct(y)};color:${color || ''}">${text}</span>`;

const badge = (x, y, text) =>
  `<span class="ap-badge" style="left:${pct(x)};bottom:${pct(y)}">${text}</span>`;

const vline = (x, text = '') =>
  `<span class="ap-vline" style="left:${pct(x)}"></span>` +
  (text ? `<span class="ap-vlab" style="left:${pct(x)}">${text}</span>` : '');

const legend = (items) =>
  `<div class="ap-lg">${items
    .map((i) => `<span><i class="${i.dash ? 'dash' : ''}" style="${i.dash
      ? `color:${i.c};border-top-color:${i.c}`
      : `background:${i.c};opacity:${i.op == null ? 1 : i.op}`}"></i>${i.t}</span>`)
    .join('')}</div>`;

/**
 * 悬停读数层（渐进增强）。items: [{x, w, t:[行...]}]，x/w 都是百分比。
 * 生成一排透明的列 span 盖在图上接指针，外加一根竖线和一只气泡（初始 opacity:0）；
 * 读数（年份/数值）在构建期就写进 data-t 属性，运行时零请求、零计算序列。
 * JS 失效时这三个元素只是永远不显示，图表本身照常完整 —— 不增加任何「打不开」风险。
 */
function hoverLayer(items) {
  return items.map((it) =>
    `<span class="ap-hs" data-t="${it.t.join('|')}" style="left:${pct(it.x)};width:${pct(it.w)}"></span>`
  ).join('') + `<span class="ap-cross"></span><div class="ap-tip"></div>`;
}

/** 单选切换（纯 CSS，无 JS）。panes: [{id, label, html}]，checkedIdx 为默认项 */
function switchUI({ name, panes, checkedIdx = 0 }) {
  const ids = panes.map((p, i) => `${name}-${i + 1}`);
  const inputs = ids
    .map((id, i) => `<input type="radio" name="${name}" id="${id}"${i === checkedIdx ? ' checked' : ''}>`)
    .join('');
  const tabbar = `<div class="ap-tabbar">` +
    panes.map((p, i) => `<label for="${ids[i]}">${p.label}</label>`).join('') + `</div>`;
  const bodies = `<div class="ap-panes">` +
    panes.map((p, i) => `<div class="ap-pane" data-p="${ids[i]}">${p.html}</div>`).join('') + `</div>`;
  return `<div class="ap-sw">${inputs}${tabbar}${bodies}</div>`;
}

/** 切换开关的 CSS 由 JS 生成（id 是动态的，写不进静态 CSS） */
const switchCSS = (name, n) => {
  let css = '';
  for (let i = 1; i <= n; i++) {
    const id = `${name}-${i}`;
    css += `#${id}:checked~.ap-panes [data-p="${id}"]{display:block}`;
    css += `#${id}:checked~.ap-tabbar label[for="${id}"]{background:var(--teal);color:#f5f1e8;border-color:var(--teal)}`;
  }
  return css;
};

/* ══════════════════════════════════════════════════════
   图 1 · 出生 / 死亡 / 净增（2000–2025）
   ══════════════════════════════════════════════════════ */
function fig1() {
  const P = D.population;
  const ys = P.years, n = ys.length;
  const MIN = -1200, MAX = 1800;
  const ticks = [-1200, -600, 0, 600, 1200, 1800];
  const zero = yP(0, MIN, MAX);
  const gw = 100 / n;
  const bw = gw * 0.42;

  let bars = '';
  for (let i = 0; i < n; i++) {
    const cx = xB(i, n);
    const b = P.births[i], d = P.deaths[i];
    // 出生向上。⚠️ 出生/死亡两根柱必须共用同一条年份中心线（cx）——
    //    之前故意错开 ±0.55 柱宽，结果相邻年份的「死亡柱」和「出生柱」
    //    挨得比同一年内两根柱还近，被读成相邻两年各一根
    //    （2026-10-19 用户实测：自己第一眼都看错了）。
    bars += `<span class="ap-bar" style="left:${pct(cx)};width:${pct(bw)};bottom:${pct(zero)};height:${pct(yP(b, MIN, MAX) - zero)};background:${C.teal}"></span>`;
    // 死亡向下（翻转）。⚠️ 必须取 yP(-d) —— 直接写 yP(d) 会落在零线**上方**，
    //    再算 zero - yP(d) 得到负数高度，柱子整个消失（踩过）。
    bars += `<span class="ap-bar dn" style="left:${pct(cx)};width:${pct(bw)};bottom:${pct(yP(-d, MIN, MAX))};height:${pct(zero - yP(-d, MIN, MAX))};background:${C.clay};opacity:.82"></span>`;
  }

  const netPts = P.net.map((v, i) => ({ x: xB(i, n), y: yP(v, MIN, MAX) }));

  /* 悬停读数：一年一列（列宽 = 100/n，柱子正好在列中心）。
     数值全部来自 data JSON，构建期写死，与图上的柱子同源。 */
  const hover = hoverLayer(ys.map((y, i) => ({
    x: xB(i, n) - gw / 2, w: gw,
    t: [
      `${y} 年`,
      `出生 ${P.births[i]} 万`,
      `死亡 ${P.deaths[i]} 万`,
      `净增 ${P.net[i] >= 0 ? '+' : ''}${P.net[i]} 万`,
    ],
  })));

  /* ⚠️ 净增折线天生要穿过出生柱（净增点永远落在柱子高度以内），
     所以：① 不给它逐点标数字（数字压在同色深柱上根本读不出来）；
     ② 线下面垫一条卡片底色的粗线当描边，把金线从深青柱上"托"起来。
     关键数值（+957 → −339）放在图例里，字号是正文级，比任何浮标都好读。 */
  const inner =
    bars +
    `<span class="ap-gl zero" style="bottom:${pct(zero)}"></span>` +
    `<svg class="ap-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
    poly(netPts, 'var(--card)', { w: 6, op: 0.72 }) +
    poly(netPts, C.gold, { w: 2.5 }) + `</svg>` +
    dot(netPts[0].x, netPts[0].y, C.gold, 6) +
    dot(netPts[n - 1].x, netPts[n - 1].y, C.gold, 7);

  const xlabels = [0, 5, 10, 15, 20, 25].map((i) => ({ x: xB(i, n), t: ys[i] }));

  return legend([
    { c: C.teal, t: '出生人口（向上）' },
    { c: C.clay, t: '死亡人口（向下）' },
    { c: C.gold, t: `净增 = 出生 − 死亡（+${P.net[0]} → ${P.net[n - 1]}）` },
  ]) + frame({ ph: 250, ybw: 46, min: MIN, max: MAX, ticks, fmt: (v) => v, inner, xlabels, hover });
}

/* ══════════════════════════════════════════════════════
   图 2 · 总人口（2000–2025，截断纵轴）
   ══════════════════════════════════════════════════════ */
function fig2() {
  const P = D.population;
  const ys = P.years, n = ys.length;
  // 纵轴从 12.5 亿起（不从 0 起）—— 26 年只变了 0.9%，从 0 画等于什么都没画
  const MIN = 125000, MAX = 142000;
  const ticks = [125000, 130000, 135000, 140000, 142000];
  const fmtTick = (v) => (v / 10000).toFixed(1);
  // 刻度用 1 位就够（12.5/13.0/…），但数值标注必须 2 位 —— 1 位会把
  // 141260 印成 14.1、140489 印成 14.0，区间两端看着像同一年。
  const fmtVal = (v) => (v / 10000).toFixed(2);

  const pts = P.total.map((v, i) => ({ x: xL(i, n), y: yP(v, MIN, MAX) }));
  const peakIdx = P.total.indexOf(Math.max(...P.total));
  const lastIdx = n - 1;

  const inner =
    `<svg class="ap-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${areaPoly(pts, C.teal, 0.09)}${poly(pts, C.teal, { w: 2.6 })}</svg>` +
    pts.map((p) => dot(p.x, p.y, C.teal, 4.5)).join('') +
    dot(pts[peakIdx].x, pts[peakIdx].y, C.teal, 9) +
    dot(pts[lastIdx].x, pts[lastIdx].y, C.teal, 9) +
    badge(pts[peakIdx].x, pts[peakIdx].y + 6, `${ys[peakIdx]} 见顶 ${fmtVal(P.total[peakIdx])}`) +
    tag(pts[lastIdx].x, pts[lastIdx].y - 5.5, fmtVal(P.total[lastIdx]), C.teal);

  const xlabels = [0, 5, 10, 15, 20, 25].map((i) => ({ x: xL(i, n), t: ys[i] }));

  /* 悬停读数：连续轴、点贴边（首点 0%、末点 100%），
     列边界取相邻点的中点 —— 首尾两列各自向外补齐到 0/100。 */
  const hover = hoverLayer(P.total.map((v, i) => {
    const l = i === 0 ? 0 : (xL(i - 1, n) + xL(i, n)) / 2;
    const r = i === n - 1 ? 100 : (xL(i, n) + xL(i + 1, n)) / 2;
    return { x: l, w: r - l, t: [`${ys[i]} 年`, `总人口 ${(v / 10000).toFixed(2)} 亿`] };
  }));

  return `<div class="ap-unit">亿人</div>` +
    legend([{ c: C.teal, t: '年末总人口' }]) +
    frame({ ph: 250, ybw: 40, min: MIN, max: MAX, ticks, fmt: fmtTick, inner, xlabels, hover });
}

/* ══════════════════════════════════════════════════════
   图 3 · 毕业生：实测 2000–2025 + 推算 2026–2050
   ══════════════════════════════════════════════════════ */
function deriveGrad() {
  const G = D.graduates;
  const BIRTH = {};
  D.population.years.forEach((y, i) => { BIRTH[y] = D.population.births[i]; });
  const LAST_BIRTH = 2025;
  const HOLD = BIRTH[LAST_BIRTH];                 // 792 万，2026 起按此持平
  const cohort = (y) => (BIRTH[y] != null ? BIRTH[y] : HOLD);

  // 锚点：分母是"毕业年份 − 学制"那一年的出生人口
  const R_UG = G.undergrad[25] / BIRTH[2025 - 22];   // 523.06 / 1599 = 32.71%
  const R_PG = G.postgrad[25] / BIRTH[2025 - 25];    // 116.65 / 1771 = 6.59%
  const LAG_UG = 22, LAG_PG = 25;
  const END = 2050, Y0 = 2000;
  const n = END - Y0 + 1;
  const YRS = Array.from({ length: n }, (_, i) => Y0 + i);

  // 上界：转化率 2026→2050 线性升到 1.35 倍（适龄人口塌下来时高校不会等比缩招）
  const RAMP_END = 2050, RAMP = 0.35;
  const upFactor = (y) => 1 + RAMP * Math.min(1, Math.max(0, (y - 2026) / (RAMP_END - 2026)));

  const proj = (arr, idx, lag, R) =>
    YRS.map((y) => {
      if (y <= 2025) return { y, v: arr[y - Y0], up: null, real: true };
      const base = cohort(y - lag) * R;
      return { y, v: base, up: base * upFactor(y), real: false };
    });

  return { YRS, ug: proj(G.undergrad, 0, LAG_UG, R_UG), pg: proj(G.postgrad, 0, LAG_PG, R_PG), R_UG, R_PG, n };
}

function fig3() {
  const { YRS, ug, pg, R_UG, R_PG, n } = deriveGrad();
  // ⚠️ 实测段的 up 必须是 null，不能是 0 —— 下面用 `up ?? v` 取上界，
  //    写成 0 的话 `0 ?? v` 得到 0（0 不是空值），阴影带左端会掉到图底。
  const sum = YRS.map((y, i) => ({
    y, v: ug[i].v + pg[i].v,
    up: ug[i].real ? null : ug[i].up + pg[i].up,
    real: ug[i].real,
  }));
  const splitX = xL(2026 - YRS[0], n);            // 实测/推算分界

  /** 单序列面板：实测实线 → 推算虚线 + 情景带 */
  function pane(series, { unitLabel, div = 4, showSplit = true }) {
    const realVals = series.filter((d) => d.real).map((d) => d.v);
    const projVals = series.filter((d) => !d.real).map((d) => d.up ?? d.v);
    const top = Math.max(...realVals, ...projVals);
    const { max, ticks } = niceScale(top, div);
    const pts = series.map((d, i) => ({ x: xL(i, n), y: yP(d.v, 0, max) }));
    const upts = series.map((d, i) => ({ x: xL(i, n), y: yP(d.up ?? d.v, 0, max) }));

    const iRealEnd = series.findIndex((d) => !d.real) - 1;
    const botReal = pts.slice(0, iRealEnd + 1);
    const botProj = pts.slice(iRealEnd);
    const upProj = upts.slice(iRealEnd);

    const iPeak = series.reduce((best, d, i) => (d.v > series[best].v ? i : best), 0);

    const inner =
      `<svg class="ap-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
      bandPoly(upProj, botProj, C.teal, 0.15) +
      areaPoly(botReal, C.teal, 0.08) +
      poly(botReal, C.teal, { w: 2.6 }) +
      poly(botProj, C.teal, { w: 2.4, dash: '5 3' }) +
      poly(upProj, C.teal, { w: 1.4, dash: '2 3', op: 0.75 }) +
      `</svg>` +
      (showSplit ? vline(splitX, '推算 →') : '') +
      dot(pts[0].x, pts[0].y, C.teal, 8) +
      tag(pts[0].x, pts[0].y + 4.2, Math.round(series[0].v) + ' 万', C.teal) +
      dot(pts[iPeak].x, pts[iPeak].y, C.teal, 9) +
      badge(pts[iPeak].x, pts[iPeak].y + 7, `${YRS[iPeak]} 峰 ${Math.round(series[iPeak].v)} 万`);

    const xlabels = [2000, 2010, 2020, 2030, 2040, 2050].map((y) => ({ x: xL(y - YRS[0], n), t: y }));

    /* 悬停读数：连续贴边轴，列边界取相邻点中点（同图 2）。
       实测年与推算年在气泡里用词分开 —— 与图上实线/虚线的区分一致。 */
    const hover = hoverLayer(series.map((d, i) => {
      const l = i === 0 ? 0 : (xL(i - 1, n) + xL(i, n)) / 2;
      const r = i === n - 1 ? 100 : (xL(i, n) + xL(i + 1, n)) / 2;
      const t = [`${d.y} 年`, d.real ? `实测 ${Math.round(d.v)} 万` : `推算 ${Math.round(d.v)} 万`];
      if (!d.real && d.up != null) t.push(`上界 ${Math.round(d.up)} 万`);
      return { x: l, w: r - l, t };
    }));

    return `<div class="ap-unit">${unitLabel}</div>` +
      frame({ ph: 250, ybw: 44, min: 0, max, ticks, fmt: (v) => Math.round(v), inner, xlabels, hover });
  }

  const paneUG = pane(ug, { unitLabel: '万人 · 本科毕业生' });
  const panePG = pane(pg, { unitLabel: '万人 · 研究生（硕 + 博）毕业生' });
  const paneSum = pane(sum, { unitLabel: '万人 · 本科 + 研究生', div: 5 });

  // 图例只放一份、放在切换条上方：三个面板的图例完全一样，每面板印一遍是噪音
  return legend([
    { c: C.teal, t: '实测（2000–2025，教育部）' },
    { c: C.teal, dash: true, t: '推算（转化率持平）' },
    { c: C.teal, op: 0.22, t: '推演上界（阴影）' },
  ]) + switchUI({
    name: 'ap-g3',
    checkedIdx: 0,
    panes: [
      { label: '只看本科', html: paneUG },
      { label: '只看研究生', html: panePG },
      { label: '两者合计', html: paneSum },
    ],
  });
}

/* ══════════════════════════════════════════════════════
   图 4 · 国有单位 vs 城镇私营企业（2000–2019，同口径收尾）
   ══════════════════════════════════════════════════════ */
function fig4() {
  const SO = D.state_owned, PR = D.private_units;
  const ys = PR.years, n = ys.length;             // 2000–2019
  const soIdx = (y) => SO.years.indexOf(y);
  const { max, ticks } = niceScale(16000, 4);
  const gw = 100 / n;
  const bw = gw * 0.40;

  let bars = '';
  for (let i = 0; i < n; i++) {
    const cx = xB(i, n);
    const a = SO.employed[soIdx(ys[i])];
    const b = PR.employed[i];
    bars +=
      `<span class="ap-bar" style="left:${pct(cx - bw * 0.55)};width:${pct(bw)};bottom:0;height:${pct(yP(a, 0, max))};background:${C.teal}"></span>` +
      `<span class="ap-bar" style="left:${pct(cx + bw * 0.55)};width:${pct(bw)};bottom:0;height:${pct(yP(b, 0, max))};background:${C.taupe}"></span>`;
  }

  /* ⚠️ 不在柱子上标数值：20 组柱子挤在 346px 的手机宽度里，
     首尾那四个数字必然骑在相邻柱子上（深色底 + 小字 = 读不出来）。
     端点值改放图例，字号是正文级 —— 信息没丢，可读性反而更好。 */
  const xlabels = [0, 5, 10, 15, 19].map((i) => ({ x: xB(i, n), t: ys[i] }));
  const so = (y) => SO.employed[soIdx(y)];

  /* 悬停读数：一年一列（同图 1）。柱子上不印数值是手机宽度的取舍，
     悬停气泡把每年的两个数都补回来。 */
  const hover = hoverLayer(ys.map((y, i) => ({
    x: xB(i, n) - gw / 2, w: gw,
    t: [`${y} 年`, `国有单位 ${SO.employed[soIdx(y)]} 万`, `私营企业 ${PR.employed[i]} 万`],
  })));

  return legend([
    { c: C.teal, t: `城镇国有单位就业人员　${so(2000)} → ${so(2019)}` },
    { c: C.taupe, t: `城镇私营企业就业人员　${PR.employed[0]} → ${PR.employed[n - 1]}` },
  ]) + frame({ ph: 250, ybw: 44, min: 0, max, ticks, fmt: (v) => v, inner: bars, xlabels, hover });
}

/* ══════════════════════════════════════════════════════
   图 5 · 公务员 / 事业编（2005–2024）
   ══════════════════════════════════════════════════════ */
function fig5() {
  const S = D.public_sector;
  const ys = S.years, n = ys.length;              // 2005–2024
  const gov = S.public_admin;
  const inst = S.education.map((v, i) => v + S.health[i]);
  const total = gov.map((v, i) => v + inst[i]);
  const breakIdx = ys.indexOf(2019);
  const bx = xB(breakIdx, n);
  const ptsOf = (arr, max) => arr.map((v, i) => ({ x: xB(i, n), y: yP(v, 0, max) }));

  /** 一根折线 + 首尾数值 + 2019 口径虚线 */
  const lineInner = (arr, max, color, { endTag = true, startTag = false } = {}) => {
    const p = ptsOf(arr, max);
    return `<svg class="ap-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
      areaPoly(p, color, 0.09) + poly(p, color, { w: 2.6 }) + `</svg>` +
      p.map((q) => dot(q.x, q.y, color, 5)).join('') +
      vline(bx, '2019 口径') +
      (startTag ? dot(p[0].x, p[0].y, color, 8) + tag(p[0].x, p[0].y + 4.2, Math.round(arr[0]), color) : '') +
      (endTag ? dot(p[n - 1].x, p[n - 1].y, color, 8) +
        tag(p[n - 1].x, p[n - 1].y + 4.2, Math.round(arr[n - 1]), color) : '');
  };

  const xlabels = [0, 5, 10, 15, 19].map((i) => ({ x: xB(i, n), t: ys[i] }));

  /* 悬停读数：类目轴一年一列（同图 1/4）。四个绘图区各配一套，
     气泡内容随面板口径走。数值一律 Math.round —— 底稿是万位小数，气泡里读整数就够。 */
  const gw5 = 100 / n;
  const hcol = (i, t) => ({ x: xB(i, n) - gw5 / 2, w: gw5, t });
  const hover1 = hoverLayer(ys.map((y, i) =>
    hcol(i, [`${y} 年`, `公务员（近似）${Math.round(gov[i])} 万`])));
  const hover2 = hoverLayer(ys.map((y, i) =>
    hcol(i, [
      `${y} 年`,
      `事业编（近似）合计 ${Math.round(inst[i])} 万`,
      `其中：教育 ${Math.round(S.education[i])} 万`,
      `其中：卫生 ${Math.round(S.health[i])} 万`,
    ])));
  const hoverTop = hoverLayer(ys.map((y, i) =>
    hcol(i, [`${y} 年`, `公务员 ${Math.round(gov[i])} 万`, `事业编 ${Math.round(inst[i])} 万`])));
  const hoverBottom = hoverLayer(ys.map((y, i) =>
    hcol(i, [`${y} 年`, `合计 ${Math.round(total[i])} 万`])));

  /* ① 只看公务员 */
  const sc1 = niceScale(Math.max(...gov), 4);
  const p1 =
    `<div class="ap-unit">万人 · 公共管理、社会保障和社会组织</div>` +
    frame({
      ph: 230, ybw: 44, min: 0, max: sc1.max, ticks: sc1.ticks, fmt: (v) => v,
      inner: lineInner(gov, sc1.max, C.teal, { startTag: true }), xlabels, hover: hover1,
    });

  /* ② 只看事业编：教育 / 卫生 两条细线 + 合计粗线 */
  const sc2 = niceScale(Math.max(...inst), 4);
  const eP = ptsOf(S.education, sc2.max), hP = ptsOf(S.health, sc2.max), iP = ptsOf(inst, sc2.max);
  /* 教育 / 卫生 画成细虚线，和图例的虚线样本对上 —— 之前画实线、图例却画虚线，
     读者会去找一条根本不存在的线。 */
  const inner2 =
    `<svg class="ap-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
    poly(eP, C.taupe, { w: 2, dash: '5 4', op: 0.9 }) + poly(hP, C.sand, { w: 2, dash: '5 4', op: 0.9 }) +
    poly(iP, C.green, { w: 2.6 }) + `</svg>` +
    iP.map((q) => dot(q.x, q.y, C.green, 5)).join('') +
    vline(bx, '2019 口径') +
    tag(iP[n - 1].x, iP[n - 1].y + 4.2, Math.round(inst[n - 1]), C.green) +
    tag(iP[0].x, iP[0].y + 4.2, Math.round(inst[0]), C.green);
  const p2 =
    `<div class="ap-unit">万人 · 教育 + 卫生和社会工作</div>` +
    legend([
      { c: C.green, t: '事业编（近似）合计' },
      { c: C.taupe, t: '其中：教育', dash: true },
      { c: C.sand, t: '其中：卫生和社会工作', dash: true },
    ]) +
    frame({ ph: 230, ybw: 44, min: 0, max: sc2.max, ticks: sc2.ticks, fmt: (v) => v, inner: inner2, xlabels, hover: hover2 });

  /* ③ 两者合计：上下两个小图共享横轴 —— 上图比规模，下图看总量趋势。
     ⚠️ 上下两帧之间必须留 margin：「2019 口径」竖线标签只有上图有，
        但上图 0 刻度会溢出到框外，不留空隙会和下图的 6000 撞在一起。 */
  const scT = niceScale(Math.max(...inst, ...gov), 4);
  const gP = ptsOf(gov, scT.max), iP2 = ptsOf(inst, scT.max);
  const topPane =
    `<div class="ap-unit">万人 · 上图：公务员 vs 事业编（同轴比规模）</div>` +
    legend([{ c: C.teal, t: '公务员' }, { c: C.green, t: '事业编' }]) +
    frame({
      ph: 170, ybw: 44, min: 0, max: scT.max, ticks: scT.ticks, fmt: (v) => v, xlabels: [],
      inner:
        `<svg class="ap-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
        poly(gP, C.teal, { w: 2.4 }) + poly(iP2, C.green, { w: 2.4 }) + `</svg>` +
        vline(bx) +
        dot(gP[n - 1].x, gP[n - 1].y, C.teal, 7) + dot(iP2[n - 1].x, iP2[n - 1].y, C.green, 7) +
        tag(gP[n - 1].x, gP[n - 1].y + 4.6, Math.round(gov[n - 1]), C.teal) +
        tag(iP2[n - 1].x, iP2[n - 1].y + 4.4, Math.round(inst[n - 1]), C.green),
      hover: hoverTop,
    });
  const scSum = niceScale(Math.max(...total), 5);
  const tP = ptsOf(total, scSum.max);
  const bottomPane =
    `<div style="margin-top:26px">` +
    `<div class="ap-unit">万人 · 下图：两者合计</div>` +
    legend([{ c: C.gold, t: '公务员 + 事业编' }]) +
    frame({
      ph: 170, ybw: 44, min: 0, max: scSum.max, ticks: scSum.ticks, fmt: (v) => v, xlabels: [],
      inner:
        `<svg class="ap-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
        areaPoly(tP, C.gold, 0.1) + poly(tP, C.gold, { w: 2.6 }) + `</svg>` +
        tP.map((q) => dot(q.x, q.y, C.gold, 5)).join('') +
        vline(bx, '2019 口径') +
        dot(tP[0].x, tP[0].y, C.gold, 8) + tag(tP[0].x, tP[0].y + 4.2, Math.round(total[0]), C.gold) +
        dot(tP[n - 1].x, tP[n - 1].y, C.gold, 8) +
        tag(tP[n - 1].x, tP[n - 1].y + 4.2, Math.round(total[n - 1]), C.gold),
      hover: hoverBottom,
    }) + `</div>`;
  const xrow = `<div class="ap-xl" style="--ybw:44px"><div></div><div class="ap-xrow">` +
    xlabels.map((l) => `<span class="${edge(l.x)}" style="left:${pct(l.x)}">${l.t}</span>`).join('') +
    `</div></div>`;

  return switchUI({
    name: 'ap-g5',
    checkedIdx: 2,
    panes: [
      { label: '只看公务员', html: p1 },
      { label: '只看事业编', html: p2 },
      { label: '两者合计', html: topPane + bottomPane + xrow },
    ],
  });
}

/* ══════════════════════════════════════════════════════
   区块拼装
   ══════════════════════════════════════════════════════ */
const SEC_BEGIN = '<!-- ===== 附录数据图 开始（生成器 tools/gen_appendix_charts.mjs）===== -->';
const SEC_END = '<!-- ===== 附录数据图 结束 ===== -->';
const CSS_BEGIN = '/* ===== appendix-charts 开始（生成器 tools/gen_appendix_charts.mjs）===== */';
const CSS_END = '/* ===== appendix-charts 结束 ===== */';

const CSS = `
${CSS_BEGIN}
/* 「附录 · 数据图」专用样式。类名一律 ap- 前缀，和正文那 8 张图的 fw- 完全不共用。
   几何用百分比排布、文字用 HTML —— 350px 手机和 980px 桌面上字号不变。 */
.ap-fig{margin:12px 0 4px}
.ap-unit{font-size:11.5px;color:var(--muted);margin:0 0 6px}
.ap-lg{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--ink2);margin:0 0 8px}
.ap-lg i{display:inline-block;width:14px;height:9px;border-radius:2px;margin-right:5px;vertical-align:-1px}
/* 虚线样本必须够宽（24px）：14px 的样本上 2px dashed 只能显出一小段，
   看起来就是根实线短横 —— 用户分不清「实测实线 / 推算虚线」（2026-10-19 踩中） */
.ap-lg i.dash{width:24px;height:0;border-top:2px dashed;background:none!important}
.ap-frame{display:grid;grid-template-columns:var(--ybw,44px) 1fr;gap:0 8px}
.ap-axl,.ap-plot{position:relative;height:var(--ph,240px)}
.ap-axl span{position:absolute;right:0;transform:translateY(50%);font-size:11px;color:var(--muted);white-space:nowrap;line-height:1}
.ap-plot{border-left:1px solid var(--cgrid)}
.ap-gl{position:absolute;left:0;right:0;height:1px;background:var(--cgrid)}
.ap-gl.zero{background:var(--line)}
.ap-bar{position:absolute;transform:translateX(-50%);border-radius:2px 2px 0 0}
.ap-bar.dn{border-radius:0 0 2px 2px}
.ap-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.ap-dot{position:absolute;transform:translate(-50%,50%);border-radius:50%}
.ap-tag{position:absolute;transform:translateX(-50%);font-size:10.5px;color:var(--muted);white-space:nowrap;line-height:1;text-shadow:0 0 3px var(--card),0 0 3px var(--card)}
.ap-badge{position:absolute;transform:translate(-50%,50%);background:#9c5a4a;color:#fff;font-size:10px;padding:2px 7px;border-radius:999px;white-space:nowrap;line-height:1.3}
.ap-vline{position:absolute;top:0;bottom:0;width:0;border-left:1.5px dotted var(--ch-clay)}
.ap-vlab{position:absolute;top:2px;transform:translateX(-50%);font-size:10px;color:var(--ch-clay);white-space:nowrap;line-height:1}
.ap-xl{display:grid;grid-template-columns:var(--ybw,44px) 1fr;gap:0 8px;margin-top:7px}
.ap-xrow{position:relative;height:18px}
.ap-xrow span{position:absolute;top:0;transform:translateX(-50%);font-size:11px;color:var(--ink);white-space:nowrap;line-height:1}
.ap-xrow span.er{transform:translateX(-100%)}
.ap-xrow span.el{transform:translateX(0)}
.ap-tag.er{transform:translateX(-100%)}
.ap-tag.el{transform:translateX(0)}
/* 纯 CSS 单选切换（不引 JS）。input 必须是 .ap-panes / .ap-tabbar 的**兄弟**，
   :checked~ 才选得中；包一层 div 就失效。 */
.ap-sw{position:relative}
.ap-sw>input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.ap-tabbar{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}
.ap-tabbar label{font-size:12.5px;padding:5px 14px;border:1px solid var(--line);border-radius:999px;background:var(--card);color:var(--ink2);cursor:pointer;line-height:1.4;user-select:none}
.ap-tabbar label:hover{border-color:var(--teal2)}
.ap-sw:focus-within .ap-tabbar label{outline:2px solid var(--teal2);outline-offset:1px}
.ap-pane{display:none}
.ap-note{margin:10px 0 30px;font-size:12.5px;line-height:1.8;color:var(--ink2)}
.ap-note b{color:var(--ink)}
.ap-note .ap-src{display:block;margin-top:4px;color:var(--muted);font-size:12px}
/* ── 悬停读数层（渐进增强：JS 失效时这些元素永远 opacity:0，图表照常完整）── */
.ap-hs{position:absolute;top:0;bottom:0;z-index:5}
.ap-cross{position:absolute;top:0;bottom:0;width:0;border-left:1px dashed var(--muted);opacity:0;z-index:4;pointer-events:none}
.ap-tip{position:absolute;top:6px;transform:translateX(-50%);background:var(--card);border:0.5px solid var(--line);border-radius:8px;padding:5px 9px;font-size:11.5px;line-height:1.55;color:var(--ink);white-space:nowrap;pointer-events:none;opacity:0;z-index:6;transition:opacity .12s linear}
.ap-tip.on{opacity:1}
.ap-tip .sub{color:var(--ink2)}
${switchCSS('ap-g3', 3)}
${switchCSS('ap-g5', 3)}
${CSS_END}
`;

const SEC = `
${SEC_BEGIN}
<div class="wrap">

<section id="datacharts">
  <span class="sec-no">附录</span>
  <h2 id="s98">数据图</h2>
  <p class="lead">五张图，横轴从 2000 年起（图 5 因行业口径最早只到 2005 年，单独说明），全部用官方序列。每张图下方写明口径、来源与推算方法——<b>凡是推算，图上都与实测分开画</b>，不做无缝衔接。桌面端把鼠标悬到图上会显示竖线与该年读数，触屏按住拖动同理。</p>

  <div class="axis-card">
    <b>先说一件没图的事</b>
    本节没有一张「企业 HC 总量」图，因为不存在这条官方序列。中国按月发城镇调查失业率、按年发城镇非私营单位就业人员，但「私营企业 + 个体」只发布到 2019 年，「企业」这个整体从来没有过逐年官方总数。下面第 4、5 张图用两条可得的官方序列去逼近它，而不是估算一个不存在的总数。
  </div>

  <h3 id="d1">图 1 · 每年出生、死亡与人口净增</h3>
  <div class="ap-fig">${fig1()}</div>
  <p class="ap-note">
    <b>出生向上、死亡向下，折线是净增（出生 − 死亡）。</b>2022 年净增首次转负（−85 万），2025 年为 −339 万。2000 → 2025 净增从 +957 万掉到 −339 万，拆开看：出生端贡献 −979 万（76%），死亡端贡献 −317 万（24%）。死亡人数这 25 年涨了 39%，不是可以忽略的那一头。
    <span class="ap-src">数据：国家统计局年度数据与《2025 年国民经济和社会发展统计公报》。单位：万人。</span>
  </p>

  <h3 id="d2">图 2 · 人口总量</h3>
  <div class="ap-fig">${fig2()}</div>
  <p class="ap-note">
    <b>2021 年见顶（141260 万），此后连年下降，2025 年末 140489 万。</b>纵轴不从 0 起，是为了让 2021 年之后那段（−0.55%）看得见——从 0 画，它只是顶端一个看不出来的下折。代价是 2000 → 2025 那 10.8% 的增长看起来更陡：<b>读这张图请以左侧刻度为准，不要读斜率。</b>
    <span class="ap-src">数据：同图 1。单位：亿人。</span>
  </p>

  <h3 id="d3">图 3 · 大学毕业生：实测到 2025，推算到 2050</h3>
  <div class="ap-fig">${fig3()}</div>
  <p class="ap-note">
    <b>本科毕业生 2038 年见顶（约 584 万），研究生 2041 年见顶（约 118 万）——比出生人口的 2016 年峰值晚了 22 年与 25 年。</b>实线是实测（教育部），虚线是推算，阴影是只往上不往下的推演区间。
    <br><b>算法</b>：毕业年份 − 学制那一年的出生人口 × 现行转化率。本科 = 22 年前出生 × 32.71%（523.06 ÷ 1599），研究生 = 25 年前出生 × 6.59%（116.65 ÷ 1771）。
    <br><b>为什么阴影只在上方</b>：分母塌了以后高校不会等比缩招，录取率会被动抬升。阴影上界按 2050 年转化率比现在高 35% 计（本科 44.2%、研究生 8.9%），是方向性推演，<b>不是预测</b>。真实数据只有现在这条实线。
    <br><b>两个已知不确定</b>：2026 年及以后的出生人口按 2025 年 792 万持平假定（2026 年数据要到 2027 年 1 月才公布）；职业本科 2023 年起从普通本科中单列，已按公报值取普通本科，未并入。
    <span class="ap-src">数据：教育部《全国教育事业发展统计公报》历年、《中国统计年鉴 2025》表 21-8。单位：万人。</span>
  </p>

  <h3 id="d4">图 4 · 国有单位 vs 城镇私营企业</h3>
  <div class="ap-fig">${fig4()}</div>
  <p class="ap-note">
    <b>20 年里国有单位少了 2629 万（−32%），城镇私营企业多了 13299 万（11.5 倍），两条线在 2011 年前后交叉。</b>这是「企业 HC」能拿到的最贴近官方的一组对照。
    <br><b>为什么停在 2019 年</b>：城镇私营企业就业人员数来自国家市场监督管理总局，2020 年其统计制度调整后不再向统计局提供，年鉴随之停发。本图停在两条序列都还在的同一年，不做拼接。国家统计局另有明确答复：城镇单位就业人员不含私营单位，两组数据来源与涵盖范围不同，<b>不能直接相加或替代</b>，所以这里也不画「合计」。
    <br><b>别和另一组数混用</b>：媒体与学术文章用「城镇就业人员 − 城镇非私营单位就业人员」反推的是<b>私营 + 个体</b>宽口径（2020 年 29418 万 → 2024 年 30796 万），比本图窄口径 2019 年的 14567 万高约 1.8 倍，两条线不可比。
    <span class="ap-src">数据：《中国统计年鉴》表 4-1「就业基本情况」（2016 年版、2020 年版）与早期年鉴「按登记注册类型分城镇就业人员数」。单位：万人。</span>
  </p>

  <h3 id="d5">图 5 · 公务员与事业编（存量口径）</h3>
  <div class="ap-fig">${fig5()}</div>
  <p class="ap-note">
    <b>公务员（近似）2005 → 2024 从 1241 万增至 2027 万（+63%），事业编（近似）从 1992 万增至 3081 万（+55%），两者合计从 3233 万增至 5108 万。</b>增长几乎全在 2019 年之前完成，2020 年后基本走平。
    <br><b>这是存量口径，不是招录量</b>：人社部 2024、2025 两版统计公报都已不再公布全国事业单位公开招聘人数，「每年招多少人」这条流量序列无法复原；而存量（年末就业人员）官方一直有，只是要借行业口径逼近。
    <br><b>两个近似的边界</b>：「公共管理、社会保障和社会组织」包含参公单位与部分社会组织，不等于公务员编制数；「教育 + 卫生」只覆盖事业单位就业约七成，不含科研、文化、农林水等。同时这是<b>城镇非私营单位就业人员</b>，含编外聘用，不等于编制数。
    <br><b>2019 年的坑</b>：三个行业同时跳升约一成（教育 +173.7 万、卫生 +93.8 万、公共管理 +172.3 万），而同年城镇非私营单位就业人员合计反而减少 96 万。更像统计范围调整而非真实扩张，跨 2019 年比较时请留意图中那条虚竖线。
    <br><b>为什么从 2005 年起</b>：现行行业分类下这三个行业的逐年数据，年鉴最早只到 2005 年；更早年份用的是 1994 版行业分类，三个行业被并入更粗的门类，拆不出来。这里留白而不是硬凑。
    <span class="ap-src">数据：《中国统计年鉴》表 4-5（2018 年版，2005–2017）、表 4-6（2025 年版，2015–2024），重叠年份两表完全一致。单位：万人。</span>
  </p>

  <p class="hint">本节所有数值均可回查：原始序列与每个数字的来源、校验记录在仓库 <code>tools/appendix-charts-data.json</code>，本页图表由 <code>tools/gen_appendix_charts.mjs</code> 生成，无外部脚本依赖。</p>
</section>

</div>
<script>
/* 悬停读数（渐进增强）：图上的透明列 .ap-hs 带着构建期写好的 data-t 读数，
   这里只做「指针在讠哪一列 → 竖线和气泡挪过去」。不请求任何外部资源；
   本脚本失效时图表照常显示，只是没有悬停效果。 */
(function(){
  'use strict';
  document.querySelectorAll('.ap-plot').forEach(function(plot){
    var hs = plot.querySelectorAll('.ap-hs');
    if (!hs.length) return;
    var cross = plot.querySelector('.ap-cross');
    var tip = plot.querySelector('.ap-tip');
    if (!cross || !tip) return;
    var cur = -1;
    function show(i){
      if (i === cur) return;
      cur = i;
      var lines = (hs[i].getAttribute('data-t') || '').split('|');
      if (!lines[0]) return;
      var p = parseFloat(hs[i].style.left) + parseFloat(hs[i].style.width) / 2;
      p = Math.max(12, Math.min(88, p));   /* 贴边列的气泡往里收，别溢出卡片 */
      cross.style.left = p + '%';
      cross.style.opacity = '1';
      var html = '';
      for (var j = 0; j < lines.length; j++)
        html += '<div' + (j ? ' class="sub"' : '') + '>' + lines[j] + '</div>';
      tip.innerHTML = html;
      tip.style.left = p + '%';
      tip.classList.add('on');
    }
    function hide(){ cur = -1; cross.style.opacity = '0'; tip.classList.remove('on'); }
    function pick(e){
      var r = plot.getBoundingClientRect();
      var i = Math.floor(((e.clientX - r.left) / r.width) * hs.length);
      show(Math.max(0, Math.min(hs.length - 1, i)));
    }
    plot.addEventListener('pointermove', pick);
    plot.addEventListener('pointerdown', pick);   /* 触屏：按住拖动也能读 */
    plot.addEventListener('pointerleave', hide);
  });
})();
</script>
${SEC_END}
`;

/* ── 主流程 ───────────────────────────────────────────── */
let html = fs.readFileSync(FILE, 'utf8');
const report = [];

/* index.html 是 CRLF（本机 Windows 编辑过）。插入的段落也转成 CRLF，
   否则文件会变成两种换行混排 —— git diff 会整段标红。 */
const EOL = html.includes('\r\n') ? '\r\n' : '\n';
const crlf = (s) => (EOL === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s);

/* ⚠️ 重跑必须**逐字节幂等**：先把自己上次写进去的那一段（连同它前面用来分隔的空行）
   整段吃掉，再按固定格式重新插。只按标记切、不连空行一起切的话，
   每跑一次就会多攒一两个换行，跑十次文件悄悄胖 20 字节、git diff 一片红。 */
function cutOwned(text, begin, end) {
  const a = text.indexOf(begin);
  const b = text.indexOf(end);
  if (a < 0 || b < 0 || b < a) return { text, hit: false };
  let s = a;
  while (s > 0 && (text[s - 1] === '\n' || text[s - 1] === '\r')) s--;
  return { text: text.slice(0, s) + text.slice(b + end.length), hit: true };
}

// 1) 摘掉上次注入的区块与 CSS（只碰自己的标记，不动正文与 fw- 那套）
let rerun = false;
{
  const r = cutOwned(html, SEC_BEGIN, SEC_END);
  html = r.text; rerun ||= r.hit;
}
{
  const r = cutOwned(html, CSS_BEGIN, CSS_END);
  html = r.text; rerun ||= r.hit;
}
if (rerun) report.push('（重跑）摘除上次生成的区块与 CSS');

// 2) 插区块：锚在「参考资料」那一节所属的 .wrap 之前
const ANCHOR = `<div class="wrap">${EOL}${EOL}<section id="refs">`;
if (!html.includes(ANCHOR)) { console.error('❌ 找不到 <section id="refs"> 前的锚点，拒绝插入'); process.exit(1); }
html = html.replace(ANCHOR, EOL + EOL + crlf(SEC.trim()) + EOL + EOL + ANCHOR);
report.push('插入「附录 · 数据图」区块（#datacharts / #s98）');

// 3) 目录项：排在「附录 · 参考资料」之前
const TOC_REF = '<a href="#refs" class="solo">附录 · 参考资料</a>';
const TOC_NEW = '<a href="#datacharts" class="solo">附录 · 数据图</a>';
if (!html.includes(TOC_REF)) { console.error('❌ 找不到目录里的参考资料项'); process.exit(1); }
if (!html.includes(TOC_NEW)) {
  html = html.replace(TOC_REF, TOC_NEW + EOL + '  ' + TOC_REF);
  report.push('目录加「附录 · 数据图」');
}

// 4) 注入 CSS（放 </style> 前；选择器与 fw- 那套不重叠，先后顺序无所谓）
const STYLE_END = EOL + '</style>';
if (!html.includes(STYLE_END)) { console.error('❌ 找不到 </style>'); process.exit(1); }
html = html.replace(STYLE_END, EOL + crlf(CSS.trim()) + EOL + '</style>');
report.push('注入 appendix-charts CSS');

const out = DRY ? null : (fs.writeFileSync(FILE, html), fs.statSync(FILE).size);
console.log(
  (DRY ? '（--dry，未落盘）' : `✅ 已改写 index.html（${out} B）`) + '\n' + report.join('\n')
);
