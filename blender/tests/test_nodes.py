"""Headless checks for the Seafoam node groups.

Run with Blender:       blender --background --factory-startup --python blender/tests/test_nodes.py
or the bpy module:      python blender/tests/test_nodes.py   (pip install bpy, Python 3.11)

Builds every group, simulates small scenes frame by frame and checks that the
behaviour matches the model: no breaking offshore, foam in the surf zone and
stranded on the sand, spray near the lip, and foam fading at the set lifetime.
"""

import math
import os
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import seafoam_nodes  # noqa: E402
from seafoam_nodes import scenes  # noqa: E402
from seafoam_nodes.nodebuilder import Tree  # noqa: E402

RESULTS = []


def check(name, condition, detail=""):
    RESULTS.append((name, bool(condition), detail))
    print(f"{'PASS' if condition else 'FAIL'}  {name}  {detail}", flush=True)


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    seafoam_nodes.build_all()


def simulate(frames):
    scene = bpy.context.scene
    for f in range(scene.frame_start, scene.frame_start + frames):
        scene.frame_set(f)
    return bpy.context.evaluated_depsgraph_get()


def attribute(mesh, name):
    data = mesh.attributes[name].data
    width = 3 if mesh.attributes[name].data_type == "FLOAT_VECTOR" else 1
    values = np.zeros(len(data) * width)
    data.foreach_get("vector" if width == 3 else "value", values)
    return values.reshape(-1, width).squeeze()


def test_groups_build():
    groups = seafoam_nodes.build_all()
    for g in groups:
        check(f"{g.name} builds", len(g.nodes) > 3, f"{len(g.nodes)} nodes")
    shore = bpy.data.node_groups["SF Shore Waves"]
    names = {i.name for i in shore.interface.items_tree if i.item_type == "SOCKET"}
    check("SF Shore Waves exposes the breaker controls", {"Beach Slope", "Curl", "Lean", "Run-up"} <= names)


def test_beach_scene():
    reset()
    water = scenes.build_beach_scene(spacing=0.6, width=30.0)
    dg = simulate(96)
    mesh = water.evaluated_get(dg).data
    is_drop = attribute(mesh, "sf_size") > 0          # spray droplets are joined into the same mesh
    y = attribute(mesh, "sf_rest")[~is_drop, 1]
    breaking, source, foam, wet = (attribute(mesh, name)[~is_drop]
                                   for name in ("sf_breaking", "sf_foam_source", "sf_foam", "sf_wet"))
    offshore = y < -70
    surf = (y > -15) & (y < -3)
    check("no breaking offshore", breaking[offshore].max() == 0.0, f"max {breaking[offshore].max():.3f}")
    check("surf zone is broken", breaking[surf].mean() > 0.8, f"mean {breaking[surf].mean():.2f}")
    check("no foam source offshore", source[offshore].max() < 0.05, f"max {source[offshore].max():.3f}")
    check("foam source in the surf zone", source[surf].mean() > 0.15, f"mean {source[surf].mean():.2f}")
    check("accumulated foam never below the source", np.all(foam >= source - 1e-4))
    check("high beach stays dry", wet[y > 14].max() == 0.0)
    stranded = (wet == 0) & (y > 0) & (foam > 0.1)
    check("foam stranded on the sand after the swash", stranded.sum() > 0, f"{stranded.sum()} points")
    co = np.zeros(len(mesh.vertices) * 3)
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    check("surface has no NaN", np.isfinite(co).all())
    droplets = co[is_drop]
    check("spray droplets exist", len(droplets) > 0, f"{len(droplets)} droplet verts")
    if len(droplets):
        dy = droplets[:, 1]
        check("spray stays near the breakers", (dy > -50).all() and (dy < 10).all(), f"y {dy.min():.1f}..{dy.max():.1f}")


def test_gerstner_jacobian():
    for steepness, expect_foam in ((0.3, False), (1.2, True)):
        reset()
        water = scenes.build_ocean_scene(size=60.0, spacing=0.5)
        scenes.set_inputs(water.modifiers["SF Gerstner Ocean"], Steepness=steepness)
        mesh = water.evaluated_get(simulate(2)).data
        jac = attribute(mesh, "sf_jacobian")
        src = attribute(mesh, "sf_foam_source")
        if expect_foam:
            check("steep Gerstner sea folds (J < 0) and foams", jac.min() < 0 and src.max() > 0.5, f"min J {jac.min():.2f}")
        else:
            check("gentle Gerstner sea makes no foam", jac.min() > 0.55 and src.max() == 0.0, f"min J {jac.min():.2f}")


def test_foam_decay_rate():
    """Foam born on frames 1-3 must fall to exp(-1) one lifetime later."""
    reset()
    t = Tree("Test Pulse Source")
    geo = t.input("Geometry", "GEOMETRY")
    _, frame = t.scene_time()
    geo = t.store(geo, "sf_foam_source", t.less(frame, 3.5))
    t.output("Geometry", "GEOMETRY", geo)
    t.finish()
    obj = bpy.data.objects.new("Pulse", scenes.grid_mesh("Pulse", 4.0, -2.0, 2.0, 1.0))
    bpy.context.scene.collection.objects.link(obj)
    scenes.add_modifier(obj, "Test Pulse Source")
    scenes.add_modifier(obj, "SF Foam Accumulate", Lifetime_Wet=1.0, Spread=0)
    scene = bpy.context.scene
    scene.render.fps = 24
    mesh = obj.evaluated_get(simulate(3 + 24)).data   # one second after the last source frame
    foam = attribute(mesh, "sf_foam").mean()
    check("foam fades by exp(-dt / lifetime)", abs(foam - math.exp(-1)) < 0.02, f"{foam:.3f} vs {math.exp(-1):.3f}")


def test_blender_ocean_modifier_bridge():
    """Blender's own FFT ocean (Ocean modifier) can feed SF Foam Accumulate."""
    reset()
    obj = bpy.data.objects.new("Ocean", bpy.data.meshes.new("Ocean"))
    bpy.context.scene.collection.objects.link(obj)
    ocean = obj.modifiers.new("Ocean", "OCEAN")
    ocean.use_foam = True
    ocean.foam_layer_name = "foam"
    ocean.choppiness = 1.6
    ocean.foam_coverage = 0.4
    ocean.wave_scale = 2.0
    scenes.add_modifier(obj, "SF Foam Accumulate", Source_Attribute="foam")
    foam = attribute(obj.evaluated_get(simulate(5)).data, "sf_foam")
    check("Ocean modifier foam layer drives SF Foam Accumulate", foam.max() > 0.5, f"max {foam.max():.2f}")


def test_operators():
    reset()
    check("Add menu entries registered", hasattr(bpy.types, "NODE_MT_seafoam") and hasattr(bpy.types, "VIEW3D_MT_seafoam"))
    bpy.ops.object.seafoam_add_scene(kind="OCEAN", spacing=1.0)
    check("Add > Seafoam Ocean builds a scene", "SF Ocean" in bpy.data.objects)
    sun = bpy.data.objects["SF Sun"]
    sun.rotation_euler = (0.0, 0.0, 0.0)              # straight overhead
    bpy.context.view_layer.update()
    bpy.ops.object.seafoam_sync_sun()
    group = next(n for n in bpy.data.materials["SF Water"].node_tree.nodes if n.bl_idname == "ShaderNodeGroup")
    direction = tuple(round(v, 3) for v in group.inputs["Sun Direction"].default_value)
    check("Sync Sun points the toon materials at the lamp", direction == (0.0, 0.0, 1.0), str(direction))


def test_packaged_zip_is_current():
    """seafoam_nodes.zip (for Install from Disk) must match the source files."""
    import zipfile
    root = Path(__file__).resolve().parents[1]
    with zipfile.ZipFile(root / "seafoam_nodes.zip") as z:
        packed = {name: z.read(name) for name in z.namelist()}
    source = {str(p.relative_to(root)): p.read_bytes() for p in (root / "seafoam_nodes").rglob("*.py")}
    check("seafoam_nodes.zip matches the source (run tools/package_addon.py)", packed == source)


def main():
    print(f"Blender {bpy.app.version_string}", flush=True)
    seafoam_nodes.register()
    for test in (test_groups_build, test_beach_scene, test_gerstner_jacobian, test_foam_decay_rate,
                 test_blender_ocean_modifier_bridge, test_operators, test_packaged_zip_is_current):
        try:
            test()
        except Exception:
            traceback.print_exc()
            check(test.__name__, False, "raised")
    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{len(RESULTS) - len(failed)} passed, {len(failed)} failed", flush=True)
    os._exit(1 if failed else 0)   # bpy as a module can hang on normal interpreter exit


main()
