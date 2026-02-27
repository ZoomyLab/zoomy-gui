importScripts("https://cdn.jsdelivr.net/pyodide/v0.28.2/full/pyodide.js");

function sendPatch(patch, buffers, msg_id) {
  self.postMessage({
    type: 'patch',
    patch: patch,
    buffers: buffers
  })
}

async function startApplication() {
  console.log("Loading pyodide...");
  self.postMessage({type: 'status', msg: 'Loading pyodide'})
  self.pyodide = await loadPyodide();
  self.pyodide.globals.set("sendPatch", sendPatch);
  console.log("Loaded pyodide!");
  const data_archives = [];
  for (const archive of data_archives) {
    let zipResponse = await fetch(archive);
    let zipBinary = await zipResponse.arrayBuffer();
    self.postMessage({type: 'status', msg: `Unpacking ${archive}`})
    self.pyodide.unpackArchive(zipBinary, "zip");
  }
  await self.pyodide.loadPackage("micropip");
  self.postMessage({type: 'status', msg: `Installing environment`})
  try {
    await self.pyodide.runPythonAsync(`
      import micropip
      await micropip.install(['https://cdn.holoviz.org/panel/wheels/bokeh-3.8.1-py3-none-any.whl', 'https://cdn.holoviz.org/panel/1.8.3/dist/wheels/panel-1.8.3-py3-none-any.whl', 'pyodide-http', 'numpy', 'zoomy-core', 'plotly']);
    `);
  } catch(e) {
    console.log(e)
    self.postMessage({
      type: 'status',
      msg: `Error while installing packages`
    });
  }
  console.log("Environment loaded!");
  self.postMessage({type: 'status', msg: 'Executing code'})
  try {
    const [docs_json, render_items, root_ids] = await self.pyodide.runPythonAsync(`\nimport asyncio\n\nfrom panel.io.pyodide import init_doc, write_doc\n\ninit_doc()\n\nimport panel as pn\nimport sys\nimport io\nimport traceback\n\n# Initialize Panel extension\npn.extension("codeeditor", "plotly")\n\n# We create a placeholder for the plot.\n# We set it to 'tight' layout so it fits nicely.\nplot_pane = pn.pane.Matplotlib(\n    dpi=144, tight=True, sizing_mode="stretch_width", visible=False\n)\n\n# Optional: Try to import custom library\ntry:\n    import zoomy_core\n\n    LIB_STATUS = "\u2705 zoomy-core loaded."\n    LIB_TYPE = "success"\nexcept ImportError:\n    LIB_STATUS = "\u26a0\ufe0f zoomy-core not found (installing or missing)."\n    LIB_TYPE = "warning"\n\n# --- UI Elements ---\n\neditor = pn.widgets.CodeEditor(\n    value="import numpy as np\\nimport matplotlib.pyplot as plt\\n\\nx = np.linspace(0, 10, 100)\\ny = np.sin(x)\\n\\nfig, ax = plt.subplots()\\nax.plot(x, y)\\nax.set_title('Sine Wave from Pyodide')\\n\\n# No need for plt.show(), we capture it automatically!",\n    language="python",\n    theme="monokai",\n    height=300,\n    sizing_mode="stretch_width",\n)\n\nrun_button = pn.widgets.Button(name="\u25b6 Run Code", button_type="primary", width=120)\nclear_button = pn.widgets.Button(name="\U0001f5d1\ufe0f Clear Console", button_type="light", width=120)\nstatus = pn.pane.Alert(LIB_STATUS, alert_type=LIB_TYPE)\n\ndebug_console = pn.widgets.TextAreaInput(\n    name="Debug Console",\n    value="Ready...",\n    disabled=True,\n    height=150,\n    sizing_mode="stretch_width",\n    styles={"font-family": "monospace", "background": "#f0f0f0"},\n)\n\n# --- Execution Logic ---\n\n\ndef run_code(event):\n    debug_console.value = "Running...\\n"\n    plot_pane.visible = False  # Hide old plot while running\n\n    # Capture stdout/stderr\n    old_stdout = sys.stdout\n    old_stderr = sys.stderr\n    new_stdout = io.StringIO()\n    new_stderr = io.StringIO()\n    sys.stdout = new_stdout\n    sys.stderr = new_stderr\n\n    try:\n        # 1. Define a dummy 'plt.show()' to prevent errors if user types it\n        # This overrides the standard show() which might block or clear the figure\n        def custom_show():\n            pass\n\n        # 2. Prepare the execution environment\n        # We add 'show' to globals so plt.show() doesn't crash\n        exec_globals = globals()\n        exec_globals["show"] = custom_show\n\n        # 3. Execute User Code\n        exec(editor.value, exec_globals)\n\n        # 4. CAPTURE MATPLOTLIB FIGURE\n        # We check if the 'matplotlib.pyplot' module has been imported\n        if "matplotlib.pyplot" in sys.modules:\n            plt = sys.modules["matplotlib.pyplot"]\n\n            # Check if there are any active figures\n            if plt.get_fignums():\n                fig = plt.gcf()  # Get Current Figure\n                plot_pane.object = fig  # Send to Panel UI\n                plot_pane.visible = True  # Show the pane\n\n                # IMPORTANT: Close the figure in MPL memory so it doesn't\n                # stack up on the next run\n                plt.close(fig)\n\n        # 5. Handle Text Output\n        output_msg = new_stdout.getvalue()\n        if not output_msg:\n            output_msg = "[Script finished]"\n        debug_console.value = f"\u2705 SUCCESS:\\n{output_msg}"\n\n    except Exception:\n        error_trace = traceback.format_exc()\n        partial_output = new_stdout.getvalue()\n        debug_console.value = (\n            f"\u274c ERROR:\\n{partial_output}\\n--- Traceback ---\\n{error_trace}"\n        )\n\n    finally:\n        sys.stdout = old_stdout\n        sys.stderr = old_stderr\n\n\ndef clear_console(event):\n    debug_console.value = "Ready..."\n    plot_pane.visible = False\n\n\nrun_button.on_click(run_code)\nclear_button.on_click(clear_console)\n\n# --- Layout ---\napp = pn.Column(\n    "# \U0001f680 ShallowFlow IDE",\n    status,\n    "### Code Editor",\n    editor,\n    pn.Row(run_button, clear_button),\n    "### Result Plot",\n    plot_pane,  # <--- The Plot appears here\n    "### Debug Console",\n    debug_console,\n    width=700,\n)\n\napp.servable(title="\U0001f680 ShallowFlow IDE")\n\n\nawait write_doc()`)
    self.postMessage({
      type: 'render',
      docs_json: docs_json,
      render_items: render_items,
      root_ids: root_ids
    })
  } catch(e) {
    const traceback = `${e}`
    const tblines = traceback.split('\n')
    self.postMessage({
      type: 'status',
      msg: tblines[tblines.length-2]
    });
    throw e
  }
}

self.onmessage = async (event) => {
  const msg = event.data
  if (msg.type === 'rendered') {
    self.pyodide.runPythonAsync(`
    from panel.io.state import state
    from panel.io.pyodide import _link_docs_worker

    _link_docs_worker(state.curdoc, sendPatch, setter='js')
    `)
  } else if (msg.type === 'patch') {
    self.pyodide.globals.set('patch', msg.patch)
    self.pyodide.runPythonAsync(`
    from panel.io.pyodide import _convert_json_patch
    state.curdoc.apply_json_patch(_convert_json_patch(patch), setter='js')
    `)
    self.postMessage({type: 'idle'})
  } else if (msg.type === 'location') {
    self.pyodide.globals.set('location', msg.location)
    self.pyodide.runPythonAsync(`
    import json
    from panel.io.state import state
    from panel.util import edit_readonly
    if state.location:
        loc_data = json.loads(location)
        with edit_readonly(state.location):
            state.location.param.update({
                k: v for k, v in loc_data.items() if k in state.location.param
            })
    `)
  }
}

startApplication()