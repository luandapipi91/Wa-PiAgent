# 从 logo.svg 直接栅格化生成各平台图标（app icon / tray icon）。
# 直接栅格化 SVG（而非手绘重现），保证 logo.svg 一改、图标即随之精确还原（含设计稿留白）。
# 依赖：cairosvg（SVG->PNG）、PIL（多尺寸合成 .ico）。
# 用法: python genicon.py <logo.svg> <out_dir>
import sys, os, io
import cairosvg
from PIL import Image

ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def render(size, svg_path):
    png = cairosvg.svg2png(url=svg_path, output_width=size, output_height=size)
    return Image.open(io.BytesIO(png)).convert("RGBA")


if __name__ == "__main__":
    svg, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    # App icons
    render(1024, svg).save(os.path.join(out, "icon-mac.png"))                    # macOS .app/.dmg（>=512 合规）
    render(512, svg).save(os.path.join(out, "icon.png"))                         # Linux + desktop 启动页 logo
    render(512, svg).save(os.path.join(out, "icon.ico"), format="ICO", sizes=ICO_SIZES)        # Windows 应用图标
    # Tray icons（同图，尺寸按平台惯例）
    render(512, svg).save(os.path.join(out, "tray_windows.ico"), format="ICO", sizes=ICO_SIZES)
    render(128, svg).save(os.path.join(out, "tray_darwin.png"))
    render(64, svg).save(os.path.join(out, "tray_linux.png"))
    print("icons ->", out)
