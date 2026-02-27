import sys
import io
import json
import base64

# We install these libraries in the HTML loader
import numpy as np
import plotly
import plotly.graph_objects as go
import matplotlib.pyplot as plt

# Optional: zoomy-core
try:
    import zoomy_core

    HAS_ZOOMY = True
except ImportError:
    HAS_ZOOMY = False


def process_code(code_string):
    """
    Executes user code and returns a JSON string containing:
    {
        "status": "success" | "error",
        "output": "stdout text",
        "plot_type": "plotly" | "matplotlib" | "none",
        "plot_data": JSON string or Base64 string
    }
    """
    # 1. Capture Stdout
    new_stdout = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = new_stdout

    response = {
        "status": "success",
        "output": "",
        "plot_type": "none",
        "plot_data": None,
    }

    # 2. Execution Scope
    # We use a persistent scope so variables survive between runs
    if not hasattr(process_code, "scope"):
        process_code.scope = globals().copy()

    try:
        # 3. Run Code
        exec(code_string, process_code.scope)

        # 4. Detect Figures
        # A. Check for 'fig' variable (Plotly convention)
        if "fig" in process_code.scope:
            obj = process_code.scope["fig"]
            # Is it a Plotly Figure?
            if hasattr(obj, "to_json"):
                response["plot_type"] = "plotly"
                response["plot_data"] = obj.to_json()

        # B. Check for Active Matplotlib Figure
        elif plt.get_fignums():
            fig = plt.gcf()
            # Save to Base64
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            buf.seek(0)
            img_str = base64.b64encode(buf.read()).decode("utf-8")
            response["plot_type"] = "matplotlib"
            response["plot_data"] = img_str
            plt.close(fig)  # Clean up

    except Exception as e:
        import traceback

        response["status"] = "error"
        response["output"] = traceback.format_exc()

    finally:
        # Restore stdout and capture output
        sys.stdout = old_stdout
        response["output"] = (
            new_stdout.getvalue() + response["output"]
        )  # Append output if error occurred

    return json.dumps(response)
