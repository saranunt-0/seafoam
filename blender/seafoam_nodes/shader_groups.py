"""Shader node groups and materials for the Seafoam look.

The foam look is the stage 1 "dissolve": a lacy pattern is thresholded by the
foam amount, so a little foam shows as thin bubble walls and a lot of foam
fills in solid. It reads sf_foam and sf_rest, so the pattern rides the water.
"""

from __future__ import annotations

import bpy

from .nodebuilder import Socket, Tree


def _attribute(t: Tree, name: str, output: int = 2):
    """Geometry attribute in a shader. output 2 = factor, 1 = vector, 0 = color."""
    node = t.node("ShaderNodeAttribute", [], attribute_type="GEOMETRY", attribute_name=name)
    return t.out(node, output)


def _voronoi(t: Tree, vector, feature):
    node = t.node("ShaderNodeTexVoronoi", {"Vector": vector, "Scale": 1.0}, feature=feature, voronoi_dimensions="3D")
    return t.out(node, 0)


def foam_look():
    t = Tree("SF Foam Look", "ShaderNodeTree", "Turns a 0..1 foam amount into stylized foam coverage and a bump height.")
    foam = t.input("Foam", "FLOAT", 0.5, 0.0, 1.0, "Foam amount, usually the sf_foam attribute")
    coords = t.input("Coordinates", "VECTOR", (0.0, 0.0, 0.0), description="Use sf_rest so the pattern rides the water")
    scale = t.input("Scale", "FLOAT", 2.5, 0.05, 100.0, "Size of the foam cells in metres")
    softness = t.input("Softness", "FLOAT", 0.04, 0.0, 0.5, "0 = hard cartoon edge")
    bubbles = t.input("Bubbles", "FLOAT", 0.6, 0.0, 1.0, "Loose bubbles around the foam edge")

    with t.section("Lace pattern"):
        p = coords / scale
        # Distance to the Voronoi cell edge: small on the bubble walls.
        lace = 1.0 - t.clamp(_voronoi(t, p, "DISTANCE_TO_EDGE") * 3.0)
        fine = 1.0 - t.clamp(_voronoi(t, p * 2.7 + (7.3, 1.1, 0.0), "DISTANCE_TO_EDGE") * 3.0)
        blobs = t.out(t.node("ShaderNodeTexNoise", {"Vector": p * 0.35, "Scale": 1.0, "Detail": 3.0}))
        pattern = lace * 0.45 + fine * 0.2 + blobs * 0.35
    with t.section("Dissolve by foam amount"):
        threshold = 1.0 - foam
        coverage = t.smoothstep(threshold - softness, threshold + softness, pattern)
        dots = 1.0 - t.smoothstep(0.12, 0.28, _voronoi(t, p * 6.0, "F1"))
        coverage = t.max(coverage, dots * t.smoothstep(0.25, 0.6, foam) * bubbles)
        coverage = coverage * t.greater(foam, 0.01)
        height = coverage * (pattern * 0.5 + 0.5)
    t.output("Factor", "FLOAT", coverage)
    t.output("Height", "FLOAT", height)
    return t.finish()


def water_shader():
    t = Tree("SF Water Shader", "ShaderNodeTree",
             "Stylized water: toon-lit depth tint, sand through the shallows, glowing crests and Seafoam foam.")
    deep = t.input("Deep Color", "COLOR", (0.01, 0.12, 0.22, 1.0))
    shallow = t.input("Shallow Color", "COLOR", (0.05, 0.55, 0.52, 1.0))
    sand = t.input("Sand Color", "COLOR", (0.62, 0.55, 0.38, 1.0))
    foam_color = t.input("Foam Color", "COLOR", (0.95, 0.97, 0.98, 1.0))
    foam_shadow = t.input("Foam Shadow", "COLOR", (0.55, 0.72, 0.8, 1.0))
    sun = t.input("Sun Direction", "VECTOR", (0.4, -0.5, 0.75), description="Direction toward the sun; use Sync Seafoam Sun after moving the lamp")
    toon = t.input("Toon", "FLOAT", 0.8, 0.0, 1.0, "0 = smooth light, 1 = hard cartoon bands")
    clarity = t.input("Clarity", "FLOAT", 1.4, 0.01, 20.0, "Metres of water you can see sand through")
    glow = t.input("Crest Glow", "FLOAT", 0.6, 0.0, 5.0, "Light shining through thin crests, strongest looking toward the sun")
    reflection = t.input("Reflection", "FLOAT", 0.3, 0.0, 1.0,
                         "Cap on sky reflection. Real water reflects almost fully at grazing angles and turns white")
    foam_scale = t.input("Foam Scale", "FLOAT", 1.6, 0.05, 100.0, "Size of the foam cells in metres")
    softness = t.input("Foam Softness", "FLOAT", 0.04, 0.0, 0.5, "0 = hard cartoon foam edge")

    with t.section("Toon light"):
        geometry = t.node("ShaderNodeNewGeometry")
        normal = t.out(geometry, 1)
        toward_eye = t.out(geometry, 4)
        light_dir = t.vmath("NORMALIZE", sun)
        lambert = t.max(t.dot(normal, light_dir), 0.0)
        bands = t.smoothstep(0.08, 0.16, lambert) * 0.5 + t.smoothstep(0.45, 0.55, lambert) * 0.5
        light = lambert + (bands - lambert) * toon
        # Sea of Thieves trick: crests glow when you look through them toward the sun.
        back = t.max(0.0 - t.dot(toward_eye, light_dir), 0.0)
        backlit = back * back * back
    with t.section("Water colour"):
        thickness = t.max(_attribute(t, "sf_thickness"), 0.0)
        tint = deep + (shallow - deep) * t.exp(0.0 - thickness / (clarity * 3.0))
        see_through = t.exp(0.0 - thickness / clarity)
        body = tint + (sand * shallow * 2.0 - tint) * (see_through * 0.65)
        crest = t.max(_attribute(t, "sf_crest"), 0.0)
        lit = body * (light * 0.85 + 0.35) + shallow * (crest * crest * glow * (backlit * 1.6 + 0.4))
        body_shader = t.node("ShaderNodeEmission", {"Color": lit, "Strength": 1.0})
    with t.section("Stylized reflection"):
        fresnel = t.out(t.node("ShaderNodeLayerWeight", {"Blend": 0.2}), 0)
        amount = t.clamp(fresnel, 0.03, reflection)
        gloss = t.node("ShaderNodeBsdfGlossy", {"Color": (1.0, 1.0, 1.0, 1.0), "Roughness": 0.04})
        water = t.node("ShaderNodeMixShader", [amount, t.out(body_shader), t.out(gloss)])
    with t.section("Foam"):
        look = t.node("ShaderNodeGroup", [], node_tree=bpy.data.node_groups.get("SF Foam Look") or foam_look())
        t.link(_attribute(t, "sf_foam"), look.inputs["Foam"])
        t.link(_attribute(t, "sf_rest", 1), look.inputs["Coordinates"])
        t.link(foam_scale, look.inputs["Scale"])
        t.link(softness, look.inputs["Softness"])
        bumped = t.out(t.node("ShaderNodeBump", {"Strength": 0.8, "Distance": 0.08, "Height": t.out(look, 1)}))
        foam_lambert = t.max(t.dot(bumped, light_dir), 0.0)
        foam_bands = t.smoothstep(0.1, 0.2, foam_lambert) * 0.6 + t.smoothstep(0.5, 0.6, foam_lambert) * 0.4
        foam_light = foam_lambert + (foam_bands - foam_lambert) * toon
        foam_lit = foam_shadow + (foam_color - foam_shadow) * foam_light
        foam = t.node("ShaderNodeEmission", {"Color": foam_lit, "Strength": 1.0})
        mix = t.node("ShaderNodeMixShader", [t.out(look, 0), t.out(water), t.out(foam)])
    t.output("Shader", "SHADER", t.out(mix))
    return t.finish()


def sand_shader():
    t = Tree("SF Sand Shader", "ShaderNodeTree", "Toon-lit sand that darkens where the waves have wet it.")
    dry = t.input("Dry Color", "COLOR", (0.95, 0.8, 0.55, 1.0))
    wet_color = t.input("Wet Color", "COLOR", (0.62, 0.5, 0.33, 1.0))
    shade = t.input("Shade Color", "COLOR", (0.55, 0.5, 0.55, 1.0), description="Colour multiplied in on the side away from the sun")
    sun = t.input("Sun Direction", "VECTOR", (0.4, -0.5, 0.75), description="Direction toward the sun; use Sync Seafoam Sun")
    toon = t.input("Toon", "FLOAT", 0.8, 0.0, 1.0, "0 = smooth light, 1 = hard cartoon bands")
    wet_line = t.input("Wet Line", "FLOAT", 9.0, 0.0, 100.0, "Metres above the shoreline the sand stays wet")
    with t.section("Wet and dry sand"):
        distance = _attribute(t, "sf_shore_distance")
        wet = 1.0 - t.smoothstep(wet_line * 0.4, wet_line, distance)
        grain = t.out(t.node("ShaderNodeTexNoise", {"Scale": 40.0, "Detail": 4.0}))
        color = dry + (wet_color - dry) * wet
        color = color * (grain * 0.16 + 0.9)
    with t.section("Toon light"):
        normal = t.out(t.node("ShaderNodeNewGeometry"), 1)
        lambert = t.max(t.dot(normal, t.vmath("NORMALIZE", sun)), 0.0)
        bands = t.smoothstep(0.1, 0.2, lambert) * 0.6 + t.smoothstep(0.5, 0.6, lambert) * 0.4
        light = lambert + (bands - lambert) * toon
        lit = color * (shade + ((1.0, 1.0, 1.0) - shade) * light)
        emit = t.node("ShaderNodeEmission", {"Color": lit, "Strength": 1.0})
    t.output("Shader", "SHADER", t.out(emit))
    return t.finish()


def spray_shader():
    t = Tree("SF Spray Shader", "ShaderNodeTree", "Bright droplets, lit like the toon foam.")
    color = t.input("Color", "COLOR", (0.95, 0.97, 1.0, 1.0))
    shadow = t.input("Shadow", "COLOR", (0.6, 0.76, 0.84, 1.0))
    sun = t.input("Sun Direction", "VECTOR", (0.4, -0.5, 0.75), description="Direction toward the sun; use Sync Seafoam Sun")
    with t.section("Droplet"):
        normal = t.out(t.node("ShaderNodeNewGeometry"), 1)
        lit = t.smoothstep(0.0, 0.15, t.dot(normal, t.vmath("NORMALIZE", sun)))
        emit = t.node("ShaderNodeEmission", {"Color": shadow + (color - shadow) * lit, "Strength": 1.0})
    t.output("Shader", "SHADER", t.out(emit))
    return t.finish()


BUILDERS = {
    "SF Foam Look": foam_look,
    "SF Water Shader": water_shader,
    "SF Sand Shader": sand_shader,
    "SF Spray Shader": spray_shader,
}


def set_sun_direction(toward_sun):
    """Tell every Seafoam toon material where the sun is (they light themselves)."""
    for mat in bpy.data.materials:
        if mat.node_tree is None:
            continue
        for node in mat.node_tree.nodes:
            if node.bl_idname == "ShaderNodeGroup" and "Sun Direction" in node.inputs:
                node.inputs["Sun Direction"].default_value = tuple(toward_sun)


def material(name: str, group_name: str):
    """A material that is just one Seafoam shader group into the output."""
    from . import ensure_group

    ensure_group(group_name)
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    nodes.clear()
    group = nodes.new("ShaderNodeGroup")
    group.node_tree = bpy.data.node_groups[group_name]
    out = nodes.new("ShaderNodeOutputMaterial")
    out.location = (300, 0)
    mat.node_tree.links.new(group.outputs[0], out.inputs["Surface"])
    return mat


def sky_world(name="SF Sky", horizon=(0.62, 0.8, 0.95), zenith=(0.1, 0.32, 0.78), strength=0.3):
    world = bpy.data.worlds.get(name) or bpy.data.worlds.new(name)
    world.use_nodes = True
    nodes, links = world.node_tree.nodes, world.node_tree.links
    nodes.clear()
    coords = nodes.new("ShaderNodeTexCoord")
    split = nodes.new("ShaderNodeSeparateXYZ")
    ramp = nodes.new("ShaderNodeMapRange")
    ramp.inputs["From Min"].default_value = -0.05
    ramp.inputs["From Max"].default_value = 0.6
    mix = nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.inputs[6].default_value = (*horizon, 1.0)
    mix.inputs[7].default_value = (*zenith, 1.0)
    # Bright to the camera, gentle as a light: keeps the sun in charge of shading.
    path = nodes.new("ShaderNodeLightPath")
    level = nodes.new("ShaderNodeMapRange")
    level.inputs["To Min"].default_value = strength
    level.inputs["To Max"].default_value = 1.0
    bg = nodes.new("ShaderNodeBackground")
    out = nodes.new("ShaderNodeOutputWorld")
    links.new(coords.outputs["Generated"], split.inputs[0])
    links.new(split.outputs["Z"], ramp.inputs["Value"])
    links.new(ramp.outputs[0], mix.inputs[0])
    links.new(mix.outputs[2], bg.inputs["Color"])
    links.new(path.outputs["Is Camera Ray"], level.inputs["Value"])
    links.new(level.outputs[0], bg.inputs["Strength"])
    links.new(bg.outputs[0], out.inputs["Surface"])
    for i, node in enumerate((coords, split, ramp, mix, bg, out)):
        node.location = (i * 220, 0)
    path.location = (660, -250)
    level.location = (880, -250)
    return world
