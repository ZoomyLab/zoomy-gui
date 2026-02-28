import sys, io, json, base64
import numpy as np
import plotly.graph_objects as go
import matplotlib.pyplot as plt

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
    sys._shallowflow_scope = {"np": np, "go": go, "plt": plt}

def process_code(code_string):
    new_stdout = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = new_stdout

    res = {"status": "success", "output": "", "plot_type": "none", "plot_data": None}
    scope = sys._shallowflow_scope

    try:
        # Clean up previous runs
        scope.pop("fig", None)
        plt.close("all")

        # Execute user code
        exec(code_string, scope)

        # --- 3. Handle Plotly (The Fix) ---
        if "fig" in scope:
            fig_obj = scope["fig"]
            res["plot_type"] = "plotly"
            
            # Instead of fig.to_json() (which uses Plotly's internal encoder),
            # we convert to a dict and use our robust NumpyEncoder.
            if hasattr(fig_obj, "to_dict"):
                fig_data = fig_obj.to_dict()
            else:
                fig_data = fig_obj
            
            # Serialize the figure data to a string
            res["plot_data"] = json.dumps(fig_data, cls=NumpyEncoder)

        # --- 4. Handle Matplotlib ---
        elif plt.get_fignums():
            buf = io.BytesIO()
            plt.gcf().savefig(buf, format="svg", bbox_inches="tight")
            res["plot_type"] = "matplotlib"
            # SVG is already a string/XML, but we base64 it to be safe for transport
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
