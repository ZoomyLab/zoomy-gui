import sys, io, json, base64
import numpy as np
import plotly.graph_objects as go

# Lazy matplotlib import — avoid loading at module level in Pyodide
# (matplotlib-pyodide's wasm_backend can hang in web workers)
plt = None
def _get_plt():
    global plt
    if plt is None:
        import matplotlib
        matplotlib.use("agg")
        import matplotlib.pyplot as _plt
        plt = _plt
    return plt

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

# --- 2. Initialize Scope ---
if not hasattr(sys, "_shallowflow_scope"):
    sys._shallowflow_scope = {"np": np, "go": go}

def process_code(code_string):
    new_stdout = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = new_stdout

    res = {"status": "success", "output": "", "plot_type": "none", "plot_data": None}
    scope = sys._shallowflow_scope
    mpl = _get_plt()
    scope["plt"] = mpl

    try:
        # Clean up previous runs
        scope.pop("fig", None)
        mpl.close("all")

        # Execute user code
        exec(code_string, scope)

        # --- 3. Handle Plotly (The Fix) ---
        if "fig" in scope:
            fig_obj = scope["fig"]
            res["plot_type"] = "plotly"

            if hasattr(fig_obj, "to_dict"):
                fig_data = fig_obj.to_dict()
            else:
                fig_data = fig_obj

            res["plot_data"] = json.dumps(fig_data, cls=NumpyEncoder)

        # --- 4. Handle Matplotlib ---
        elif mpl.get_fignums():
            buf = io.BytesIO()
            mpl.gcf().savefig(buf, format="svg", bbox_inches="tight")
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
