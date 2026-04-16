"""2D mesh visualization with cell-colored fields.

Reads simulation results from `store` (populated by solver code).
The timeline slider injects `time_step`, and `field_name` can be
edited below or selected from store.fields.

If no simulation has run yet, shows a demo with synthetic data.
"""
import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
from matplotlib.cm import ScalarMappable
from matplotlib.colors import Normalize
import numpy as np

# --- Controls (edit these, or use slider/selector) ---
if "field_name" not in dir():
    field_name = None       # None = auto-select first field
if "time_step" not in dir():
    time_step = 0
colormap = "viridis"

# --- Load data from store or generate demo ---
data = store.data if store.data else {}

if data and data.get("coords") is not None:
    # Real simulation data
    fields_list = store.fields
    if field_name is None:
        field_name = fields_list[0] if fields_list else "q0"

    values = store.get_field(field_name, time_step=int(time_step))
    coords = data["coords"]
    vertices = data.get("vertices")
    cells = data.get("cells")
    n_snaps = data.get("n_snapshots", 0)
    t_label = f"step {int(time_step)}/{n_snaps - 1}" if n_snaps > 0 else "final"
    all_fields = fields_list

    if values is None:
        print(f"Field '{field_name}' not found. Available: {fields_list}")
        values = np.zeros(data["n_cells"])

else:
    # Demo data: 8x8 quad mesh
    print("No simulation data in store. Showing demo.")
    print("Run a simulation first, then call: store.save(mesh, model, Q, Qaux)")
    nx, ny = 8, 8
    x = np.linspace(0, 1, nx + 1)
    y = np.linspace(0, 1, ny + 1)
    xx, yy = np.meshgrid(x, y)
    vertices = np.column_stack([xx.ravel(), yy.ravel()])
    cells_list = []
    for j in range(ny):
        for i in range(nx):
            n0 = j * (nx + 1) + i
            cells_list.append([n0, n0 + 1, n0 + nx + 2, n0 + nx + 1])
    cells = np.array(cells_list)
    coords = np.array([vertices[c].mean(0) for c in cells])
    n_steps = 100
    phase = 2 * np.pi * int(time_step) / max(n_steps, 1)
    values = np.sin(2 * np.pi * coords[:, 0] + phase)
    field_name = "demo (sin wave)"
    t_label = f"step {int(time_step)}/99"
    n_snaps = 100
    all_fields = ["demo (sin wave)"]

# --- Render ---
if vertices is not None and cells is not None:
    polygons = [vertices[cell] for cell in cells]
else:
    # 1D fallback: bar chart
    fig, ax = plt.subplots(1, 1, figsize=(7, 4))
    ax.bar(range(len(values)), values, width=1.0, color=plt.get_cmap(colormap)(Normalize()(values)))
    ax.set_title(f"{field_name}  —  {t_label}")
    ax.set_xlabel("cell index")
    display(fig)
    polygons = None

if polygons is not None:
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

    display(fig)

# Print available fields for reference
print(f"Fields: {all_fields}")
if n_snaps > 0:
    print(f"Snapshots: {n_snaps} (use slider to change time step)")
