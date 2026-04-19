"""Pyodide-side execution engine for the Zoomy GUI.

Design notes:

* Simulation results live in an HDF5 file on Pyodide's virtual filesystem
  (``/tmp/zoomy_sim/sim.h5`` by convention). Nothing else. The browser is a
  regular filesystem as far as Python is concerned.
* ``store`` is a :class:`zoomy_plotting.SimulationStore` built via
  ``zoomy_plotting.read_hdf5(path)``. Lazy field reads, no in-memory
  arrays outside the open h5py handle.
* No ``SimulationStore`` shim, no ``auto_save_from_scope`` sniffing,
  no ``load_server_results`` JSON path. One code path for both the local
  Pyodide solver and a remote server job: download the HDF5 → write to
  VFS → read it.
* No fallbacks. If ``store`` is unset or malformed, viz snippets raise.
"""

import base64
import io
import json
import os
import sys

import numpy as np


# --- Lazy imports — plotly init is slow in WASM, matplotlib-pyodide
#     hangs in web workers unless we go through pyplot carefully. ---
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


# --- Robust JSON encoder for numpy types (int64/float32 crash the default). ---
class NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        if isinstance(obj, np.floating):
            return float(obj)
        if isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


# --- Rich display funnel (Jupyter-like output cells). ---
class ZoomyDisplay:
    def __call__(self, obj=None, *, mermaid=None, latex=None, html=None):
        if mermaid is not None:
            self._emit({"mime": "text/x-mermaid", "content": str(mermaid)})
        elif latex is not None:
            self._emit({"mime": "text/x-latex", "content": str(latex)})
        elif html is not None:
            self._emit({"mime": "text/html", "content": str(html)})
        elif obj is None:
            return
        elif hasattr(obj, "to_dict"):  # plotly figure
            self._emit({"mime": "application/vnd.plotly+json",
                        "content": json.dumps(obj.to_dict(), cls=NumpyEncoder)})
        elif hasattr(obj, "savefig"):  # matplotlib figure
            buf = io.BytesIO()
            obj.savefig(buf, format="svg", bbox_inches="tight")
            buf.seek(0)
            self._emit({"mime": "image/svg+xml",
                        "content": buf.read().decode("utf-8")})
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
            content = cell.get("content", "")
            if cell.get("mime") == "text/x-mermaid":
                print("[mermaid]", content[:200])
            elif cell.get("mime") == "text/x-latex":
                print("[latex]", content[:200])
            else:
                print(content[:500] if len(content) > 500 else content)


display = ZoomyDisplay()


# --- Persistent exec scope. Populated lazily; ``store`` starts unset and
#     is set by the solver template to a ``zoomy_plotting.SimulationStore``. ---
if not hasattr(sys, "_shallowflow_scope"):
    sys._shallowflow_scope = {"np": np}

sys._shallowflow_scope["display"] = display
sys._shallowflow_scope.setdefault("store", None)


# --- Live stdout streaming to the GUI dashboard log. ---
class _LiveStdout(io.StringIO):
    def __init__(self):
        super().__init__()
        self._buf = ""

    def write(self, s):
        super().write(s)
        if hasattr(sys, "_zoomy_display_callback"):
            self._buf += s
            while "\n" in self._buf:
                line, self._buf = self._buf.split("\n", 1)
                if line.strip():
                    try:
                        sys._zoomy_display_callback({
                            "mime": "text/x-log",
                            "content": line,
                        })
                    except Exception:
                        pass
        return len(s)


# --- Helper used by the solver template to load results into the store. ---
def open_hdf5(path):
    """Open an HDF5 simulation output via zoomy_plotting and install it
    as the exec-scope ``store``.

    Raises loudly on anything unexpected: missing file, missing ``/mesh``
    group, mesh/field shape mismatch. No fallback, no soft failure."""
    import zoomy_plotting as zp   # lazy; triggers PyPI micropip install

    if not os.path.isfile(path):
        raise FileNotFoundError(f"open_hdf5: no such file: {path}")

    store = zp.read_hdf5(path)    # validates schema internally

    # Sanity: the mesh we loaded must match the fields we loaded.
    # zoomy_plotting's SimulationStore already asserts vertices.shape[1]==dim
    # in __post_init__; we add a cell-count cross-check here so mismatches
    # surface with a clear message instead of at plot time.
    if store.cells.shape[0] != store.n_cells:
        raise ValueError(
            f"open_hdf5: cells/Q mismatch in {path}: "
            f"{store.cells.shape[0]} cells from /mesh, "
            f"but fields report {store.n_cells} cells. "
            f"Check the solver's HDF5 writer."
        )

    sys._shallowflow_scope["store"] = store
    print(f"[store] opened {path}  dim={store.dim} cell_type={store.cell_type} "
          f"n_cells={store.n_cells} n_snapshots={store.n_snapshots}")
    return store


sys._shallowflow_scope["open_hdf5"] = open_hdf5


def close_store():
    """Close any store currently installed in scope and release its file handle.

    The previous run's ``SimulationStore`` holds an open ``h5py.File`` via
    ``_resource``; that lock prevents ``mesh.write_to_hdf5(path)`` from
    truncating the same path on a subsequent run. The solver template
    calls this before writing so re-runs succeed cleanly."""
    s = sys._shallowflow_scope.get("store")
    if s is None:
        return
    try:
        s.close()
    except Exception:
        pass
    sys._shallowflow_scope["store"] = None


sys._shallowflow_scope["close_store"] = close_store


# --- Autocomplete via jedi ------------------------------------------------
# jedi is installed by the worker on first 'complete_code' call via
# micropip (the worker owns async install — doing it from sync Python
# is painful in Pyodide's single-threaded event loop). engine.py just
# imports it and runs jedi.Script.complete().


def complete_code(code: str, row: int, col: int, limit: int = 50) -> dict:
    """Return jedi completions at (1-indexed row, 0-indexed col)."""
    try:
        import jedi
    except ImportError:
        return {"completions": [], "error": "jedi unavailable"}
    try:
        script = jedi.Script(code)
        completions = script.complete(row, col)
    except Exception as e:
        return {"completions": [], "error": str(e)}

    out = []
    for c in completions[:limit]:
        # signature(): jedi returns a list of Signature objects. Empty
        # for non-callables; for functions/methods we pick the first.
        sig_str = ""
        try:
            sigs = c.get_signatures()
            if sigs:
                sig_str = sigs[0].to_string()
        except Exception:
            pass
        # docstring(): can be expensive for some symbols; cap it.
        doc = ""
        try:
            doc = c.docstring(raw=True) or ""
            if len(doc) > 2000:
                doc = doc[:2000] + " […]"
        except Exception:
            pass
        out.append({
            "name": c.name,
            "type": c.type,
            "signature": sig_str,
            "docstring": doc,
            "module": getattr(c, "module_name", "") or "",
        })
    return {"completions": out}


sys._shallowflow_scope["complete_code"] = complete_code


# --- Main entry point for run_code messages from the worker. ---
def process_code(code_string):
    new_stdout = _LiveStdout()
    old_stdout = sys.stdout
    sys.stdout = new_stdout

    # Single output convention: the only way a script produces a card-level
    # output is by calling ``display(obj)``. No more fig-sniffing from the
    # exec scope — keeps snippets uniform and makes the "one plot replaces
    # the previous one" behaviour in the GUI a simple clear-then-append.
    res = {"status": "success", "output": "", "store_meta": None}
    scope = sys._shallowflow_scope

    try:
        if _plt is not None:
            _plt.close("all")   # tidy up any stray mpl figures from the prior run
        exec(code_string, scope)

    except KeyboardInterrupt:
        # Cooperative cancel: the main thread wrote SIGINT into the shared
        # interrupt buffer, Pyodide raised KeyboardInterrupt between
        # bytecodes. Close any open store so the next run's write_to_hdf5
        # doesn't collide with a half-finished handle.
        s = scope.get("store")
        if s is not None:
            try:
                s.close()
            except Exception:
                pass
            scope["store"] = None
        res["status"] = "cancelled"
        res["output"] = "Simulation cancelled by user.\n"
    except Exception:
        import traceback
        res["status"] = "error"
        res["output"] = traceback.format_exc()
    finally:
        sys.stdout = old_stdout
        res["output"] = new_stdout.getvalue() + res["output"]

    # Store metadata for the GUI's slider / field selector. Read off the
    # zoomy_plotting.SimulationStore currently in scope, if one is installed.
    s = scope.get("store")
    if s is not None and hasattr(s, "field") and hasattr(s, "n_snapshots"):
        try:
            res["store_meta"] = {
                "fields": list(s.field.keys()),
                "n_snapshots": int(s.n_snapshots),
                "dim": int(s.dim),
                "n_cells": int(s.n_cells),
            }
        except Exception:
            res["store_meta"] = None

    return json.dumps(res, cls=NumpyEncoder)
