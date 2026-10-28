"""Geometry Nodes groups for stylized waves and foam.

Every group writes plain named attributes, so they chain as modifiers or as
nodes, and the materials read the same names:

    sf_rest          undisplaced position (foam pattern coordinates, advection)
    sf_foam_source   where foam is born this frame, 0..1
    sf_foam          accumulated foam after SF Foam Accumulate, 0..1
    sf_wet           1 for water, 0 for dry sand (foam lasts longer when dry)
    sf_spray         where spray should be thrown, 0..1
    sf_crest         -1 in troughs, 1 on crests (subsurface glow in the shader)
    sf_thickness     water column above the bed, for fake transparency
    sf_breaking      0 before the break point, 1 deep in the surf zone
    sf_jacobian      surface compression; < 1 squeezed, < 0 folded
"""

from __future__ import annotations

import math

from .nodebuilder import GRAVITY, TAU, Socket, Tree

# Six Gerstner components: length ratio, share of steepness, direction offset
# (in units of Spread) and phase. Uneven ratios avoid an obvious repeat.
GERSTNER_WAVES = (
    (1.00, 0.30, 0.00, 0.0),
    (0.73, 0.22, 0.42, 1.7),
    (0.55, 0.17, -0.57, 4.1),
    (0.41, 0.13, 0.83, 2.6),
    (0.31, 0.10, -0.29, 5.3),
    (0.23, 0.08, 1.00, 0.9),
)


def gerstner_ocean():
    t = Tree("SF Gerstner Ocean", description=(
        "Open-sea waves as a sum of six Gerstner waves. Writes sf_foam_source where the "
        "surface is squeezed (Jacobian below the threshold), the stage 1 whitecap rule."))
    geo = t.input("Geometry", "GEOMETRY")
    wavelength = t.input("Wavelength", "FLOAT", 24.0, 1.0, 500.0, "Longest wave in metres")
    steepness = t.input("Steepness", "FLOAT", 0.65, 0.0, 1.5, "Total crest sharpness. Above 1 the crests fold over")
    direction = t.input("Direction", "FLOAT", 0.0, description="Direction the waves travel", subtype="ANGLE")
    spread = t.input("Spread", "FLOAT", math.radians(35), 0.0, math.pi, "How far wave directions fan out", "ANGLE")
    time_scale = t.input("Time Scale", "FLOAT", 1.0, 0.0, 10.0, "Speed the waves up or slow them down")
    bias = t.input("Foam Below J", "FLOAT", 0.55, -1.0, 2.0, "Foam is born where the Jacobian drops below this")
    gain = t.input("Foam Gain", "FLOAT", 4.0, 0.0, 20.0, "How quickly foam reaches full strength below the threshold")

    seconds, _ = t.scene_time()
    time = seconds * time_scale
    rest = t.position()
    geo = t.store(geo, "sf_rest", rest)

    ox = oy = oz = 0.0
    jxx = jyy = jxy = 0.0
    amplitude = 0.0
    for i, (ratio, share, angle, phase) in enumerate(GERSTNER_WAVES):
        with t.section(f"Wave {i + 1}"):
            k = TAU / (wavelength * ratio)
            omega = t.sqrt(k * GRAVITY)
            heading = direction + spread * angle
            dx, dy = t.cos(heading), t.sin(heading)
            a = steepness * share / k
            theta = k * (rest.x * dx + rest.y * dy) - omega * time + phase
            c, s = t.cos(theta), t.sin(theta)
            # Gerstner: water moves toward the crest, so crests sharpen.
            ox = ox + a * c * dx
            oy = oy + a * c * dy
            oz = oz + a * s
            # Jacobian terms; k * a is this wave's steepness.
            q = steepness * share * s
            jxx = jxx + q * dx * dx
            jyy = jyy + q * dy * dy
            jxy = jxy + q * dx * dy
            amplitude = amplitude + a

    with t.section("Foam source (Jacobian)"):
        jacobian = (1.0 - jxx) * (1.0 - jyy) - jxy * jxy
        source = t.clamp((bias - jacobian) * gain)
        crest = t.clamp(oz / t.max(amplitude, 1e-4), -1.0, 1.0)
        geo = t.store(geo, "sf_jacobian", jacobian)
        geo = t.store(geo, "sf_foam_source", source)
        geo = t.store(geo, "sf_crest", crest)
        geo = t.store(geo, "sf_wet", 1.0)
        geo = t.store(geo, "sf_thickness", 30.0)
        geo = t.set_position(geo, offset=t.vec(ox, oy, oz))
        geo = t.out(t.node("GeometryNodeSetShadeSmooth", {"Geometry": geo}))
    t.output("Geometry", "GEOMETRY", geo)
    return t.finish()


def shore_waves():
    t = Tree("SF Shore Waves", description=(
        "Waves that shoal, curl and break on a plane beach, then run up the sand. "
        "The shoreline runs along X; the sea is toward -Y. Expects a dense grid."))
    geo = t.input("Geometry", "GEOMETRY")
    shore_y = t.input("Shoreline Y", "FLOAT", 0.0, description="Still-water shoreline, in object space")
    slope = t.input("Beach Slope", "FLOAT", 1 / 15, 0.005, 0.5, "Rise per metre. Steeper beaches plunge, gentle ones spill")
    height = t.input("Wave Height", "FLOAT", 1.2, 0.0, 10.0, "Offshore wave height in metres")
    period = t.input("Wave Period", "FLOAT", 8.0, 1.0, 25.0, "Seconds between crests")
    angle = t.input("Wave Angle", "FLOAT", math.radians(12), -1.2, 1.2,
                    "Crest angle to the shoreline. Non-zero makes the break peel along the beach", "ANGLE")
    depth = t.input("Offshore Depth", "FLOAT", 8.0, 0.5, 100.0, "The sea floor flattens out at this depth")
    gamma = t.input("Breaking Index", "FLOAT", 0.78, 0.4, 1.2, "Waves break when height / depth reaches this (McCowan 0.78)")
    curl = t.input("Curl", "FLOAT", 1.0, 0.0, 2.0, "How far the crest rotates over into a lip when the wave plunges")
    lean = t.input("Lean", "FLOAT", 0.7, 0.0, 2.0, "Forward tilt of the crest as it breaks (Fournier & Reeves)")
    runup = t.input("Run-up", "FLOAT", 1.0, 0.0, 3.0, "Scale on Hunt's run-up distance")
    irregularity = t.input("Irregularity", "FLOAT", 0.35, 0.0, 1.0, "Wobbly crests and wave sets")
    time_scale = t.input("Time Scale", "FLOAT", 1.0, 0.0, 10.0, "Speed the waves up or slow them down")
    foam_gain = t.input("Foam Gain", "FLOAT", 1.0, 0.0, 5.0, "Multiplies every foam source: whitewater, bores and swash")

    seconds, _ = t.scene_time()
    time = seconds * time_scale
    rest = t.position()
    geo = t.store(geo, "sf_rest", rest)
    x, y = rest.x, rest.y

    with t.section("Depth and travel time"):
        s = shore_y - y                                  # metres seaward of the shoreline
        h_still = t.clamp(s * slope, 0.0, depth)
        h = t.max(h_still, 0.08)
        c = t.sqrt(h * GRAVITY)
        s_flat = depth / slope                           # where the beach meets the flat floor
        # Time for a crest to reach the shoreline: integral of ds / sqrt(g h)
        # on the slope, constant speed beyond it.
        tau = (2.0 * t.sqrt(t.clamp(s, 0.0, s_flat)) / t.sqrt(slope * GRAVITY)
               + t.max(s - s_flat, 0.0) / t.sqrt(depth * GRAVITY)
               + t.min(s, 0.0) / math.sqrt(0.08 * GRAVITY))

    with t.section("Phase"):
        omega = TAU / period
        k0 = omega * omega / GRAVITY
        wobble = t.noise(w=x * 0.013 + 3.1, scale=1.0, detail=1.0, dimensions="1D") - 0.5
        # Snell: the alongshore wavenumber is constant, so a constant k0 sin(angle)
        # term is all refraction needs on a straight beach.
        alongshore = k0 * t.sin(angle) * x + irregularity * (TAU * 0.4) * wobble
        theta = omega * (time + tau) + alongshore
        cos_t, sin_t = t.cos(theta), t.sin(theta)

    with t.section("Shoaling and breaking"):
        sets = t.noise(vector=t.vec(x * 0.006, (time + tau) / (period * 6.0), 0.0), scale=1.0, detail=1.0)
        h0 = height * (1.0 + irregularity * (sets - 0.5) * 1.2)
        h_shoal = h0 * (depth / h) ** 0.25               # Green's law
        h_break = (h0 * depth ** 0.25 / gamma) ** 0.8    # depth where Green's law meets H = gamma h
        breaking = t.clamp((h_break - h_still) / (h_break * 0.55))
        h_surf = (gamma + (0.5 - gamma) * breaking) * h_still
        wave_h = t.min(h_shoal, h_surf)
        amp = wave_h * 0.5
        nearness = t.smoothstep(0.3, 1.0, h_shoal / (gamma * h))

    with t.section("Breaker shape"):
        k = omega / c
        z_wave = amp * (cos_t + 0.3 * nearness * t.cos(theta * 2.0))   # Stokes-like sharp crest
        curling = t.smoothstep(0.0, 0.3, breaking) * (1.0 - t.smoothstep(0.45, 0.85, breaking))
        bore = t.smoothstep(0.6, 1.0, breaking)
        # Gerstner crest sharpening, kept below 1 so the sheet does not loop.
        steep = 0.5 * nearness + 0.35 * curl * curling + 0.35 * bore
        gerstner = steep / k * sin_t
        # Fournier & Reeves: lean the raised water forward, steepening the face.
        tilt = lean * (0.25 * nearness + 0.9 * curling + 0.8 * t.smoothstep(0.5, 1.0, breaking))
        dy_lean = gerstner + tilt * z_wave

    with t.section("Curl: rotate the crest over a pivot in front of it"):
        # Phase relative to the nearest crest, -pi..pi; negative is the face toward the beach.
        phi = t.math("FLOORED_MODULO", theta + math.pi, TAU) - math.pi
        # Rotation weight peaks just behind the crest: that water overtakes and becomes the jet.
        weight = t.exp(0.0 - ((phi - 0.35) / 0.55) * ((phi - 0.35) / 0.55))
        envelope = t.smoothstep(0.0, 0.3, breaking) * (1.0 - 0.5 * t.smoothstep(0.6, 1.0, breaking))
        turn = curl * envelope * weight * math.radians(150)
        # Position relative to a pivot a little ahead of the crest, scaled by wave height,
        # so the lip is as big as the wave is tall (not as long as it is wide).
        rel_y = (0.0 - phi) / k + dy_lean - tilt * amp - 0.3 * wave_h
        rel_z = z_wave - 0.1 * wave_h
        ca, sa = t.cos(turn), t.sin(turn)
        curl_dy = rel_y * ca + rel_z * sa - rel_y
        curl_dz = rel_z * ca - rel_y * sa - rel_z
        dy_sea = dy_lean + curl_dy
        z_curl = z_wave + curl_dz

    with t.section("Swash on the sand"):
        theta_shore = omega * time + alongshore
        cycle = t.fract(theta_shore / TAU)               # 0 when a bore reaches the shoreline
        rise = t.smoothstep(0.0, 0.25, cycle) * (1.0 - t.smoothstep(0.3, 0.95, cycle))
        deep_length = GRAVITY / TAU * period * period
        # Hunt (1959): run-up height R = slope * sqrt(H0 L0), so the
        # horizontal reach is sqrt(H0 L0) whatever the slope.
        reach = runup * t.sqrt(h0 * deep_length) * rise
        land = 0.0 - s                                   # metres landward of the shoreline
        wet_land = t.greater(land, 0.0) * t.less(land, reach)
        bed_land = slope * land
        film = 0.12 * t.sqrt(t.clamp(1.0 - land / t.max(reach, 0.01)))

    with t.section("Surface"):
        sea = t.greater(s, 0.0)
        z_sea = t.max(z_curl, 0.03 - h_still)            # never below the sea floor
        z_land = wet_land * (bed_land + film) + (1.0 - wet_land) * (bed_land - 0.15)
        z = sea * z_sea + (1.0 - sea) * z_land
        dy = sea * dy_sea
        geo = t.set_position(geo, offset=t.vec(0.0, dy, z))
        geo = t.out(t.node("GeometryNodeSetShadeSmooth", {"Geometry": geo}))

    with t.section("Foam, spray and shading attributes"):
        front = 0.7 * cos_t - 0.7 * sin_t                # crest and the face toward the beach
        # The curling face and the jet stay clear (spray marks the lip); whitewater
        # starts where the lip lands, in narrow bands on each bore front.
        roller = t.smoothstep(0.55, 0.75, breaking) * t.smoothstep(0.45, 0.9, front)
        whitewater = bore * t.smoothstep(0.3, 0.85, front)
        tip = wet_land * (1.0 - t.smoothstep(0.0, 0.8, reach - land))
        source = t.max(t.max(roller, whitewater) * sea, tip * 0.7) * foam_gain
        spray = curling * t.smoothstep(0.6, 0.95, weight) * t.smoothstep(0.4, 1.2, wave_h) * sea   # the lip
        bed_below = 0.0 - t.clamp((shore_y - (y + dy)) * slope, -100.0, depth)
        crest = t.clamp(z_wave / t.max(amp, 0.05), -1.0, 1.0) * t.smoothstep(0.1, 0.5, amp)
        geo = t.store(geo, "sf_foam_source", t.clamp(source))
        geo = t.store(geo, "sf_spray", spray)
        geo = t.store(geo, "sf_wet", t.max(sea, wet_land))
        geo = t.store(geo, "sf_breaking", breaking * sea)
        geo = t.store(geo, "sf_depth", h_still)
        geo = t.store(geo, "sf_thickness", z - bed_below)
        geo = t.store(geo, "sf_crest", crest)
    t.output("Geometry", "GEOMETRY", geo)
    return t.finish()


def _simulation_zone(t: Tree, initial=None):
    sim_in = t.nt.nodes.new("GeometryNodeSimulationInput")
    sim_out = t.nt.nodes.new("GeometryNodeSimulationOutput")
    sim_in.pair_with_output(sim_out)
    t._place(sim_in, [initial] if initial is not None else [])
    if initial is not None:
        t.link(initial, sim_in.inputs["Geometry"])
    return sim_in, sim_out


def foam_accumulate():
    t = Tree("SF Foam Accumulate", description=(
        "Gives foam a life: each frame the old foam spreads, fades and drifts, and new foam "
        "from the source attribute is added. foam = max(spread(foam) * exp(-dt / life), source)."))
    geo = t.input("Geometry", "GEOMETRY")
    source_name = t.input("Source Attribute", "STRING", "sf_foam_source", description="Float attribute where foam is born")
    wet_name = t.input("Wet Attribute", "STRING", "sf_wet", description="1 = water, 0 = dry sand. Missing means all wet")
    life_wet = t.input("Lifetime Wet", "FLOAT", 5.0, 0.05, 120.0, "Seconds for foam on water to fade to 37%")
    life_dry = t.input("Lifetime Dry", "FLOAT", 25.0, 0.05, 600.0, "Seconds for foam stranded on sand to fade")
    spread = t.input("Spread", "INT", 1, 0, 20, "Blur steps per frame; foam disperses")
    drift = t.input("Drift", "VECTOR", (0.0, 0.0, 0.0), description="Metres per second the foam is carried")

    with t.section("Simulation: last frame's foam"):
        sim_in, sim_out = _simulation_zone(t, geo)
        dt = t.out(sim_in, 0)
        previous = Socket(t, sim_in.outputs["Geometry"])
        old_foam, _ = t.named("sf_foam")
        by_index = t.out(t.node("GeometryNodeSampleIndex", {"Geometry": previous, "Value": old_foam, "Index": t.index()}))
        rest_attr, has_rest = t.named("sf_rest", "FLOAT_VECTOR")
        rest = t.out(t.node("GeometryNodeSwitch", {"Switch": has_rest, "False": t.position(), "True": rest_attr},
                            input_type="VECTOR"))
        rest_mesh = t.set_position(previous, position=rest)
        upstream = rest - drift * dt                     # semi-Lagrangian: look back along the drift
        advected = t.out(t.node("GeometryNodeSampleNearestSurface",
                                {"Mesh": rest_mesh, "Value": old_foam, "Sample Position": upstream}))
        moving = t.greater(t.length(drift), 1e-5)
        carried = t.out(t.node("GeometryNodeSwitch", {"Switch": moving, "False": by_index, "True": advected},
                               input_type="FLOAT"))

    with t.section("Spread, fade, add new foam"):
        current = t.store(geo, "sf_foam_prev", carried)
        prev_field, _ = t.named("sf_foam_prev")
        blurred = t.out(t.node("GeometryNodeBlurAttribute", {"Value": prev_field, "Iterations": spread, "Weight": 1.0}))
        wet_value, has_wet = t.named(wet_name)
        wet = t.out(t.node("GeometryNodeSwitch", {"Switch": has_wet, "False": 1.0, "True": wet_value}, input_type="FLOAT"))
        life = life_dry + (life_wet - life_dry) * wet
        fade = t.exp(0.0 - dt / t.max(life, 0.01))
        source, _ = t.named(source_name)
        foam = t.max(blurred * fade, t.clamp(source))
        current = t.store(current, "sf_foam", foam)
        current = t.remove_attributes(current, "sf_foam_prev")
        t.link(current, sim_out.inputs["Geometry"])
        t._place(sim_out, [current])
    t.output("Geometry", "GEOMETRY", Socket(t, sim_out.outputs["Geometry"]))
    return t.finish()


def spray():
    t = Tree("SF Spray", description=(
        "Throws ballistic droplets from the sf_spray attribute (breaking lips) and adds them "
        "to the geometry as small spheres. Simulated, so play or bake from the start frame."))
    geo = t.input("Geometry", "GEOMETRY")
    weight_name = t.input("Weight Attribute", "STRING", "sf_spray", description="Float attribute: where to throw droplets from")
    rate = t.input("Rate", "FLOAT", 12.0, 0.0, 1000.0, "Droplets per square metre per second at full weight")
    up = t.input("Up Speed", "FLOAT", 3.5, 0.0, 30.0, "Upward launch speed, m/s")
    throw = t.input("Throw", "VECTOR", (0.0, 3.0, 0.0), description="Extra launch velocity, m/s (toward the beach)")
    jitter = t.input("Jitter", "FLOAT", 1.2, 0.0, 10.0, "Random spread of launch velocity, m/s")
    lifetime = t.input("Lifetime", "FLOAT", 1.1, 0.05, 10.0, "Seconds a droplet lives")
    size = t.input("Size", "FLOAT", 0.09, 0.001, 2.0, "Droplet radius in metres")
    material = t.input("Material", "MATERIAL", description="Material for the droplets, e.g. SF Spray")

    with t.section("Emit"):
        sim_in, sim_out = _simulation_zone(t)
        dt = t.out(sim_in, 0)
        _, frame = t.scene_time()
        seed = t.out(t.node("FunctionNodeFloatToInt", [frame]))
        weight, _ = t.named(weight_name)
        dist = t.node("GeometryNodeDistributePointsOnFaces",
                      {"Mesh": geo, "Density": weight * rate * dt, "Seed": seed}, distribute_method="RANDOM")
        # Distributed points inherit every water attribute; droplets need none.
        emitted = t.remove_attributes(t.out(dist), "sf_*", wildcard=True)
        normal = t.out(dist, 1)
        rnd = t.node("FunctionNodeRandomValue", [], data_type="FLOAT_VECTOR")
        t.link((-1.0, -1.0, -0.3), rnd.inputs[0])
        t.link((1.0, 1.0, 1.0), rnd.inputs[1])
        t.link(seed, rnd.inputs[8])
        launch = normal * 1.5 + throw + t.vec(0.0, 0.0, up) + t.out(rnd) * jitter
        emitted = t.store(emitted, "sf_vel", launch)
        rnd_size = t.node("FunctionNodeRandomValue", [], data_type="FLOAT")
        t.link(0.5, rnd_size.inputs[2])
        t.link(1.5, rnd_size.inputs[3])
        emitted = t.store(emitted, "sf_size", t.out(rnd_size, 1) * size)
        emitted = t.store(emitted, "sf_age", 0.0)

    with t.section("Fly and die"):
        drops = t.join(Socket(t, sim_in.outputs["Geometry"]), emitted)
        vel, _ = t.named("sf_vel", "FLOAT_VECTOR")
        drops = t.store(drops, "sf_vel", vel * t.exp(0.0 - dt * 0.4) + t.vec(0.0, 0.0, -GRAVITY) * dt)
        moved, _ = t.named("sf_vel", "FLOAT_VECTOR")
        drops = t.set_position(drops, offset=moved * dt)
        age, _ = t.named("sf_age")
        drops = t.store(drops, "sf_age", age + dt)
        old, _ = t.named("sf_age")
        drops = t.out(t.node("GeometryNodeDeleteGeometry", {"Geometry": drops, "Selection": t.greater(old, lifetime)},
                             domain="POINT"))
        t.link(drops, sim_out.inputs["Geometry"])
        t._place(sim_out, [drops])

    with t.section("Draw as droplets"):
        particles = Socket(t, sim_out.outputs["Geometry"])
        sphere = t.out(t.node("GeometryNodeMeshIcoSphere", {"Radius": 1.0, "Subdivisions": 1}))
        p_age, _ = t.named("sf_age")
        p_size, _ = t.named("sf_size")
        scale = p_size * (1.0 - 0.6 * p_age / lifetime)
        inst = t.out(t.node("GeometryNodeInstanceOnPoints", {"Points": particles, "Instance": sphere, "Scale": scale}))
        droplets = t.out(t.node("GeometryNodeRealizeInstances", {"Geometry": inst}))
        droplets = t.out(t.node("GeometryNodeSetMaterial", {"Geometry": droplets, "Material": material}))
        joined = t.join(geo, droplets)
    t.output("Geometry", "GEOMETRY", joined)
    return t.finish()


def beach():
    t = Tree("SF Beach", description=(
        "A sand beach matching SF Shore Waves: plane slope, flat sea floor, small ripples. "
        "Ignores its input geometry, so put it on any mesh object."))
    t.input("Geometry", "GEOMETRY")
    width = t.input("Width", "FLOAT", 120.0, 1.0, 5000.0, "Along the shoreline (X)")
    land = t.input("Land", "FLOAT", 30.0, 0.0, 1000.0, "Dry beach behind the shoreline")
    sea = t.input("Sea", "FLOAT", 150.0, 0.0, 5000.0, "Sea floor in front of the shoreline")
    spacing = t.input("Spacing", "FLOAT", 0.5, 0.05, 10.0, "Grid spacing in metres")
    shore_y = t.input("Shoreline Y", "FLOAT", 0.0, description="Match SF Shore Waves")
    slope = t.input("Beach Slope", "FLOAT", 1 / 15, 0.005, 0.5, "Match SF Shore Waves")
    depth = t.input("Offshore Depth", "FLOAT", 8.0, 0.5, 100.0, "Match SF Shore Waves")
    ripples = t.input("Ripples", "FLOAT", 0.04, 0.0, 1.0, "Height of sand ripples in metres")
    material = t.input("Material", "MATERIAL", description="Material for the sand, e.g. SF Sand")

    with t.section("Sand surface"):
        length = land + sea
        nx = t.out(t.node("FunctionNodeFloatToInt", [width / spacing + 1.0]))
        ny = t.out(t.node("FunctionNodeFloatToInt", [length / spacing + 1.0]))
        grid = t.out(t.node("GeometryNodeMeshGrid", {"Size X": width, "Size Y": length, "Vertices X": nx, "Vertices Y": ny}))
        p = t.position()
        y = p.y + shore_y + (land - sea) * 0.5
        ripple = t.noise(vector=t.vec(p.x * 0.35, y * 1.4, 0.0), scale=1.0, detail=3.0) - 0.5
        z = t.max((y - shore_y) * slope, 0.0 - depth) + ripple * ripples * 2.0
        sand = t.set_position(grid, position=t.vec(p.x, y, z))
        sand = t.store(sand, "sf_shore_distance", y - shore_y)
        sand = t.out(t.node("GeometryNodeSetShadeSmooth", {"Geometry": sand}))
        sand = t.out(t.node("GeometryNodeSetMaterial", {"Geometry": sand, "Material": material}))
    t.output("Geometry", "GEOMETRY", sand)
    return t.finish()


BUILDERS = {
    "SF Gerstner Ocean": gerstner_ocean,
    "SF Shore Waves": shore_waves,
    "SF Foam Accumulate": foam_accumulate,
    "SF Spray": spray,
    "SF Beach": beach,
}
