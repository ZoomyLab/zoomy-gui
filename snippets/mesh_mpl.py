"""Matplotlib mesh viewer — handles 1D/2D/3D uniformly.

Reads from the GUI's `store` object (auto-populated after a simulation).
Timeline slider injects `time_step`, the field selector injects `field_name`.

  1D → line plot
  2D → polygon mesh with cell-colored faces + colorbar
  3D → isometric view of boundary faces (surface)

Integration strategy: prefer ``zoomy_plotting.MatplotlibPlotter`` when the
library is installed (it's on PyPI; the Pyodide worker installs it via
micropip at boot). Fall back to the inline implementation if the import
fails — PyPI / network hiccups must not stop a plot from appearing.
"""
import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
import numpy as np
from collections import Counter

# --- User controls ---
if "field_name" not in dir(): field_name = None
if "time_step" not in dir(): time_step = 0
colormap = "viridis"


def _plot_via_zoomy_plotting(gui_store, time_step, field_name):
    """Try to delegate to zoomy_plotting.MatplotlibPlotter.

    Returns True if a plot was produced; False to fall through to the
    inline path (missing data, axis mismatch, ImportError, etc.).
    """
    try:
        import zoomy_plotting as zp
    except Exception:
        return False

    d = gui_store.data or {}
    if d.get("Q") is None:
        print("No simulation data available.")
        print("Run a simulation first — results will be fetched automatically.")
        return True   # handled (message printed)

    verts = d.get("vertices")
    cells_a = d.get("cells")
    dim = int(d.get("dim", 1))
    if verts is None or cells_a is None:
        return False   # not enough geometry for zp; let inline handle 1-D / fallback

    verts = np.asarray(verts)
    cells_a = np.asarray(cells_a)
    # zoomy_core stores vertex_coordinates as (dim_embed, n). Canonicalize
    # to (n, dim); zp's SimulationStore enforces that axis.
    if verts.ndim == 2 and verts.shape[0] in (1, 2, 3) and verts.shape[1] > verts.shape[0]:
        verts = verts.T
    if verts.shape[1] > dim:
        verts = np.ascontiguousarray(verts[:, :dim])

    # Infer cell_type from k.
    n_per = int(cells_a.shape[1]) if cells_a.ndim == 2 else 0
    cell_type = {
        (1, 2): "line",
        (2, 3): "triangle", (2, 4): "quad",
        (3, 4): "tetra", (3, 8): "hexahedron", (3, 6): "wedge",
    }.get((dim, n_per), "line")

    # Build a zp Zstruct and a lazy cell reader that defers to the GUI store.
    all_names = list(d.get("fields", [])) + list(d.get("aux_fields", []))
    if not all_names:
        return False
    field_z = zp.Zstruct({name: i for i, name in enumerate(all_names)})

    def reader(t, idx):
        name = all_names[int(idx)]
        return np.asarray(gui_store.get_field(name, time_step=int(t)))

    zp_store = zp.SimulationStore(
        dim=dim,
        cell_type=cell_type,
        vertices=np.asarray(verts),
        cells=np.asarray(cells_a),
        times=np.asarray(d["times"]) if d.get("times") is not None else None,
        field=field_z,
        _cell_reader=reader,
    )

    plotter = zp.MatplotlibPlotter(zp_store)
    field = field_name if field_name in field_z else all_names[0]
    ts = max(0, min(int(time_step), zp_store.n_snapshots - 1))

    with zp.apply_style():
        if dim == 3:
            fig = plt.figure()
            ax = fig.add_subplot(111, projection="3d")
        else:
            fig, ax = plt.subplots()
        plotter.plot(ax, time_step=ts, field=field, cmap=colormap)

    print(f"[zp] {zp_store.cell_type} dim={dim} field={field!r} snaps={zp_store.n_snapshots}")
    return True


# --- Inline fallback (used when zoomy_plotting is not available
#     or when the store's geometry is incomplete) ---

from matplotlib.collections import PolyCollection
from matplotlib.cm import ScalarMappable
from matplotlib.colors import Normalize


def _resolve_field(store, field_name, time_step):
    d = store.data
    if not d: return None, None, 0, 0
    fl = store.fields
    if not fl: return None, None, 0, 0
    if field_name is None or field_name not in fl: field_name = fl[0]
    n_snaps = d.get("n_snapshots", 0)
    ts = 0 if n_snaps == 0 else max(0, min(int(time_step), n_snaps - 1))
    return store.get_field(field_name, time_step=ts), field_name, ts, n_snaps


def _boundary_faces_3d(cells):
    n_per = cells.shape[1] if hasattr(cells, "shape") and len(cells.shape) > 1 else len(cells[0])
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


def _inline_fallback(store, time_step, field_name, colormap):
    data = store.data
    if not data or data.get("Q") is None:
        print("No simulation data available.")
        print("Run a simulation first — results will be fetched automatically.")
        return
    values, field_name, ts, n_snaps = _resolve_field(store, field_name, time_step)
    if values is None:
        print("No fields to plot.")
        return
    dim = data.get("dim", 1)
    t_label = f"step {ts}/{n_snaps - 1}" if n_snaps > 0 else "final"
    coords = data.get("coords")
    vertices = data.get("vertices")
    cells = data.get("cells")

    if dim == 1 and coords is not None:
        x = coords[:, 0] if coords.ndim > 1 else coords
        fig, ax = plt.subplots(1, 1, figsize=(7, 4))
        ax.plot(x, values, "-o", markersize=3)
        ax.set_xlabel("x"); ax.set_ylabel(field_name)
        ax.set_title(f"{field_name}  —  {t_label}")
        ax.grid(True, alpha=0.3)
    elif dim == 2 and vertices is not None and cells is not None:
        polygons = [vertices[cell][:, :2] for cell in cells]
        fig, ax = plt.subplots(1, 1, figsize=(7, 6))
        norm = Normalize(vmin=float(values.min()), vmax=float(values.max()))
        colors = plt.get_cmap(colormap)(norm(values))
        coll = PolyCollection(polygons, facecolors=colors, edgecolors="black", linewidths=0.3)
        ax.add_collection(coll)
        ax.set_xlim(vertices[:, 0].min(), vertices[:, 0].max())
        ax.set_ylim(vertices[:, 1].min(), vertices[:, 1].max())
        ax.set_aspect("equal")
        ax.set_title(f"{field_name}  —  {t_label}")
        sm = ScalarMappable(cmap=colormap, norm=norm); sm.set_array([])
        fig.colorbar(sm, ax=ax, shrink=0.8, label=field_name)
    elif dim == 3 and vertices is not None and cells is not None:
        from mpl_toolkits.mplot3d.art3d import Poly3DCollection
        faces, face_cells = _boundary_faces_3d(np.asarray(cells))
        if not faces:
            print(f"No 3D boundary faces extracted from {len(cells)} cells.")
            return
        poly_coords = [vertices[f] for f in faces]
        face_values = np.array([float(values[int(c)]) for c in face_cells])
        norm = Normalize(vmin=float(values.min()), vmax=float(values.max()))
        face_colors = plt.get_cmap(colormap)(norm(face_values))
        fig = plt.figure(figsize=(7, 6))
        ax = fig.add_subplot(111, projection="3d")
        col = Poly3DCollection(poly_coords, facecolors=face_colors,
                               edgecolors="black", linewidths=0.2, alpha=0.9)
        ax.add_collection3d(col)
        ax.set_xlim(vertices[:, 0].min(), vertices[:, 0].max())
        ax.set_ylim(vertices[:, 1].min(), vertices[:, 1].max())
        ax.set_zlim(vertices[:, 2].min(), vertices[:, 2].max())
        ax.view_init(elev=30, azim=45)
        try: ax.set_box_aspect([1, 1, 1])
        except Exception: pass
        ax.set_title(f"{field_name}  —  {t_label}")
        sm = ScalarMappable(cmap=colormap, norm=norm); sm.set_array([])
        fig.colorbar(sm, ax=ax, shrink=0.6, label=field_name)
    else:
        fig, ax = plt.subplots(1, 1, figsize=(7, 4))
        ax.bar(range(len(values)), values, width=1.0)
        ax.set_xlabel("cell index"); ax.set_ylabel(field_name)
        ax.set_title(f"{field_name}  —  {t_label} (no mesh geometry)")
    print(f"dim={dim}, fields={store.fields}, snapshots={n_snaps}")


# --- Main ---
if not _plot_via_zoomy_plotting(store, time_step, field_name):
    _inline_fallback(store, time_step, field_name, colormap)
