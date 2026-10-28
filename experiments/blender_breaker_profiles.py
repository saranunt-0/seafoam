"""Experiment C: does the SF Shore Waves node actually curl?

Evaluates the Blender node on a narrow strip of water and plots the
cross-section of one crest as it shoals, curls, plunges and runs up the
beach, for four shape models:

    Gerstner + lean      curl 0            (Fournier & Reeves tilt: steep front, no lip)
    small curl           curl 0.5
    default curl         curl 1.0          (the lip rotates about 150 degrees over a pivot)
    big curl             curl 1.6

Run with Blender's Python (pip install bpy on Python 3.11, plus matplotlib):
    python experiments/blender_breaker_profiles.py
"""

import math
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "blender"))

import bpy  # noqa: E402
import numpy as np  # noqa: E402

import seafoam_nodes  # noqa: E402
from seafoam_nodes import scenes  # noqa: E402

G = 9.81
SLOPE, DEPTH, PERIOD = 1 / 15, 8.0, 8.0
CREST_AT = (46, 36, 31, 28, 25, 21, 15, 8, 2)     # metres seaward of the shoreline
MODELS = (
    ("Gerstner + lean", 0.0, 0.7),
    ("small curl", 0.5, 0.7),
    ("default curl", 1.0, 0.7),
    ("big curl", 1.6, 0.7),
)


def travel_time(s):
    """Same expression as the node: time for a crest at s to reach the shoreline."""
    s_flat = DEPTH / SLOPE
    return 2 * math.sqrt(min(max(s, 0), s_flat)) / math.sqrt(G * SLOPE) + max(s - s_flat, 0) / math.sqrt(G * DEPTH)


def profiles(curl, lean):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    seafoam_nodes.build_all()
    strip = scenes.grid_mesh("Strip", 1.0, -60.0, 14.0, 0.05)
    obj = bpy.data.objects.new("Strip", strip)
    bpy.context.scene.collection.objects.link(obj)
    scenes.add_modifier(obj, "SF Shore Waves", Curl=curl, Lean=lean, Irregularity=0.0, Wave_Angle=0.0,
                        Beach_Slope=SLOPE, Offshore_Depth=DEPTH, Wave_Period=PERIOD)
    scene = bpy.context.scene
    fps = scene.render.fps
    result = []
    for s in CREST_AT:
        t = 6 * PERIOD - travel_time(s)          # crest phase 0 sits at s at this time
        frame = t * fps
        scene.frame_set(int(frame), subframe=frame - int(frame))
        mesh = obj.evaluated_get(bpy.context.evaluated_depsgraph_get()).data
        co = np.zeros(len(mesh.vertices) * 3)
        mesh.vertices.foreach_get("co", co)
        co = co.reshape(-1, 3)
        rest = np.zeros(len(mesh.vertices) * 3)
        mesh.attributes["sf_rest"].data.foreach_get("vector", rest)
        rest = rest.reshape(-1, 3)
        row = (np.abs(rest[:, 0]) < 1e-3) & (rest[:, 1] < -1.0)   # centre line, sea only
        order = np.argsort(rest[row, 1])               # walk the surface in its own order: shows folds
        result.append((s, co[row][order]))
    return result


def main():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    seafoam_nodes.register()
    fig, axes = plt.subplots(len(MODELS), 1, figsize=(10, 2.6 * len(MODELS)), dpi=130, sharex=True)
    cmap = plt.get_cmap("viridis")
    for ax, (title, curl, lean) in zip(axes, MODELS):
        overhangs = 0
        for i, (s, pts) in enumerate(profiles(curl, lean)):
            y, z = pts[:, 1], pts[:, 2]
            ax.plot(y, z, color=cmap(i / (len(CREST_AT) - 1)), lw=1.2)
            overhangs += int((np.diff(y) < -0.01).sum() > 0)
        bed = np.linspace(-60, 14, 200)
        ax.fill_between(bed, np.maximum(bed * SLOPE, -DEPTH), -3, color="#d9c49b", zorder=0)
        ax.set_ylim(-2.6, 2.4)
        ax.set_xlim(-50, 13)
        ax.set_aspect(2.5)
        ax.set_title(f"{title}: curl {curl}, lean {lean}  ({overhangs} of {len(CREST_AT)} moments overturn)", fontsize=9)
        print(f"{title:<24} overturning profiles: {overhangs}/{len(CREST_AT)}")
    axes[-1].set_xlabel("y (m), shoreline at 0, waves travel to the right   (vertical exaggeration x2.5)")
    fig.suptitle("One crest through the break zone, early (purple) to late (yellow)", fontsize=10)
    fig.tight_layout()
    out = Path(__file__).parent / "figures" / "blender_breaker_profiles.png"
    fig.savefig(out)
    print(f"Figure written to {out}", flush=True)
    os._exit(0)   # bpy as a module can hang on normal interpreter exit


main()
