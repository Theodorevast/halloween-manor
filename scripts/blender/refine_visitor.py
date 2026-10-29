# 访客 GLB 精修（Blender 5.2 无头运行，由 scripts/blender/refine.mjs 调用）。
#
# Tripo 自动绑骨是按人形来的：翠宝是个球，球身下半截会被分给大腿骨，走路时球底跟着腿变形；
# 挂在腿边的配件（提灯、披风下摆、流苏）也跟着腿拉伸。这里把权重重新分一遍：
#   - 球身、帽子、领子、披风这些「身上的东西」整块跟着肩膀所在的那节脊柱骨（默认 Spine2）走，不再变形
#   - 只有贴着腿骨、臂骨的那一圈（腿、手臂、手、鞋）保留原来的权重；交界处平滑过渡
# 另外：删掉零碎的小面片、超出预算时减面、贴图限到 2048、去掉动作里的水平位移（原地动画），
# 导出 GLB；可选出预览图（各动作若干帧 × 正面 / 侧面 / 背面，和一张按分类上色的权重图）。
#
# 动作分了批（Tripo 的 retarget 一次最多 5 个，访客要 8 个）：--merge 第二批.glb（可重复）把后面几批的动作并进来，
# 导出的 GLB 里是全部动作，骨架、网格只用 --in 的那一份。
#
#   blender -b --factory-startup -P refine_visitor.py -- --in in.glb --out out.glb [--report r.json] [--preview 前缀] [--merge 第二批.glb]
#
# 只用 Blender 自带的 bpy / bmesh / mathutils，不依赖第三方包。
import argparse
import json
import math
import random
import re
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
    p.add_argument('--merge', action='append', default=[], help='后面几批 retarget 的 GLB（绝对路径，可重复）：同一个绑骨结果、骨骼名相同，只取它的动作，挂到 --in 的骨架上')
    p.add_argument('--max-tris', type=int, default=15000)
    p.add_argument('--max-texture', type=int, default=2048, help='底色贴图的最大边长')
    p.add_argument('--max-texture-aux', type=int, default=1024, help='其余贴图（法线、粗糙度金属度）的最大边长')
    p.add_argument('--image-format', default='WEBP', choices=['AUTO', 'JPEG', 'WEBP'], help='导出贴图的格式；WEBP 带透明，体积最小')
    p.add_argument('--image-quality', type=int, default=88)
    p.add_argument('--body-bone', default='auto', help='身体整块跟着的骨头；auto = 手臂分出去的那节脊柱骨')
    p.add_argument('--limb-scale', type=float, default=1.35, help='腿 / 手臂的「管子」半径放大多少倍以内算肢体')
    p.add_argument('--blend', type=float, default=0.6, help='肢体到身体的过渡宽度（相对管子半径）')
    p.add_argument('--spine-damp', type=float, default=1.0, help='脊柱各节转动保留多少（1 = 不改，0.5 = 减半）')
    p.add_argument('--no-reweight', action='store_true')
    p.add_argument('--trust', default='', help='逗号分隔的 arms / legs：这些肢体不做「管子」判断，照自动绑骨的权重跟着肢体走（骨头放偏了的模型用）')
    p.add_argument('--trust-dist', type=float, default=math.inf,
                   help='--trust 点名的肢体只信离骨段这么远（米）以内的点：d 以内跟肢体，d 到 2d 平滑过渡到身体，再远的算身体（被自动绑骨误分给肢体的大衣、披风碎块）。手脚不受影响；不给就不限（和以前一样）')
    p.add_argument('--split-feet', action='store_true',
                   help='删掉同时连着左脚、右脚的面（顶点的主导骨头分别是左、右两边的 Foot / ToeBase）：两只鞋底被一片面连着时，迈步就被拉成一条长板。不补洞（开口在鞋底内侧，游戏里看不出来）；不给就不做（和以前一样）')
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


def import_glb(path):
    bpy.ops.import_scene.gltf(filepath=path, merge_vertices=True, **({'disable_bone_shape': True} if 'disable_bone_shape' in imp else {}))


import_glb(A.src)
arm = next((o for o in bpy.context.scene.objects if o.type == 'ARMATURE'), None)


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


# ---------------------------------------------------------------- 并入后面几批 retarget 的动作

DATA_KINDS = ('objects', 'meshes', 'armatures', 'materials', 'node_groups', 'images', 'actions')


def merge_animations(base, paths):
    """每个 GLB 是同一个绑骨结果的另一批 retarget：骨骼名、静止姿势都一样，只有动作不同（带着一份网格、骨架、贴图）。
    导入 → 把它带来的动作挂到 base 骨架的 NLA 上（和导入器放动作的方式一样：一个动作一条轨道、静音，导出按 ACTIONS 模式
    把轨道上的动作各导成一段）→ 删掉它带来的网格、骨架、材质、贴图，只留下动作。
    骨骼名对不上的通道不会生效：按名字核对一遍，对不上的报警告（全对不上就是接错了模型，直接停下）"""
    if not base:
        raise SystemExit('[refine] --merge 要有骨架：--in 的 GLB 里没有骨架')
    ad = base.animation_data or base.animation_data_create()

    def rest(arm_obj):
        # 世界坐标里每根骨头头部、尾部的静止位置（拷贝成普通数据：后面再导入东西，骨头的引用会失效）
        bpy.context.view_layer.update()  # 无头模式下导入完的物件 matrix_world 不会自己更新，算位置前先刷新
        mw = arm_obj.matrix_world
        return {b.name: (mw @ b.head_local, mw @ b.tail_local) for b in arm_obj.data.bones}

    mine = rest(base)
    pts = [v for ends in mine.values() for v in ends]
    size = max((max(p[i] for p in pts) - min(p[i] for p in pts)) for i in range(3)) or 1.0
    merged = []
    for path in paths:
        before = {k: {i.name for i in getattr(bpy.data, k)} for k in DATA_KINDS}
        import_glb(path)
        new = {k: [i.name for i in getattr(bpy.data, k) if i.name not in before[k]] for k in DATA_KINDS}
        other = next((bpy.data.objects[n] for n in new['objects'] if bpy.data.objects[n].type == 'ARMATURE'), None)
        acts = sorted((bpy.data.actions[n] for n in new['actions']), key=lambda a: a.name)
        if not other:
            raise SystemExit(f'[refine] --merge {path}：GLB 里没有骨架')
        if not acts:
            warn(f'--merge {path}：GLB 里没有动作，没有可并入的')
        # 骨架核对：骨骼名一样、静止姿势一样（世界坐标里骨头头部的位置差，除以骨架大小）
        theirs = rest(other)
        if set(mine) != set(theirs):
            warn(f'--merge {path}：骨骼名和 --in 的不一样（只有这边：{sorted(set(mine) - set(theirs))[:4]}，只有那边：{sorted(set(theirs) - set(mine))[:4]}）')
        common = sorted(set(mine) & set(theirs))
        dev = max(((mine[n][0] - theirs[n][0]).length for n in common), default=0.0) / size
        if dev > 0.02:
            warn(f'--merge {path}：静止姿势和 --in 的差了骨架大小的 {dev * 100:.1f}%（最大处），动作套上去可能变形')
        # 每个动作的通道要能找到骨头
        for act in acts:
            hit = miss = 0
            lost = set()
            for fc in fcurves_of(act):
                m = re.match(r'pose\.bones\["([^"]+)"\]', fc.data_path)
                if not m:
                    continue
                if m.group(1) in mine:
                    hit += 1
                else:
                    miss += 1
                    lost.add(m.group(1))
            if miss and not hit:
                raise SystemExit(f'[refine] --merge {path}：动作 {act.name} 的通道一个都对不上 --in 的骨骼（{sorted(lost)[:3]}…），不是同一个绑骨结果')
            if miss:
                warn(f'--merge {path}：动作 {act.name} 有 {miss} 条通道的骨头在 --in 里找不到（{sorted(lost)[:3]}），这些通道不生效')
        # 和已有的动作重名时 Blender 会给新的加 .001 后缀：游戏按片段名找，重名就找不对了
        dup = [a.name for a in acts if re.sub(r'\.\d{3}$', '', a.name) in before['actions']]
        if dup:
            warn(f'--merge {path}：动作 {dup} 和已有的重名（Blender 加了 .001 后缀），游戏里按片段名找不到，换一个预设或改清单')
        for act in acts:
            track = ad.nla_tracks.new()
            track.name = act.name
            strip = track.strips.new(act.name, int(round(act.frame_range[0])), act)
            # 动作的槽位是按它原来那个骨架（Armature.001）起的名字；NLA 条要指到一个槽位上
            if getattr(act, 'slots', None) and getattr(strip, 'action_slot', None) is None:
                strip.action_slot = act.slots[0]
            track.mute = True
        # 删掉这个 GLB 带来的网格、骨架、材质、贴图（先物件，再它们的数据；动作留着）
        for n in new['objects']:
            bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
        for kind in ('meshes', 'armatures', 'materials', 'node_groups', 'images'):
            coll = getattr(bpy.data, kind)
            for n in new[kind]:
                if n in coll:
                    coll.remove(coll[n])
        merged.append({'file': path, 'actions': [a.name for a in acts], 'rest_deviation': round(dev, 5)})
        log(f'并入 {path}：动作 {[a.name for a in acts]}，静止姿势差 {dev * 100:.2f}%')
    return merged


merged_in = merge_animations(arm, A.merge) if A.merge else []
# 片段长度不是整帧时，导出按整帧采样会把最后不到一帧截掉，循环接缝处跳一下：把动作的帧范围向外取整
for act in bpy.data.actions:
    f0, f1 = act.frame_range
    if f0 != math.floor(f0) or f1 != math.ceil(f1):
        act.use_frame_range = True
        act.frame_start, act.frame_end = math.floor(f0), math.ceil(f1)
# 骨头的显示形状（老版本导入器没有 disable_bone_shape 时）不算模型
shapes = {pb.custom_shape for pb in arm.pose.bones if pb.custom_shape} if arm else set()
meshes = [o for o in bpy.context.scene.objects if o.type == 'MESH' and o not in shapes]
if not meshes:
    raise SystemExit('[refine] GLB 里没有网格')
report['meshes'] = [o.name for o in meshes]
report['actions'] = {a.name: [round(a.frame_range[0]), round(a.frame_range[1])] for a in bpy.data.actions}
if merged_in:
    report['merged'] = merged_in


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


def skeleton_by_name():
    """Mixamo 命名的骨架（Tripo 绑骨 spec=mixamo 就是）按名字认，最可靠。
    按位置认会被怪姿势骗：实测探险家的右大腿根比胯骨还高、右手臂根比脖子还高（2026-10-28）"""
    bones = arm.data.bones
    strip = lambda n: re.sub(r'^mixamorig\d*[:_]?', '', n)
    by = {strip(b.name): b for b in bones}
    if not all(k in by for k in ('Hips', 'Spine', 'LeftUpLeg', 'RightUpLeg', 'LeftArm', 'RightArm')):
        return None
    spine = [by[k] for k in ('Hips', 'Spine', 'Spine1', 'Spine2', 'Spine3', 'Neck', 'Head') if k in by]
    legs = [[by[f'{s}UpLeg']] + descendants(by[f'{s}UpLeg']) for s in ('Left', 'Right')]
    arms = []
    for s in ('Left', 'Right'):
        top = by.get(f'{s}Shoulder') or by[f'{s}Arm']
        arms.append((top.parent, [top] + descendants(top)))
    return by['Hips'], spine, legs, arms


def analyse_skeleton():
    named = skeleton_by_name()
    if named:
        return named
    bones = arm.data.bones
    size = max(arm.dimensions) or 1.0
    # 根（hips）：层级最浅、又至少分出 3 根子骨头的那个（Hips → 脊柱 + 两条腿；手有 5 根手指，但层级深）。
    # 有的骨架在 Hips 上面还套一层空的根骨头，所以不直接取没有父骨头的那个
    hips = min((b for b in bones if len(b.children) >= 3), key=lambda b: len(b.parent_recursive), default=None)
    if not hips:
        return None
    h0 = bone_world(hips)[0]
    # 离中轴线（过 hips、竖直）的水平距离：模型正面朝哪个方向都行（Tripo 的模型实测是侧着的，手臂沿 Blender 的 y 轴）
    off = lambda p: math.hypot(p.x - h0.x, p.y - h0.y)
    # 脊柱：从 hips 起，每次走向「头最高、又最靠中轴」的子骨头（看骨头头部的位置，不看尾巴：导入时尾巴是猜的）
    spine = [hips]
    cur = hips

    def score(c):
        # 按整棵子树打分：子树里最高的点要高、要在中轴上；整棵子树伸得越开扣得越多（只扣一半，脊柱的子树带着两条手臂）。
        # 脖子和两个肩膀的头可能在同一点（Tripo 的骨架就是），这样才分得出来：脖子往上长，肩膀往两边长
        heads = [bone_world(b)[0] for b in [c] + descendants(c)]
        top = max(heads, key=lambda p: p.z)
        return top.z - 2 * off(top) - 0.5 * max(off(p) for p in heads)

    while cur.children:
        z0 = bone_world(cur)[0].z
        nxt = max(cur.children, key=score)
        # 再往下走不动：最好的那个也不比现在高，或者偏离中轴（是条腿或肩膀）
        if bone_world(nxt)[0].z <= z0 - 1e-4 or off(bone_world(nxt)[0]) > 0.08 * size:
            break
        spine.append(nxt)
        cur = nxt
    spine_set = set(b.name for b in spine)
    hz = h0.z
    legs, arms = [], []
    for s in spine:
        for c in s.children:
            if c.name in spine_set:
                continue
            chain = [c] + descendants(c)
            pts = [p for b in chain for p in bone_world(b)]
            lowest = min(p.z for p in pts)
            side = max(off(p) for p in pts)
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
            # 中轴线（过 hips、竖直）在水平面上的位置：球心应该在它附近
            'axis': [bone_world(hips)[0].x, bone_world(hips)[0].y],
        }
        # 正面朝向：脚掌指向脚尖的平均方向（水平），预览图按它摆镜头
        toes = []
        for ch in legs:
            names = [b.name.lower() for b in ch]
            foot = next((b for b in ch if 'foot' in b.name.lower()), None)
            toe = next((b for b in ch if 'toe' in b.name.lower()), None)
            if foot and toe:
                d = bone_world(toe)[0] - bone_world(foot)[0]
                toes.append(Vector((d.x, d.y, 0)))
        if toes:
            f = sum(toes, Vector()) / len(toes)
            if f.length > 1e-6:
                skel['facing'] = list(f.normalized())
        report['skeleton'] = skel
        log(f'骨架：hips={hips.name}，脊柱 {len(spine)} 节，身体跟着 {body_bone.name}，腿 {[len(c) for c in legs]}，手臂 {[len(c) for _, c in arms_]}')

# ---------------------------------------------------------------- 球身拟合（RANSAC：随机四点定球，数贴着球面的点）


def fit_sphere(pts, tol, ok=lambda c, r: True, iters=800):
    """ok(球心, 半径)：候选球合不合理（球心在中轴附近、半径在身高的一定比例内）。
    不加约束的话，斗篷那种大块弧面的点比球身还多，会被当成「球」（实测吸血鬼：拟合出半径 0.35、球心在身后的球）"""
    best, best_n = None, -1
    rnd = random.Random(7)
    for _ in range(iters):
        s = rnd.sample(pts, 4)
        sol = sphere_from4(*s)
        if not sol or not ok(*sol):
            continue
        c, r = sol
        n = sum(1 for p in pts if abs((p - c).length - r) < tol)
        if n > best_n:
            best, best_n = (c, r), n
    if not best:
        return None
    # 用内点做一次最小二乘精修（精修后不合理就用精修前的）
    c, r = best
    inl = [p for p in pts if abs((p - c).length - r) < tol]
    ref = lsq_sphere(inl)
    return (ref if ref and ok(*ref) else best), len(inl)


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
            # 锁骨（Mixamo 的 Shoulder）算身体：球身没有能耸的肩膀。不并进来的话，领子靠肩膀的两个角会跟着锁骨动
            if any(k in n.lower() for k in ('shoulder', 'clavicle')):
                continue
            limb_of[n] = ('arm', i)
    spine = set(skel['spine'])

    def dominant(w):
        return max(w.items(), key=lambda kv: kv[1])[0] if w else None

    # 球：在全部顶点里找。不能只看「主导骨头在脊柱上」的点：Tripo 的自动绑骨把球身大块分给了 Hips、两个肩膀和大腿
    # （实测吸血鬼球面上的点：Hips 609、肩膀 537 + 512、大腿 362，脊柱只有 84）
    height = max(p.z for p in pos) - min(p.z for p in pos)
    sp = random.Random(3).sample(pos, min(6000, len(pos)))
    ball = None
    if len(sp) >= 50:
        ax, ay = skel['axis']
        z_lo = bone_world(arm.data.bones[skel['hips']])[0].z - 0.15 * height
        z_hi = max(bone_world(arm.data.bones[n])[0].z for n in skel['spine']) + 0.1 * height
        # 合理的球身：球心离中轴线（水平）不超过身高的 15%（实测骨架的脊柱在球心前面 7 厘米）、高度在胯和脊柱顶之间，
        # 半径是身高的 15%–42%（翠宝的球约占身高的一半）
        ok = lambda c, r: math.hypot(c.x - ax, c.y - ay) < 0.15 * height and z_lo < c.z < z_hi and 0.15 * height < r < 0.42 * height
        fit = fit_sphere(sp, tol=0.012 * height, ok=ok, iters=3000)
        if fit:
            (c, r), n = fit
            ball = (c, r)
            report.setdefault('ball', {})[obj.name] = {'center': [round(v, 4) for v in c], 'radius': round(r, 4), 'inliers': n, 'of': len(sp), 'height': round(height, 4)}
            log(f'{obj.name}：球心 {tuple(round(v, 3) for v in c)}，半径 {r:.3f}（{n}/{len(sp)} 个点贴着球面），模型高 {height:.3f}')
    if not ball:
        warn(f'{obj.name}：没拟合出球身，只按肢体距离分')

    # 大腿、小腿、上臂、前臂的「管子半径」：主导骨头是它、又不在球里的点，到骨段距离的 5% 分位数 × 1.15。
    # 肢体是一根管子，它表面上的点到骨头的距离都差不多，是这些点里最近的一群；挂在腿边的配件、披风下摆也被自动绑骨
    # 分给了大腿，而且点数可能比腿还多（实测吸血鬼的斗篷），所以只能取最近的那一小部分，取中位数或 30% 分位都会落在斗篷上
    effector = set(skel['effectors'])
    outside = (lambda p: (p - ball[0]).length > ball[1] * 1.08) if ball else (lambda p: True)
    radius = {}
    for name in limb_of:
        if name in effector:
            continue
        a, b = bone_seg[name]
        ds = sorted(seg_dist(p, a, b) for p, w in zip(pos, weights) if dominant(w) == name and outside(p))
        if len(ds) >= 12:
            radius[name] = ds[int(len(ds) * 0.05)] * 1.15
    # 同一条肢体里，一节骨头量出来比最细的那节粗 2.5 倍以上，说明它身边量到的根本不是肢体：
    # 翠宝的大腿骨整根在球里，球外面分给大腿的点全是斗篷（实测量出 20–28 厘米，小腿只有 3.4 厘米）
    for kind_i in set(limb_of.values()):
        rs = [radius[n] for n, k in limb_of.items() if k == kind_i and n in radius]
        if rs:
            cap = 2.5 * min(rs)
            for n, k in limb_of.items():
                if k == kind_i and n in radius and radius[n] > cap:
                    radius[n] = cap
    # 骨头太短、点太少量不准的，用同一条肢体的中位数补
    for kind_i in set(limb_of.values()):
        names = [n for n, k in limb_of.items() if k == kind_i and n not in effector]
        known = sorted(radius[n] for n in names if n in radius)
        if known:
            for n in names:
                radius.setdefault(n, known[len(known) // 2])
    # --trust 点名的肢体（骨头放偏了的模型）：管子判断不可信，名下的点照自动绑骨的权重跟着肢体走。
    # 实测骷髅：自动绑骨把肩关节放在球的上部（离地 0.64），手臂网格却是从球中间（约 0.5）伸出来的，
    # 按管子判断会把上臂整段分给身体，手一垂下来上臂就被拉成两片「翅膀」（2026-10-28）。
    # 试过按「名下的点有多少落在管子里」自动判断：四套里大多数骨头都不到一半（骨头本来就不在管子正中），分不出来
    trust_kinds = {k.strip() for k in A.trust.split(',') if k.strip()}
    trusted = {n for n, (kind, _) in limb_of.items() if f'{kind}s' in trust_kinds}
    for name in radius:
        a, b = bone_seg[name]
        us = [seg_dist(p, a, b) / max(1e-6, radius[name]) for p, w in zip(pos, weights) if dominant(w) == name and outside(p)]
        if us:
            report.setdefault('tube_frac', {})[name] = round(sum(1 for u in us if u <= A.limb_scale) / len(us), 3)
    if trusted:
        near = f'（只信离骨段 {A.trust_dist} 米以内的点，{A.trust_dist}–{A.trust_dist * 2} 米过渡）' if math.isfinite(A.trust_dist) else ''
        log(f'{obj.name}：{sorted(trust_kinds)} 照原权重跟着肢体{near}')
        report['trust'] = {'kinds': sorted(trust_kinds), 'dist': A.trust_dist if math.isfinite(A.trust_dist) else None}

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
        elif dom in trusted:
            # --trust-dist（2026-10-29）：只信离骨段 d 以内的点，d 到 2d 平滑过渡到身体。承太郎的大衣、吸血鬼的斗篷上有被自动绑骨
            # 误分给手臂、大腿的远处碎块，不限距离时整块跟着肢体走，大衣后背被扯成斜三角；不加 --trust 时腿后侧、鞋口、袖子又被判成身体
            # （鞋后跟拉出细长的面、袖子在肩上翘着）。默认无穷大，和以前完全一样
            a, b = bone_seg[dom]
            limbness = 1.0 - smoothstep(A.trust_dist, A.trust_dist * 2.0, seg_dist(p, a, b)) if math.isfinite(A.trust_dist) else 1.0
        elif dom in radius:
            # 大腿、上臂这些「管子」：贴着管子的是肢体，离得远的（挂在旁边的配件）算身体，中间平滑过渡
            a, b = bone_seg[dom]
            u = seg_dist(p, a, b) / max(1e-6, radius[dom])
            limbness = 1.0 - smoothstep(A.limb_scale, A.limb_scale + A.blend * 2, u)
        else:
            limbness = 1.0
        if ball:
            # 球面上、球里面的点都算身体（腿根、手臂根接在球上，交界处平滑过渡）。球面上的点离球心在 r ± 4% 之内
            # （拟合的容差是身高的 1.2%，约为半径的 4%），所以过渡从 1.04 r 才开始
            limbness *= smoothstep(ball[1] * 1.04, ball[1] * 1.12, (p - ball[0]).length)
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


def split_feet(obj):
    """--split-feet（2026-10-29）：删掉同时有左脚、右脚主导顶点的面。女巫的两只鞋底之间有一片约 0.5 厘米的连接面，
    鞋、脚骨是 effector（整块跟着脚），迈步时两只脚分开，这片面被拉成一条长板（最大拉伸 63–102 倍，复审 2）。
    按精修后的最终权重判断。不补洞：开口在鞋底内侧，游戏里侧面、背后（含低机位）看逃跑都看不出来（2026-10-29 实测；
    Blender 亮光下从正下方、背后贴地看得到）。返回删掉的面数和少了的顶点数"""
    me = obj.data
    names = {g.index: g.name for g in obj.vertex_groups}

    def side(v):
        if not v.groups:
            return None
        n = names.get(max(v.groups, key=lambda g: g.weight).group, '')
        if 'Foot' not in n and 'Toe' not in n:
            return None
        return 'L' if 'Left' in n else 'R' if 'Right' in n else None

    sides = [side(v) for v in me.vertices]
    bad = [p.index for p in me.polygons if {'L', 'R'} <= {sides[i] for i in p.vertices}]
    if not bad:
        return 0, 0
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    n0 = len(bm.verts)
    # context='FACES'：只被这些面用到的边、顶点一起删掉，不留孤立顶点
    bmesh.ops.delete(bm, geom=[bm.faces[i] for i in bad], context='FACES')
    removed = n0 - len(bm.verts)
    bm.to_mesh(me)
    bm.free()
    return len(bad), removed


if A.split_feet and skel:
    for o in meshes:
        faces, verts = split_feet(o)
        report.setdefault('split_feet', {})[o.name] = {'removed_faces': faces, 'removed_verts': verts}
        if faces:
            log(f'{o.name}：删掉连着两只鞋的 {faces} 个面（顶点少了 {verts} 个）')
        else:
            warn(f'{o.name}：--split-feet 没找到连着两只鞋的面')
    report['tris_after'] = tri_count()

# ---------------------------------------------------------------- 动作：原地 + 脊柱减幅


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

# 底色贴图（接在 Principled BSDF 的 Base Color 上的）保留到 --max-texture，其余（法线、粗糙度金属度）到 --max-texture-aux：
# 四套访客每套 3 张 2048 贴图一共要 250 多 MB 显存，手机上扛不住；法线、粗糙度在昏暗的屋里看不出 1024 和 2048 的差别
def base_color_images():
    out = set()
    for mat in bpy.data.materials:
        if not mat.use_nodes:
            continue
        for node in mat.node_tree.nodes:
            if node.type != 'BSDF_PRINCIPLED':
                continue
            stack = [l.from_node for l in node.inputs['Base Color'].links]
            while stack:
                n = stack.pop()
                if n.type == 'TEX_IMAGE' and n.image:
                    out.add(n.image.name)
                stack += [l.from_node for i in n.inputs for l in i.links]
    return out


base_imgs = base_color_images()
tex = []
for img in bpy.data.images:
    if img.size[0] == 0:
        continue
    w, h = img.size
    limit = A.max_texture if img.name in base_imgs else A.max_texture_aux
    if max(w, h) > limit:
        s = limit / max(w, h)
        img.scale(max(1, round(w * s)), max(1, round(h * s)))
        tex.append(f'{img.name} {w}x{h} → {img.size[0]}x{img.size[1]}{" (底色)" if img.name in base_imgs else ""}')
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
    # 镜头按认出来的正面摆（脚尖方向）；认不出时按 Blender 的习惯（正面朝 −Y）
    f = Vector(skel['facing']) if skel and skel.get('facing') else Vector((0, -1, 0))
    s = Vector((-f.y, f.x, 0))
    views = {'front': f + Vector((0, 0, 0.25)), 'side': s + Vector((0, 0, 0.25)), 'back': -f + Vector((0, 0, 0.25))}
    files = []
    # 导入时其余动作放在 NLA 轨道上：预览时关掉 NLA，只看当前这一个动作
    ad = arm.animation_data_create() if arm else None
    nla_was = ad.use_nla if ad else None
    if ad:
        ad.use_nla = False

    def posed_bounds():
        # 摆了姿势之后的包围盒（跑步前倾、受惊后仰时比静止姿势大），每张图按它取景
        dg = bpy.context.evaluated_depsgraph_get()
        ps = []
        for o in meshes:
            ev = o.evaluated_get(dg)
            ps += [ev.matrix_world @ Vector(c) for c in ev.bound_box]
        a = Vector((min(p.x for p in ps), min(p.y for p in ps), min(p.z for p in ps)))
        b = Vector((max(p.x for p in ps), max(p.y for p in ps), max(p.z for p in ps)))
        return (a + b) / 2, max(b - a)

    def shoot(tag):
        c, sz = posed_bounds()
        cam.data.ortho_scale = max(size, sz) * 1.25
        for vname, d in views.items():
            cam.location = c + d.normalized() * size * 3
            cam.rotation_euler = (c - cam.location).to_track_quat('-Z', 'Y').to_euler()
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
    export_extras=False, export_image_format=A.image_format, export_image_quality=A.image_quality, export_jpeg_quality=A.image_quality,
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
