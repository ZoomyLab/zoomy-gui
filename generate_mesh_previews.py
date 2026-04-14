"""Generate mesh preview SVGs and cards/meshes/generated.json.

Uses the MeshCatalog to discover meshes — the same source of truth
that the GUI uses at runtime. Downloads meshes, generates 2D SVGs,
and writes card entries with templates that use MeshCatalog.load().

Usage:
    python generate_mesh_previews.py
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


def main():
    from zoomy_core.mesh.mesh_catalog import MeshCatalog

    print("Fetching mesh catalog...")
    catalog = MeshCatalog(auto_fetch=True)
    cards = []

    for name in catalog.names():
        entry = catalog.get(name)
        parts = name.split("__")
        title = parts[-1].replace("_", " ").title() if len(parts) > 1 else name.replace("_", " ").title()
        category = parts[0].replace("_", " ").title() if len(parts) > 1 else ""

        card_id = f"catalog-{name}"
        preview_name = f"{card_id}.svg"
        preview_path = os.path.join(PREVIEW_DIR, preview_name)

        # Template uses MeshCatalog — single source of truth
        template = (
            f'from zoomy_core.mesh.mesh_catalog import MeshCatalog\n'
            f'\n'
            f'mesh = MeshCatalog().load("{name}")\n'
        )

        # Try to download and generate preview
        has_preview = False
        for fmt in ["msh", "h5"]:
            if fmt in entry.types:
                try:
                    print(f"  {name} ({fmt})...", end=" ")
                    mesh_path = catalog.download(name, filetype=fmt)
                    if fmt == "msh":
                        plot_mesh_2d(str(mesh_path), preview_path)
                        has_preview = True
                        print("OK")
                    else:
                        print("skip (h5, no preview)")
                    break
                except Exception as e:
                    print(f"SKIP ({e})")

        card = {
            "id": card_id,
            "title": title,
            "source": "catalog",
            "category": category,
            "mesh_name": name,
            "mesh_sizes": entry.sizes or [],
            "description": f"{category}: {title}" if category else title,
            "template": template,
        }
        if has_preview:
            card["preview"] = "previews/" + preview_name
        cards.append(card)

    with open(GENERATED_JSON, "w") as f:
        json.dump(cards, f, indent=2)

    print(f"\nWrote {len(cards)} cards to {GENERATED_JSON}")


if __name__ == "__main__":
    main()
