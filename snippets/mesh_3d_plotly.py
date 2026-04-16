"""3D mesh visualization with interactive rotation/zoom.

Reads simulation results from `store` (populated by solver code).
The timeline slider injects `time_step`, and `field_name` can be
edited below. Use mouse to rotate, pan, and zoom.

If no simulation has run yet, shows a demo with synthetic data.
"""
import plotly.graph_objects as go
import numpy as np

# --- Controls ---
if "field_name" not in dir():
    field_name = None
if "time_step" not in dir():
    time_step = 0
colormap = "Viridis"

# --- Load data from store or generate demo ---
data = store.data if store.data else {}

if data and data.get("vertices") is not None and data.get("dim", 1) >= 2:
    fields_list = store.fields
    if field_name is None:
        field_name = fields_list[0] if fields_list else "q0"

    values = store.get_field(field_name, time_step=int(time_step))
    vertices = data["vertices"]
    cells = data.get("cells")
    n_snaps = data.get("n_snapshots", 0)
    t_label = f"step {int(time_step)}/{n_snaps - 1}" if n_snaps > 0 else "final"

    if values is None:
        print(f"Field '{field_name}' not found. Available: {fields_list}")
        values = np.zeros(data["n_cells"])

    # Build triangulated surface from cell connectivity
    vx = vertices[:, 0].tolist()
    vy = vertices[:, 1].tolist()
    vz = vertices[:, 2].tolist() if vertices.shape[1] > 2 else [0.0] * len(vertices)

    # Triangulate cells (quads → 2 triangles, tris → 1 triangle)
    tri_i, tri_j, tri_k = [], [], []
    if cells is not None:
        for cell in cells:
            if len(cell) >= 3:
                tri_i.append(cell[0]); tri_j.append(cell[1]); tri_k.append(cell[2])
            if len(cell) >= 4:
                tri_i.append(cell[0]); tri_j.append(cell[2]); tri_k.append(cell[3])

    # Map cell values to vertices (average from adjacent cells)
    vert_values = np.zeros(len(vertices))
    vert_count = np.zeros(len(vertices))
    if cells is not None:
        for ci, cell in enumerate(cells):
            val = values[ci] if ci < len(values) else 0
            for vi in cell:
                vert_values[vi] += val
                vert_count[vi] += 1
    vert_count[vert_count == 0] = 1
    vert_values /= vert_count
    intensity = vert_values.tolist()

else:
    # Demo: unit cube surface
    print("No simulation data in store. Showing demo.")
    print("Run a simulation first, then call: store.save(mesh, model, Q, Qaux)")
    n = 4
    x = np.linspace(0, 1, n + 1)
    y = np.linspace(0, 1, n + 1)
    z = np.linspace(0, 1, n + 1)
    verts = []
    tri_i, tri_j, tri_k = [], [], []
    offset = 0
    for face_dim in range(3):
        dims = [d for d in range(3) if d != face_dim]
        grids = [x, y, z]
        g0, g1 = np.meshgrid(grids[dims[0]], grids[dims[1]])
        n0, n1 = g0.shape
        for face_val in [0, len(grids[face_dim]) - 1]:
            for jj in range(n1):
                for ii in range(n0):
                    pt = [0.0, 0.0, 0.0]
                    pt[face_dim] = grids[face_dim][face_val]
                    pt[dims[0]] = g0[ii, jj]
                    pt[dims[1]] = g1[ii, jj]
                    verts.append(pt)
            for jj in range(n1 - 1):
                for ii in range(n0 - 1):
                    v00 = offset + jj * n0 + ii
                    tri_i.extend([v00, v00])
                    tri_j.extend([v00 + 1, v00 + n0])
                    tri_k.extend([v00 + n0, v00 + n0 + 1])
            offset += n0 * n1
    verts = np.array(verts)
    vx, vy, vz = verts[:, 0].tolist(), verts[:, 1].tolist(), verts[:, 2].tolist()
    phase = 2 * np.pi * int(time_step) / 100
    intensity = np.sin(phase + 3 * np.linalg.norm(verts - 0.5, axis=1)).tolist()
    field_name = "demo (wave)"
    t_label = f"step {int(time_step)}/99"
    n_snaps = 100
    fields_list = ["demo (wave)"]

# --- Render ---
fig = go.Figure(data=[
    go.Mesh3d(
        x=vx, y=vy, z=vz,
        i=tri_i, j=tri_j, k=tri_k,
        intensity=intensity,
        colorscale=colormap,
        showscale=True,
        colorbar=dict(title=field_name),
        flatshading=True,
        lighting=dict(ambient=0.6, diffuse=0.8),
        lightposition=dict(x=100, y=200, z=300),
    )
])

fig.update_layout(
    title=f"{field_name}  —  {t_label}",
    scene=dict(
        aspectmode="data",
        xaxis_title="X", yaxis_title="Y", zaxis_title="Z",
        camera=dict(eye=dict(x=1.5, y=1.5, z=1.2)),
    ),
    margin=dict(l=0, r=0, t=40, b=0),
)

print(f"Fields: {fields_list}")
if n_snaps > 0:
    print(f"Snapshots: {n_snaps}")
