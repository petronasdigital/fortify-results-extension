import struct, zlib, math, os, shutil

def make_png_rgba(width, height, pixels):
    def chunk(name, data):
        c = struct.pack('>I', len(data)) + name + data
        return c + struct.pack('>I', zlib.crc32(name + data) & 0xffffffff)
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    raw = b''
    for y in range(height):
        raw += b'\x00'
        for x in range(width):
            r,g,b,a = pixels[y][x]
            raw += bytes([r,g,b,a])
    compressed = zlib.compress(raw, 9)
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', compressed) + chunk(b'IEND', b'')

def lerp(a,b,t): return a + (b-a)*t
def clamp(v,lo=0,hi=255): return max(lo,min(hi,int(v)))

def draw_icon(size):
    S = size
    px = [[(0,0,0,0)]*S for _ in range(S)]

    def set_px(x,y,r,g,b,a=255):
        if 0<=x<S and 0<=y<S:
            br,bg,bb,ba = px[y][x]
            fa = a/255.0
            px[y][x] = (clamp(br*(1-fa)+r*fa), clamp(bg*(1-fa)+g*fa), clamp(bb*(1-fa)+b*fa), clamp(ba + a*(1-ba/255)))

    def fill_circle(cx,cy,r,col):
        for y in range(max(0,int(cy-r-2)),min(S,int(cy+r+2))):
            for x in range(max(0,int(cx-r-2)),min(S,int(cx+r+2))):
                d = math.hypot(x+0.5-cx, y+0.5-cy)
                a = clamp((r+0.5-d)*255, 0, 255)
                if a > 0: set_px(x,y,*col,a)

    def draw_ring(cx,cy,r,w,col):
        for y in range(max(0,int(cy-r-w-2)),min(S,int(cy+r+w+2))):
            for x in range(max(0,int(cx-r-w-2)),min(S,int(cx+r+w+2))):
                d = math.hypot(x+0.5-cx, y+0.5-cy)
                a = clamp((w/2+0.5-abs(d-r))*255, 0, 255)
                if a > 0: set_px(x,y,*col,a)

    def draw_line(x0,y0,x1,y1,w,col):
        dx,dy = x1-x0, y1-y0
        length = math.hypot(dx,dy)
        if length==0: return
        nx,ny = -dy/length, dx/length
        steps = int(length*3)+1
        for i in range(steps+1):
            t = i/steps
            mx,my = x0+dx*t, y0+dy*t
            for ox in range(-int(w)-2, int(w)+3):
                for oy in range(-int(w)-2, int(w)+3):
                    px_x = int(mx + nx*ox*0.5)
                    px_y = int(my + ny*oy*0.5)
                    proj = ox*0.5
                    a = clamp((w/2+0.5-abs(proj))*255, 0, 255)
                    if a>0: set_px(px_x, px_y, *col, a)

    # ── Rounded rect background ──
    r_bg = S*0.14
    for y in range(S):
        for x in range(S):
            qx = abs(x+0.5-S/2) - (S/2-r_bg)
            qy = abs(y+0.5-S/2) - (S/2-r_bg)
            d = math.hypot(max(qx,0), max(qy,0)) + min(max(qx,qy),0)
            alpha = clamp((0-d)*255, 0, 255) if d < 1 else (255 if d < 0 else 0)
            if d < 1:
                alpha = clamp((1-d)*255, 0, 255) if d > -1 else 255
                t = (x + y) / (2*S)
                rv = clamp(lerp(0x0d, 0x1a, t))
                gv = clamp(lerp(0x1b, 0x3a, t))
                bv = clamp(lerp(0x2a, 0x5c, t))
                set_px(x, y, rv, gv, bv, alpha)
            elif d <= 0:
                t = (x + y) / (2*S)
                rv = clamp(lerp(0x0d, 0x1a, t))
                gv = clamp(lerp(0x1b, 0x3a, t))
                bv = clamp(lerp(0x2a, 0x5c, t))
                set_px(x, y, rv, gv, bv, 255)

    # Rebuild properly: fill all pixels inside rounded rect
    for y in range(S):
        for x in range(S):
            qx = abs(x+0.5-S/2) - (S/2-r_bg)
            qy = abs(y+0.5-S/2) - (S/2-r_bg)
            d = math.hypot(max(qx,0), max(qy,0)) + min(max(qx,qy),0)
            alpha = clamp((-d+0.7)*255/1.4, 0, 255)
            if alpha > 0:
                t = (x + y) / (2*S)
                rv = clamp(lerp(0x0d, 0x1e, t))
                gv = clamp(lerp(0x1b, 0x3a, t))
                bv = clamp(lerp(0x2a, 0x60, t))
                set_px(x, y, rv, gv, bv, alpha)

    # ── Shield ──
    cx, cy_s = S*0.5, S*0.48
    sw, sh = S*0.52, S*0.60

    def in_shield_aa(px_, py_):
        # Sub-pixel AA: sample 4x4
        count = 0
        for sx in range(4):
            for sy in range(4):
                rx = (px_ + sx*0.25 + 0.125 - cx) / (sw*0.55)
                ry = (py_ + sy*0.25 + 0.125 - cy_s) / (sh*0.52)
                if ry < -1.0 or ry > 1.0:
                    continue
                if ry < 0.4:
                    if abs(rx) < 1.0:
                        count += 1
                else:
                    max_rx = 1.0 - (ry-0.4)/0.6
                    if abs(rx) < max_rx:
                        count += 1
        return count

    for y in range(S):
        for x in range(S):
            c = in_shield_aa(x, y)
            if c > 0:
                alpha = int(c/16*255)
                t_y = (y - (cy_s - sh*0.52)) / (sh*1.04)
                t_y = max(0, min(1, t_y))
                rv = clamp(lerp(0x28, 0x0d, t_y))
                gv = clamp(lerp(0x90, 0x47, t_y))
                bv = clamp(lerp(0xe8, 0xa1, t_y))
                set_px(x, y, rv, gv, bv, alpha)

    # Shield inner highlight (lighter top)
    for y in range(S):
        for x in range(S):
            c = in_shield_aa(x, y)
            if c > 0:
                ry = (y+0.5 - cy_s) / (sh*0.52)
                rx = (x+0.5 - cx) / (sw*0.55)
                # Top-left highlight
                highlight = max(0, (-ry - rx)*0.3)
                if highlight > 0:
                    alpha = int(min(highlight, 1)*60 * c/16)
                    set_px(x, y, 180, 220, 255, alpha)

    # ── Magnifying glass ──
    mr = S*0.155
    mcx, mcy = cx + S*0.04, cy_s - S*0.03
    ring_w = S*0.055
    draw_ring(mcx, mcy, mr, ring_w, (255, 255, 255))

    # handle
    angle = math.pi*0.78
    hx1 = mcx + math.cos(angle)*(mr - ring_w*0.1)
    hy1 = mcy + math.sin(angle)*(mr - ring_w*0.1)
    hx2 = mcx + math.cos(angle)*(mr + S*0.21)
    hy2 = mcy + math.sin(angle)*(mr + S*0.21)
    draw_line(hx1, hy1, hx2, hy2, S*0.065, (255, 255, 255))
    # round cap at handle end
    fill_circle(hx2, hy2, S*0.033, (255, 255, 255))

    # Scan lines inside lens
    for i in [-1, 0, 1]:
        ly = mcy + i*mr*0.33
        dx_i = math.sqrt(max(0, (mr*0.68)**2 - (ly-mcy)**2))
        draw_line(mcx-dx_i, ly, mcx+dx_i, ly, S*0.026, (255, 255, 255))

    # ── Orange alert badge (top-right of shield) ──
    adx = cx + sw*0.30
    ady = cy_s - sh*0.36
    ar  = S*0.09
    fill_circle(adx, ady, ar, (255, 87, 0))
    # White "!" — bar + dot
    bar_top    = ady - ar*0.55
    bar_bottom = ady + ar*0.05
    dot_y      = ady + ar*0.52
    draw_line(adx, bar_top, adx, bar_bottom, S*0.022, (255, 255, 255))
    fill_circle(adx, dot_y, S*0.016, (255, 255, 255))

    return px

script_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(script_dir)

for size in [128, 512]:
    pxdata = draw_icon(size)
    data = make_png_rgba(size, size, pxdata)
    fname = f'icon{size}.png'
    with open(fname, 'wb') as f:
        f.write(data)
    print(f'{fname}: {len(data)} bytes')

shutil.copy('icon128.png', 'icon.png')
print('icon.png updated')
