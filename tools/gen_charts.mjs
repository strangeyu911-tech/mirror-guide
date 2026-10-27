/**
 * 把 index.html 里 8 张 ECharts 图换成**纯 HTML/CSS + 内联 SVG** 的静态图表。
 *
 * 动机：echarts.min.js 有 1 MB，且从境外 cdnjs 同步加载 —— 它一挂/一慢，
 * 整个文档的 load 事件永远不触发（实测 20 秒后 readyState 仍是 loading）。
 * 这套站本来只需要 8 张静态图，用不着一个 1 MB 的运行时库。
 *
 * 关键取舍（为什么不用 echarts SSR 预渲染成固定尺寸 SVG）：
 *   .chart 的宽度是 100%（手机 ~350px、桌面 ~980px），高度固定。
 *   固定尺寸的 SVG 塞进不同宽度的容器，文字会跟着缩放 ——
 *   390px 手机上 11px 的字会变成 ~4px，根本没法看。
 *   所以改成「几何用 CSS 百分比 + 文字用 HTML」：文字永远是 CSS 字号，
 *   任意宽度都可读；折线几何用 viewBox="0 0 100 100" + preserveAspectRatio="none"
 *   的 `<polyline>` 画，配 vector-effect="non-scaling-stroke" 保证线宽不随缩放变形，
 *   数据点则用 HTML 圆点单独摆 —— 这样点还是正圆、字还是正常字号。
 *
 * 用法：node tools/gen_charts.mjs [--dry]
 *   直接改写 index.html；--dry 只打印不落盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const FILE = path.join(ROOT, 'index.html');
const DRY = process.argv.includes('--dry');

/* 图表配色走 CSS 变量（--ch-*，深浅两套，见下方 CSS）。
   ⚠️ 别改回写死色值 —— 深色主题下 #24565a 这种暗青会糊进 #16181a 背景里。 */
const S = {
  taupe: 'var(--ch-taupe)', teal: 'var(--ch-teal)', gold: 'var(--ch-gold)',
  sand: 'var(--ch-sand)', clay: 'var(--ch-clay)', green: 'var(--ch-green)',
};
/* 徽章类的固定色（不随主题变 —— 深底白字在两种主题下都够对比度） */
const BADGE_BG = '#9c5a4a';
const pct = (n) => (Math.round(n * 100) / 100) + '%';
const pos = (i, n) => ((i + 0.5) / n) * 100;          // 类目轴上的点，取带宽中心
const h = (v, min, max) => ((v - min) / (max - min)) * 100;
/** 贴边的标签改成向内锚定，否则最右/最左那个会被裁掉（echarts 也会这么处理） */
const edge = (x) => (x >= 90 ? ' er' : x <= 10 ? ' el' : '');

/* ── 通用片段 ─────────────────────────────────────────── */

const unit = (t) => `<div class="fw-unit">${t}</div>`;

const legend = (items) =>
  `<div class="fw-legend">${items
    .map((i) => `<span><i style="background:${i.c}"></i>${i.t}</span>`)
    .join('')}</div>`;

const yAxis = (ticks, min, max) =>
  `<div class="fw-axl">${[...ticks]
    .reverse()
    .map((t) => `<span style="bottom:${pct(h(t, min, max))}">${t}</span>`)
    .join('')}</div>`;

const grid = (ticks, min, max) =>
  ticks.map((t) => `<span class="fw-gl" style="bottom:${pct(h(t, min, max))}"></span>`).join('');

/** 纵向柱状图。groups：每个类目一个数组，元素 {v, c, show} */
function vbar(cfg) {
  const { xs, groups, min, max, ticks, ph, barW, tilt, unit_, legend_, fmt } = cfg;
  const n = xs.length;
  const g = groups.length;
  let bars = '';
  for (let i = 0; i < n; i++) {
    const cx = pos(i, n);
    for (let k = 0; k < g; k++) {
      const it = groups[k][i];
      if (!it || it.v == null) continue;
      const off = g === 1 ? 0 : (k - (g - 1) / 2) * (barW + 3);
      const leftCss = g === 1 ? pct(cx) : `calc(${pct(cx)} + ${Math.round(off)}px)`;
      bars +=
        `<span class="fw-bar" style="left:${leftCss};width:${barW}px;height:${pct(h(it.v, min, max))};background:${it.c}"></span>` +
        `<span class="fw-val" style="left:${leftCss};bottom:calc(${pct(h(it.v, min, max))} + 3px)">${fmt ? fmt(it.v) : it.v}</span>`;
    }
  }
  return `${unit_ ? unit(unit_) : ''}${legend_ ? legend(legend_) : ''}` +
    `<div class="fw-v" style="--ph:${ph}px;--ybw:${cfg.ybw || 44}px">` +
    yAxis(ticks, min, max) +
    `<div class="fw-plot">${grid(ticks, min, max)}${bars}</div></div>` +
    `<div class="fw-v fw-xl" style="--ybw:${cfg.ybw || 44}px"><div></div>` +
    `<div class="fw-xrow${tilt ? ' tilt' : ''}">${xs
      .map((x, i) => `<span class="${edge(pos(i, n)).trim()}" style="left:${pct(pos(i, n))}">${x}</span>`)
      .join('')}</div></div>`;
}

/** 横向柱状图。rows 自上而下（注意类目轴在 echarts 里是自下而上，调用方已反转） */
function hbar(cfg) {
  const { rows, max, ticks, lbw, mark, fmt } = cfg;
  const axisPos = (v) => pct((v / max) * 100);
  const overlayLeft = (v) =>
    `calc(${lbw}px + 8px + (100% - ${lbw}px - 8px) * ${(v / max).toFixed(4)})`;
  return (
    `<div class="fw-h" style="--lbw:${lbw}px">` +
    `<div class="fw-hgrid">${ticks
      .map((t) => `<span style="left:${overlayLeft(t)}"></span>`)
      .join('')}</div>` +
    (mark
      ? `<span class="fw-hmark" style="left:${overlayLeft(mark.at)}"></span>` +
        `<span class="fw-hmarklab" style="left:${overlayLeft(mark.at)}">${mark.text}</span>`
      : '') +
    rows
      .map(
        (r) =>
          `<div class="fw-hrow"><span class="fw-hlb">${r.lb}</span>` +
          `<span class="fw-htrack"><span class="fw-hbar" style="width:${axisPos(r.v)};background:${r.c}"></span>` +
          `<span class="fw-hval" style="left:calc(${axisPos(r.v)} + 6px)">${
            fmt ? fmt(r.v) : r.v
          }</span></span></div>`
      )
      .join('') +
    `<div class="fw-hrow fw-haxis"><span></span><span class="fw-htrack">${ticks
      .map((t) => `<span class="fw-haxval" style="left:${axisPos(t)}">${t}</span>`)
      .join('')}</span></div>` +
    `</div>`
  );
}

/** 折线图。pts：[{x, y, lab, mark}]，x 是 0–100 的轴位置，y 是真实值 */
function line(cfg) {
  const { pts, xlabels, min, max, ticks, ph, unit_, color, area, ybw, marks, dotSize } = cfg;
  const py = (v) => h(v, min, max);
  const ptsStr = pts
    .map((p) => `${p.x.toFixed(3)},${(100 - py(p.y)).toFixed(3)}`)
    .join(' ');
  const areaStr = ptsStr + ` ${pts[pts.length - 1].x.toFixed(3)},100 ${pts[0].x.toFixed(3)},100`;
  /* ⚠️ 参考线（markLine）必须拼进 .fw-plot **里面**。
     它们是 position:absolute；拼在 .fw-v 外层、绘图区之前的话，最近的定位祖先是 BODY，
     于是水平线被拉成整页宽、垂直线拉满整个视口 —— 实测 offsetParent=BODY，
     屏幕上一条都看不到（pension 那三条警戒线就是这么丢的）。 */
  const marksHtml = !marks
    ? ''
    : marks
        .map((m) => {
          if (m.y != null)
            return `<span class="fw-mline ${m.style}" style="bottom:${pct(py(m.y))};border-top-color:${m.c}"></span>` +
              `<span class="fw-mlab" style="bottom:calc(${pct(py(m.y))} + 4px);left:4px;color:${m.c}">${m.lab}</span>`;
          const x = ((m.x - cfg.xmin) / (cfg.xmax - cfg.xmin)) * 100;
          return `<span class="fw-mline v ${m.style}" style="left:${pct(x)};border-left-color:${m.c}"></span>` +
            `<span class="fw-mlab v" style="left:${pct(x)};color:${m.c}">${m.lab}</span>`;
        })
        .join('');
  let out = unit_ ? unit(unit_) : '';
  out +=
    `<div class="fw-v" style="--ph:${ph}px;--ybw:${ybw || 44}px">` +
    yAxis(ticks, min, max) +
    `<div class="fw-plot">${grid(ticks, min, max)}${marksHtml}` +
    `<svg class="fw-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
    (area ? `<polygon points="${areaStr}" fill="${area}"/>` : '') +
    `<polyline points="${ptsStr}" fill="none" stroke="${color}" stroke-width="2.5" ` +
    `vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>` +
    pts
      .map(
        (p) =>
          `<span class="fw-dot" style="left:${pct(p.x)};bottom:${pct(py(p.y))};width:${dotSize || 7}px;height:${dotSize || 7}px;background:${color}"></span>` +
          (p.lab
            ? `<span class="fw-val${edge(p.x)}" style="left:${pct(p.x)};bottom:calc(${pct(py(p.y))} + 7px)">${p.lab}</span>`
            : '') +
          (p.mark
            ? `<span class="fw-mark" style="left:${pct(p.x)};bottom:calc(${pct(py(p.y))} - 22px)">${p.mark}</span>`
            : '')
      )
      .join('') +
    `</div></div>` +
    `<div class="fw-v fw-xl" style="--ybw:${ybw || 44}px"><div></div>` +
    `<div class="fw-xrow">${xlabels
      .map((l) => `<span class="${edge(l.x).trim()}" style="left:${pct(l.x)}">${l.t}</span>`)
      .join('')}</div></div>`;
  return out;
}

/* ── 8 张图的定义（数据全部照抄原 echarts option）────────── */

const CHARTS = {
  'chart-debt': () =>
    vbar({
      xs: ['日 IMF', '日 日方', '日 达利欧', '中 全口径IMF', '中 BIS', '中 显性'],
      groups: [
        [
          { v: 204.4, c: S.taupe }, { v: 260, c: S.taupe }, { v: 215, c: S.taupe },
          { v: 106.9, c: S.teal }, { v: 85, c: S.teal }, { v: 60, c: S.teal },
        ],
      ],
      min: 0, max: 300, ticks: [0, 50, 100, 150, 200, 250, 300],
      ph: 230, barW: 26, tilt: true, unit_: '政府债务 / GDP %', ybw: 34,
    }),

  'chart-birth': () => {
    const years = ['2016', '2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'];
    const vals = [1786, 1723, 1523, 1465, 1200, 1062, 956, 902, 954, 792];
    return line({
      min: 600, max: 1800, ticks: [600, 800, 1000, 1200, 1400, 1600, 1800],
      pts: vals.map((v, i) => ({
        x: pos(i, vals.length), y: v, lab: String(v), mark: i === 9 ? '新低' : null,
      })),
      xlabels: years.map((t, i) => ({ x: pos(i, years.length), t })),
      ph: 240, unit_: '万人', color: S.teal, area: 'rgba(36,86,90,0.08)', ybw: 40,
    });
  },

  'chart-grad': () =>
    vbar({
      xs: ['2023', '2024', '2025', '2026'],
      groups: [
        [474, 438, 388, 343].map((v) => ({ v, c: S.taupe })),
        [114.84, 118.57, 123.68, null].map((v) => ({ v, c: S.teal })),
      ],
      min: 0, max: 500, ticks: [0, 100, 200, 300, 400, 500],
      ph: 215, barW: 22, unit_: '万人', ybw: 40,
      legend_: [{ c: S.taupe, t: '硕士统考报名' }, { c: S.teal, t: '硕士录取（含推免）' }],
    }),

  'chart-salary': () =>
    `<div class="fw-unit">起薪(元)</div>` +
    legend([{ c: S.teal, t: '2019届月起薪' }, { c: S.gold, t: '2003–2021年均增速（右轴）' }]) +
    (() => {
      const xs = ['专科', '本科', '硕士', '博士'];
      const vals = [3548, 5417, 8778, 13849];
      const rate = [6.1, 7.8, 7.0, 9.0];
      const rlab = ['6.1%', '7.8%', '7.0%', '>9%'];
      /* 增速标签默认压在圆点**上方**。硕士那枚例外：它的点就在柱身里、离柱顶只有
         18px，标签放上方会压住柱顶的 8778（实测量到 2px 重叠），所以改放圆点下方 ——
         本科→硕士是下坡、硕士→博士是上坡，下方这一段是空的，不盖折线。 */
      const rBelow = [false, false, true, false];
      const LAB_DY = 11;
      const min = 0, max = 15000, ticks = [0, 3000, 6000, 9000, 12000, 15000];
      const rmax = 14, rticks = [0, 3.5, 7, 10.5, 14];
      const n = 4, ph = 215;
      let bars = '';
      for (let i = 0; i < n; i++) {
        const c = pct(pos(i, n));
        bars +=
          `<span class="fw-bar" style="left:${c};width:34px;height:${pct(h(vals[i], min, max))};background:${S.teal}"></span>` +
          `<span class="fw-val" style="left:${c};bottom:calc(${pct(h(vals[i], min, max))} + 3px)">${vals[i]}</span>`;
      }
      /* 增速的纵向位置一律用 h() 换算（= 距底百分比，和右轴刻度同一套），
         再取 100− 给 SVG 用（SVG 的 y 从顶往下长）。
         ⚠️ 别在下面再拼一个 % —— pct() 已经带了；拼成 %% 是无效值，
            CSS 会把 bottom 整条丢掉，标签和圆点全部掉到绘图区顶部。 */
      const lineB = (v) => h(v, min, rmax);
      const linePts = rate
        .map((v, i) => `${pos(i, n).toFixed(3)},${(100 - lineB(v)).toFixed(3)}`)
        .join(' ');
      return (
        `<div class="fw-split">` +
        `<div class="fw-v" style="--ph:${ph}px;--ybw:40px">` +
        yAxis(ticks, min, max) +
        `<div class="fw-plot">${grid(ticks, min, max)}${bars}` +
        `<svg class="fw-svg" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
        /* 两遍画同一条折线：先一条卡片底色的粗线当"描边"，再盖金色细线。
           这条线要横穿硕士/博士两根实心柱，单靠 2.5px 金线压在深青上不够跳。
           ⚠️ 块注释放在两个加号中间会被解析成「A + (+"字符串")」，
           拼进 HTML 的字面量就是 NaN —— 注释要么贴在上一个操作数后面，要么别加号。 */
        `<polyline points="${linePts}" fill="none" stroke="var(--card)" stroke-width="5" ` +
        `vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>` +
        `<polyline points="${linePts}" fill="none" stroke="${S.gold}" stroke-width="2.5" ` +
        `vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/></svg>` +
        rate
          .map((v, i) => {
            const b = pct(lineB(v));
            /* 标签用 bottom 定位（锚的是下边缘），所以"放圆点下方"要减掉整个标签高度：
               标签约 12.5px 高 + 圆点半径 4px + 留白 6px ≈ 23px，少减一点就会盖住圆点 */
            const dy = rBelow[i] ? `- ${LAB_DY + 12}px` : `+ ${LAB_DY}px`;
            return (
              `<span class="fw-dot" style="left:${pct(pos(i, n))};bottom:${b};width:8px;height:8px;background:${S.gold}"></span>` +
              `<span class="fw-val fw-chip" style="left:${pct(pos(i, n))};bottom:calc(${b} ${dy});color:var(--ch-gold-ink)">${rlab[i]}</span>`
            );
          })
          .join('') +
        `</div>` +
        `</div>` +
        /* ⚠️ 右轴必须是 .fw-split 的直接子元素（在 .fw-v 关掉之后）。
           之前把它拼在 .fw-v 里面，于是它的 grid 上下文变成 .fw-v 的两列网格，
           grid-column:2 抢走了绘图区那一列 —— 绘图区塌成 40px、柱子全看不见。 */
        `<div class="fw-axr" style="--ph:${ph}px">${[...rticks]
          .reverse()
          .map((t) => `<span style="bottom:${pct(h(t, min, rmax))}">${t}%</span>`)
          .join('')}</div>` +
        `<div class="fw-v fw-xl" style="--ybw:40px"><div></div>` +
        `<div class="fw-xrow">${xs
          .map((x, i) => `<span style="left:${pct(pos(i, n))}">${x}</span>`)
          .join('')}</div></div>` +
        `</div>`
      );
    })(),
  'chart-primary': () =>
    vbar({
      xs: ['2023 实际', '2024 实际', '2025 实际', '2026 估算'],
      groups: [
        [
          { v: 1877.88, c: S.teal }, { v: 1616.63, c: S.teal },
          { v: 1461.74, c: S.teal }, { v: 1234, c: S.sand },
        ],
      ],
      min: 0, max: 2000, ticks: [0, 500, 1000, 1500, 2000],
      ph: 230, barW: 44, unit_: '万人', ybw: 40,
    }),

  'chart-major': () =>
    hbar({
      rows: [
        { lb: '微电子科学与工程', v: 7814, c: S.teal },
        { lb: '电子科学与技术', v: 7752, c: S.teal },
        { lb: '光电信息科学与工程', v: 7525, c: S.teal },
        { lb: '材料科学与工程', v: 7304, c: S.teal },
        { lb: '通信工程', v: 7249, c: S.teal },
      ],
      max: 8000, ticks: [0, 2000, 4000, 6000, 8000], lbw: 104,
      mark: { at: 6435, text: '全国本科平均 6435' },
    }),

  'chart-further': () =>
    hbar({
      rows: [
        { lb: '材料类', v: 32.4, c: S.green },
        { lb: '医学', v: 28.5, c: S.green },
        { lb: '农学', v: 28.1, c: S.green },
        { lb: '理学', v: 26.9, c: S.green },
        { lb: '历史学', v: 22.8, c: S.green },
        { lb: '法学', v: 21.1, c: S.green },
        { lb: '工学', v: 21.1, c: S.green },
      ],
      max: 40, ticks: [0, 10, 20, 30, 40], lbw: 58, fmt: (v) => v + '%',
    }),

  'chart-pension': () =>
    line({
      min: 0, max: 3, ticks: [0, 0.5, 1, 1.5, 2, 2.5, 3],
      pts: [{ x: 0, y: 2.67, lab: '2.67' }, { x: 100, y: 0.89, lab: '0.89 (1:1.12)' }],
      xlabels: [2025, 2030, 2035, 2040, 2045, 2050, 2055, 2060].map((y) => ({
        x: ((y - 2025) / 35) * 100, t: String(y),
      })),
      ph: 240, unit_: '缴费者 / 领取者', color: S.teal, area: 'rgba(36,86,90,0.08)', ybw: 34,
      dotSize: 9, xmin: 2025, xmax: 2060,
      marks: [
        { y: 1.0, style: 'dashed', c: S.clay, lab: '平衡线 1.0（低于即倒挂）' },
        { x: 2036, style: 'dotted', c: S.sand, lab: '2036 当期收不抵支' },
        { x: 2044, style: 'dotted', c: S.clay, lab: '2044 累计结余耗尽' },
      ],
    }),
};

/* ── CSS ─────────────────────────────────────────────── */

/* 重跑时靠这一对标记把上次注入的 CSS 整段摘掉，别改名字 */
const CSS_MARK_BEGIN = '/* ===== static-charts 开始（生成器 tools/gen_charts.mjs）===== */';
const CSS_MARK_END = '/* ===== static-charts 结束 ===== */';

const CSS = `
${CSS_MARK_BEGIN}
/* 图表配色。深色主题必须整体提亮 —— 亮色那套值放到 #16181a 上会糊成一片。 */
:root{
  --ch-taupe:#7a6f60; --ch-teal:#24565a; --ch-gold:#b07a3d;
  --ch-sand:#b08d57; --ch-clay:#9c5a4a; --ch-green:#6f8a6a;
  /* 折线数值专用字色：gold 本体压在白卡片上只有 3.3:1，10px 的小字要更深一档 */
  --ch-gold-ink:#8a5520;
}
html[data-theme="dark"]{
  --ch-taupe:#a89a85; --ch-teal:#57a09c; --ch-gold:#d2a463;
  --ch-sand:#c8a877; --ch-clay:#c47d68; --ch-green:#8fa98a;
  --ch-gold-ink:#e6bd85;
}
/* 几何一律用百分比/CSS 排布、文字一律是 HTML —— 这样 350px 手机和 980px 桌面上
   字号都不变。别退回"固定尺寸 SVG 缩放"那套，手机上字会小到看不清。 */
.chart-static{height:auto!important;width:100%}
.fw-unit{font-size:11.5px;color:var(--muted);margin:0 0 6px}
.fw-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--ink2);margin:0 0 8px}
.fw-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.fw-v{display:grid;grid-template-columns:var(--ybw,44px) 1fr;gap:0 8px}
.fw-v.fw-xl{margin-top:5px}
.fw-axl,.fw-axr{position:relative;height:var(--ph,240px)}
.fw-axl span,.fw-axr span{position:absolute;transform:translateY(50%);font-size:11px;color:var(--muted);white-space:nowrap;line-height:1}
.fw-axl span{right:0}
/* 双轴图（起薪那张）。.fw-split 里是 **三个** 孩子，别只想着两个：
     ① .fw-v（左轴 + 绘图区）  ② .fw-axr（右轴）  ③ 末尾那行 X 轴标签 —— 它也是 .fw-v！
   ⚠️ 第 ① 条必须带 :not(.fw-xl)，否则两个 .fw-v 被塞进同一格互相重叠：
      绘图区塌掉、X 轴标签跑到图顶上。
   ⚠️ 外层也别写成 grid-template-columns:44px 1fr 40px 那种三栏 —— .fw-v 会掉进 44px 的第一栏。
   .fw-v 内部的列宽由它自己的 --ybw 管，外层只负责分「左轴+绘图区」和「右轴」两栏。 */
.fw-split{display:grid;grid-template-columns:1fr 40px;gap:0 6px;align-items:start}
.fw-split .fw-v:not(.fw-xl){grid-column:1;grid-row:1}
.fw-split .fw-v.fw-xl{grid-column:1;grid-row:2}
.fw-axr{grid-column:2;grid-row:1}
.fw-axr span{left:0}
.fw-plot{position:relative;height:var(--ph,240px);border-left:1px solid var(--cgrid)}
.fw-gl{position:absolute;left:0;right:0;height:1px;background:var(--cgrid)}
.fw-bar{position:absolute;bottom:0;transform:translateX(-50%);border-radius:3px 3px 0 0}
/* text-shadow 在这里当描边用：彩色标签常压在实心柱子上（起薪那张的金色折线标签
   就落在深青柱顶），描一圈卡片底色才能把字从柱子里托出来 */
.fw-val{position:absolute;transform:translateX(-50%);font-size:10.5px;color:var(--muted);white-space:nowrap;line-height:1;text-shadow:0 0 3px var(--card),0 0 3px var(--card)}
/* 折线数值的底片。同一条折线上的标签会分别落在纸色空地和实心柱身上（起薪那张的
   硕士、博士两枚就压在深青柱里），换字色治不了本 —— 金色 #b07a3d 压在 #24565a 上
   只有约 2.3:1，任何单一字色都只能讨好其中一半背景。给标签自己一块卡片底色，
   身后是纸是柱都读得清，深浅两个主题也不用各调一套。 */
.fw-chip{background:var(--card);border-radius:4px;padding:1px 4px;text-shadow:none}
.fw-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.fw-dot{position:absolute;transform:translate(-50%,50%);border-radius:50%}
.fw-mark{position:absolute;transform:translate(-50%,50%);background:${BADGE_BG};color:#fff;font-size:10px;padding:2px 7px;border-radius:999px;white-space:nowrap;line-height:1.3}
.fw-mline{position:absolute;left:0;right:0;height:0;border-top:1.5px dashed ${S.clay}}
.fw-mline.dotted{border-top-style:dotted;border-top-width:2px}
.fw-mline.v{left:0;right:auto;top:0;bottom:0;height:auto;width:0;border-top:0;border-left:1.5px dotted ${S.clay}}
.fw-mlab{position:absolute;font-size:10px;white-space:nowrap;line-height:1;text-shadow:0 0 3px var(--card),0 0 3px var(--card)}
.fw-mlab.v{top:0;transform:translateX(-50%) rotate(90deg);transform-origin:center top;margin-top:44px}
.fw-xrow{position:relative;height:18px}
.fw-xrow span{position:absolute;top:0;transform:translateX(-50%);font-size:11px;color:var(--ink);white-space:nowrap;line-height:1}
.fw-xrow.tilt{height:42px}
.fw-xrow.tilt span{transform:translateX(-50%) rotate(-22deg);transform-origin:center top}
/* margin-top 是给 .fw-hmarklab 留的位置（标签浮在图表上方外侧） */
.fw-h{position:relative;margin-top:20px}
.fw-hgrid{position:absolute;left:0;right:0;top:0;bottom:34px;pointer-events:none}
.fw-hgrid span{position:absolute;top:0;bottom:0;width:1px;background:var(--cgrid)}
.fw-hrow{display:grid;grid-template-columns:var(--lbw,96px) 1fr;align-items:center;gap:8px;height:30px}
.fw-hlb{font-size:11px;color:var(--ink);text-align:right;line-height:1.25}
.fw-htrack{position:relative;height:16px}
.fw-hbar{position:absolute;left:0;top:0;height:100%;border-radius:3px}
.fw-hval{position:absolute;top:50%;transform:translateY(-50%);font-size:10.5px;color:var(--muted);white-space:nowrap}
/* 参考线（如「全国本科平均 6435」）。
   ⚠️ z-index 不能省：mark.at 常年落在实心数据条内部，而条所在的 .fw-htrack 是
   position:relative 且 DOM 在 .fw-hmark 之后 —— 不加 z-index 线会被条整个盖住。 */
.fw-hmark{position:absolute;top:0;bottom:34px;width:0;border-left:1.5px dashed var(--ch-clay);z-index:3}
/* 标签只能放图表上方外侧：横条图内部条几乎铺满，放图内必被压住 */
.fw-hmarklab{position:absolute;bottom:100%;margin-bottom:3px;transform:translateX(-50%);font-size:10px;color:var(--ch-clay);white-space:nowrap;z-index:4}
.fw-haxis{height:20px;align-items:start}
.fw-haxval{position:absolute;top:2px;transform:translateX(-50%);font-size:11px;color:var(--muted);white-space:nowrap}
@media(max-width:560px){
  .fw-h{--lbw:78px!important}
  .fw-hlb{font-size:10.5px}
  .fw-xrow.tilt span{transform:translateX(-50%) rotate(-30deg)}
}
/* 贴边标签向内锚定 —— 必须排在所有 .fw-xrow 规则之后 */
.fw-xrow span.er,.fw-val.er{transform:translateX(-100%)}
.fw-xrow span.el,.fw-val.el{transform:translateX(0)}
.fw-xrow.tilt span.er{transform:translateX(-100%) rotate(-22deg)}
.fw-xrow.tilt span.el{transform:translateX(0) rotate(-22deg)}
@media(max-width:560px){
  .fw-xrow.tilt span.er{transform:translateX(-100%) rotate(-30deg)}
  .fw-xrow.tilt span.el{transform:translateX(0) rotate(-30deg)}
}
${CSS_MARK_END}
`;

/* ── 主流程 ───────────────────────────────────────────── */

let html = fs.readFileSync(FILE, 'utf8');
const RERUN = html.includes('chart-static');
const report = [];

/* 0) 重跑：先把上次的产物摘干净，回到「8 个空占位 div + 其余原样」的状态。
      有了这一步就不必 git checkout —— 那会连带丢掉手写的改动（P0 提示条等）。 */
if (RERUN) {
  const a = html.indexOf(CSS_MARK_BEGIN);
  const b = html.indexOf(CSS_MARK_END);
  if (a < 0 || b < 0 || b < a) {
    console.error('❌ 找不到上次注入的 CSS 块标记，无法安全重跑'); process.exit(1);
  }
  html = html.slice(0, a) + html.slice(b + CSS_MARK_END.length);
  for (const id of Object.keys(CHARTS)) {
    const open = `<div id="${id}" class="chart chart-static">`;
    const close = `<!--/${id}-->`;
    const i = html.indexOf(open);
    const j = html.indexOf(close);
    if (i < 0 || j < 0 || j < i) {
      console.error(`❌ 找不到 ${id} 的已生成区块（缺 ${close}）`); process.exit(1);
    }
    html = html.slice(0, i) + `<div id="${id}" class="chart"></div>` + html.slice(j + close.length);
  }
  report.push('（重跑）摘除上次生成的 8 块图表 + 静态图表 CSS');
}

// 1) 替换 8 个占位 div（结束注释给下次重跑用）
for (const [id, gen] of Object.entries(CHARTS)) {
  const re = new RegExp(`<div id="${id}"[^>]*></div>`);
  const m = html.match(re);
  if (!m) { console.error(`❌ 找不到占位符 ${id}`); process.exit(1); }
  /* ⚠️ 首尾都不带换行：占位符那一行的换行由文件自己提供。带上末尾 '\n' 就等于
     每重跑一次往图后多插一个空行 —— 8 张图重跑两遍，diff 里会多出 8 个空白行，
     看着像改了内容。 */
  const out = `<div id="${id}" class="chart chart-static">${gen()}\n</div><!--/${id}-->`;
  const before = m[0].length;
  html = html.replace(re, out);
  report.push(`${id}  ${before}B → ${out.length}B`);
}

// 2) 摘掉 echarts 的 cdnjs script（1 MB 的那个）
const echartsTag = /\n?<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/echarts\/[^"]+"><\/script>/;
if (echartsTag.test(html)) { html = html.replace(echartsTag, ''); report.push('移除 echarts cdnjs 脚本'); }
else if (RERUN) { /* 上次已移除 */ }
else { console.error('❌ 没找到 echarts 的 script 标签'); process.exit(1); }

// 3) qrcode 改自托管 + defer（不再走境外 CDN，也不阻塞解析）
const qrTag = /<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/qrcodejs\/[^"]+"><\/script>/;
if (qrTag.test(html)) {
  html = html.replace(qrTag, '<script src="vendor/qrcode.min.js" defer></script>');
  report.push('qrcode 改自托管 vendor/qrcode.min.js + defer');
} else if (html.includes('<script src="vendor/qrcode.min.js" defer></script>')) { /* 已是自托管 */ }
else { console.error('❌ 没找到 qrcode 的 script 标签'); process.exit(1); }

// 4) 删掉 charts[] / colors() / renderCharts() 整段，以及 resize 监听与调用
const lines = html.split('\n');
const i0 = lines.findIndex((l) => l.trim() === 'var charts=[];');
const i1 = lines.findIndex((l) => l.trim() === 'renderCharts();');
if (i0 >= 0 && i1 > i0) {
  const removed = i1 - i0 + 1;
  lines.splice(i0, removed);
  html = lines.join('\n');
  report.push(`删除图表脚本段 ${removed} 行（charts/colors/renderCharts/resize）`);
} else if (RERUN) { html = lines.join('\n'); }
else { console.error('❌ 定位不到图表脚本段'); process.exit(1); }

// 主题切换里那句 renderCharts() 已不存在，一并去掉
if (/syncSwitch\(\);renderCharts\(\);/.test(html)) {
  html = html.replace('syncSwitch();renderCharts();', 'syncSwitch();');
  report.push('主题切换去掉 renderCharts() 调用（改由 CSS 变量自动生效）');
} else if (!RERUN) { console.error('❌ 没找到主题切换里的 renderCharts()'); process.exit(1); }

/* 5) 注入 CSS。
   ⚠️ 插在「附录 · 数据图」那段 CSS **前面**（存在的话），别直接怼到 </style> 前：
   两个生成器都往 </style> 前塞整块 CSS，谁最后跑谁的块在后 —— 只跑一次 gen_charts
   index.html 就会多出 5000 多字符的「整块搬家」假 diff。插到附录块之前相当于插在
   原地，重跑不再搬动。前面那些空行也一并归一到 4 个换行（= 原来的 3 个空行），
   否则每重跑一次就多攒一个空行。 */
const cssAnchor = '\n</style>';
if (!html.includes(cssAnchor)) { console.error('❌ 找不到 </style>'); process.exit(1); }
const EOL = html.includes('\r\n') ? '\r\n' : '\n';
const crlf = (s) => (EOL === '\r\n' ? s.replace(/\r?\n/g, '\r\n') : s);
const AP_BEG = '/* ===== appendix-charts 开始';
const apAt = html.indexOf(AP_BEG);
if (apAt > 0) {
  html = html.slice(0, apAt).replace(/\n+$/, '\n\n\n\n') +
    crlf(CSS).replace(/^\r?\n/, '') + html.slice(apAt);
} else {
  html = html.replace(cssAnchor, crlf(CSS) + '</style>');
}
report.push('注入静态图表 CSS');

// 图表网格线配色变量（跟随主题）
const rootAnchor = '  --shadow:0 1px 2px rgba(40,35,25,.06),0 8px 24px rgba(40,35,25,.06);';
if (html.includes('--cgrid:#e6dfd1;')) { /* 已有，别重复插 */ }
else if (html.includes(rootAnchor)) {
  html = html.replace(rootAnchor, rootAnchor + '\n  --cgrid:#e6dfd1;');
  report.push('亮色主题加 --cgrid');
}
const darkAnchor = '  --shadow:0 1px 2px rgba(0,0,0,.3),0 8px 24px rgba(0,0,0,.3);';
if (html.includes('--cgrid:#2e3338;')) { /* 已有，别重复插 */ }
else if (html.includes(darkAnchor)) {
  html = html.replace(darkAnchor, darkAnchor + '\n  --cgrid:#2e3338;');
  report.push('深色主题加 --cgrid');
}

if (DRY) {
  console.log('（--dry，未落盘）\n' + report.join('\n'));
} else {
  fs.writeFileSync(FILE, html);
  console.log(`✅ 已改写 index.html（${fs.statSync(FILE).size} B）\n` + report.join('\n'));
}
