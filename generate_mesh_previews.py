"""Generate mesh preview SVGs and cards/meshes/generated.json.

Scans the meshes/ directory for .msh files produced by run.sh,
generates SVG previews (2D or 3D), and writes GUI card entries.

Prerequisites:
    - Run meshes/run.sh first to generate .msh files from .geo sources
    - Requires: meshio, matplotlib, numpy

Usage:
    python generate_mesh_previews.py            # incremental (skip up-to-date)
    python generate_mesh_previews.py --force    # rebuild all previews
"""

import os
import json
import sys

# Add zoomy_core to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "library", "zoomy_core"))

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
import numpy as np

PREVIEW_DIR = os.path.join(os.path.dirname(__file__), "previews")
GENERATED_JSON = os.path.join(os.path.dirname(__file__), "cards", "meshes", "generated.json")

os.makedirs(PREVIEW_DIR, exist_ok=True)
os.makedirs(os.path.dirname(GENERATED_JSON), exist_ok=True)


_3D_CELL_TYPES = {"tetra", "hexahedron", "wedge", "pyramid"}
_2D_CELL_TYPES = {"triangle", "quad"}

# Face definitions for extracting boundary surfaces from 3D cells
_FACE_DEFS = {
    "tetra": [[0,1,2], [0,1,3], [0,2,3], [1,2,3]],
    "hexahedron": [[0,1,2,3], [4,5,6,7], [0,1,5,4], [2,3,7,6], [0,3,7,4], [1,2,6,5]],
    "wedge": [[0,1,2], [3,4,5], [0,1,4,3], [1,2,5,4], [0,2,5,3]],
    "pyramid": [[0,1,2,3], [0,1,4], [1,2,4], [2,3,4], [3,0,4]],
}


def _is_3d_mesh(mesh):
    """Check if mesh has 3D cells."""
    for cell_block in mesh.cells:
        if cell_block.type in _3D_CELL_TYPES:
            return True
    return False


def _extract_surface_faces(mesh):
    """Extract boundary faces from 3D cells (faces that appear only once)."""
    from collections import Counter
    face_count = Counter()
    face_map = {}

    for cell_block in mesh.cells:
        face_defs = _FACE_DEFS.get(cell_block.type)
        if not face_defs:
            # 2D cells are surface faces themselves
            if cell_block.type in _2D_CELL_TYPES:
                for cell in cell_block.data:
                    key = tuple(sorted(cell))
                    face_count[key] += 1
                    face_map[key] = cell
            continue
        for cell in cell_block.data:
            for fi in face_defs:
                face_nodes = cell[fi]
                key = tuple(sorted(face_nodes))
                face_count[key] += 1
                face_map[key] = face_nodes

    # Boundary faces appear exactly once
    return [face_map[k] for k, cnt in face_count.items() if cnt == 1]


def plot_mesh_3d(mesh_path, output_path):
    import meshio
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection
    mesh = meshio.read(mesh_path)
    points = mesh.points

    fig = plt.figure(figsize=(6, 5))
    ax = fig.add_subplot(111, projection="3d")

    surface_faces = _extract_surface_faces(mesh)
    if surface_faces:
        polygons = [points[f] for f in surface_faces]
        collection = Poly3DCollection(
            polygons, edgecolors="black", facecolors="#b3d9ff",
            linewidths=0.3, alpha=0.4
        )
        ax.add_collection3d(collection)
    else:
        ax.scatter(points[:, 0], points[:, 1], points[:, 2], s=1, c="black")

    ax.set_xlim(points[:, 0].min(), points[:, 0].max())
    ax.set_ylim(points[:, 1].min(), points[:, 1].max())
    ax.set_zlim(points[:, 2].min(), points[:, 2].max())
    ax.view_init(elev=30, azim=45)
    try:
        ax.set_box_aspect([1, 1, 1])
    except AttributeError:
        pass  # older matplotlib
    ax.axis("off")
    fig.savefig(output_path, format="svg", bbox_inches="tight", transparent=True)
    plt.close(fig)


def plot_mesh_2d(mesh_path, output_path):
    import meshio
    mesh = meshio.read(mesh_path)
    points = mesh.points[:, :2]
    fig, ax = plt.subplots(1, 1, figsize=(6, 4))
    for cell_block in mesh.cells:
        if cell_block.type in ("triangle", "quad"):
            polygons = [points[cell] for cell in cell_block.data]
            collection = PolyCollection(
                polygons, edgecolors="black", facecolors="none", linewidths=0.3
            )
            ax.add_collection(collection)
    ax.set_xlim(points[:, 0].min(), points[:, 0].max())
    ax.set_ylim(points[:, 1].min(), points[:, 1].max())
    ax.set_aspect("equal")
    ax.axis("off")
    fig.savefig(output_path, format="svg", bbox_inches="tight", transparent=True)
    plt.close(fig)


def plot_mesh(mesh_path, output_path):
    """Auto-detect 2D vs 3D and plot accordingly."""
    import meshio
    mesh = meshio.read(mesh_path)
    if _is_3d_mesh(mesh):
        plot_mesh_3d(mesh_path, output_path)
    else:
        plot_mesh_2d(mesh_path, output_path)


MESHES_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "..", "meshes")
BLACKLIST = {"old", "test"}

# Pretty category names
CATEGORY_NAMES = {
    "basic_shapes": "Basic Shapes",
    "channels": "Channels",
    "curved": "Curved Geometries",
    "structural": "Structural",
    "volumes": "3-D Volumes",
    "complex": "Complex Assemblies",
    "square": "Square",
    "channel_quad_2d": "Channel Quad 2D",
}


def _scan_msh_files():
    """Walk the meshes/ directory tree and collect all .msh files.

    Returns list of (category, variant, msh_path) tuples.
    The structure mirrors run.sh: top-level dirs are categories,
    sub-dirs are geometry variants, .msh files are the meshes.
    """
    meshes_dir = os.path.normpath(MESHES_DIR)
    if not os.path.isdir(meshes_dir):
        print(f"Meshes directory not found: {meshes_dir}")
        return []

    entries = []

    for root, dirs, files in os.walk(meshes_dir):
        # Skip blacklisted directories (matches run.sh behaviour)
        dirs[:] = sorted(d for d in dirs if d not in BLACKLIST)

        for f in sorted(files):
            if not f.endswith(".msh"):
                continue

            msh_path = os.path.join(root, f)
            rel = os.path.relpath(root, meshes_dir)
            parts = rel.split(os.sep)

            # Top-level category is first directory
            category = parts[0] if parts[0] != "." else ""
            # Variant is the sub-path + filename (without extension)
            variant_parts = parts[1:] if len(parts) > 1 else []
            variant_parts.append(f.replace(".msh", ""))
            variant = "/".join(variant_parts)

            entries.append((category, variant, msh_path))

    return entries


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Generate mesh preview SVGs")
    parser.add_argument("--force", action="store_true",
                        help="Force rebuild all previews (default: incremental)")
    args = parser.parse_args()

    print("Scanning meshes/ for .msh files...")
    print("  (Run meshes/run.sh first if you need to regenerate from .geo sources)\n")

    entries = _scan_msh_files()
    if not entries:
        print("No .msh files found. Run meshes/run.sh to generate them.")
        return

    cards = []
    seen_ids = set()
    n_skipped = 0
    n_generated = 0

    for category, variant, msh_path in entries:
        cat_label = CATEGORY_NAMES.get(category, category.replace("_", " ").title())
        variant_label = variant.replace("_", " ").replace("/", " / ").title()
        title = variant_label

        card_id = f"mesh-gen-{category}-{variant}".replace("/", "-").replace(" ", "-").lower()
        card_id = card_id.replace("--", "-").strip("-")
        if card_id in seen_ids:
            continue
        seen_ids.add(card_id)

        preview_name = f"{card_id}.svg"
        preview_path = os.path.join(PREVIEW_DIR, preview_name)

        # Incremental: skip if preview exists and is newer than the .msh file
        has_preview = os.path.exists(preview_path)
        if has_preview and not args.force:
            if os.path.getmtime(preview_path) >= os.path.getmtime(msh_path):
                n_skipped += 1
            else:
                has_preview = False  # stale, regenerate

        if not has_preview or args.force:
            try:
                print(f"  {card_id}...", end=" ")
                plot_mesh(msh_path, preview_path)
                has_preview = True
                n_generated += 1
                print("OK")
            except Exception as e:
                has_preview = False
                print(f"SKIP ({e})")

        card = {
            "id": card_id,
            "title": title,
            "source": "generated",
            "category": cat_label,
            "description": f"{cat_label}: {title}" if cat_label else title,
            "mesh_file": os.path.abspath(msh_path),
        }
        if has_preview:
            card["preview"] = "previews/" + preview_name
        cards.append(card)

    with open(GENERATED_JSON, "w") as f:
        json.dump(cards, f, indent=2)

    print(f"\n{len(cards)} cards written to generated.json")
    print(f"  {n_generated} previews generated, {n_skipped} up-to-date (skipped)")


if __name__ == "__main__":
    main()
