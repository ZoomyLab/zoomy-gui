"""3D mesh visualization with interactive rotation/zoom.

Reads simulation results from `store` (populated by solver code).
The timeline slider injects `time_step`, and `field_name` can be
edited below. Use mouse to rotate, pan, and zoom.

Usage (in a model/solver card first):
    Q, Qaux = solver.solve(mesh, model)
    store.save(mesh, model, Q, Qaux)
"""
import plotly.graph_objects as go
import numpy as np

# --- Controls ---
if "field_name" not in dir():
    field_name = None
if "time_step" not in dir():
    time_step = 0
colormap = "Viridis"

# --- Load data from store ---
data = store.data
if not data or data.get("vertices") is None:
    print("No simulation data available.")
    print("Run a simulation first, then call:")
    print("  store.save(mesh, model, Q, Qaux)")
else:
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
    else:
        vx = vertices[:, 0].tolist()
        vy = vertices[:, 1].tolist()
        vz = vertices[:, 2].tolist() if vertices.shape[1] > 2 else [0.0] * len(vertices)

        # Triangulate cells (quads -> 2 tris, tris -> 1 tri)
        tri_i, tri_j, tri_k = [], [], []
        if cells is not None:
            for cell in cells:
                if len(cell) >= 3:
                    tri_i.append(int(cell[0])); tri_j.append(int(cell[1])); tri_k.append(int(cell[2]))
                if len(cell) >= 4:
                    tri_i.append(int(cell[0])); tri_j.append(int(cell[2])); tri_k.append(int(cell[3]))

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

        fig = go.Figure(data=[
            go.Mesh3d(
                x=vx, y=vy, z=vz,
                i=tri_i, j=tri_j, k=tri_k,
                intensity=vert_values.tolist(),
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
