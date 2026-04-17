"""2D mesh visualization with cell-colored fields.

Reads simulation results from `store` (populated by solver code).
The timeline slider injects `time_step`, and `field_name` can be
edited below or selected from store.fields.

Usage (in a model/solver card first):
    Q, Qaux = solver.solve(mesh, model)
    store.save(mesh, model, Q, Qaux)
"""
import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
from matplotlib.cm import ScalarMappable
from matplotlib.colors import Normalize
import numpy as np

# --- Controls (edit these, or use slider) ---
if "field_name" not in dir():
    field_name = None       # None = auto-select first field
if "time_step" not in dir():
    time_step = 0
colormap = "viridis"

# --- Load data from store ---
data = store.data
if not data or data.get("coords") is None:
    print("No simulation data available.")
    print("Run a simulation first, then call:")
    print("  store.save(mesh, model, Q, Qaux)")
else:
    fields_list = store.fields
    if field_name is None:
        field_name = fields_list[0] if fields_list else "q0"

    values = store.get_field(field_name, time_step=int(time_step))
    vertices = data.get("vertices")
    cells = data.get("cells")
    coords = data["coords"]
    n_snaps = data.get("n_snapshots", 0)
    t_label = f"step {int(time_step)}/{n_snaps - 1}" if n_snaps > 0 else "final"

    if values is None:
        print(f"Field '{field_name}' not found. Available: {fields_list}")
    elif vertices is not None and cells is not None and data.get("dim", 1) >= 2:
        # 2D mesh plot
        polygons = [vertices[cell] for cell in cells]

        fig, ax = plt.subplots(1, 1, figsize=(7, 6))
        norm = Normalize(vmin=values.min(), vmax=values.max())
        colors = plt.get_cmap(colormap)(norm(values))

        collection = PolyCollection(polygons, facecolors=colors, edgecolors="black", linewidths=0.4)
        ax.add_collection(collection)
        ax.set_xlim(vertices[:, 0].min(), vertices[:, 0].max())
        ax.set_ylim(vertices[:, 1].min(), vertices[:, 1].max())
        ax.set_aspect("equal")
        ax.set_title(f"{field_name}  —  {t_label}")

        sm = ScalarMappable(cmap=colormap, norm=norm)
        sm.set_array([])
        fig.colorbar(sm, ax=ax, shrink=0.8, label=field_name)
    else:
        # 1D line plot fallback
        x = coords[:, 0] if coords.ndim > 1 else np.arange(len(values))
        fig, ax = plt.subplots(1, 1, figsize=(7, 4))
        ax.plot(x, values, "-o", markersize=2)
        ax.set_title(f"{field_name}  —  {t_label}")
        ax.set_xlabel("x")
        ax.set_ylabel(field_name)

    print(f"Fields: {fields_list}")
    if n_snaps > 0:
        print(f"Snapshots: {n_snaps} (use slider)")
