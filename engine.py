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

# --- 3. Initialize Scope ---
if not hasattr(sys, "_shallowflow_scope"):
    sys._shallowflow_scope = {"np": np}

sys._shallowflow_scope["display"] = display
sys._shallowflow_scope["_results"] = getattr(sys, "_zoomy_results", {})
if not hasattr(sys, "_zoomy_results"):
    sys._zoomy_results = sys._shallowflow_scope["_results"]

def process_code(code_string):
    new_stdout = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = new_stdout

    res = {"status": "success", "output": "", "plot_type": "none", "plot_data": None}
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

        # --- 3. Handle Plotly (only if plotly was imported by user code) ---
        if "fig" in scope:
            try:
                go = _get_go()
                fig_obj = scope["fig"]
                res["plot_type"] = "plotly"
                fig_data = fig_obj.to_dict() if hasattr(fig_obj, "to_dict") else fig_obj
                res["plot_data"] = json.dumps(fig_data, cls=NumpyEncoder)
            except ImportError:
                res["output"] += "\n(plotly not installed — cannot render figure)"

        # --- 4. Handle Matplotlib (only if matplotlib was imported by user code) ---
        elif _plt is not None and _plt.get_fignums():
            buf = io.BytesIO()
            _plt.gcf().savefig(buf, format="svg", bbox_inches="tight")
            res["plot_type"] = "matplotlib"
            res["plot_data"] = base64.b64encode(buf.read()).decode("utf-8")

    except Exception:
        import traceback
        res["status"] = "error"
        res["output"] = traceback.format_exc()
    finally:
        sys.stdout = old_stdout
        res["output"] = new_stdout.getvalue() + res["output"]

    # Use the robust encoder for the final response packet as well
    return json.dumps(res, cls=NumpyEncoder)
