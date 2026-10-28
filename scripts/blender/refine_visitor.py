# 访客 GLB 精修（Blender 5.2 无头运行，由 scripts/blender/refine.mjs 调用）。
#
# Tripo 自动绑骨是按人形来的：翠宝是个球，球身下半截会被分给大腿骨，走路时球底跟着腿变形；
# 挂在腿边的配件（提灯、披风下摆、流苏）也跟着腿拉伸。这里把权重重新分一遍：
#   - 球身、帽子、领子、披风这些「身上的东西」整块跟着肩膀所在的那节脊柱骨（默认 Spine2）走，不再变形
#   - 只有贴着腿骨、臂骨的那一圈（腿、手臂、手、鞋）保留原来的权重；交界处平滑过渡
# 另外：删掉零碎的小面片、超出预算时减面、贴图限到 2048、去掉动作里的水平位移（原地动画），
# 导出 GLB；可选出预览图（各动作若干帧 × 正面 / 侧面 / 背面，和一张按分类上色的权重图）。
#
#   blender -b --factory-startup -P refine_visitor.py -- --in in.glb --out out.glb [--report r.json] [--preview 前缀]
#
# 只用 Blender 自带的 bpy / bmesh / mathutils，不依赖第三方包。
import argparse
import json
import math
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    p = argparse.ArgumentParser(prog='refine_visitor.py')
    p.add_argument('--in', dest='src', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--report')
    p.add_argument('--preview', help='预览图路径前缀（绝对路径），不给就不渲染')
    p.add_argument('--max-tris', type=int, default=15000)
    p.add_argument('--max-texture', type=int, default=2048)
    p.add_argument('--body-bone', default='auto', help='身体整块跟着的骨头；auto = 手臂分出去的那节脊柱骨')
    p.add_argument('--limb-scale', type=float, default=1.35, help='腿 / 手臂的「管子」半径放大多少倍以内算肢体')
    p.add_argument('--blend', type=float, default=0.6, help='肢体到身体的过渡宽度（相对管子半径）')
    p.add_argument('--spine-damp', type=float, default=1.0, help='脊柱各节转动保留多少（1 = 不改，0.5 = 减半）')
    p.add_argument('--no-reweight', action='store_true')
    p.add_argument('--min-island', type=float, default=0.002, help='面数少于总数这个比例的孤立碎片删掉')
    return p.parse_args(argv)


A = parse_args()
report = {'input': A.src, 'output': A.out, 'warnings': []}


def warn(msg):
    report['warnings'].append(msg)
    print('[refine] 警告：' + msg)


def log(msg):
    print('[refine] ' + msg)


# ---------------------------------------------------------------- 导入

bpy.ops.wm.read_factory_settings(use_empty=True)
# 导入时按场景帧率把秒换成帧，导出时按整帧重新采样：设成 30（Tripo / Mixamo 的动作都是 30 帧）关键帧正好落在整帧上
bpy.context.scene.render.fps = 30
# merge_vertices：glTF 在贴图接缝处把顶点拆开了，不合回来的话每块 UV 岛都是一块「孤立碎片」，下面清理碎片时会被误删。
# disable_bone_shape：导入器默认给骨头建一个显示用的球（也是网格物体），会被当成模型的一部分算面数、拟合球身
imp = bpy.ops.import_scene.gltf.get_rna_type().properties.keys()
bpy.ops.import_scene.gltf(filepath=A.src, merge_vertices=True, **({'disable_bone_shape': True} if 'disable_bone_shape' in imp else {}))
# 片段长度不是整帧时，导出按整帧采样会把最后不到一帧截掉，循环接缝处跳一下：把动作的帧范围向外取整
for act in bpy.data.actions:
    f0, f1 = act.frame_range
    if f0 != math.floor(f0) or f1 != math.ceil(f1):
        act.use_frame_range = True
        act.frame_start, act.frame_end = math.floor(f0), math.ceil(f1)
arm = next((o for o in bpy.context.scene.objects if o.type == 'ARMATURE'), None)
# 骨头的显示形状（老版本导入器没有 disable_bone_shape 时）不算模型
shapes = {pb.custom_shape for pb in arm.pose.bones if pb.custom_shape} if arm else set()
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o not in shapes]
if not meshes:
    raise SystemExit('[refine] GLB 里没有网格')
report['meshes'] = [o.name for o in meshes]
report['actions'] = {a.name: [round(a.frame_range[0]), round(a.frame_range[1])] for a in bpy.data.actions}


def tri_count():
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in meshes)


report['tris_before'] = tri_count()
log(f'导入：{len(meshes)} 个网格，{report["tris_before"]} 三角面，骨架 {arm.name if arm else "无"}，动作 {list(report["actions"])}')

# ---------------------------------------------------------------- 骨架结构：脊柱、腿、手臂（按层级和朝向认，不靠骨头名字）


def bone_world(b):
    mw = arm.matrix_world
    return mw @ b.head_local, mw @ b.tail_local


def descendants(b):
    out = []
    stack = list(b.children)
    while stack:
        c = stack.pop()
        out.append(c)
        stack.extend(c.children)
    return out


def analyse_skeleton():
    bones = arm.data.bones
    size = max(arm.dimensions) or 1.0
    # 根（hips）：层级最浅、又至少分出 3 根子骨头的那个（Hips → 脊柱 + 两条腿；手有 5 根手指，但层级深）。
    # 有的骨架在 Hips 上面还套一层空的根骨头，所以不直接取没有父骨头的那个
    hips = min((b for b in bones if len(b.children) >= 3), key=lambda b: len(b.parent_recursive), default=None)
    if not hips:
        return None
    cx = bone_world(hips)[0].x
    # 脊柱：从 hips 起，每次走向「头最高、又最靠中线」的子骨头（看骨头头部的位置，不看尾巴：导入时尾巴是猜的）
    spine = [hips]
    cur = hips
    while cur.children:
        z0 = bone_world(cur)[0].z
        nxt = max(cur.children, key=lambda c: bone_world(c)[0].z - 2 * abs(bone_world(c)[0].x - cx))
        if bone_world(nxt)[0].z <= z0 + 1e-4 or abs(bone_world(nxt)[0].x - cx) > 0.08 * size:
            break
        spine.append(nxt)
        cur = nxt
    spine_set = set(b.name for b in spine)
    hz = bone_world(hips)[0].z
    legs, arms = [], []
    for s in spine:
        for c in s.children:
            if c.name in spine_set:
                continue
            chain = [c] + descendants(c)
            pts = [p for b in chain for p in bone_world(b)]
            lowest = min(p.z for p in pts)
            side = max(abs(p.x - cx) for p in pts)
            if lowest < hz - 0.05 * size:
                legs.append(chain)
            elif side > 0.15 * size:
                arms.append((s, chain))
    return hips, spine, legs, arms


EFFECTOR = ('hand', 'finger', 'thumb', 'index', 'middle', 'ring', 'pinky', 'foot', 'toe')


def effectors(chain, kind):
    """链上的「末端」：手（含手指）、脚（含脚趾、鞋）。按名字认，名字认不出就按层级：腿从第 3 节起，手臂从第 3 节（没有锁骨）或第 4 节起"""
    named = [b.name for b in chain if any(k in b.name.lower() for k in EFFECTOR)]
    if named:
        return set(named)
    base = len(chain[0].parent_recursive)
    depth = {b.name: len(b.parent_recursive) - base for b in chain}
    has_clavicle = kind == 'arm' and len([b for b in chain if depth[b.name] == 0]) == 1 and any('shoulder' in b.name.lower() or 'clavicle' in b.name.lower() for b in chain)
    cut = 2 if kind == 'leg' else (3 if has_clavicle else 2)
    return {n for n, d in depth.items() if d >= cut}


skel = None
if arm and not A.no_reweight:
    found = analyse_skeleton()
    hips, spine, legs, arms_ = found if found else (None, [], [], [])
    if len(legs) < 2 or len(arms_) < 2:
        warn(f'骨架认不全（腿 {len(legs)} 条、手臂 {len(arms_)} 条），不重分权重')
    else:
        body_bone = None
        if A.body_bone != 'auto':
            body_bone = next((b for b in arm.data.bones if b.name == A.body_bone or b.name.endswith(':' + A.body_bone) or b.name.endswith(A.body_bone)), None)
            if not body_bone:
                warn(f'找不到 --body-bone {A.body_bone}，改用自动')
        if not body_bone:
            # 手臂从哪节脊柱分出去，身体就跟那节走（肩膀和球身一起动，手臂根部不会在球面上滑）
            parents = [s for s, _ in arms_]
            body_bone = max(parents, key=lambda s: spine.index(s))
        skel = {
            'hips': hips.name,
            'spine': [b.name for b in spine],
            'body': body_bone.name,
            'legs': [[b.name for b in ch] for ch in legs],
            'arms': [[b.name for b in ch] for _, ch in arms_],
            'effectors': sorted(set().union(*(effectors(ch, 'leg') for ch in legs), *(effectors(ch, 'arm') for _, ch in arms_))),
        }
        report['skeleton'] = skel
        log(f'骨架：hips={hips.name}，脊柱 {len(spine)} 节，身体跟着 {body_bone.name}，腿 {[len(c) for c in legs]}，手臂 {[len(c) for _, c in arms_]}')

# ---------------------------------------------------------------- 球身拟合（RANSAC：随机四点定球，数贴着球面的点）


def fit_sphere(pts, tol, iters=400):
    best, best_n = None, -1
    rnd = random.Random(7)
    for _ in range(iters):
        s = rnd.sample(pts, 4)
        sol = sphere_from4(*s)
        if not sol:
            continue
        c, r = sol
        n = sum(1 for p in pts if abs((p - c).length - r) < tol)
        if n > best_n:
            best, best_n = (c, r), n
    if not best:
        return None
    # 用内点做一次最小二乘精修
    c, r = best
    inl = [p for p in pts if abs((p - c).length - r) < tol]
    return lsq_sphere(inl) or best, len(inl)


def sphere_from4(a, b, c, d):
    m = Matrix((tuple(b - a), tuple(c - a), tuple(d - a)))
    if abs(m.determinant()) < 1e-12:
        return None
    rhs = Vector(((b.length_squared - a.length_squared) / 2, (c.length_squared - a.length_squared) / 2, (d.length_squared - a.length_squared) / 2))
    ctr = m.inverted() @ rhs
    return ctr, (a - ctr).length


def lsq_sphere(pts):
    # |p|² = 2c·p + k，k = r² − |c|²；解 4×4 法方程
    n = len(pts)
    if n < 8:
        return None
    ata = [[0.0] * 4 for _ in range(4)]
    atb = [0.0] * 4
    for p in pts:
        row = (2 * p.x, 2 * p.y, 2 * p.z, 1.0)
        y = p.length_squared
        for i in range(4):
            atb[i] += row[i] * y
            for j in range(4):
                ata[i][j] += row[i] * row[j]
    m = Matrix(ata)
    if abs(m.determinant()) < 1e-18:
        return None
    x = m.inverted() @ Vector(atb)
    ctr = Vector((x[0], x[1], x[2]))
    r2 = x[3] + ctr.length_squared
    return (ctr, math.sqrt(r2)) if r2 > 0 else None


def seg_dist(p, a, b):
    ab = b - a
    t = 0.0 if ab.length_squared < 1e-12 else max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
    return (p - (a + ab * t)).length


def smoothstep(e0, e1, x):
    t = max(0.0, min(1.0, (x - e0) / max(1e-9, e1 - e0)))
    return t * t * (3 - 2 * t)


# ---------------------------------------------------------------- 重分权重


def reweight(obj):
    vg_by_name = {g.name: g for g in obj.vertex_groups}
    idx_name = {g.index: g.name for g in obj.vertex_groups}
    mw = obj.matrix_world
    me = obj.data
    pos = [mw @ v.co for v in me.vertices]
    weights = [{idx_name[g.group]: g.weight for g in v.groups if g.weight > 0 and g.group in idx_name} for v in me.vertices]
    bone_seg = {b.name: bone_world(b) for b in arm.data.bones}
    limb_of = {}
    for i, ch in enumerate(skel['legs']):
        for n in ch:
            limb_of[n] = ('leg', i)
    for i, ch in enumerate(skel['arms']):
        for n in ch:
            limb_of[n] = ('arm', i)
    spine = set(skel['spine'])

    def dominant(w):
        return max(w.items(), key=lambda kv: kv[1])[0] if w else None

    # 球：主导骨头在脊柱上的点里找
    height = max(p.z for p in pos) - min(p.z for p in pos)
    sp = [pos[i] for i, w in enumerate(weights) if dominant(w) in spine]
    if len(sp) > 4000:
        sp = random.Random(3).sample(sp, 4000)
    ball = None
    if len(sp) >= 50:
        fit = fit_sphere(sp, tol=0.015 * height)
        if fit:
            (c, r), n = fit
            ball = (c, r)
            report.setdefault('ball', {})[obj.name] = {'center': [round(v, 4) for v in c], 'radius': round(r, 4), 'inliers': n, 'of': len(sp), 'height': round(height, 4)}
            log(f'{obj.name}：球心 {tuple(round(v, 3) for v in c)}，半径 {r:.3f}（{n}/{len(sp)} 个点贴着球面），模型高 {height:.3f}')
    if not ball:
        warn(f'{obj.name}：没拟合出球身，只按肢体距离分')

    # 大腿、小腿、上臂、前臂的「管子半径」：主导骨头是它、又不在球里的点，到骨段距离的 30% 分位数。
    # 用偏小的分位数：腿边挂着的配件（提灯、披风下摆）也被自动绑骨分给了大腿，它们离骨头更远，不能把半径拉大
    effector = set(skel['effectors'])
    outside = (lambda p: (p - ball[0]).length > ball[1] * 1.02) if ball else (lambda p: True)
    radius = {}
    for name in limb_of:
        if name in effector:
            continue
        a, b = bone_seg[name]
        ds = sorted(seg_dist(p, a, b) for p, w in zip(pos, weights) if dominant(w) == name and outside(p))
        if len(ds) >= 12:
            radius[name] = ds[int(len(ds) * 0.3)]
    # 骨头太短、点太少量不准的，用同一条肢体的中位数补
    for kind_i in set(limb_of.values()):
        names = [n for n, k in limb_of.items() if k == kind_i and n not in effector]
        known = sorted(radius[n] for n in names if n in radius)
        if known:
            for n in names:
                radius.setdefault(n, known[len(known) // 2])

    body = skel['body']
    if body not in vg_by_name:
        vg_by_name[body] = obj.vertex_groups.new(name=body)
    counts = {'body': 0, 'limb': 0, 'blend': 0}
    new_weights = []
    for p, w in zip(pos, weights):
        dom = dominant(w)
        kind_i = limb_of.get(dom)
        if kind_i is None:
            limbness = 0.0  # 主导骨头在脊柱上（球身、帽子、领子、背后的披风）：身体
        elif dom in effector:
            limbness = 1.0  # 手、脚（含鞋）整块跟着肢体
        elif dom in radius:
            # 大腿、上臂这些「管子」：贴着管子的是肢体，离得远的（挂在旁边的配件）算身体，中间平滑过渡
            a, b = bone_seg[dom]
            u = seg_dist(p, a, b) / max(1e-6, radius[dom])
            limbness = 1.0 - smoothstep(A.limb_scale, A.limb_scale + A.blend * 2, u)
        else:
            limbness = 1.0
        if ball:
            # 球面上、球里面的点都算身体（腿根、手臂根接在球上，交界处平滑过渡）
            limbness *= smoothstep(ball[1] * 0.98, ball[1] * 1.06, (p - ball[0]).length)
        if limbness <= 0.001:
            counts['body'] += 1
            new_weights.append({body: 1.0})
            continue
        # 肢体部分：只留这条肢体链上的权重（去掉被分到脊柱、别的肢体上的零碎）
        lw = {n: v for n, v in w.items() if limb_of.get(n) == kind_i}
        s = sum(lw.values())
        if s <= 1e-6:
            lw, s = {dom: 1.0}, 1.0
        out = {n: v / s * limbness for n, v in lw.items()}
        if limbness < 0.999:
            out[body] = out.get(body, 0) + (1 - limbness)
            counts['blend'] += 1
        else:
            counts['limb'] += 1
        new_weights.append(out)

    # 写回：清空再按新的写（只保留最大的 4 个，glTF 每顶点 4 个影响）
    for g in obj.vertex_groups:
        g.remove(range(len(me.vertices)))
    for i, w in enumerate(new_weights):
        top = sorted(w.items(), key=lambda kv: -kv[1])[:4]
        s = sum(v for _, v in top) or 1.0
        for n, v in top:
            if n not in vg_by_name:
                vg_by_name[n] = obj.vertex_groups.new(name=n)
            vg_by_name[n].add([i], v / s, 'REPLACE')
    report.setdefault('classes', {})[obj.name] = counts
    report.setdefault('limb_radius', {}).update({n: round(r, 4) for n, r in radius.items()})
    log(f'{obj.name}：身体 {counts["body"]}、肢体 {counts["limb"]}、过渡 {counts["blend"]} 个顶点')
    return new_weights


# ---------------------------------------------------------------- 网格清理：碎片、超预算减面


def remove_islands(obj):
    """删掉孤立的小碎片。连通性按顶点位置算，不按拓扑：glTF 在硬边（法线不同）处把顶点拆开了，
    merge_vertices 合不回来，按拓扑算的话一个硬边模型的每个面都是一块「碎片」"""
    me = obj.data
    size = max(obj.dimensions) or 1.0
    q = 1e5 / size  # 位置量化到模型尺寸的十万分之一
    parent = list(range(len(me.vertices)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    first = {}
    for v in me.vertices:
        key = (round(v.co.x * q), round(v.co.y * q), round(v.co.z * q))
        if key in first:
            union(v.index, first[key])
        else:
            first[key] = v.index
    for p in me.polygons:
        vs = p.vertices
        for k in range(1, len(vs)):
            union(vs[0], vs[k])
    islands = {}
    for p in me.polygons:
        islands.setdefault(find(p.vertices[0]), []).append(p.index)
    total = len(me.polygons)
    small = [isl for isl in islands.values() if len(isl) < A.min_island * total]
    if small:
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.faces.ensure_lookup_table()
        bmesh.ops.delete(bm, geom=[bm.faces[i] for isl in small for i in isl], context='FACES')
        loose = [v for v in bm.verts if not v.link_faces]
        bmesh.ops.delete(bm, geom=loose, context='VERTS')
        bm.to_mesh(me)
        bm.free()
    return len(islands), len(small), sum(len(i) for i in small)


cleanup = {}
for o in meshes:
    n, k, f = remove_islands(o)
    cleanup[o.name] = {'islands': n, 'removed_islands': k, 'removed_faces': f}
    if k:
        log(f'{o.name}：{n} 块里删掉 {k} 块碎片（{f} 个面）')
report['cleanup'] = cleanup

tris = tri_count()
if tris > A.max_tris:
    ratio = A.max_tris / tris * 0.98
    for o in meshes:
        mod = o.modifiers.new('refine_decimate', 'DECIMATE')
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o]):
            # 减面要排在骨架修改器前面才能应用（顶点组跟着插值，权重不丢）
            bpy.ops.object.modifier_move_to_index(modifier=mod.name, index=0)
            bpy.ops.object.modifier_apply(modifier=mod.name)
    log(f'减面：{tris} → {tri_count()}')
report['tris_after'] = tri_count()

# ---------------------------------------------------------------- 在清理、减面之后的网格上重分权重

reweighted = {}
if skel:
    for o in meshes:
        if any(m.type == 'ARMATURE' for m in o.modifiers):
            reweighted[o.name] = reweight(o)

# ---------------------------------------------------------------- 动作：原地 + 脊柱减幅


def fcurves_of(action):
    # Blender 4.4 起动作分「层 / 条 / 通道包」；老接口 action.fcurves 在 5.x 已经没了
    try:
        return list(action.fcurves)
    except AttributeError:
        out = []
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    out.extend(bag.fcurves)
        return out


def model_height():
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    return (max(p.z for p in pts) - min(p.z for p in pts)) or 1.0


root_fixed = []
H = model_height()
for act in bpy.data.actions:
    fcs = fcurves_of(act)
    if skel:
        hips = arm.data.bones[skel['hips']]
        hips_path = f'pose.bones["{skel["hips"]}"].location'
        # pose 的 location 在 hips 骨骼自己的静止坐标系里：换到世界里看是哪个方向、一单位多长
        basis = arm.matrix_world.to_3x3() @ hips.matrix_local.to_3x3()
        for fc in fcs:
            # 只看水平方向的净位移：首尾差超过身高的 5% 就当成根运动，把线性漂移减掉。
            # 竖直方向不动（受惊片段最后蹲下去、停在低处是对的，不能拉回来）
            if fc.data_path != hips_path or len(fc.keyframe_points) < 3:
                continue
            axis = basis @ Vector([1.0 if i == fc.array_index else 0.0 for i in range(3)])
            if axis.length < 1e-9 or abs(axis.normalized().z) > 0.5:
                continue
            k = fc.keyframe_points
            drift = k[-1].co.y - k[0].co.y
            span = k[-1].co.x - k[0].co.x
            if abs(drift) * axis.length > 0.05 * H and span > 0:
                for kp in k:
                    f = (kp.co.x - k[0].co.x) / span
                    kp.co.y -= drift * f
                    kp.handle_left.y -= drift * f
                    kp.handle_right.y -= drift * f
                root_fixed.append(f'{act.name}[{fc.array_index}] {drift * axis.length:+.3f} m')
        if A.spine_damp < 0.999:
            for name in skel['spine'][1:]:
                path = f'pose.bones["{name}"].rotation_quaternion'
                comps = {fc.array_index: fc for fc in fcs if fc.data_path == path}
                if len(comps) != 4:
                    continue
                n = len(comps[0].keyframe_points)
                if any(len(c.keyframe_points) != n for c in comps.values()):
                    continue
                for i in range(n):
                    q = Quaternion([comps[j].keyframe_points[i].co.y for j in range(4)])
                    d = Quaternion().slerp(q, A.spine_damp)
                    for j in range(4):
                        comps[j].keyframe_points[i].co.y = d[j]
    for fc in fcs:
        fc.update()
report['root_motion_removed'] = root_fixed
if root_fixed:
    log(f'去掉根运动：{root_fixed}')

# ---------------------------------------------------------------- 贴图限到 max-texture

tex = []
for img in bpy.data.images:
    if img.size[0] == 0:
        continue
    w, h = img.size
    if max(w, h) > A.max_texture:
        s = A.max_texture / max(w, h)
        img.scale(max(1, round(w * s)), max(1, round(h * s)))
        tex.append(f'{img.name} {w}x{h} → {img.size[0]}x{img.size[1]}')
    else:
        tex.append(f'{img.name} {w}x{h}')
report['textures'] = tex

# ---------------------------------------------------------------- 预览图


def render_previews(prefix):
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.display.shading.light = 'STUDIO'
    sc.render.resolution_x = sc.render.resolution_y = 420
    sc.render.film_transparent = False
    if not sc.world:
        sc.world = bpy.data.worlds.new('pv')
    sc.world.color = (0.82, 0.82, 0.84)
    cam = bpy.data.objects.new('pv', bpy.data.cameras.new('pv'))
    cam.data.type = 'ORTHO'
    sc.collection.objects.link(cam)
    sc.camera = cam
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    ctr, size = (lo + hi) / 2, max(hi - lo)
    cam.data.ortho_scale = size * 1.3
    views = {'front': Vector((0, -1, 0.25)), 'side': Vector((1, 0, 0.25)), 'back': Vector((0, 1, 0.25))}
    # 正面朝哪边导入后不一定（glTF 的 +Z 对应 Blender 的 −Y），所以正面、侧面、背面都渲，文件名里标视角
    files = []
    # 导入时其余动作放在 NLA 轨道上：预览时关掉 NLA，只看当前这一个动作
    ad = arm.animation_data_create() if arm else None
    nla_was = ad.use_nla if ad else None
    if ad:
        ad.use_nla = False

    def shoot(tag):
        for vname, d in views.items():
            cam.location = ctr + d.normalized() * size * 3
            cam.rotation_euler = (ctr - cam.location).to_track_quat('-Z', 'Y').to_euler()
            sc.render.filepath = f'{prefix}-{tag}-{vname}.png'
            bpy.ops.render.render(write_still=True)
            files.append(sc.render.filepath)

    # 权重分类图：身体蓝、肢体橙、过渡在中间（读最终的顶点组）
    if reweighted:
        sc.display.shading.color_type = 'VERTEX'
        for o in meshes:
            g = o.vertex_groups.get(skel['body'])
            if not reweighted.get(o.name) or not g:
                continue
            attr = o.data.color_attributes.new('refine_class', 'BYTE_COLOR', 'POINT')
            for v in o.data.vertices:
                b = next((x.weight for x in v.groups if x.group == g.index), 0.0)
                attr.data[v.index].color = (0.95 - 0.8 * b, 0.55 - 0.15 * b, 0.15 + 0.8 * b, 1)
            o.data.color_attributes.active_color = attr
        if ad:
            ad.action = None
        for pb in arm.pose.bones if arm else []:
            pb.matrix_basis.identity()
        shoot('weights')
        for o in meshes:
            a = o.data.color_attributes.get('refine_class')
            if a:
                o.data.color_attributes.remove(a)
    sc.display.shading.color_type = 'TEXTURE'
    if ad:
        for act in bpy.data.actions:
            ad.action = act
            if hasattr(ad, 'action_slot') and getattr(act, 'slots', None):
                ad.action_slot = act.slots[0]
            f0, f1 = act.frame_range
            for k, f in enumerate((f0, f0 + (f1 - f0) * 0.33, f0 + (f1 - f0) * 0.66)):
                sc.frame_set(int(round(f)))
                shoot(f'{act.name}-{k}')
        ad.action = None
        ad.use_nla = nla_was
        sc.frame_set(1)
    else:
        shoot('static')
    bpy.data.objects.remove(cam)
    return files


if A.preview:
    report['previews'] = render_previews(A.preview)

# ---------------------------------------------------------------- 导出

if arm and arm.animation_data:
    arm.animation_data.action = None
for pb in arm.pose.bones if arm else []:
    pb.matrix_basis.identity()
op_props = bpy.ops.export_scene.gltf.get_rna_type().properties.keys()
want = dict(
    filepath=A.out, export_format='GLB', use_selection=False,
    export_animations=True, export_animation_mode='ACTIONS', export_force_sampling=True,
    export_optimize_animation_size=True, export_skins=True, export_def_bones=False,
    export_yup=True, export_apply=False, export_texcoords=True, export_normals=True,
    export_tangents=False, export_morph=False, export_cameras=False, export_lights=False,
    export_extras=False, export_image_format='AUTO', export_jpeg_quality=90,
)
kw = {k: v for k, v in want.items() if k in op_props}
skipped = sorted(set(want) - set(kw))
if skipped:
    warn(f'这个版本的 glTF 导出器没有这些选项，跳过：{skipped}')
bpy.ops.export_scene.gltf(**kw)
log(f'导出 {A.out}：{report["tris_after"]} 三角面')

if A.report:
    with open(A.report, 'w', encoding='utf-8') as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
