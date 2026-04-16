import plotly.graph_objects as go
import numpy as np

# --- Mesh data (replace with your own or load from zoomy) ---
# Example: unit cube surface mesh
nx, ny, nz = 4, 4, 4
x = np.linspace(0, 1, nx + 1)
y = np.linspace(0, 1, ny + 1)
z = np.linspace(0, 1, nz + 1)

# Build triangulated surface faces of the cube
verts = []
tris_i, tris_j, tris_k = [], [], []
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
                tris_i.extend([v00, v00])
                tris_j.extend([v00 + 1, v00 + n0])
                tris_k.extend([v00 + n0, v00 + n0 + 1])
        offset += n0 * n1

verts = np.array(verts)

# Example fields with time evolution
n_steps = 100
center = np.array([0.5, 0.5, 0.5])

# time_step is injected by the timeline slider
if "time_step" not in dir():
    time_step = 0
time_step = min(int(time_step), n_steps - 1)

phase = 2 * np.pi * time_step / n_steps
intensity = np.sin(phase + 3 * np.linalg.norm(verts - center, axis=1))

# --- User controls ---
field_name = "wave"
colormap = "Viridis"

# --- Render ---
fig = go.Figure(data=[
    go.Mesh3d(
        x=verts[:, 0].tolist(),
        y=verts[:, 1].tolist(),
        z=verts[:, 2].tolist(),
        i=tris_i,
        j=tris_j,
        k=tris_k,
        intensity=intensity.tolist(),
        colorscale=colormap,
        cmin=-1, cmax=1,
        showscale=True,
        colorbar=dict(title=field_name),
        flatshading=True,
        lighting=dict(ambient=0.6, diffuse=0.8),
        lightposition=dict(x=100, y=200, z=300),
    )
])

fig.update_layout(
    title=f"{field_name}  —  step {time_step}/{n_steps - 1}",
    scene=dict(
        aspectmode="data",
        xaxis_title="X", yaxis_title="Y", zaxis_title="Z",
        camera=dict(eye=dict(x=1.5, y=1.5, z=1.2)),
    ),
    margin=dict(l=0, r=0, t=40, b=0),
)
