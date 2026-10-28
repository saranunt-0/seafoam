"""Build the Seafoam beach demo, find the best curl, render it and save a .blend.

    blender --background --factory-startup --python blender/demo/build_demo.py -- [options]
    python blender/demo/build_demo.py [options]          (bpy module, Python 3.11)

Options:
    --out DIR          where renders go (default: blender/demo/renders)
    --spacing M        water grid spacing in metres (default 0.25)
    --frames N         how many frames to simulate before picking the curl (default 150)
    --res WxH          still resolution (default 1280x720)
    --samples N        Cycles samples for stills (default 48)
    --animation N      also render N frames (low res) and make an MP4 and a GIF
    --animation-camera NAME   camera for the animation (default "SF Aerial Camera")
    --save PATH        save the scene as a .blend
"""

import math
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import seafoam_nodes  # noqa: E402
from seafoam_nodes import scenes  # noqa: E402


def option(name, default, cast=str):
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    if f"--{name}" in argv:
        return cast(argv[argv.index(f"--{name}") + 1])
    return default


def lip_of_current_frame(water, half_width):
    """Centre and strength of the curling lip, from the sf_spray attribute."""
    mesh = water.evaluated_get(bpy.context.evaluated_depsgraph_get()).data
    n = len(mesh.vertices)
    spray = np.zeros(n)
    mesh.attributes["sf_spray"].data.foreach_get("value", spray)
    co = np.zeros(n * 3)
    mesh.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    keep = (spray > 0.3) & (np.abs(co[:, 0]) < half_width)
    if keep.sum() < 20:
        return 0.0, None
    # The break peels along X, so take the 4 m stretch with the most lip, not the mean.
    bins = np.floor(co[keep, 0] / 4.0)
    mass = {b: spray[keep][bins == b].sum() for b in np.unique(bins)}
    peak = max(mass, key=mass.get)
    sel = bins == peak
    weights = spray[keep][sel]
    return float(mass[peak]), (co[keep][sel] * weights[:, None]).sum(axis=0) / weights.sum()


def render(scene, camera, path, res, samples):
    scene.camera = camera
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.cycles.samples = samples
    scene.render.filepath = str(path)
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f"  {path.name}: {time.time() - t0:.0f}s", flush=True)


def main():
    out = Path(option("out", str(ROOT / "demo" / "renders")))
    out.mkdir(parents=True, exist_ok=True)
    spacing = option("spacing", 0.25, float)
    frames = option("frames", 150, int)
    res = tuple(int(v) for v in option("res", "1280x720").split("x"))
    samples = option("samples", 48, int)
    animation = option("animation", 0, int)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    seafoam_nodes.register()
    water = scenes.build_beach_scene(spacing=spacing)
    scene = bpy.context.scene
    scene.cycles.device = "CPU"
    scene.frame_end = max(frames, animation)

    # 1. Simulate in order (foam and spray are simulation zones) and score each
    #    frame by how much curling lip is in the middle of the beach.
    print(f"Simulating {frames} frames...", flush=True)
    best = (0.0, None, 1)
    for f in range(1, frames + 1):
        scene.frame_set(f)
        if f >= 48:
            score, centre = lip_of_current_frame(water, half_width=30.0)
            if score > best[0]:
                best = (score, centre, f)
    score, centre, frame = best
    print(f"Best curl at frame {frame}, lip centre {np.round(centre, 1)}", flush=True)

    # 2. Aim a low "water photographer" camera at that lip from the unbroken
    #    shoulder (the break peels toward -X, so the shoulder is on that side).
    scene.frame_set(frame)
    barrel = bpy.data.objects["SF Barrel Camera"]
    cx, cy, cz = centre
    barrel.location = (cx - 14.0, cy + 7.0, 1.0)
    direction = np.subtract((cx + 3.0, cy - 1.5, cz * 0.8), barrel.location)
    barrel.rotation_euler = (math.atan2(math.hypot(direction[0], direction[1]), -direction[2]), 0.0,
                             math.atan2(direction[1], direction[0]) - math.pi / 2)

    # The beach camera stays on the sand but turns toward the curl.
    beach = bpy.data.objects["SF Beach Camera"]
    direction = np.subtract((cx + 6.0, cy, 1.4), beach.location)
    beach.rotation_euler = (math.atan2(math.hypot(direction[0], direction[1]), -direction[2]), 0.0,
                            math.atan2(direction[1], direction[0]) - math.pi / 2)

    print("Rendering stills...", flush=True)
    render(scene, barrel, out / "barrel.png", res, samples)
    render(scene, bpy.data.objects["SF Beach Camera"], out / "beach.png", res, samples)
    render(scene, bpy.data.objects["SF Aerial Camera"], out / "aerial.png", res, samples)

    save = option("save", None)
    if save:
        scene.camera = bpy.data.objects["SF Beach Camera"]
        bpy.ops.wm.save_as_mainfile(filepath=str(Path(save).resolve()), compress=True)
        print(f"Saved {save}", flush=True)

    # 3. Optional animation from the beach, frames rendered in simulation order.
    if animation:
        print(f"Rendering {animation} animation frames...", flush=True)
        seq = out / "frames"
        seq.mkdir(exist_ok=True)
        anim_camera = bpy.data.objects[option("animation-camera", "SF Aerial Camera")]
        for f in range(1, animation + 1):
            scene.frame_set(f)
            render(scene, anim_camera, seq / f"frame_{f:04d}.png", (640, 360), 12)
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg:
            subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-framerate", "24", "-i", str(seq / "frame_%04d.png"),
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", str(out / "animation.mp4")], check=True)
            subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-framerate", "24", "-i", str(seq / "frame_%04d.png"),
                            "-vf", "fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
                            str(out / "animation.gif")], check=True)
            shutil.rmtree(seq)
            print("Wrote animation.mp4 and animation.gif", flush=True)
    os._exit(0)   # bpy as a module can hang on normal interpreter exit


main()
