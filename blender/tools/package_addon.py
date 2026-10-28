"""Zip blender/seafoam_nodes into blender/seafoam_nodes.zip for Install from Disk.

    python blender/tools/package_addon.py
"""

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "seafoam_nodes"
TARGET = ROOT / "seafoam_nodes.zip"


def package():
    files = sorted(p for p in SOURCE.rglob("*.py"))
    with zipfile.ZipFile(TARGET, "w", zipfile.ZIP_DEFLATED) as z:
        for path in files:
            # Fixed timestamps keep the zip byte-identical when nothing changed.
            info = zipfile.ZipInfo(str(path.relative_to(ROOT)), date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            z.writestr(info, path.read_bytes())
    return TARGET, files


if __name__ == "__main__":
    target, files = package()
    print(f"Wrote {target} ({len(files)} files)")
