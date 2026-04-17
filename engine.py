import sys, io, json, base64
import numpy as np

# Lazy imports — avoid loading heavy packages at module level in Pyodide.
# plotly import is slow in WASM; matplotlib-pyodide hangs in web workers.
_go = None
_plt = None

def _get_go():
    global _go
    if _go is None:
        import plotly.graph_objects as go
        _go = go
    return _go

def _get_plt():
    global _plt
    if _plt is None:
        import matplotlib
        matplotlib.use("agg")
        import matplotlib.pyplot as mpl_plt
        _plt = mpl_plt
    return _plt

# --- 1. Custom Encoder for Robustness ---
class NumpyEncoder(json.JSONEncoder):
    """
    Explicitly handles NumPy types that often crash the default JSON serializer
    in Pyodide/WASM environments (specifically int64 and float32).
    """
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        elif isinstance(obj, np.floating):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        return super(NumpyEncoder, self).default(obj)

# --- 2. Rich display function (Jupyter-like output cells) ---

class ZoomyDisplay:
    """Rich output funnel. In Pyodide: sends to GUI output cells. In CPython: falls back to print."""

    def __call__(self, obj=None, *, mermaid=None, latex=None, html=None):
        if mermaid is not None:
            self._emit({"mime": "text/x-mermaid", "content": str(mermaid)})
        elif latex is not None:
            self._emit({"mime": "text/x-latex", "content": str(latex)})
        elif html is not None:
            self._emit({"mime": "text/html", "content": str(html)})
        elif obj is None:
            return
        elif hasattr(obj, "to_dict"):  # Plotly figure
            self._emit({"mime": "application/vnd.plotly+json", "content": json.dumps(obj.to_dict(), cls=NumpyEncoder)})
        elif hasattr(obj, "savefig"):  # Matplotlib figure
            buf = io.BytesIO()
            obj.savefig(buf, format="svg", bbox_inches="tight")
            buf.seek(0)
            self._emit({"mime": "image/svg+xml", "content": buf.read().decode("utf-8")})
        elif hasattr(obj, "to_html"):  # pandas DataFrame
            self._emit({"mime": "text/html", "content": obj.to_html()})
        elif isinstance(obj, np.ndarray):
            self._emit({"mime": "text/plain", "content": repr(obj)})
        else:
            self._emit({"mime": "text/plain", "content": str(obj)})

    def _emit(self, cell):
        if hasattr(sys, "_zoomy_display_callback"):
            sys._zoomy_display_callback(cell)
        else:
            # Fallback for CPython / CLI
            content = cell.get("content", "")
            if cell.get("mime") == "text/x-mermaid":
                print("[mermaid]", content[:200])
            elif cell.get("mime") == "text/x-latex":
                print("[latex]", content[:200])
            else:
                print(content[:500] if len(content) > 500 else content)

display = ZoomyDisplay()

# --- 3. Simulation results store ---

class SimulationStore:
    """Stores simulation results for visualization.

    After a solver.solve() call, use store.save(...) to make results
    available to the visualization cards.

    Usage in simulation code::

        Q, Qaux = solver.solve(mesh, model, write_output=True)
        store.save(mesh, model, Q, Qaux)

    Or from HDF5 timeline::

        store.load_hdf5("outputs/sim.h5")

    Usage in visualization code::

        data = store.data  # dict with mesh, Q, Qaux, fields, times, etc.
    """

    def __init__(self):
        self.data = {}

    def save(self, mesh, model, Q, Qaux=None, times=None, Q_timeline=None, Qaux_timeline=None):
        """Store simulation results for visualization."""
        # Extract field names from model
        field_names = []
        if hasattr(model, 'variables'):
            v = model.variables
            if hasattr(v, 'keys'):
                field_names = list(v.keys())
            elif hasattr(v, '_fields'):
                field_names = list(v._fields)
        if not field_names:
            field_names = [f"q{i}" for i in range(Q.shape[0])]

        aux_names = []
        if Qaux is not None and Qaux.size > 0:
            if hasattr(model, 'aux_variables'):
                av = model.aux_variables
                if hasattr(av, 'keys'):
                    aux_names = list(av.keys())
                elif hasattr(av, '_fields'):
                    aux_names = list(av._fields)
            if not aux_names:
                aux_names = [f"aux{i}" for i in range(Qaux.shape[0])]

        # Extract mesh coordinates
        coords = None
        if hasattr(mesh, 'cell_centers'):
            coords = np.asarray(mesh.cell_centers)
        elif hasattr(mesh, 'x'):
            coords = np.asarray(mesh.x)

        vertices = None
        if hasattr(mesh, 'vertices'):
            vertices = np.asarray(mesh.vertices)
        elif hasattr(mesh, 'nodes'):
            vertices = np.asarray(mesh.nodes)

        cells = None
        if hasattr(mesh, 'cells'):
            cells = np.asarray(mesh.cells) if not callable(mesh.cells) else None
        if cells is None and hasattr(mesh, 'connectivity'):
            cells = np.asarray(mesh.connectivity)

        self.data = {
            "Q": np.asarray(Q),                    # (n_vars, n_cells) final state
            "Qaux": np.asarray(Qaux) if Qaux is not None else None,
            "fields": field_names,                  # ['h', 'hu', ...]
            "aux_fields": aux_names,                # ['grad_h', ...]
            "coords": coords,                       # cell centers
            "vertices": vertices,                    # mesh vertex coords
            "cells": cells,                          # cell connectivity
            "dim": getattr(mesh, 'dim', 1),
            "n_cells": Q.shape[1] if Q.ndim > 1 else len(Q),
        }

        # Timeline data (multiple snapshots)
        if Q_timeline is not None:
            self.data["Q_timeline"] = np.asarray(Q_timeline)  # (n_snaps, n_vars, n_cells)
            self.data["times"] = np.asarray(times) if times is not None else np.arange(Q_timeline.shape[0], dtype=float)
            self.data["n_snapshots"] = Q_timeline.shape[0]
        if Qaux_timeline is not None:
            self.data["Qaux_timeline"] = np.asarray(Qaux_timeline)

        print(f"[store] Saved: {len(field_names)} fields, {Q.shape[1] if Q.ndim > 1 else len(Q)} cells" +
              (f", {self.data.get('n_snapshots', 0)} snapshots" if Q_timeline is not None else ""))

    def load_hdf5(self, filepath):
        """Load results from HDF5 file written by the solver."""
        from zoomy_core.misc.io import load_timeline_of_fields_from_hdf5
        x, Q_all, Qaux_all, times = load_timeline_of_fields_from_hdf5(filepath)
        self.data = {
            "Q": Q_all[-1],
            "Qaux": Qaux_all[-1] if Qaux_all is not None else None,
            "Q_timeline": Q_all,
            "Qaux_timeline": Qaux_all,
            "times": times,
            "n_snapshots": Q_all.shape[0],
            "fields": [f"q{i}" for i in range(Q_all.shape[1])],
            "aux_fields": [f"aux{i}" for i in range(Qaux_all.shape[1])] if Qaux_all is not None and Qaux_all.ndim > 1 else [],
            "coords": x,
            "dim": 1 if x.ndim == 1 else x.shape[1],
            "n_cells": Q_all.shape[2],
        }
        print(f"[store] Loaded HDF5: {self.data['n_snapshots']} snapshots, {self.data['n_cells']} cells")

    @property
    def fields(self):
        """All available field names (primary + auxiliary)."""
        return self.data.get("fields", []) + self.data.get("aux_fields", [])

    def get_field(self, name, time_step=-1):
        """Get a specific field at a specific time step."""
        d = self.data
        names = d.get("fields", [])
        aux_names = d.get("aux_fields", [])

        if name in names:
            idx = names.index(name)
            if "Q_timeline" in d and time_step >= 0:
                return d["Q_timeline"][min(time_step, d["n_snapshots"] - 1), idx]
            return d["Q"][idx]
        elif name in aux_names:
            idx = aux_names.index(name)
            if "Qaux_timeline" in d and time_step >= 0:
                return d["Qaux_timeline"][min(time_step, d["n_snapshots"] - 1), idx]
            return d["Qaux"][idx] if d.get("Qaux") is not None else None
        return None

store = SimulationStore()

# --- 4. Initialize Scope ---
if not hasattr(sys, "_shallowflow_scope"):
    sys._shallowflow_scope = {"np": np}

sys._shallowflow_scope["display"] = display
sys._shallowflow_scope["store"] = store
sys._shallowflow_scope["_results"] = getattr(sys, "_zoomy_results", {})
if not hasattr(sys, "_zoomy_results"):
    sys._zoomy_results = sys._shallowflow_scope["_results"]

def process_code(code_string):
    new_stdout = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = new_stdout

    res = {"status": "success", "output": "", "plot_type": "none", "plot_data": None, "store_meta": None}
    scope = sys._shallowflow_scope

    try:
        # Clean up previous matplotlib figures if loaded
        if _plt is not None:
            scope["plt"] = _plt
            _plt.close("all")
        if _go is not None:
            scope["go"] = _go
        scope.pop("fig", None)

        # Execute user code
        exec(code_string, scope)

        # --- Detect which plotting library the user's fig belongs to ---
        fig_obj = scope.get("fig")
        is_plotly_fig = fig_obj is not None and hasattr(fig_obj, "to_dict") and not hasattr(fig_obj, "savefig")
        is_mpl_fig = fig_obj is not None and hasattr(fig_obj, "savefig")

        # Prefer user's imported plt; fallback to engine's _plt
        user_plt = scope.get("plt") or _plt

        if is_plotly_fig:
            res["plot_type"] = "plotly"
            res["plot_data"] = json.dumps(fig_obj.to_dict(), cls=NumpyEncoder)
        elif is_mpl_fig:
            buf = io.BytesIO()
            fig_obj.savefig(buf, format="svg", bbox_inches="tight")
            buf.seek(0)
            res["plot_type"] = "matplotlib"
            res["plot_data"] = base64.b64encode(buf.read()).decode("utf-8")
        elif user_plt is not None and user_plt.get_fignums():
            buf = io.BytesIO()
            user_plt.gcf().savefig(buf, format="svg", bbox_inches="tight")
            buf.seek(0)
            res["plot_type"] = "matplotlib"
            res["plot_data"] = base64.b64encode(buf.read()).decode("utf-8")

    except Exception:
        import traceback
        res["status"] = "error"
        res["output"] = traceback.format_exc()
    finally:
        sys.stdout = old_stdout
        res["output"] = new_stdout.getvalue() + res["output"]

    # Attach store metadata so JS can update slider range + field dropdown
    if store.data:
        res["store_meta"] = {
            "fields": store.fields,
            "n_snapshots": store.data.get("n_snapshots", 0),
            "dim": store.data.get("dim", 1),
            "n_cells": store.data.get("n_cells", 0),
        }

    # Use the robust encoder for the final response packet as well
    return json.dumps(res, cls=NumpyEncoder)
