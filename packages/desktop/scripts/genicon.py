# 用 PIL 精确手绘 logo.svg（绿底青蛙线稿）-> Windows .ico / mac/linux .png。
# 用法: python genicon.py <logo.svg> <out_dir>
import sys, os
from PIL import Image, ImageDraw

def render(S=512):
    k = S/120.0
    img = Image.new("RGBA",(S,S),(0,0,0,0)); d = ImageDraw.Draw(img)
    d.rounded_rectangle([0,0,S-1,S-1], radius=int(26*k), fill=(75,162,111,255))
    def C(x,y,r,fill=None,outline=None,w=0.0):
        xx,yy,rr=x*k,y*k,r*k; box=[xx-rr,yy-rr,xx+rr,yy+rr]
        if fill is not None: d.ellipse(box,fill=fill)
        if outline is not None and w: d.ellipse(box,outline=outline,width=max(1,int(w*k)))
    C(60,64,38,outline=(255,255,255,255),w=2.5)
    for ex in (38,82):
        C(ex,30,18,fill=(255,255,255,255),outline=(255,255,255,255),w=2.5); C(ex,31,11,fill=(22,23,27,255))
    for (x,y,r) in [(33,24,5),(77,24,5),(41,34,2.5),(85,34,2.5)]: C(x,y,r,fill=(255,255,255,255))
    for (x,y) in [(24,65),(96,65)]: C(x,y,6,fill=(255,255,255,int(255*0.18)))
    p0=(40*k,78*k); p1=(60*k,95*k); p2=(80*k,78*k); pts=[p0]
    for i in range(1,49):
        t=i/48.0
        pts.append(((1-t)**2*p0[0]+2*(1-t)*t*p1[0]+t*t*p2[0], (1-t)**2*p0[1]+2*(1-t)*t*p1[1]+t*t*p2[1]))
    d.line(pts,fill=(255,255,255,255),width=max(2,int(2.8*k)),joint="curve")
    return img

if __name__ == "__main__":
    _svg, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    img = render(512)
    img.save(os.path.join(out,"tray_windows.ico"), format="ICO", sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
    img.resize((128,128)).save(os.path.join(out,"tray_darwin.png"))
    img.resize((64,64)).save(os.path.join(out,"tray_linux.png"))
    print("icons ->", out)
