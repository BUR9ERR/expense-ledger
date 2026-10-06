# -*- coding: utf-8 -*-
"""
记账本 · 应用图标生成
用 Python 标准库（struct + zlib）手写 PNG：蓝色圆角方块 + 白色 ¥ 字。
不依赖 Pillow——理由和项目不引第三方库一致。

生成的文件（都在 assets/ 下）：
  icon-180.png            iOS 主屏图标（apple-touch-icon）
  icon-192.png            Android / PWA 常规
  icon-512.png            PWA 启动画面
  icon-maskable-512.png   Android 自适应图标（全出血，安全区内放主体）

重新生成：python tools/make-icons.py
"""

import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'assets'

BG = (0, 122, 255)      # iOS 蓝，与页面 --accent 一致
FG = (255, 255, 255)    # 白色 ¥
SS = 4                  # 超采样倍数（每像素 SS×SS 个子样本，抗锯齿）


def inside_rounded_rect(x, y, size, radius):
    """点是否在圆角矩形内（0..size 坐标系）：把点夹到核心矩形再算圆距离"""
    if x < 0 or y < 0 or x > size or y > size:
        return False
    r = radius
    cx = min(max(x, r), size - r)
    cy = min(max(y, r), size - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def dist_to_segment(px, py, ax, ay, bx, by):
    """点到线段的距离"""
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    if denom == 0:
        return math.hypot(wx, wy)
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


# ¥ 字的笔画，归一化坐标（0..1），线宽也归一化
# 两撇 + 竖钩省略成竖线 + 两横——远看就是明确的 ¥
STROKES = [
    ((0.285, 0.22), (0.50, 0.50)),
    ((0.715, 0.22), (0.50, 0.50)),
    ((0.50, 0.50), (0.50, 0.80)),
]
BARS = [
    (0.33, 0.565, 0.67, 0.615),
    (0.33, 0.675, 0.67, 0.725),
]
STROKE_W = 0.052


def glyph_coverage(px, py, glyph_scale, glyph_center):
    """点在 ¥ 字形内的覆盖率近似：线段距离 + 矩形条"""
    # 平移到字形的局部坐标系
    gx = (px - glyph_center[0]) / glyph_scale + 0.5
    gy = (py - glyph_center[1]) / glyph_scale + 0.5
    for (ax, ay), (bx, by) in STROKES:
        if dist_to_segment(gx, gy, ax, ay, bx, by) <= STROKE_W / 2:
            return True
    for x0, y0, x1, y1 in BARS:
        if x0 <= gx <= x1 and y0 <= gy <= y1:
            return True
    return False


def make_icon(size, maskable):
    """渲染一张图标，返回 PNG 字节。
    maskable=True 时背景全出血（系统会自己裁圆角），主体缩小到安全区。"""
    radius = 0 if maskable else size * 0.22
    glyph_scale = size * (0.56 if maskable else 0.72)
    center = (size / 2, size / 2)

    rows = []
    for j in range(size):
        row = bytearray([0])  # PNG 每行开头的 filter 类型
        for i in range(size):
            rr_hit = gg_hit = 0
            samples = SS * SS
            rr_count = 0
            glyph_count = 0
            for sj in range(SS):
                for si in range(SS):
                    px = i + (si + 0.5) / SS
                    py = j + (sj + 0.5) / SS
                    if radius == 0 or inside_rounded_rect(px, py, size, radius):
                        rr_count += 1
                        if glyph_coverage(px, py, glyph_scale, center):
                            glyph_count += 1
            rr_cov = rr_count / samples
            glyph_cov = glyph_count / samples
            # 白字叠在蓝底上，再按圆角覆盖率做透明
            r = BG[0] + (FG[0] - BG[0]) * glyph_cov
            g = BG[1] + (FG[1] - BG[1]) * glyph_cov
            b = BG[2] + (FG[2] - BG[2]) * glyph_cov
            a = rr_cov * 255
            row += bytes((int(r + 0.5), int(g + 0.5), int(b + 0.5), int(a + 0.5)))
        rows.append(bytes(row))

    return encode_png(size, size, b''.join(rows))


def encode_png(w, h, raw):
    """RGBA8 原始数据 → PNG 文件字节（标准库手写，无依赖）"""

    def chunk(tag, data):
        out = struct.pack('>I', len(data)) + tag + data
        out += struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
        return out

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0)  # 8bit RGBA
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', ihdr)
            + chunk(b'IDAT', zlib.compress(raw, 9))
            + chunk(b'IEND', b''))


def main():
    targets = [
        ('icon-180.png', 180, False),
        ('icon-192.png', 192, False),
        ('icon-512.png', 512, False),
        ('icon-maskable-512.png', 512, True),
    ]
    for name, size, maskable in targets:
        data = make_icon(size, maskable)
        path = ASSETS / name
        path.write_bytes(data)
        print('生成 %s（%d 字节）' % (path.relative_to(ROOT), len(data)))


if __name__ == '__main__':
    main()
