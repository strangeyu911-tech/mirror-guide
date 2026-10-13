# -*- coding: utf-8 -*-
"""把 patch-og.png 里的 "33" 定点替换成 "41"（修正版）。

关键点：文字墨迹相对「绘制原点」的偏移要用 getbbox 取，不能拿测试画布上的
绝对坐标当偏移（上一版就是这么错的，整体偏了 (40,30)）。
绘制后立即回测，确认新墨迹落在目标位置 ±1px 内。
"""
from PIL import Image, ImageDraw, ImageFont
import numpy as np
import os

SRC = r'C:\Users\23159\Doubao\chats\2026-10-12\new-chat-2\mirror-guide\patch-og.png'
DST = r'D:\全局项目库\.workbuddy\tmp\og-rebuild\patch-og.new.png'
FONT = r'C:\Windows\Fonts\Noto Sans SC Bold (TrueType).otf'
COLOR = (36, 86, 90)

im = Image.open(SRC).convert('RGB')
before = np.asarray(im).astype(int)
draw = ImageDraw.Draw(im)

JOBS = [
    dict(name='A 这 33 条补丁',  box=(620, 312, 765, 348), xlo=656, xhi=684, size=18),
    dict(name='B 33 条下行周期', box=(890, 512, 1150, 552), xlo=901, xhi=936, size=21),
]


def ink_in(arr, box, xlo, xhi, thresh):
    x0, y0, x1, y1 = box
    sub = arr[y0:y1, x0:x1].mean(axis=2)
    m = sub < thresh
    keep = np.zeros_like(m)
    keep[:, max(0, xlo - x0):max(0, xhi - x0)] = True
    ys, xs = np.where(m & keep)
    if len(ys) == 0:
        return None
    return (x0 + int(xs.min()), y0 + int(ys.min()), x0 + int(xs.max()), y0 + int(ys.max()))


results = []
for j in JOBS:
    box, xlo, xhi = j['box'], j['xlo'], j['xhi']
    cur = np.asarray(im).astype(int)

    # 原数字 bbox：用较松的阈值把抗锯齿的边边角角也圈进来
    ob = ink_in(cur, box, xlo, xhi, 215)
    x0e, y0e, x1e, y1e = ob[0] - 2, ob[1] - 2, ob[2] + 2, ob[3] + 2
    bg = tuple(int(v) for v in np.median(cur[max(0, box[1] - 10):box[1], xlo:xhi].reshape(-1, 3), axis=0))
    print(f"[{j['name']}] 原数字 bbox(松阈值)={ob} 宽{ob[2]-ob[0]+1} 高{ob[3]-ob[1]+1} 背景={bg}")

    # 1) 擦除
    draw.rectangle([x0e, y0e, x1e, y1e], fill=bg)

    # 2) 重绘：先取墨迹相对绘制原点的偏移
    f = ImageFont.truetype(FONT, j['size'])
    bx = f.getbbox('41')
    offx, offy = bx[0], bx[1]
    tw, th = bx[2] - bx[0], bx[3] - bx[1]
    cx = (ob[0] + ob[2]) / 2.0
    left = round(cx - tw / 2.0)
    top = ob[1] + (ob[3] - ob[1] + 1 - th) // 2   # 垂直居中到原墨迹
    ox, oy = left - offx, top - offy
    draw.text((ox, oy), '41', font=f, fill=COLOR)
    print(f"        预测新墨迹 = ({left},{top})-({left+tw-1},{top+th-1})  size={j['size']}  getbbox={bx}")

    results.append((j['name'], ob, (left, top, left + tw - 1, top + th - 1), j['size']))

# 3) 回测
after = np.asarray(im).astype(int)
print('\n=== 回测 ===')
for name, ob, nb, size in results:
    got = ink_in(after, (max(0, nb[0] - 30), max(0, nb[1] - 15), nb[2] + 30, nb[3] + 15),
                 nb[0] - 6, nb[2] + 7, 215)
    dx = (got[0] - nb[0], got[1] - nb[1])
    ok = abs(dx[0]) <= 1 and abs(dx[1]) <= 1
    print(f'  {name}: 目标 {nb}  实测 {got}  偏差 {dx}  {"OK" if ok else "!! 偏移"}')

os.makedirs(os.path.dirname(DST), exist_ok=True)
im.save(DST)
print('\n写出:', DST)

d = (np.abs(before - after).sum(axis=2) > 8)
ys, xs = np.where(d)
print(f'改动像素 {d.sum()}，范围 x:{xs.min()}-{xs.max()} y:{ys.min()}-{ys.max()}')
