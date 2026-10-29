# 主角鬼魂的模型清理（路 G，2026-10-29）：Tripo 图生模型的原始 GLB → 游戏用的 public/assets/ghost/ghost.glb。
# 路径一律绝对路径（Blender 的工作目录不是项目根，相对的输出路径会写到 C:\ 下面）；scripts/tripo/ghost.mjs --cleanup 会拼好：
#   blender -b --factory-startup --python-exit-code 1 -P ghost_cleanup.py -- --in <model.glb> --out <ghost.glb>
#           [--report r.json] [--preview 前缀] [--max-tris 8000] [其余参数见 parse()]
# 步骤（坐标都是导入后的 Blender 坐标，z 朝上；Tripo 把模型归一到高 1、包围盒居中，下面兜帽的参数都按这个坐标量的）：
#  1. 导入、合并重复点，合成一个网格，归一到高 1、包围盒居中
#  2. 兜帽：Tripo 在兜帽里长了一张光溜溜的「脸」（凸出来的椭圆面，几乎和帽檐齐平）。把这块面的顶点往后推成一个深碗：
#     脸的轮廓（y、z 方向的椭圆）以内、x 在 hood-xmin 以前的顶点，往 −x 推 hood-depth ×（1 − r²）^0.75（r 是到椭圆中心的
#     归一化距离），中间最深、边上不动，帽檐在椭圆外面也不动。不用布尔：试过椭球差集，脸的边留下一圈，像个圆舷窗
#  3. 去地面：最下面 cut（5%）里是封住长袍底的平板和铺在地上卷起来的布条，整段切掉。长袍底留成敞口：
#     游戏里下摆那一截本来就淡出、溶开，镜头也看不到底下
#  4. 去碎块：不连着身体、面数不到 min-part 的小块删掉
#  5. 减面到 ≤ max-tris，三角化；法线朝外、平滑（清掉导入时带的自定义法线）
#  6. 遮蔽：每个顶点往法线那半边打 ao-rays 条射线，ao-dist 以内碰到东西的比例 → 0..1（1 = 敞开），映射后存成顶点属性 _occl
#     （glTF 的自定义属性，three 读成 geometry 的 _occl）。游戏里鬼魂的材质按它压暗：兜帽洞里、褶子深处暗下去，
#     洞就读成一团黑，不是一张脸
#  7. 转到游戏的朝向（Tripo 默认朝 +x 导出，游戏的正面是 glTF 的 +z = Blender 的 −y），x / y 居中、底在 0
#  8. 雾晕外扩的方向：平时的鬼魂外面那层雾晕沿法线外扩 6.5 厘米，这个模型褶子、帽檐的折角多，沿法线外扩的面会自己折叠，
#     出一道道亮条（2026-10-29 实测）。把顶点法线和相邻顶点反复平均 inflate-smooth 次，得到一个很平滑的方向，存成 _inflate
#     （glTF 的坐标：y 朝上）；游戏里雾晕沿它外扩，程序化的人形没有这个属性就还是沿法线
#  9. 导出 GLB（只有 position、normal、_occl、_inflate；不要 UV、材质）；报告（JSON）和预览图
# Blender 是 GPL 软件，这里只把它当离线工具跑，产物（GLB）不受影响；游戏里不打包任何 Blender 的代码
import argparse
import json
import math
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree


def parse():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser(prog='ghost_cleanup.py')
    p.add_argument('--in', dest='src', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--report')
    p.add_argument('--preview', help='预览图的前缀（绝对路径），出 <前缀>-<视角>.png')
    p.add_argument('--max-tris', type=int, default=8000)
    p.add_argument('--front', default='+x', choices=['+x', '-x', '+y', '-y'], help='导入后模型的正面朝哪')
    p.add_argument('--cut', type=float, default=0.05, help='最下面这么高（身高比例）整段切掉')
    p.add_argument('--min-part', type=float, default=0.01, help='面数不到总数这个比例的不连着的小块删掉')
    # 兜帽里的脸：按 2026-10-29 这个模型从正面打射线量的深度图、正面特写定的：脸那块椭圆面中心 y 0.0085、z 0.396，
    # 半径约 0.028 × 0.031，最前面 x 约 0.105；帽檐在 x 0.11–0.14（椭圆外面）；后脑勺在 x −0.05 左右
    p.add_argument('--hood', default='0.0085,0.396', help='脸那块椭圆面的中心 y,z')
    p.add_argument('--hood-radii', default='0.028,0.031', help='椭圆的半径 y,z')
    p.add_argument('--hood-depth', type=float, default=0.075, help='中间往后推多少')
    p.add_argument('--hood-xmin', type=float, default=0.06, help='只推 x 比这个大的顶点（脸那一层，不碰后脑勺）')
    p.add_argument('--no-hood', action='store_true', help='不推（对比用）')
    p.add_argument('--ao-rays', type=int, default=96)
    p.add_argument('--ao-dist', type=float, default=0.12, help='遮蔽只看这么远（身高比例）')
    p.add_argument('--ao-range', default='0.35,0.92', help='遮蔽值在这之间映射到 0..1（以下全黑、以上不压）')
    p.add_argument('--inflate-smooth', type=int, default=40, help='雾晕外扩方向：顶点法线和相邻顶点平均几次')
    return p.parse_args(argv)


A = parse()
REPORT = {'src': A.src, 'out': A.out, 'args': {k: v for k, v in vars(A).items() if k not in ('src', 'out')}}


def log(s):
    print(f'[ghost] {s}', flush=True)


def floats(s):
    return [float(x) for x in s.split(',')]


def ops_kwargs(op, want):
    """只传这个版本的算子认的参数和取值（不同版本的导入 / 导出器选项不一样）"""
    props = op.get_rna_type().properties
    kw = {}
    for k, v in want.items():
        if k not in props.keys():
            continue
        p = props[k]
        if p.type == 'ENUM' and not p.is_enum_flag and v not in [i.identifier for i in p.enum_items]:
            continue
        kw[k] = v
    skipped = sorted(set(want) - set(kw))
    if skipped:
        log(f'这个版本的 {op.idname()} 没有这些选项，跳过：{skipped}')
    return kw


def edit_bm(ob, fn):
    """在 bmesh 里改网格：fn(bm) 的返回值原样返回"""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    r = fn(bm)
    bm.to_mesh(ob.data)
    bm.free()
    ob.data.update()
    return r


def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


def components(bm):
    """按边连着的面分块：返回 [[面, …], …]，大的在前"""
    bm.faces.index_update()
    bm.faces.ensure_lookup_table()
    seen = set()
    out = []
    for f in bm.faces:
        if f.index in seen:
            continue
        seen.add(f.index)
        stack, comp = [f], []
        while stack:
            g = stack.pop()
            comp.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        out.append(comp)
    out.sort(key=len, reverse=True)
    return out


def front_depth(ob, y, z):
    """从正面（+x 往 −x）打一条射线，第一个碰到的 x：量兜帽里的脸（或洞底）在哪"""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    tree = BVHTree.FromBMesh(bm)
    bm.free()
    hit = tree.ray_cast(Vector((2.0, y, z)), Vector((-1.0, 0.0, 0.0)))
    return round(hit[0].x, 4) if hit[0] else None


# ---------------------------------------------------------------- 1. 导入、合成一个网格

for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.import_scene.gltf(**ops_kwargs(bpy.ops.import_scene.gltf, dict(filepath=A.src, merge_vertices=True)))
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH']
if not meshes:
    raise SystemExit('GLB 里没有网格')
for o in meshes:
    mw = o.matrix_world.copy()
    o.parent = None
    o.matrix_world = mw
bpy.ops.object.select_all(action='DESELECT')
for o in meshes:
    o.select_set(True)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
ob = bpy.context.view_layer.objects.active
ob.name = 'ghost'
for o in [o for o in bpy.context.scene.objects if o is not ob]:
    bpy.data.objects.remove(o, do_unlink=True)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
REPORT['meshes_in'] = len(meshes)
REPORT['tris_in'] = tri_count(ob)


def normalize(bm):
    """归一到高 1、包围盒居中（Tripo 本来就是这样；别的来源的模型也按这个坐标套兜帽参数）。返回缩放和开口边的条数"""
    lo = Vector((min(v.co.x for v in bm.verts), min(v.co.y for v in bm.verts), min(v.co.z for v in bm.verts)))
    hi = Vector((max(v.co.x for v in bm.verts), max(v.co.y for v in bm.verts), max(v.co.z for v in bm.verts)))
    k = 1.0 / max(hi.z - lo.z, 1e-9)
    c = (lo + hi) / 2
    for v in bm.verts:
        v.co = (v.co - c) * k
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    return {'scale': round(k, 6), 'boundary_edges': sum(1 for e in bm.edges if e.is_boundary)}


REPORT['normalize'] = edit_bm(ob, normalize)
log(f"导入：{REPORT['meshes_in']} 个网格、{REPORT['tris_in']} 三角面；开口边 {REPORT['normalize']['boundary_edges']} 条")

# ---------------------------------------------------------------- 2. 兜帽：把脸推成深碗

hy, hz = floats(A.hood)
ry, rz = floats(A.hood_radii)
REPORT['hood_depth_before'] = front_depth(ob, hy, hz)


def push_face(bm):
    moved = 0
    for v in bm.verts:
        if v.co.x <= A.hood_xmin:
            continue
        r2 = ((v.co.y - hy) / ry) ** 2 + ((v.co.z - hz) / rz) ** 2
        if r2 >= 1:
            continue
        v.co.x -= A.hood_depth * (1 - r2) ** 0.75
        moved += 1
    return moved


if not A.no_hood:
    REPORT['hood_moved_verts'] = edit_bm(ob, push_face)
REPORT['hood_depth_after'] = front_depth(ob, hy, hz)
log(f"兜帽：推了 {REPORT.get('hood_moved_verts', 0)} 个顶点；正面看脸中间的深度 x {REPORT['hood_depth_before']} → {REPORT['hood_depth_after']}")

# ---------------------------------------------------------------- 3、4. 切掉最下面一截（地面）、去碎块


def cut_and_clean(bm):
    zc = -0.5 + A.cut
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, zc), plane_no=(0, 0, 1), clear_inner=True)
    comps = components(bm)
    total = sum(len(c) for c in comps)
    drop = [c for c in comps[1:] if len(c) < A.min_part * total]
    keep_extra = [len(c) for c in comps[1:] if len(c) >= A.min_part * total]
    bmesh.ops.delete(bm, geom=[f for c in drop for f in c], context='FACES')
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    return {'cut_z': round(zc, 4), 'parts_after_cut': len(comps), 'fragments_removed': len(drop),
            'fragment_faces': sum(len(c) for c in drop), 'other_big_parts': keep_extra}


REPORT['cut'] = edit_bm(ob, cut_and_clean)
log(f"去地面：切掉 z < {REPORT['cut']['cut_z']}；之后 {REPORT['cut']['parts_after_cut']} 块，删掉碎块 {REPORT['cut']['fragments_removed']} 个"
    f"（{REPORT['cut']['fragment_faces']} 面），另外留下的大块 {REPORT['cut']['other_big_parts']}")

# ---------------------------------------------------------------- 5. 减面、三角化、法线


def triangulate(bm):
    bmesh.ops.triangulate(bm, faces=bm.faces[:])


edit_bm(ob, triangulate)
REPORT['tris_before_decimate'] = tri_count(ob)
for attempt in range(4):
    n = tri_count(ob)
    if n <= A.max_tris:
        break
    mod = ob.modifiers.new('decimate', 'DECIMATE')
    mod.decimate_type = 'COLLAPSE'
    mod.ratio = (A.max_tris * (0.97 - 0.02 * attempt)) / n
    if hasattr(mod, 'use_collapse_triangulate'):
        mod.use_collapse_triangulate = True
    bpy.ops.object.modifier_apply(modifier=mod.name)
    edit_bm(ob, triangulate)
REPORT['tris_out'] = tri_count(ob)
if REPORT['tris_out'] > A.max_tris:
    raise SystemExit(f"减面后还有 {REPORT['tris_out']} 三角面，超过 {A.max_tris}")


def fix_normals(bm):
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    # 朝外的检查：面中心到身体中轴（同高度的那一圈的中心）的方向 · 面法线，按面积加权（开口的网格算不了体积，用这个代替）
    bm.normal_update()
    out_area = in_area = 0.0
    for f in bm.faces:
        c = f.calc_center_median()
        d = Vector((c.x, c.y, 0.0))
        a = f.calc_area()
        if d.length < 1e-6:
            continue
        if d.normalized().dot(f.normal) >= 0:
            out_area += a
        else:
            in_area += a
    return {'outward_area_share': round(out_area / max(out_area + in_area, 1e-9), 3)}


REPORT['normals'] = edit_bm(ob, fix_normals)
if ob.data.has_custom_normals:
    bpy.ops.mesh.customdata_custom_splitnormals_clear()
ob.data.shade_smooth()
log(f"减面：{REPORT['tris_before_decimate']} → {REPORT['tris_out']} 三角面；法线朝外的面积占 {REPORT['normals']['outward_area_share']}")

# ---------------------------------------------------------------- 6. 遮蔽 → _occl


def hemisphere(n):
    """n 个按余弦分布的单位向量（z 朝上的半球，固定的斐波那契螺旋，结果可重现）"""
    out = []
    ga = math.pi * (3 - math.sqrt(5))
    for i in range(n):
        u = (i + 0.5) / n
        r = math.sqrt(u)
        th = ga * i
        out.append(Vector((r * math.cos(th), r * math.sin(th), math.sqrt(max(0.0, 1 - u)))))
    return out


def bake_occlusion(bm):
    bm.normal_update()
    tree = BVHTree.FromBMesh(bm)
    dirs = hemisphere(A.ao_rays)
    lo, hi = floats(A.ao_range)
    raw = []
    for v in bm.verts:
        n = v.normal if v.normal.length > 0.5 else Vector((0, 0, 1))
        rot = n.to_track_quat('Z', 'Y').to_matrix()
        o = v.co + n * 1e-4
        hits = 0
        for d in dirs:
            if tree.ray_cast(o, rot @ d, A.ao_dist)[0] is not None:
                hits += 1
        raw.append(1.0 - hits / len(dirs))
    # 和相邻顶点平均一次（减掉射线条数有限带来的颗粒）
    bm.verts.ensure_lookup_table()
    smooth = []
    for v in bm.verts:
        nb = [e.other_vert(v).index for e in v.link_edges]
        smooth.append((raw[v.index] * 2 + sum(raw[i] for i in nb)) / (2 + len(nb)))

    def remap(x):
        t = min(1.0, max(0.0, (x - lo) / max(hi - lo, 1e-6)))
        return t * t * (3 - 2 * t)
    return [remap(x) for x in smooth]


bm = bmesh.new()
bm.from_mesh(ob.data)
bm.verts.index_update()
occl = bake_occlusion(bm)
bm.free()
attr = ob.data.attributes.new('_occl', 'FLOAT', 'POINT')
attr.data.foreach_set('value', occl)
# 预览用的一份顶点色（不导出）
pv = ob.data.color_attributes.new('occl_preview', 'BYTE_COLOR', 'POINT')
for i, x in enumerate(occl):
    pv.data[i].color = (x, x, x, 1.0)
# 兜帽碗里（推过的那块椭圆、x 在后脑勺前面）的遮蔽：应该接近 0
bowl = [occl[v.index] for v in ob.data.vertices
        if v.co.x > -0.02 and ((v.co.y - hy) / ry) ** 2 + ((v.co.z - hz) / rz) ** 2 < 0.6]
srt = sorted(occl)
REPORT['occlusion'] = {
    'bowl_verts': len(bowl), 'bowl_mean': round(sum(bowl) / max(1, len(bowl)), 3), 'bowl_max': round(max(bowl, default=0), 3),
    'min': round(srt[0], 3), 'median': round(srt[len(srt) // 2], 3), 'mean': round(sum(srt) / len(srt), 3),
    'share_below_0.5': round(sum(1 for x in srt if x < 0.5) / len(srt), 3),
}
log(f"遮蔽：最小 {REPORT['occlusion']['min']}、中位 {REPORT['occlusion']['median']}、低于 0.5 的顶点占 {REPORT['occlusion']['share_below_0.5']}；"
    f"兜帽碗里 {REPORT['occlusion']['bowl_verts']} 个顶点，平均 {REPORT['occlusion']['bowl_mean']}、最大 {REPORT['occlusion']['bowl_max']}")

# ---------------------------------------------------------------- 7. 朝向、居中

yaw = {'+x': -math.pi / 2, '-x': math.pi / 2, '+y': math.pi, '-y': 0.0}[A.front]
ob.data.transform(Matrix.Rotation(yaw, 4, 'Z'))
vs = [v.co for v in ob.data.vertices]
lo = Vector((min(v.x for v in vs), min(v.y for v in vs), min(v.z for v in vs)))
hi = Vector((max(v.x for v in vs), max(v.y for v in vs), max(v.z for v in vs)))
ob.data.transform(Matrix.Translation(Vector((-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z))))
ob.data.update()
REPORT['size'] = [round(hi.x - lo.x, 4), round(hi.y - lo.y, 4), round(hi.z - lo.z, 4)]
# 身体中轴（身高 20%–70% 那一段的中心）离包围盒中心多远：游戏按包围盒居中，下摆歪的话中轴会偏
mid = [v.co for v in ob.data.vertices if 0.2 * (hi.z - lo.z) < v.co.z < 0.7 * (hi.z - lo.z)]
ax = (sum((v.x for v in mid)) / len(mid), sum((v.y for v in mid)) / len(mid))
REPORT['axis_offset'] = [round(ax[0], 4), round(ax[1], 4)]
log(f"朝向：正面 {A.front} → glTF +z；大小（Blender x, y, z）{REPORT['size']}；身体中轴离中心 {REPORT['axis_offset']}")

# ---------------------------------------------------------------- 8. 雾晕外扩的方向 → _inflate


def smooth_normals(me, iters):
    me.update()
    n = [Vector(v.normal) for v in me.vertices]
    nb = [[] for _ in me.vertices]
    for e in me.edges:
        a, b = e.vertices
        nb[a].append(b)
        nb[b].append(a)
    for _ in range(iters):
        nxt = []
        for i, ns in enumerate(nb):
            acc = n[i] * 2
            for j in ns:
                acc += n[j]
            nxt.append(acc.normalized() if acc.length > 1e-9 else n[i])
        n = nxt
    return n


inf = smooth_normals(ob.data, A.inflate_smooth)
# 存成 glTF 的坐标（y 朝上）：导出器只换算 position、normal，自定义属性原样写出去（导出后由 ghost.mjs 对着 NORMAL 查一遍）
flat = []
for v in inf:
    flat += [v.x, v.z, -v.y]
ia = ob.data.attributes.new('_inflate', 'FLOAT_VECTOR', 'POINT')
ia.data.foreach_set('vector', flat)
REPORT['inflate'] = {'iterations': A.inflate_smooth, 'mean_dot_with_normal': round(sum(a.dot(Vector(v.normal)) for a, v in zip(inf, ob.data.vertices)) / len(inf), 3)}
log(f"雾晕外扩方向：平均 {A.inflate_smooth} 次，和顶点法线的平均夹角余弦 {REPORT['inflate']['mean_dot_with_normal']}")

# ---------------------------------------------------------------- 9. 导出、报告、预览

ob.data.materials.clear()
for uv in list(ob.data.uv_layers):
    ob.data.uv_layers.remove(uv)
bpy.ops.object.select_all(action='DESELECT')
ob.select_set(True)
bpy.context.view_layer.objects.active = ob
bpy.ops.export_scene.gltf(**ops_kwargs(bpy.ops.export_scene.gltf, dict(
    filepath=A.out, export_format='GLB', use_selection=True, export_yup=True, export_apply=True,
    export_texcoords=False, export_normals=True, export_tangents=False, export_materials='NONE',
    export_vertex_color='NONE', export_all_vertex_colors=False, export_attributes=True,
    export_animations=False, export_skins=False, export_morph=False, export_cameras=False, export_lights=False,
    export_extras=False,
)))
log(f"导出 {A.out}：{REPORT['tris_out']} 三角面")


def render_previews(prefix):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.render.resolution_x = sc.render.resolution_y = 480
    if not sc.world:
        sc.world = bpy.data.worlds.new('pv')
    sc.world.color = (0.82, 0.82, 0.84)
    cam = bpy.data.objects.new('pv', bpy.data.cameras.new('pv'))
    cam.data.type = 'ORTHO'
    sc.collection.objects.link(cam)
    sc.camera = cam
    h = REPORT['size'][2]
    body = Vector((0, 0, h / 2))
    head = Vector((0, -0.05, h * 0.88))
    files = []
    # 游戏的正面 = Blender 的 −y
    shots = [
        ('front', body, Vector((0, -1, 0.12)), h * 1.15, 'MATERIAL'),
        ('side', body, Vector((1, 0, 0.12)), h * 1.15, 'MATERIAL'),
        ('back', body, Vector((0, 1, 0.12)), h * 1.15, 'MATERIAL'),
        ('head', head, Vector((0, -1, 0.05)), h * 0.32, 'MATERIAL'),
        ('head-occl', head, Vector((0, -1, 0.05)), h * 0.32, 'VERTEX'),
        ('occl', body, Vector((0, -1, 0.12)), h * 1.15, 'VERTEX'),
    ]
    ob.data.color_attributes.active_color = ob.data.color_attributes['occl_preview']
    for name, c, d, scale, color in shots:
        sc.display.shading.color_type = color
        # 遮蔽图不打光（FLAT）：看到的就是 _occl 本身
        sc.display.shading.light = 'FLAT' if color == 'VERTEX' else 'STUDIO'
        cam.data.ortho_scale = scale
        cam.location = c + d.normalized() * 4
        cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
        sc.render.filepath = f'{prefix}-{name}.png'
        bpy.ops.render.render(write_still=True)
        files.append(sc.render.filepath)
    return files


if A.preview:
    REPORT['previews'] = render_previews(A.preview)
if A.report:
    with open(A.report, 'w', encoding='utf-8') as fh:
        json.dump(REPORT, fh, ensure_ascii=False, indent=2)
log('完成')
