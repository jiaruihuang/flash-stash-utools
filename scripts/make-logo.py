#!/usr/bin/env python3
"""生成/更新 logo.png（128x128）—— 对 scripts/logo-master-256.png（256 母版）做 2x2 盒降采样。
无任何第三方依赖（仅标准库 zlib/struct），兼容本机与 Windows。"""
import os, struct, zlib, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(ROOT, "scripts", "logo-master-256.png")
OUT = os.path.join(ROOT, "logo.png")
TARGET = 128

def read_png(path):
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG 文件"
    pos = 8
    idat = b""
    w = h = bpp = bit = color = 0
    while pos < len(data):
        ln, typ = struct.unpack(">I4s", data[pos:pos+8])
        chunk = data[pos+8:pos+8+ln]
        if typ == b"IHDR":
            w, h, bit, color, = struct.unpack(">IIBB", chunk[:10])
            bpp = 4 if color == 6 else (3 if color == 2 else (2 if color == 4 else 1))
        elif typ == b"IDAT":
            idat += chunk
        elif typ == b"IEND":
            break
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w * bpp
    px = bytearray()
    prev = bytearray(stride)
    i = 0
    for _ in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i+stride]); i += stride
        if f == 1:
            for x in range(bpp, stride): line[x] = (line[x] + line[x-bpp]) & 255
        elif f == 2:
            for x in range(stride): line[x] = (line[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                a = line[x-bpp] if x >= bpp else 0
                line[x] = (line[x] + ((a + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = line[x-bpp] if x >= bpp else 0
                b2 = prev[x]
                c = prev[x-bpp] if x >= bpp else 0
                p = a + b2 - c
                pa, pb, pc = abs(p-a), abs(p-b2), abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (b2 if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        px += line
        prev = line
    return w, h, bpp, bytes(px)

def write_png(path, w, h, px):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    stride = w * 4
    raw = b"".join(b"\x00" + px[y*stride:(y+1)*stride] for y in range(h))
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))

def box_downscale(w, h, px, factor):
    ow, oh = w // factor, h // factor
    out = bytearray(ow * oh * 4)
    n = factor * factor
    for oy in range(oh):
        for ox in range(ow):
            r = g = b = a = 0
            base = (oy * factor * w + ox * factor) * 4
            for dy in range(factor):
                row = base + dy * w * 4
                for dx in range(factor):
                    i = row + dx * 4
                    r += px[i]; g += px[i+1]; b += px[i+2]; a += px[i+3]
            j = (oy * ow + ox) * 4
            out[j] = r // n; out[j+1] = g // n; out[j+2] = b // n; out[j+3] = a // n
    return ow, oh, bytes(out)

def main():
    if not os.path.exists(MASTER):
        sys.exit("缺少母版 scripts/logo-master-256.png")
    w, h, bpp, px = read_png(MASTER)
    if bpp == 3:  # RGB → RGBA
        px = b"".join(px[i:i+3] + b"\xff" for i in range(0, len(px), 3))
        bpp = 4
    factor = w // TARGET if w >= TARGET else 1
    if factor > 1:
        w, h, px = box_downscale(w, h, px, factor)
    if w != TARGET or h != TARGET:
        sys.exit(f"母版尺寸 {w}x{h} 无法整数降采样到 {TARGET}")
    write_png(OUT, w, h, px)
    print(f"logo.png -> {OUT} ({w}x{h})")

if __name__ == "__main__":
    main()
