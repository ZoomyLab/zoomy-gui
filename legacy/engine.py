import sys, io, json, base64
import numpy as np
import plotly.graph_objects as go
import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt


class NumpyEncoder(json.JSONEncoder):
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        elif isinstance(obj, np.floating):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


if not hasattr(sys, "_shallowflow_scope"):
    sys._shallowflow_scope = {"np": np, "go": go, "plt": plt}


def process_code(code_string):
    new_stdout = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = new_stdout

    res = {"status": "success", "output": "", "plot_type": "none", "plot_data": None}
    scope = sys._shallowflow_scope

    try:
        scope.pop("fig", None)
        plt.close("all")

        exec(code_string, scope)

        if "fig" in scope:
            fig_obj = scope["fig"]
            res["plot_type"] = "plotly"
            if hasattr(fig_obj, "to_dict"):
                fig_data = fig_obj.to_dict()
            else:
                fig_data = fig_obj
            res["plot_data"] = json.dumps(fig_data, cls=NumpyEncoder)

        elif plt.get_fignums():
            buf = io.BytesIO()
            plt.gcf().savefig(buf, format="svg", bbox_inches="tight")
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

    return json.dumps(res, cls=NumpyEncoder)
