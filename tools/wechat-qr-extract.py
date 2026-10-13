#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
从微信「我的二维码」截图里，还原出一张干净、可直接上网页的二维码。
------------------------------------------------------------------
用法：
    python tools/wechat-qr-extract.py <截图> [输出.png]
    python tools/wechat-qr-extract.py <截图> --scale 16 --quiet 4

思路（不是"裁剪"而是"还原"）：
  截图里的码是 432px 宽、37 个模块（版本 5），模块边长 11.676px —— **不是整数**。
  直接按像素裁，裁剪边界就有亚像素相位偏差，重绘出来边缘发毛、还不一定扫得出来
  （实测：宽高差 1px 就能让 OpenCV 读不出来）。
  所以这里先**反推出模块网格**（模块数 N × 模块边长 m + 对齐偏移），
  再按网格取每格中心采样 → 得到一个干净的 N×N 布尔矩阵 → 之后想渲染多大都行。

步骤：
  1. 按"行/列里的有色像素数"找码的大致外接矩形（同时避开截图里
     顶部的头像·昵称、底部的说明文字）；
  2. 在候选模块数（21/25/29/33/37/41/45）里逐个试，配合 ±3px 的对齐微调，
     **用 OpenCV 解码是否成功当作验收标准**，反推出真正的模块网格；
  3. 采样出模块矩阵 + 每个模块的实际颜色（微信彩色码通常是 2 色：主紫 + 角上红）；
  4. 按 --scale 像素/模块重绘，四周留 --quiet 个模块宽的静区；
  5. 输出前再解码一次自检，内容和第 2 步一致才写出文件。

为什么要留静区：QR 规范要求 ≥4 个模块，微信截图本身几乎不给。
⚠️ 实测**不给静区 OpenCV 直接读不出这个码**，别省。

为什么不用 hardcode 坐标：截图尺寸/留白随手机和微信版本变，写死坐标换台机器就废。
"""
import os
import argparse

import numpy as np
import cv2
from PIL import Image, ImageDraw

# 找大致位置用的判据：码的墨是彩色的（微信默认紫 + 角上红），背景近白。
INK_MAX = 235          # 任一通道低于它 → 够暗，算墨
INK_CHROMA = 22        # 通道极差超过它 → 够彩，算墨
MIN_RUN = 3            # 一行/一列至少这么多墨像素才算落在码里，滤噪点
MODULE_CANDIDATES = (21, 25, 29, 33, 37, 41, 45, 49)   # QR 版本 1~10 的模块数
OFFSETS = range(-3, 4)


def is_ink(p):
    r, g, b = p[:3]
    mx, mn = max(r, g, b), min(r, g, b)
    return mx < INK_MAX or (mx - mn) > INK_CHROMA


def find_bbox(im):
    """找码的大致外接矩形（后面还会用网格反推精确边界，这里只求"差不多"）。"""
    w, h = im.size
    px = im.load()

    rows = [(y, sum(1 for x in range(w) if is_ink(px[x, y]))) for y in range(h)]
    peak = max(c for _, c in rows)
    if peak < 20:
        raise SystemExit("找不到二维码：整张图没有足够的有色像素，确认传的是二维码截图？")

    band = [y for y, c in rows if c > peak * 0.15]
    # 头像/昵称、底部说明也会命中，取最长的连续段
    runs, cur = [], [band[0]]
    for y in band[1:]:
        if y - cur[-1] <= 8:
            cur.append(y)
        else:
            runs.append(cur)
            cur = [y]
    runs.append(cur)
    seg = max(runs, key=len)
    y0, y1 = seg[0], seg[-1]

    cols = [(x, sum(1 for y in range(y0, y1 + 1) if is_ink(px[x, y]))) for x in range(w)]
    xs = [x for x, c in cols if c > MIN_RUN]
    return xs[0], y0, xs[-1] - xs[0] + 1, y1 - y0 + 1


def sample_grid(gray, x0, y0, n, m, dx, dy, thr):
    """按 n×n 网格、模块边长 m、左上角 (x0+dx, y0+dy) 采样成布尔矩阵。"""
    ox, oy = x0 + dx, y0 + dy
    H, W = gray.shape
    mat = np.zeros((n, n), dtype=bool)
    r_in = max(1, int(m * 0.22))          # 只取模块中心附近，避开边缘过渡带
    for r in range(n):
        cy = int(oy + (r + 0.5) * m)
        y1, y2 = cy - r_in, cy + r_in + 1
        if y1 < 0 or y2 > H:
            return None
        for c in range(n):
            cx = int(ox + (c + 0.5) * m)
            x1, x2 = cx - r_in, cx + r_in + 1
            if x1 < 0 or x2 > W:
                return None
            mat[r, c] = gray[y1:y2, x1:x2].mean() < thr
    return mat


def reject_center_logo(mat, n):
    """微信码正中压着一块 logo。判断采样结果里有没有"整块实心方块"（那就是 logo），
    交给调用方决定要不要盖掉重画。"""
    k = max(4, n // 5)
    c = n // 2 - k // 2
    block = mat[c:c + k, c:c + k]
    return block.mean()


def find_logo_plate(arr, x0, y0, n, m):
    """微信码正中通常压着一块实心圆角方块（logo 底板）。采样会把这块（连同里面白色的
    logo 图案）解成一坨脏像素。这里在原图上定位它的**模块范围**，好把它抹平重画。
    返回 (r0, c0, h, w)（模块坐标，h/w 是模块数）；找不到返回 None。"""
    x1, y1 = int(x0 + n * m), int(y0 + n * m)
    mx0, mx1 = int(x0 + n * m * 0.22), int(x0 + n * m * 0.78)   # 只看中间 56% 见方
    my0, my1 = int(y0 + n * m * 0.22), int(y0 + n * m * 0.78)
    mx0, my0 = max(mx0, x0), max(my0, y0)
    mx1, my1 = min(mx1, x1), min(my1, y1)
    sub = arr[my0:my1, mx0:mx1]
    if sub.shape[0] < 8 or sub.shape[1] < 8:
        return None
    g = cv2.cvtColor(sub.astype(np.uint8), cv2.COLOR_RGB2GRAY)
    bw = (g < 205).astype(np.uint8)
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=2)
    num, _lab, stats, _c = cv2.connectedComponentsWithStats(bw, 8)
    best = None
    for i in range(1, num):
        x, y, w, h, area = stats[i]
        if w < m * 4 or h < m * 4:            # 至少 4 个模块见方
            continue
        if area / float(w * h) < 0.55:        # 得像个实心方块，不是散点
            continue
        if best is None or area > best[4]:
            best = (x, y, w, h, area)
    if best is None:
        return None
    x, y, w, h, _ = best
    c0, r0 = (mx0 + x - x0) / m, (my0 + y - y0) / m
    pw, ph = int(round(w / m)), int(round(h / m))
    c0, r0 = int(round(c0)), int(round(r0))
    if abs((r0 + ph / 2.0) - n / 2.0) > 2.0 or abs((c0 + pw / 2.0) - n / 2.0) > 2.0:
        return None                           # 不居中，多半不是 logo 底板
    if not (4 <= pw <= n - 8 and 4 <= ph <= n - 8):
        return None
    return (r0, c0, ph, pw)


def decode_matrix(mat, quiet, scale):
    n = mat.shape[0]
    side = (n + quiet * 2) * scale
    img = np.full((side, side), 255, np.uint8)
    ys, xs = np.nonzero(mat)
    for r, c in zip(ys, xs):
        img[(r + quiet) * scale:(r + quiet + 1) * scale,
            (c + quiet) * scale:(c + quiet + 1) * scale] = 0
    data, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
    return data or None, img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst", nargs="?", default="wechat-qr.png")
    ap.add_argument("--scale", type=int, default=16, help="每个模块渲染多少像素（默认 16）")
    ap.add_argument("--quiet", type=int, default=4, help="四周留几个模块宽的静区（默认 4）")
    ap.add_argument("--mono", action="store_true", help="输出纯黑白，不要原图的紫/红配色")
    ap.add_argument("--center", choices=("solid", "keep"), default="solid",
                    help="中心 logo 底板：solid=抹平重画成干净圆角块（默认），keep=保留采样原样")
    args = ap.parse_args()

    if not os.path.exists(args.src):
        raise SystemExit("源图不存在：" + args.src)

    im = Image.open(args.src).convert("RGB")
    gray = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2GRAY).astype(np.float32)
    thr, _ = cv2.threshold(gray.astype(np.uint8), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    x0, y0, bw, bh = find_bbox(im)
    print("大致位置 (%d,%d) %dx%d；Otsu 阈值 %.0f" % (x0, y0, bw, bh, thr))

    # ---- 反推模块网格：以"能不能解码"为唯一验收标准 ----
    found = None
    for n in MODULE_CANDIDATES:
        m = bw / float(n)
        if not (6.0 <= m <= 26.0):        # 模块太小/太大都不合理
            continue
        for d in sorted(OFFSETS, key=abs):   # 偏移越接近 0 越可信，优先试
            mat = sample_grid(gray, x0, y0, n, m, d, 0, thr)
            if mat is None:
                continue
            data, _ = decode_matrix(mat, args.quiet, args.scale)
            if data:
                found = (n, m, d, 0, mat, data)
                break
        if found:
            break
    if not found:
        raise SystemExit("❌ 试遍候选模块数都解不出来。把源图发我看看，可能不是标准 QR 或截图被裁过。")

    n, m, dx, dy, mat, data = found
    print("✅ 反推出：%d×%d 模块（版本 %d），模块边长 %.3fpx，对齐偏移 (%+d,%+d)"
          % (n, n, (n - 17) // 4, m, dx, dy))
    print("   内容：%s" % data)
    print("   中心 logo 区域实心度 %.2f（越高越像被 logo 压住）" % reject_center_logo(mat, n))

    arr = np.array(im).astype(np.float32)
    ox, oy = x0 + dx, y0 + dy
    r_in = max(1, int(m * 0.22))

    # ---- 中心 logo：微信默认压着一块实心圆角方块，采样出来是一坨脏像素 ----
    #      这里把它抹平、之后重画成干净的圆角底板（不改功能，纯粹好看）。
    #      ⚠️ 必须在"采色"之前做，否则 mat 一变、颜色数组就跟模块对不上号了。
    plate = None
    plate_color = None
    if args.center == "solid":
        box = find_logo_plate(arr, x0, y0, n, m)
        if box:
            r0, c0, ph, pw = box
            trial = mat.copy()
            trial[r0:r0 + ph, c0:c0 + pw] = False
            data2, _ = decode_matrix(trial, args.quiet, args.scale)
            if data2 == data:
                mat = trial
                plate = box
                # 底板自身颜色 = 原图上这块里"够暗"的像素均值（排除中间的白色 logo 图案）
                py0, py1 = int(oy + r0 * m), int(oy + (r0 + ph) * m)
                px0, px1 = int(ox + c0 * m), int(ox + (c0 + pw) * m)
                sub = arr[max(0, py0):py1, max(0, px0):px1]
                gsub = gray[max(0, py0):py1, max(0, px0):px1]
                msk = gsub < thr
                if msk.sum() > 20:
                    plate_color = tuple(int(v) for v in sub[msk].mean(axis=0).round())
                print("   中心底板：模块 [%d,%d)×[%d,%d)（%d×%d），已抹平待重画"
                      % (r0, r0 + ph, c0, c0 + pw, ph, pw))
            else:
                print("   ⚠️ 抹掉中心底板后解不出，保持原样不动")
        else:
            print("   中心没检出 logo 底板，跳过")

    # ---- 还原配色：从原图取每个暗模块的实际颜色 ----
    ys, xs = np.nonzero(mat)

    def module_color(r, c):
        cy, cx = int(oy + (r + 0.5) * m), int(ox + (c + 0.5) * m)
        patch = arr[max(0, cy - r_in):cy + r_in + 1, max(0, cx - r_in):cx + r_in + 1]
        return patch.reshape(-1, 3).mean(axis=0)

    dark_colors = np.array([module_color(r, c) for r, c in zip(ys, xs)], np.float32)
    if args.mono or len(dark_colors) == 0:
        palette = [(0, 0, 0)]
        assign = np.zeros(len(dark_colors), dtype=int)
    else:
        # k-means 聚出实际用到的墨色（微信彩色码一般 2 色：主紫 + 角上红）
        k = 2
        crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 40, 0.5)
        _, lab, cen = cv2.kmeans(dark_colors, k, None, crit, 5, cv2.KMEANS_PP_CENTERS)
        cen = cen.round().astype(int)
        assign = lab.ravel()
        palette = [tuple(int(v) for v in c) for c in cen]
    print("   墨色 %s" % palette)
    counts = np.bincount(assign, minlength=len(palette)) if len(assign) else np.array([1])
    main_color = palette[int(counts.argmax())]

    # ---- 渲染 ----
    n2 = n + args.quiet * 2
    side = n2 * args.scale
    canvas = np.full((side, side, 3), 255, np.uint8)
    for (r, c), a in zip(zip(ys, xs), assign):
        y1, y2 = (r + args.quiet) * args.scale, (r + args.quiet + 1) * args.scale
        x1, x2 = (c + args.quiet) * args.scale, (c + args.quiet + 1) * args.scale
        canvas[y1:y2, x1:x2] = palette[a]

    out = Image.fromarray(canvas, "RGB")
    if plate:
        r0, c0, ph, pw = plate
        q = args.quiet
        bx0, by0 = (c0 + q) * args.scale, (r0 + q) * args.scale
        bx1, by1 = (c0 + pw + q) * args.scale, (r0 + ph + q) * args.scale
        rad = int(min(bx1 - bx0, by1 - by0) * 0.22)
        fill = plate_color or tuple(int(v) for v in main_color)
        ImageDraw.Draw(out).rounded_rectangle([bx0, by0, bx1 - 1, by1 - 1],
                                              radius=rad, fill=fill)
    out.save(args.dst, "PNG", optimize=True)

    # ---- 自检：成品必须能读出同样的内容，静区必须干净 ----
    back = cv2.cvtColor(np.array(out), cv2.COLOR_RGB2GRAY)
    got, _, _ = cv2.QRCodeDetector().detectAndDecode(back)
    a = np.array(out)
    edge = np.concatenate([a[0].reshape(-1, 3), a[-1].reshape(-1, 3), a[:, 0], a[:, -1]])
    nonwhite = int((edge != 255).any(axis=1).sum())
    kb = os.path.getsize(args.dst) / 1024.0
    print("输出 %dx%d（%d 模块 × %d 静区 × %dpx），%.1f KB"
          % (side, side, n, args.quiet, args.scale, kb))
    print("成品解码：%s" % (got or "读不出来"))
    print("静区：%s" % ("OK（最外圈全白）" if nonwhite == 0 else "异常，最外圈 %d 个非白像素" % nonwhite))
    if got != data:
        raise SystemExit("❌ 成品解码内容与采样结果不一致，别用这张。")
    print("✅ 内容一致：%s" % got)
    print("→ " + os.path.abspath(args.dst))


if __name__ == "__main__":
    main()
