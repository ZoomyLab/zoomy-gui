import os
import glob
import meshio
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
import numpy as np

MESH_DIRS = [
    (os.path.join(os.path.dirname(__file__), "..", "..", "..", "meshes"), "meshes"),
]
OUTPUT_DIR = "previews"

os.makedirs(OUTPUT_DIR, exist_ok=True)


def plot_mesh_2d(mesh, output_path):
    points = mesh.points[:, :2]
    fig, ax = plt.subplots(1, 1, figsize=(6, 4))

    for cell_block in mesh.cells:
        if cell_block.type in ("triangle", "quad"):
            polygons = [points[cell] for cell in cell_block.data]
            collection = PolyCollection(polygons, edgecolors="black", facecolors="none", linewidths=0.3)
            ax.add_collection(collection)

    ax.set_xlim(points[:, 0].min(), points[:, 0].max())
    ax.set_ylim(points[:, 1].min(), points[:, 1].max())
    ax.set_aspect("equal")
    ax.axis("off")
    fig.savefig(output_path, format="svg", bbox_inches="tight", transparent=True)
    plt.close(fig)


def main():
    for base_dir, label in MESH_DIRS:
        msh_files = glob.glob(os.path.join(base_dir, "**", "*.msh"), recursive=True)
        for msh_path in msh_files:
            rel = os.path.relpath(msh_path, base_dir)
            name = rel.replace(os.sep, "_").replace(".msh", "")
            output_path = os.path.join(OUTPUT_DIR, f"mesh_{name}.svg")

            print(f"Generating preview for {msh_path}...")
            try:
                mesh = meshio.read(msh_path)
                plot_mesh_2d(mesh, output_path)
                print(f"  Saved to {output_path}")
            except Exception as e:
                print(f"  Failed: {e}")


if __name__ == "__main__":
    main()
