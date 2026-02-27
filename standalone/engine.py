import sys, io, json, base64
import numpy as np
import plotly.graph_objects as go
import matplotlib.pyplot as plt

# We initialize the scope once with common libraries
if not hasattr(sys, "_shallowflow_scope"):
    sys._shallowflow_scope = {"np": np, "go": go, "plt": plt, "go": go}


def process_code(code_string):
    new_stdout = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = new_stdout

    res = {"status": "success", "output": "", "plot_type": "none", "plot_data": None}
    scope = sys._shallowflow_scope

    try:
        # Prevent ghost plots from previous runs
        scope.pop("fig", None)
        plt.close("all")

        # Execute the user code
        exec(code_string, scope)

        # 1. Priority: Plotly
        if "fig" in scope:
            fig_obj = scope["fig"]
            res["plot_type"] = "plotly"
            # Use Plotly's internal converter to handle NumPy types correctly
            if hasattr(fig_obj, "to_json"):
                res["plot_data"] = fig_obj.to_json()
            else:
                res["plot_data"] = json.dumps(fig_obj)

        # 2. Fallback: Matplotlib
        elif plt.get_fignums():
            buf = io.BytesIO()
            plt.gcf().savefig(buf, format="svg", bbox_inches="tight")
            res["plot_type"] = "matplotlib"
            res["plot_data"] = base64.b64encode(buf.read()).decode("utf-8")

    except Exception:
        import traceback

        res["status"] = "error"
        res["output"] = traceback.format_exc()
    finally:
        sys.stdout = old_stdout
        res["output"] = new_stdout.getvalue() + res["output"]

    return json.dumps(res)
