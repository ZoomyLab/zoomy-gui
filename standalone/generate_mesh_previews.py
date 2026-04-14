"""Generate mesh preview SVGs and update cards/meshes/generated.json.

Scans the meshes repository for .msh files, generates 2D SVG previews,
and writes card entries to generated.json for the GUI.

Usage:
    python generate_mesh_previews.py
"""

import os
import glob
import json
import meshio
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
import numpy as np

MESH_DIRS = [
    (os.path.join(os.path.dirname(__file__), "..", "..", "..", "meshes"), "meshes"),
]
PREVIEW_DIR = os.path.join(os.path.dirname(__file__), "previews")
GENERATED_JSON = os.path.join(os.path.dirname(__file__), "cards", "meshes", "generated.json")

os.makedirs(PREVIEW_DIR, exist_ok=True)
os.makedirs(os.path.dirname(GENERATED_JSON), exist_ok=True)


def plot_mesh_2d(mesh, output_path):
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


def main():
    cards = []

    for base_dir, label in MESH_DIRS:
        if not os.path.isdir(base_dir):
            print(f"Skipping {base_dir} (not found)")
            continue

        msh_files = sorted(glob.glob(os.path.join(base_dir, "**", "*.msh"), recursive=True))
        for msh_path in msh_files:
            if "/old/" in msh_path:
                continue

            rel = os.path.relpath(msh_path, base_dir)
            # Card ID from path: channel_quad_2d/mesh.msh → mesh-gen-channel_quad_2d-mesh
            card_id = "mesh-gen-" + rel.replace(os.sep, "-").replace(".msh", "")
            # Title: last folder + filename
            parts = rel.replace(".msh", "").split(os.sep)
            title = " / ".join(p.replace("_", " ").title() for p in parts)
            # Category from first folder
            category = parts[0].replace("_", " ").title() if len(parts) > 1 else ""

            # Preview SVG
            preview_name = card_id + ".svg"
            preview_path = os.path.join(PREVIEW_DIR, preview_name)

            print(f"  {rel}...", end=" ")
            try:
                mesh = meshio.read(msh_path)
                plot_mesh_2d(mesh, preview_path)
                print("OK")
            except Exception as e:
                print(f"SKIP ({e})")
                preview_name = None

            card = {
                "id": card_id,
                "title": title,
                "source": "generated",
                "category": category,
                "description": f"{category}: {title}" if category else title,
                "mesh_file": msh_path,
            }
            if preview_name:
                card["preview"] = "previews/" + preview_name
            cards.append(card)

    with open(GENERATED_JSON, "w") as f:
        json.dump(cards, f, indent=2)

    print(f"\nWrote {len(cards)} cards to {GENERATED_JSON}")


if __name__ == "__main__":
    main()
