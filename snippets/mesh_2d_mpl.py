import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
from matplotlib.cm import ScalarMappable
from matplotlib.colors import Normalize
import numpy as np

# --- Mesh data (replace with your own or load from zoomy) ---
# Example: 10x10 quad mesh on [0,1]^2
nx, ny = 10, 10
x = np.linspace(0, 1, nx + 1)
y = np.linspace(0, 1, ny + 1)
xx, yy = np.meshgrid(x, y)
vertices = np.column_stack([xx.ravel(), yy.ravel()])

# Build quad cells (each cell = 4 vertex indices)
cells = []
for j in range(ny):
    for i in range(nx):
        n0 = j * (nx + 1) + i
        cells.append([n0, n0 + 1, n0 + nx + 2, n0 + nx + 1])
cells = np.array(cells)

# Example fields: one value per cell, multiple time steps
n_cells = len(cells)
n_steps = 100  # matches slider range 0-99
cell_centers = np.array([vertices[c].mean(0) for c in cells])

fields = {
    "pressure": np.array([
        np.sin(2 * np.pi * (cell_centers[:, 0] + t / n_steps))
        for t in range(n_steps)
    ]),
    "velocity": np.array([
        np.cos(np.pi * cell_centers[:, 1]) * (1 + t / n_steps)
        for t in range(n_steps)
    ]),
}

# --- User controls ---
field_name = "pressure"   # change to "velocity" etc.
# time_step is injected by the timeline slider (0-100)
if "time_step" not in dir():
    time_step = 0
time_step = min(int(time_step), n_steps - 1)
colormap = "viridis"

# --- Render ---
values = fields[field_name][time_step]
polygons = [vertices[cell] for cell in cells]

fig, ax = plt.subplots(1, 1, figsize=(7, 6))
norm = Normalize(vmin=fields[field_name].min(), vmax=fields[field_name].max())
colors = plt.get_cmap(colormap)(norm(values))

collection = PolyCollection(polygons, facecolors=colors, edgecolors="black", linewidths=0.4)
ax.add_collection(collection)
ax.set_xlim(vertices[:, 0].min(), vertices[:, 0].max())
ax.set_ylim(vertices[:, 1].min(), vertices[:, 1].max())
ax.set_aspect("equal")
ax.set_title(f"{field_name}  —  step {time_step}/{n_steps - 1}")

sm = ScalarMappable(cmap=colormap, norm=norm)
sm.set_array([])
fig.colorbar(sm, ax=ax, shrink=0.8, label=field_name)

display(fig)
