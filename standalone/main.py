import panel as pn
import sys
import io
import traceback

# --- 1. SETUP & EXTENSIONS ---
# Load CodeEditor for the IDE and Plotly for 3D visualization
pn.extension("codeeditor", "plotly", sizing_mode="stretch_width")

# --- 2. DEFAULT CODE (The "Ultimate" Time-Series Demo) ---
# This script demonstrates handling both changing fields AND changing geometry.
DEFAULT_CODE = """import plotly.graph_objects as go
import panel as pn
import numpy as np

# --- 1. DATA GENERATION (Simulating a Time-Series) ---
# We create 20 frames of a sphere that "breathes" (changing geometry)
# and has a "wave" of color moving across it (changing field).

n_steps = 20
frames = []

# Base Geometry (Grid)
phi = np.linspace(0, np.pi, 20)
theta = np.linspace(0, 2 * np.pi, 40)
phi, theta = np.meshgrid(phi, theta)

print(f"Generating {n_steps} time steps...")

for t in range(n_steps):
    # Time factor (0 to 2pi)
    time = t / n_steps * 2 * np.pi
    
    # A. DYNAMIC GEOMETRY (Mesh Deformation)
    # The sphere expands and contracts ("breathes")
    radius = 1 + 0.2 * np.sin(time)
    
    x = (radius * np.sin(phi) * np.cos(theta)).flatten()
    y = (radius * np.sin(phi) * np.sin(theta)).flatten()
    z = (radius * np.cos(phi)).flatten()
    
    # B. DYNAMIC FIELD (Scalar Value)
    # A color wave moves up and down the Z-axis
    field = np.sin(z * 3 + time * 2)
    
    # Store everything for this frame
    frames.append({
        'x': x, 'y': y, 'z': z, 'field': field
    })

print("Data ready. Initializing Plot...")

# --- 2. INITIAL PLOT ---
# We create the figure using the first frame (t=0)
initial_frame = frames[0]

mesh = go.Mesh3d(
    x=initial_frame['x'], 
    y=initial_frame['y'], 
    z=initial_frame['z'],
    intensity=initial_frame['field'],
    colorscale='Viridis',
    cmin=-1, cmax=1, # Lock color range to avoid flickering
    showscale=True
)

fig = go.Figure(data=[mesh])

# Set a fixed camera so the view doesn't reset on update
fig.update_layout(
    scene=dict(
        xaxis=dict(range=[-1.5, 1.5], visible=False),
        yaxis=dict(range=[-1.5, 1.5], visible=False),
        zaxis=dict(range=[-1.5, 1.5], visible=False),
        aspectmode='cube'
    ),
    height=500,
    margin=dict(l=0, r=0, b=0, t=0)
)

# Put figure in a Pane so we can update it
plot_pane = pn.pane.Plotly(fig, sizing_mode='stretch_width')

# --- 3. ANIMATION PLAYER ---
player = pn.widgets.Player(
    name='Time Step',
    start=0, end=n_steps-1, value=0,
    loop_policy='loop', interval=100
)

# --- 4. THE UPDATE FUNCTION ---
def update_view(step):
    frame = frames[step]
    data = plot_pane.object.data[0]
    
    # CASE 1: Changing Scalar Field (Color)
    # Very fast, minimal memory bandwidth
    data.intensity = frame['field']
    
    # CASE 2: Changing Geometry (Topography/Mesh)
    # If your mesh moves, update x, y, z. 
    # (If your mesh is static, you can remove these lines for speed)
    data.x = frame['x']
    data.y = frame['y']
    data.z = frame['z']
    
    # Trigger UI refresh
    plot_pane.param.trigger('object')
    return f"Step: {step} | Radius: {1 + 0.2*np.sin(step/n_steps*2*np.pi):.2f}"

# Bind the function to the player
status_text = pn.bind(update_view, player)

# --- 5. RESULT LAYOUT ---
# We assign our layout to a variable 'layout' so the IDE picks it up
layout = pn.Column(
    "### 🌊 Dynamic 3D Simulation",
    "Demonstrating simultaneous mesh deformation and field evolution.",
    plot_pane,
    pn.Row(player, status_text)
)

layout # Final line: Return the layout to be displayed
"""

# --- 3. UI COMPONENTS ---

# Status Header
status_alert = pn.pane.Alert(
    "✅ System Ready. Python Kernel Loaded.",
    alert_type="success",
    sizing_mode="stretch_width",
)

# The Code Editor
editor = pn.widgets.CodeEditor(
    value=DEFAULT_CODE,
    language="python",
    theme="monokai",
    height=400,
    sizing_mode="stretch_width",
)

# Control Buttons
run_button = pn.widgets.Button(
    name="▶ Run Simulation", button_type="primary", width=150, icon="player-play"
)
clear_button = pn.widgets.Button(
    name="🗑️ Clear Output", button_type="light", width=150, icon="trash"
)

# The Output Area (Dynamic)
# We use a placeholder that we will replace with plots/layouts
result_placeholder = pn.Column(
    pn.pane.Markdown(
        "### 📉 Result Area\n_Run the code to see visualizations here..._"
    ),
    sizing_mode="stretch_width",
)

# The Debug Console
debug_console = pn.widgets.TextAreaInput(
    name="Debug Console (stdout/stderr)",
    value="Ready...",
    disabled=True,
    height=150,
    sizing_mode="stretch_width",
    styles={
        "font-family": "monospace",
        "background": "#f8f9fa",
        "border": "1px solid #dee2e6",
    },
)

# --- 4. EXECUTION ENGINE ---


def run_code(event):
    """
    Executes the code in the editor within a persistent scope.
    Captures stdout/stderr and detects displayable objects.
    """
    debug_console.value = "🚀 Running..."
    run_button.loading = True

    # A. Prepare Scope
    # We attach the scope to the function so variables persist (needed for animations)
    if not hasattr(run_code, "scope"):
        run_code.scope = globals().copy()

    # B. Capture Streams
    old_stdout = sys.stdout
    old_stderr = sys.stderr
    new_stdout = io.StringIO()
    new_stderr = io.StringIO()
    sys.stdout = new_stdout
    sys.stderr = new_stderr

    try:
        # C. Execute Code
        # We pass the SAME dictionary for globals/locals to handle scope correctly
        exec(editor.value, run_code.scope, run_code.scope)

        # D. Detect Output Objects
        # We look for common variable names or 'last expression' logic
        display_obj = None

        # Priority 1: Did the user define 'layout'? (Best for Panel apps)
        if "layout" in run_code.scope:
            display_obj = run_code.scope["layout"]

        # Priority 2: Did the user define 'fig'? (Best for Plotly/Matplotlib)
        elif "fig" in run_code.scope:
            display_obj = run_code.scope["fig"]

        # Priority 3: Check Matplotlib backend
        elif (
            "matplotlib" in run_code.scope
            and "pyplot" in run_code.scope["matplotlib"].__dict__
        ):
            plt = run_code.scope["matplotlib"].pyplot
            if plt.get_fignums():
                display_obj = plt.gcf()
                plt.close(display_obj)

        # E. Update Result Area
        if display_obj:
            # Wrap it in a Panel component to be safe
            result_placeholder[:] = [pn.panel(display_obj, sizing_mode="stretch_width")]
            status_alert.object = "✅ Execution Successful"
            status_alert.alert_type = "success"
        else:
            status_alert.object = (
                "⚠️ Execution finished, but no 'layout' or 'fig' variable found."
            )
            status_alert.alert_type = "warning"

        # F. Update Console
        output_msg = new_stdout.getvalue()
        if output_msg:
            debug_console.value = f"✅ DONE:\n{output_msg}"
        else:
            debug_console.value = "✅ DONE (No text output)"

    except Exception:
        # G. Error Handling
        error_trace = traceback.format_exc()
        partial_output = new_stdout.getvalue()
        debug_console.value = (
            f"❌ ERROR:\n{partial_output}\n--- Traceback ---\n{error_trace}"
        )
        status_alert.object = "❌ Error Occurred (Check Console)"
        status_alert.alert_type = "danger"

    finally:
        # Restore environment
        sys.stdout = old_stdout
        sys.stderr = old_stderr
        run_button.loading = False


def clear_output(event):
    result_placeholder[:] = [pn.pane.Markdown("### 📉 Result Area\n_Cleared._")]
    debug_console.value = "Ready..."
    status_alert.object = "✅ Cleared."
    status_alert.alert_type = "success"
    # Optional: Reset scope?
    # run_code.scope = globals().copy()


run_button.on_click(run_code)
clear_button.on_click(clear_output)

# --- 5. MAIN LAYOUT ---

app = pn.Column(
    "# 🚀 ShallowFlow IDE",
    status_alert,
    "### 📝 Code Editor",
    editor,
    pn.Row(run_button, clear_button),
    pn.layout.Divider(),
    result_placeholder,
    pn.layout.Divider(),
    "### 📟 Debug Console",
    debug_console,
    width=900,
)

# Use a meaningful title for the browser tab
app.servable(title="ShallowFlow IDE")
