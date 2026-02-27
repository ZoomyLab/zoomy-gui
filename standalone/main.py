import panel as pn
import plotly.graph_objects as go
import numpy as np
import sys
import io

# Initialize extensions
# We do NOT use 'app.servable()' at the end anymore.
pn.extension("codeeditor", "plotly", sizing_mode="stretch_width")


# --- 1. THE EXECUTION ENGINE (Shared) ---
def execute_block(editor, output_pane, status_pane):
    # Capture stdout
    new_stdout = io.StringIO()
    old_stdout = sys.stdout
    sys.stdout = new_stdout

    status_pane.object = "🏃 Running..."
    status_pane.alert_type = "primary"

    try:
        # Create a fresh scope
        local_scope = {}

        # Run Code
        exec(editor.value, globals(), local_scope)

        # Check for Figure
        if "fig" in local_scope:
            output_pane.object = local_scope["fig"]
            status_pane.object = "✅ Success"
            status_pane.alert_type = "success"
        else:
            status_pane.object = "⚠️ Ran, but no 'fig' found."
            status_pane.alert_type = "warning"

    except Exception as e:
        status_pane.object = f"❌ Error: {str(e)}"
        status_pane.alert_type = "danger"
    finally:
        sys.stdout = old_stdout


# --- 2. THE COMPONENT BUILDER ---
async def mount_simulation(target_id, default_code, title):
    """
    Creates the widgets and explicitly writes them to the HTML ID.
    """
    # Define Widgets
    editor = pn.widgets.CodeEditor(
        value=default_code, height=250, theme="monokai", sizing_mode="stretch_width"
    )

    run_btn = pn.widgets.Button(
        name="▶ Run Simulation", button_type="primary", width=150
    )
    status = pn.pane.Alert(
        "Ready", alert_type="light", height=40, sizing_mode="stretch_width"
    )
    plot_pane = pn.pane.Plotly(height=350, sizing_mode="stretch_width")

    # Link Button
    run_btn.on_click(lambda e: execute_block(editor, plot_pane, status))

    # Create Layout
    layout = pn.Column(
        f"### {title}",
        status,
        pn.Row(editor, plot_pane),
        run_btn,
        sizing_mode="stretch_width",
    )

    # --- CRITICAL FIX: EXPLICIT WRITE ---
    # This forces Panel to find the ID 'target_id' and render 'layout' into it.
    await pn.io.pyodide.write(target_id, layout)


# --- 3. MOUNT EVERYTHING ---
# We use 'await' because writing to the DOM is an async operation in Pyodide
async def main():
    # Block 1
    code_1 = """import plotly.graph_objects as go
import numpy as np

x = np.linspace(0, 10, 100)
y = np.sin(x)

fig = go.Figure(data=go.Scatter(x=x, y=y, mode='lines+markers'))
fig.update_layout(title="Sine Wave", height=300)
"""
    await mount_simulation("sim-1", code_1, "1. Basic Sine Wave")

    # Block 2
    code_2 = """import plotly.graph_objects as go
import numpy as np

# Create a 3D Cone (Vector Field)
fig = go.Figure(data=go.Cone(
    x=[1], y=[1], z=[1],
    u=[1], v=[1], w=[0],
    sizemode="absolute", sizeref=2, anchor="tail"))

fig.update_layout(scene=dict(aspectmode='data'), height=300)
"""
    await mount_simulation("sim-2", code_2, "2. 3D Vector Field")


# Trigger the main function
# In Pyodide, top-level await is allowed
pn.state.onload(main)
