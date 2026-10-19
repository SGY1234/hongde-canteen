"""把二维码模块矩阵画成 PNG，用于人工目视检查。
用法：python scripts/render-qr.py <matrix.json> <out.png>
"""
import json
import sys
from PIL import Image


def main():
    src = sys.argv[1]
    dst = sys.argv[2]
    scale = int(sys.argv[3]) if len(sys.argv) > 3 else 14
    margin = 4

    with open(src, "r", encoding="utf-8") as f:
        q = json.load(f)

    size = q["size"]
    px = (size + margin * 2) * scale
    img = Image.new("RGB", (px, px), "white")
    pix = img.load()
    for r in range(size):
        row = q["modules"][r]
        for c in range(size):
            if row[c]:
                x0 = (c + margin) * scale
                y0 = (r + margin) * scale
                for dy in range(scale):
                    for dx in range(scale):
                        pix[x0 + dx, y0 + dy] = (0, 0, 0)
    img.save(dst)
    print("OK size=%d version=%s mask=%s -> %s" % (size, q["version"], q["mask"], dst))


if __name__ == "__main__":
    main()
