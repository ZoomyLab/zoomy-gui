"""Plotly mesh viewer — handles 1D/2D/3D uniformly with interactive navigation.

Reads from `store` (auto-populated after a simulation).
Timeline slider injects `time_step`, edit `field_name` to switch fields.

  1D → Scatter line plot
  2D → Mesh3d at z=0 with per-vertex coloring
  3D → Boundary surface via Mesh3d with camera controls
"""
import plotly.graph_objects as go
import numpy as np
from collections import Counter


def _resolve_field(store, field_name, time_step):
    d = store.data
    if not d: return None, None, 0, 0
    fl = store.fields
    if not fl: return None, None, 0, 0
    if field_name is None or field_name not in fl: field_name = fl[0]
    n_snaps = d.get("n_snapshots", 0)
    ts = 0 if n_snaps == 0 else max(0, min(int(time_step), n_snaps - 1))
    return store.get_field(field_name, time_step=ts), field_name, ts, n_snaps


def _triangulate(cells):
    """Fan-triangulate cells (quads/polys → tris)."""
    ii, jj, kk = [], [], []
    for cell in cells:
        if len(cell) < 3: continue
        for t in range(1, len(cell) - 1):
            ii.append(int(cell[0])); jj.append(int(cell[t])); kk.append(int(cell[t + 1]))
    return ii, jj, kk


def _boundary_faces_3d(cells):
    cells = np.asarray(cells)
    n_per = cells.shape[1] if len(cells.shape) > 1 else len(cells[0])
    if n_per == 4:
        face_defs = [[0,1,2],[0,1,3],[0,2,3],[1,2,3]]
    elif n_per == 8:
        face_defs = [[0,1,2,3],[4,5,6,7],[0,1,5,4],[2,3,7,6],[0,3,7,4],[1,2,6,5]]
    else: return [], []
    count, fmap, parent = Counter(), {}, {}
    for ci, cell in enumerate(cells):
        for fi in face_defs:
            nodes = [int(cell[k]) for k in fi]
            key = tuple(sorted(nodes))
            count[key] += 1
            fmap[key] = nodes
            parent[key] = ci
    faces, face_cells = [], []
    for k, c in count.items():
        if c == 1:
            faces.append(fmap[k]); face_cells.append(parent[k])
    return faces, face_cells


def _cell_to_vert_values(vertices, cells, cell_values):
    vv = np.zeros(len(vertices)); vc = np.zeros(len(vertices))
    for ci, cell in enumerate(cells):
        val = float(cell_values[ci]) if ci < len(cell_values) else 0.0
        for vi in cell:
            vv[int(vi)] += val; vc[int(vi)] += 1
    vc[vc == 0] = 1
    return vv / vc


# --- Controls ---
if "field_name" not in dir(): field_name = None
if "time_step" not in dir(): time_step = 0
colormap = "Viridis"

# --- Load data ---
data = store.data
if not data or data.get("Q") is None:
    print("No simulation data available.")
    print("Run a simulation first — results will be fetched automatically.")
    fig = None
else:
    values, field_name, ts, n_snaps = _resolve_field(store, field_name, time_step)
    if values is None:
        print("No fields to plot."); fig = None
    else:
        dim = data.get("dim", 1)
        t_label = f"step {ts}/{n_snaps - 1}" if n_snaps > 0 else "final"
        coords = data.get("coords")
        vertices = data.get("vertices")
        cells = data.get("cells")

        if dim == 1 and coords is not None:
            x = coords[:, 0] if coords.ndim > 1 else coords
            fig = go.Figure(go.Scatter(x=x.tolist(), y=np.asarray(values).tolist(),
                                       mode="lines+markers"))
            fig.update_layout(title=f"{field_name}  —  {t_label}",
                              xaxis_title="x", yaxis_title=field_name,
                              margin=dict(l=40, r=20, t=40, b=40))

        elif dim == 2 and vertices is not None and cells is not None:
            cells_a = np.asarray(cells)
            vert_vals = _cell_to_vert_values(vertices, cells_a, values)
            ii, jj, kk = _triangulate(cells_a)
            z = vertices[:, 2].tolist() if vertices.shape[1] > 2 else [0.0] * len(vertices)
            fig = go.Figure(go.Mesh3d(
                x=vertices[:, 0].tolist(), y=vertices[:, 1].tolist(), z=z,
                i=ii, j=jj, k=kk,
                intensity=vert_vals.tolist(),
                colorscale=colormap, showscale=True,
                colorbar=dict(title=field_name), flatshading=False,
            ))
            fig.update_layout(
                title=f"{field_name}  —  {t_label}",
                scene=dict(aspectmode="data",
                           camera=dict(eye=dict(x=0, y=0, z=2.2), up=dict(x=0, y=1, z=0))),
                margin=dict(l=0, r=0, t=40, b=0),
            )

        elif dim == 3 and vertices is not None and cells is not None:
            faces, face_cells = _boundary_faces_3d(cells)
            if not faces:
                print(f"No 3D boundary faces extracted from {len(cells)} cells.")
                fig = None
            else:
                ii, jj, kk = _triangulate(faces)
                vert_vals = _cell_to_vert_values(vertices, cells, values)
                fig = go.Figure(go.Mesh3d(
                    x=vertices[:, 0].tolist(), y=vertices[:, 1].tolist(),
                    z=vertices[:, 2].tolist(),
                    i=ii, j=jj, k=kk,
                    intensity=vert_vals.tolist(),
                    colorscale=colormap, showscale=True,
                    colorbar=dict(title=field_name),
                    flatshading=True,
                    lighting=dict(ambient=0.6, diffuse=0.8),
                    lightposition=dict(x=100, y=200, z=300),
                ))
                fig.update_layout(
                    title=f"{field_name}  —  {t_label}",
                    scene=dict(aspectmode="data",
                               camera=dict(eye=dict(x=1.5, y=1.5, z=1.2))),
                    margin=dict(l=0, r=0, t=40, b=0),
                )
        else:
            # No mesh geometry — bar chart by cell index
            fig = go.Figure(go.Bar(x=list(range(len(values))), y=np.asarray(values).tolist()))
            fig.update_layout(title=f"{field_name}  —  {t_label} (no mesh)",
                              xaxis_title="cell index", yaxis_title=field_name,
                              margin=dict(l=40, r=20, t=40, b=40))

        print(f"dim={dim}, fields={store.fields}, snapshots={n_snaps}")
