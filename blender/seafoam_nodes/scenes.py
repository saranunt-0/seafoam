"""Ready-made scenes: a breaking-wave beach and an open ocean with whitecaps.

Everything is built with bpy.data (no operators), so it also runs in
`blender --background` and from the bpy Python module.
"""

from __future__ import annotations

import math

import bpy
import numpy as np

from . import ensure_group
from .shader_groups import material, set_sun_direction, sky_world

# One set of beach numbers shared by the sand and the waves.
BEACH = {
    "Shoreline Y": 0.0,
    "Beach Slope": 1 / 15,
    "Offshore Depth": 8.0,
}


def grid_mesh(name, size_x, y_min, y_max, spacing):
    """A flat quad grid from y_min to y_max (numpy-built, fast for 100k+ verts)."""
    nx = int(round(size_x / spacing)) + 1
    ny = int(round((y_max - y_min) / spacing)) + 1
    xs = np.linspace(-size_x / 2, size_x / 2, nx)
    ys = np.linspace(y_min, y_max, ny)
    gx, gy = np.meshgrid(xs, ys)
    verts = np.column_stack([gx.ravel(), gy.ravel(), np.zeros(gx.size)]).astype(np.float32)
    i = np.arange(nx * ny).reshape(ny, nx)
    quads = np.column_stack([i[:-1, :-1].ravel(), i[:-1, 1:].ravel(), i[1:, 1:].ravel(), i[1:, :-1].ravel()])
    mesh = bpy.data.meshes.new(name)
    mesh.vertices.add(len(verts))
    mesh.vertices.foreach_set("co", verts.ravel())
    mesh.loops.add(quads.size)
    mesh.loops.foreach_set("vertex_index", quads.ravel().astype(np.int32))
    mesh.polygons.add(len(quads))
    mesh.polygons.foreach_set("loop_start", np.arange(0, quads.size, 4, dtype=np.int32))
    mesh.polygons.foreach_set("loop_total", np.full(len(quads), 4, dtype=np.int32))
    mesh.update(calc_edges=True)
    mesh.validate()
    return mesh


def add_modifier(obj, group_name, label=None, **values):
    group = ensure_group(group_name)
    mod = obj.modifiers.new(label or group_name, "NODES")
    mod.node_group = group
    set_inputs(mod, **values)
    return mod


def set_inputs(mod, **values):
    """Set modifier inputs by their visible names (spaces as underscores)."""
    items = {item.name: item for item in mod.node_group.interface.items_tree if item.item_type == "SOCKET"}
    for key, value in values.items():
        item = items[key.replace("_", " ")]
        mod[item.identifier] = value


def _link_object(obj, collection=None):
    (collection or bpy.context.scene.collection).objects.link(obj)
    return obj


def _sun(name, elevation, azimuth, strength):
    light = bpy.data.lights.new(name, "SUN")
    light.energy = strength
    light.angle = math.radians(1.5)
    obj = bpy.data.objects.new(name, light)
    obj.rotation_euler = (math.radians(90 - elevation), 0.0, math.radians(azimuth))
    _link_object(obj)
    # A sun lamp shines along its local -Z, so +Z points at the sun.
    set_sun_direction(obj.rotation_euler.to_matrix().col[2])
    return obj


def _camera(name, location, target, lens=35.0):
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    cam.clip_end = 2000
    obj = bpy.data.objects.new(name, cam)
    obj.location = location
    direction = np.subtract(target, location)
    obj.rotation_euler = (math.atan2(math.hypot(direction[0], direction[1]), -direction[2]), 0.0,
                          math.atan2(direction[1], direction[0]) - math.pi / 2)
    return _link_object(obj)


def _render_defaults(scene):
    scene.render.engine = "CYCLES"
    # Standard keeps colours saturated; AgX rolls sunlit sand off to grey-white.
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.cycles.samples = 64
    scene.cycles.use_denoising = True
    scene.render.fps = 24
    scene.frame_start = 1
    scene.frame_end = 240
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720


def build_beach_scene(spacing=0.3, width=100.0):
    """Shoaling, curling waves on a 1:15 beach with surf foam, swash and spray."""
    scene = bpy.context.scene
    water_mat = material("SF Water", "SF Water Shader")
    sand_mat = material("SF Sand", "SF Sand Shader")
    spray_mat = material("SF Spray", "SF Spray Shader")

    beach = _link_object(bpy.data.objects.new("SF Beach", bpy.data.meshes.new("SF Beach")))
    add_modifier(beach, "SF Beach", Width=width, Land=40.0, Sea=170.0, Material=sand_mat, **BEACH)

    water = _link_object(bpy.data.objects.new("SF Water", grid_mesh("SF Water", width, -170.0, 22.0, spacing)))
    water.data.materials.append(water_mat)
    # A bigger crest angle peels slower along the beach: easier to see the curl.
    add_modifier(water, "SF Shore Waves", Wave_Angle=math.radians(30), **BEACH)
    # Foam fades well inside one 8 s wave period, so each bore leaves its own trail.
    add_modifier(water, "SF Foam Accumulate", Lifetime_Wet=2.5, Lifetime_Dry=8.0, Drift=(0.0, 0.5, 0.0))
    add_modifier(water, "SF Spray", Material=spray_mat, Size=0.06)

    _sun("SF Sun", elevation=32, azimuth=-110, strength=4.5)
    scene.world = sky_world()
    scene.camera = _camera("SF Beach Camera", (-6.0, 19.0, 2.6), (4.0, -26.0, 1.5), lens=28)
    _camera("SF Aerial Camera", (-16.0, 34.0, 24.0), (4.0, -20.0, 0.0), lens=34)
    _camera("SF Barrel Camera", (24.0, -20.5, 1.5), (-10.0, -27.0, 1.0), lens=24)
    _render_defaults(scene)
    return water


def build_ocean_scene(size=160.0, spacing=0.4):
    """Open sea: Gerstner waves, Jacobian whitecaps and foam that lingers."""
    scene = bpy.context.scene
    water_mat = material("SF Water", "SF Water Shader")
    half = size / 2
    water = _link_object(bpy.data.objects.new("SF Ocean", grid_mesh("SF Ocean", size, -half, half, spacing)))
    water.data.materials.append(water_mat)
    add_modifier(water, "SF Gerstner Ocean")
    add_modifier(water, "SF Foam Accumulate", Lifetime_Wet=6.0, Spread=2)
    _sun("SF Sun", elevation=30, azimuth=-140, strength=4.5)
    scene.world = sky_world()
    scene.camera = _camera("SF Ocean Camera", (-30.0, -40.0, 9.0), (10.0, 10.0, 0.0), lens=28)
    _render_defaults(scene)
    return water
