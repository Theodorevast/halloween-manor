# 访客 GLB 底色贴图的后处理（Blender 5.2 无头运行，由 scripts/blender/retint.mjs 调用；流水线 export 步骤在精修之后调它）。
#
# 只改底色贴图（Color）和手套那几块的金属度 / 粗糙度贴图（ORM），其余（网格、骨骼、权重、动作、法线贴图、别处的 ORM）按字节原样拷贝：
# 不经过 Blender 的 glTF 导出，精修的结果一点不动。Blender 只用来读网格（UV、骨骼权重）、解码 / 编码 WEBP。
#
#   blender -b --factory-startup --python-exit-code 1 -P retint.py -- --in in.glb --out out.glb --config cfg.json [--report r.json] [--preview 前缀]
#   路径都要绝对路径（Blender 的工作目录不一定是项目根）
#
# cfg.json（来自 scripts/tripo/visitors.json 访客的 retint，路径由调用方换成绝对路径）：
#   gloves：手套重涂成参考访客手套的颜色和材质。
#     { "reference": "<参考 GLB>", "bones": ["LeftHand", "RightHand"], "maxDist": 0.15, "dilate": 6, "material": true }
#     手套的范围 = 主导骨头是手、离手骨不超过 maxDist 米的面（再远的是被自动绑骨误分给手的别处网格，不算）在 UV 上盖住的像素；
#     颜色 = 参考 GLB 里同样找出来的手套像素的中位数。原来比它亮的像素（掌心的小星星）保留，暗的都抬到这个颜色。
#     dilate：手套岛外面一圈没有被任何面用到的像素（UV 岛之间的填充）也涂上，免得远处取低分辨率贴图时周围的深色渗进手套边
#     material：ORM 贴图里手套像素的粗糙度（G）、金属度（B）也换成参考手套的中位数（AO 不动）。游戏里没有环境贴图，
#     金属度接近 1 的手套只剩高光，底色再浅看着也是黑的（2026-10-29 承太郎：手套底色和 DIO 一样是 0.655 的灰，金属度 0.98 对 0.035）
#   lift：提亮某一类颜色，色相、饱和度不变，只把明度乘上 gain（可以写几条）。
#     { "hue": [195, 265], "sat": [0.15, 0.3], "value": [0.3, 0.45], "gain": 1.8, "exclude": ["gloves", "legs"] }
#     hue：色相范围（度），两边各 10 度平滑过渡；sat：饱和度从 sat[0] 到 sat[1] 平滑变成全量（低饱和的黑、灰、白不动）；
#     value：明度在 value[0] 以下全量、到 value[1] 平滑减到 0（亮的东西不动）；exclude：不碰的部位（gloves = 上面的手套范围，
#     legs = 主导骨头是腿、脚的面，hands = 主导骨头是手的全部面）
#   debug：{"paint": "gloves" | "far-hands" | "lift"} 把对应的像素涂成纯色，给人看范围（不写进正式产物）
import argparse
import json
import math
import os
import struct
import sys

import bpy
import numpy as np
from mathutils.geometry import intersect_point_line


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser(prog='retint.py')
    p.add_argument('--in', dest='src', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--config', required=True, help='JSON 文件（见文件头）')
    p.add_argument('--report')
    p.add_argument('--preview', help='预览图前缀（绝对路径）：改前 / 改后的底色贴图和范围')
    p.add_argument('--quality', type=int, default=88, help='WEBP 质量（和精修导出时一样）')
    return p.parse_args(argv)


A = parse_args()
CFG = json.load(open(A.config, encoding='utf-8'))
report = {'input': A.src, 'output': A.out, 'config': CFG, 'warnings': []}


def log(msg):
    print('[retint] ' + msg)


def warn(msg):
    report['warnings'].append(msg)
    print('[retint] 警告：' + msg)


# ---------------------------------------------------------------- GLB 读写（只换一张图片的字节，其余原样）

def read_glb(path):
    data = open(path, 'rb').read()
    magic, _ver, length = struct.unpack_from('<III', data, 0)
    if magic != 0x46546C67:
        raise SystemExit(f'{path} 不是 GLB')
    off, js, binc = 12, None, b''
    while off < length:
        clen, ctype = struct.unpack_from('<II', data, off)
        off += 8
        chunk = data[off:off + clen]
        off += clen
        if ctype == 0x4E4F534A:
            js = json.loads(chunk.decode('utf-8'))
        elif ctype == 0x004E4942:
            binc = chunk
    return js, binc


def view_bytes(js, binc, vi):
    bv = js['bufferViews'][vi]
    o = bv.get('byteOffset', 0)
    return binc[o:o + bv['byteLength']]


def write_glb(path, js, binc, replace):
    """replace：{bufferView 下标: 新字节}。按下标顺序重排整个 BIN，每段 8 字节对齐，偏移重算；accessor 只引用 bufferView，不用改"""
    parts, off = [], 0
    views = js['bufferViews']
    for i, bv in enumerate(views):
        data = replace.get(i, view_bytes(js, binc, i))
        pad = (-off) % 8
        if pad:
            parts.append(b'\0' * pad)
            off += pad
        bv['byteOffset'] = off
        bv['byteLength'] = len(data)
        parts.append(data)
        off += len(data)
    newbin = b''.join(parts)
    newbin += b'\0' * ((-len(newbin)) % 4)
    js['buffers'][0]['byteLength'] = len(newbin)
    jsb = json.dumps(js, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    jsb += b' ' * ((-len(jsb)) % 4)
    total = 12 + 8 + len(jsb) + 8 + len(newbin)
    with open(path + '.tmp', 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(jsb), 0x4E4F534A) + jsb)
        f.write(struct.pack('<II', len(newbin), 0x004E4942) + newbin)
    os.replace(path + '.tmp', path)


# ---------------------------------------------------------------- 网格：按骨头分区，栅格化成贴图上的像素掩码

def load_mesh(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    sc = bpy.context.scene
    mesh = next(o for o in sc.objects if o.type == 'MESH')
    arm = next(o for o in sc.objects if o.type == 'ARMATURE')
    arm.data.pose_position = 'REST'
    return mesh, arm


def raster(mask, polys_uv, W, H):
    """把 UV 三角形（像素坐标）画进 mask（行 0 = 贴图最下面一行，和 Blender 的 pixels 一样）"""
    for pts in polys_uv:
        for t in range(1, len(pts) - 1):
            tri = pts[[0, t, t + 1]]
            x0, y0 = np.maximum(np.floor(tri.min(0)).astype(int), 0)
            x1, y1 = np.minimum(np.ceil(tri.max(0)).astype(int), [W - 1, H - 1])
            if x1 < x0 or y1 < y0:
                continue
            xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
            (ax, ay), (bx, by), (cx, cy) = tri
            d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
            if abs(d) < 1e-12:
                continue
            l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / d
            l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / d
            mask[y0:y1 + 1, x0:x1 + 1] |= (l1 >= -0.02) & (l2 >= -0.02) & (1 - l1 - l2 >= -0.02)


def regions(mesh, arm, W, H, hand_bones, max_dist):
    """返回 {'all', 'gloves', 'hands', 'far-hands', 'legs'} 各自的像素掩码，和一些统计"""
    me = mesh.data
    mw = mesh.matrix_world
    names = {g.index: g.name for g in mesh.vertex_groups}
    hand_full = {f'mixamorig:{b}' for b in hand_bones}
    seg = {}
    for b in hand_full:
        if b in arm.data.bones:
            bone = arm.data.bones[b]
            seg[b] = (arm.matrix_world @ bone.head_local, arm.matrix_world @ bone.tail_local)
    dom = []
    for v in me.vertices:
        dom.append(names.get(max(v.groups, key=lambda x: x.weight).group, '') if v.groups else '')
    far = [False] * len(me.vertices)
    for i, v in enumerate(me.vertices):
        if dom[i] in seg:
            h, t = seg[dom[i]]
            p = mw @ v.co
            q, f = intersect_point_line(p, h, t)
            f = max(0.0, min(1.0, f))
            far[i] = (p - (h + (t - h) * f)).length > max_dist
    uv = me.uv_layers.active.data
    buckets = {'all': [], 'gloves': [], 'hands': [], 'far-hands': [], 'legs': []}
    for poly in me.polygons:
        vs = [me.loops[li].vertex_index for li in poly.loop_indices]
        pts = np.array([(uv[li].uv[0] * W - 0.5, uv[li].uv[1] * H - 0.5) for li in poly.loop_indices])
        buckets['all'].append(pts)
        ds = [dom[i] for i in vs]
        if all(d in hand_full for d in ds):
            buckets['hands'].append(pts)
            if any(far[i] for i in vs):
                buckets['far-hands'].append(pts)
            else:
                buckets['gloves'].append(pts)
        elif all(any(k in d for k in ('UpLeg', 'Leg', 'Foot', 'Toe')) for d in ds):
            buckets['legs'].append(pts)
    masks = {}
    for k, polys in buckets.items():
        m = np.zeros((H, W), dtype=bool)
        raster(m, polys, W, H)
        masks[k] = m
    stats = {k: len(v) for k, v in buckets.items()}
    stats['far_vertices'] = sum(far)
    return masks, stats


# ---------------------------------------------------------------- 图片

def load_image(data, tmp_path):
    with open(tmp_path, 'wb') as f:
        f.write(data)
    img = bpy.data.images.load(tmp_path)
    img.colorspace_settings.name = 'sRGB'
    W, H = img.size
    px = np.empty(W * H * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    return img, px.reshape(H, W, 4)


def encode_webp(px, W, H, path, quality):
    img = bpy.data.images.new('retint_out', W, H, alpha=True)
    img.colorspace_settings.name = 'sRGB'
    img.pixels.foreach_set(np.clip(px, 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'WEBP'
    sc = bpy.context.scene
    sc.render.image_settings.file_format = 'WEBP'
    sc.render.image_settings.quality = quality
    sc.render.image_settings.color_mode = 'RGBA'
    img.save(filepath=path, quality=quality)
    data = open(path, 'rb').read()
    bpy.data.images.remove(img)
    return data


def save_png(px, W, H, path):
    img = bpy.data.images.new('retint_preview', W, H, alpha=True)
    img.pixels.foreach_set(np.clip(px, 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def hsv(rgb):
    mx = rgb.max(-1)
    mn = rgb.min(-1)
    sat = np.where(mx > 1e-6, (mx - mn) / np.maximum(mx, 1e-6), 0.0)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    hue = (np.degrees(np.arctan2(math.sqrt(3) * (g - b), 2 * r - g - b)) + 360) % 360
    return hue, sat, mx


def smooth(e0, e1, x):
    t = np.clip((x - e0) / max(1e-6, e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def dilate_into(px, done, free, steps):
    """把 done 里的颜色往外扩 steps 像素，只扩进 free（没有面用到的填充像素）。返回扩到的像素"""
    out = done.copy()
    for _ in range(steps):
        grown = np.zeros_like(out)
        src = np.zeros(px.shape, dtype=np.float32)
        cnt = np.zeros(out.shape, dtype=np.float32)
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh_m = np.roll(np.roll(out, dy, 0), dx, 1)
            sh_p = np.roll(np.roll(px, dy, 0), dx, 1)
            take = sh_m & ~out & free
            src[take] += sh_p[take]
            cnt[take] += 1
            grown |= take
        px[grown] = src[grown] / cnt[grown][:, None]
        out |= grown
    return out & ~done


# ---------------------------------------------------------------- 主流程

def texture_image(js, which):
    """材质里某张贴图对应的 image 下标：which = 'base'（底色）或 'mr'（金属度 / 粗糙度，glTF 的 G = 粗糙度、B = 金属度）"""
    pbr = js['materials'][0]['pbrMetallicRoughness']
    key = {'base': 'baseColorTexture', 'mr': 'metallicRoughnessTexture'}[which]
    if key not in pbr:
        return None
    t = js['textures'][pbr[key]['index']]
    return (t.get('extensions', {}).get('EXT_texture_webp', {}) or {}).get('source', t.get('source'))


def open_visitor(path, tag, bones, max_dist):
    """读一个访客 GLB：底色 / ORM 两张图的像素，和各自分辨率下的分区掩码"""
    js, binc = read_glb(path)
    mesh, arm = load_mesh(path)  # 会清空场景：先读网格，再读图片
    out = {'js': js, 'bin': binc, 'img': {}, 'px': {}, 'masks': {}}
    for which in ('base', 'mr'):
        ii = texture_image(js, which)
        if ii is None:
            continue
        meta = js['images'][ii]
        ext = 'webp' if meta.get('mimeType') == 'image/webp' else 'png'
        _img, px = load_image(view_bytes(js, binc, meta['bufferView']), os.path.join(tmp_dir, f'_retint_{tag}_{which}.{ext}'))
        H, W = px.shape[:2]
        masks, stats = regions(mesh, arm, W, H, bones, max_dist)
        out['img'][which] = meta
        out['px'][which] = px
        out['masks'][which] = masks
        out['stats'] = stats
    return out


tmp_dir = os.path.dirname(A.out)
os.makedirs(tmp_dir, exist_ok=True)
gl = CFG.get('gloves') or {}
bones = gl.get('bones', ['LeftHand', 'RightHand'])
max_dist = float(gl.get('maxDist', 0.15))
debug = (CFG.get('debug') or {}).get('paint')

me_ = open_visitor(A.src, 'in', bones, max_dist)
px = me_['px']['base']
H, W = px.shape[:2]
masks = me_['masks']['base']
orig = px.copy()
report['faces'] = me_['stats']
report['texels'] = {k: int(m.sum()) for k, m in masks.items()}
log(f'底色贴图 {W}×{H}；面：{me_["stats"]}；离手骨超过 {max_dist} 米却跟着手的顶点 {me_["stats"]["far_vertices"]} 个（不算手套）')
changed = np.zeros((H, W), dtype=bool)
mr_changed = None

if gl:
    ref = gl.get('reference')
    if not ref or not os.path.exists(ref):
        raise SystemExit(f'gloves.reference 找不到：{ref}')
    rf = open_visitor(ref, 'ref', bones, max_dist)
    rm = rf['masks']['base']['gloves']
    ref_rgb = np.median(rf['px']['base'][rm][:, :3], axis=0)
    rep = {'file': ref, 'texels': int(rm.sum()), 'median_rgb': [round(float(x), 4) for x in ref_rgb]}
    ref_mr = None
    if gl.get('material', True) and 'mr' in rf['px'] and 'mr' in me_['px']:
        rmm = rf['masks']['mr']['gloves']
        ref_mr = np.median(rf['px']['mr'][rmm][:, 1:3], axis=0)  # G 粗糙度、B 金属度
        rep['median_roughness_metallic'] = [round(float(x), 4) for x in ref_mr]
    report['glove_reference'] = rep
    m = masks['gloves']
    before = px[m][:, :3]
    report['gloves_before'] = {'median_rgb': [round(float(x), 4) for x in np.median(before, 0)], 'dark_share': round(float((before.max(-1) < 0.35).mean()), 3)}
    if 'mr' in me_['px']:
        mm = me_['masks']['mr']['gloves']
        report['gloves_before']['median_roughness_metallic'] = [round(float(x), 4) for x in np.median(me_['px']['mr'][mm][:, 1:3], 0)]
    if debug == 'gloves':
        px[m, :3] = (1, 0, 0)
    elif debug == 'far-hands':
        px[masks['far-hands'], :3] = (1, 0, 1)
    elif not debug:
        # 颜色：手套是中性灰，原来的色偏、暗块都换成参考颜色；比参考明显亮的像素（掌心的小星星）保留原样
        rgb = px[m][:, :3]
        keep = rgb.max(-1) > float(ref_rgb.max()) + 0.08
        px[m, :3] = np.where(keep[:, None], rgb, ref_rgb[None, :])
        spread = dilate_into(px, m, ~masks['all'], int(gl.get('dilate', 6)))
        changed |= m | spread
        report['gloves_after'] = {'median_rgb': [round(float(x), 4) for x in np.median(px[m][:, :3], 0)], 'dilated_texels': int(spread.sum())}
        log(f'手套颜色：{int(m.sum())} 个像素换成 {tuple(round(float(x), 3) for x in ref_rgb)}（参考 {os.path.basename(ref)}），外扩 {int(spread.sum())} 个填充像素')
        # 材质：粗糙度、金属度照参考手套的中位数（AO 不动）。游戏里没有环境贴图，金属度接近 1 的手套只剩高光，看着是黑的
        if ref_mr is not None:
            mpx = me_['px']['mr']
            mmask = me_['masks']['mr']
            mm = mmask['gloves']
            mpx[mm, 1] = ref_mr[0]
            mpx[mm, 2] = ref_mr[1]
            mspread = dilate_into(mpx, mm, ~mmask['all'], max(1, int(gl.get('dilate', 6)) // 2))
            mr_changed = int((mm | mspread).sum())
            report['gloves_after']['roughness_metallic'] = [round(float(x), 4) for x in ref_mr]
            log(f'手套材质：{int(mm.sum())} 个像素的粗糙度 / 金属度换成 {tuple(round(float(x), 3) for x in ref_mr)}')

for i, rule in enumerate([] if debug in ('gloves', 'far-hands') else (CFG.get('lift') or [])):
    hue, sat, val = hsv(px[..., :3])
    h0, h1 = rule.get('hue', [0, 360])
    feather = 10.0
    if h0 <= h1:
        hw = smooth(h0 - feather, h0, hue) * (1 - smooth(h1, h1 + feather, hue))
    else:
        hw = np.maximum(smooth(h0 - feather, h0, hue), 1 - smooth(h1, h1 + feather, hue))
    s0, s1 = rule.get('sat', [0.15, 0.3])
    v0, v1 = rule.get('value', [0.3, 0.45])
    w = hw * smooth(s0, s1, sat) * (1 - smooth(v0, v1, val))
    for ex in rule.get('exclude', []):
        if ex in masks:
            w = np.where(masks[ex], 0.0, w)
    if debug == 'lift':
        px[w > 0.5, :3] = (0, 1, 0)
        continue
    gain = float(rule.get('gain', 1.5))
    factor = 1 + (gain - 1) * w
    px[..., :3] = px[..., :3] * factor[..., None]
    sel = w > 0.02
    changed |= sel
    report.setdefault('lift', []).append({'rule': rule, 'texels': int(sel.sum()), 'full_texels': int((w > 0.98).sum()),
                                          'value_before_p50': round(float(np.median(val[sel])), 4) if sel.any() else None,
                                          'value_after_p50': round(float(np.median(val[sel] * factor[sel])), 4) if sel.any() else None})
    log(f'提亮第 {i + 1} 条：{int(sel.sum())} 个像素（全量 {int((w > 0.98).sum())}），明度最多 × {gain}（色相、饱和度不变）')

report['changed_texels'] = int(changed.sum())
replace = {me_['img']['base']['bufferView']: encode_webp(px, W, H, os.path.join(tmp_dir, '_retint_out_base.webp'), A.quality)}
if mr_changed:
    mH, mW = me_['px']['mr'].shape[:2]
    replace[me_['img']['mr']['bufferView']] = encode_webp(me_['px']['mr'], mW, mH, os.path.join(tmp_dir, '_retint_out_mr.webp'), A.quality)
    report['changed_texels_mr'] = mr_changed
write_glb(A.out, me_['js'], me_['bin'], replace)
for f in os.listdir(tmp_dir):
    if f.startswith('_retint_'):
        try:
            os.remove(os.path.join(tmp_dir, f))
        except OSError:
            pass
report['bytes'] = {'in': os.path.getsize(A.src), 'out': os.path.getsize(A.out)}
if A.preview:
    os.makedirs(os.path.dirname(A.preview), exist_ok=True)
    save_png(orig, W, H, A.preview + '-before.png')
    save_png(px, W, H, A.preview + '-after.png')
    vis = np.zeros((H, W, 4), dtype=np.float32)
    vis[..., 3] = 1
    vis[masks['all'], :3] = 0.15
    vis[changed, 1] = 0.8
    vis[masks['gloves'], :3] = (1, 0.25, 0.25)
    vis[masks['far-hands'], :3] = (1, 0, 1)
    save_png(vis, W, H, A.preview + '-mask.png')
    report['previews'] = [A.preview + s for s in ('-before.png', '-after.png', '-mask.png')]
if A.report:
    with open(A.report, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
log(f'写出 {A.out}（底色改了 {int(changed.sum())} 个像素{f"，ORM 改了 {mr_changed} 个" if mr_changed else ""}）')
