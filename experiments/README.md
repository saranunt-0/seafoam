# Experiments

Small, reproducible experiments behind the research notes. Figures land in `figures/`.

| Script | Question | Needs |
|---|---|---|
| [`shoaling.py`](shoaling.py) | Where and how does a wave break on a sloping beach? Linear shoaling, the 0.78 limit, Iribarren breaker types | numpy, matplotlib |
| [`swe_runup.py`](swe_runup.py) | What do shallow-water waves do on a beach, and which breaking detector puts foam in the right place? 1D nonlinear shallow-water solver with wetting and drying, plus advected foam | numpy, matplotlib (~1 min) |
| [`blender_breaker_profiles.py`](blender_breaker_profiles.py) | Does the Blender `SF Shore Waves` node curl, and how do Curl and Lean change the profile? | `bpy` (Python 3.11), matplotlib |

```sh
python experiments/shoaling.py
python experiments/swe_runup.py
python experiments/blender_breaker_profiles.py      # with the bpy module: pip install bpy (Python 3.11)
```

Results are discussed in [`docs/breaking-waves.md`](../docs/breaking-waves.md).
