import json
import param
import panel as pn


_DEPS_INSTALLED = False

DEFAULT_CODE = """\
import plotly.graph_objects as go
import numpy as np

x = np.linspace(0, 4 * np.pi, 200)
y = np.sin(x)

fig = go.Figure(data=go.Scatter(x=x, y=y, mode="lines"))
fig.update_layout(title="Sine Wave")
"""


class CodeCell(pn.viewable.Viewer):
    code = param.String(default=DEFAULT_CODE)

    def __init__(self, **params):
        super().__init__(**params)
        self._editor = pn.widgets.CodeEditor(
            value=self.code,
            language="python",
            theme="monokai",
            height=250,
            sizing_mode="stretch_width",
        )
        self._editor.param.watch(self._sync_from_editor, "value")
        self.param.watch(self._sync_to_editor, "code")

    def _sync_from_editor(self, event):
        if self.code != event.new:
            self.code = event.new

    def _sync_to_editor(self, event):
        if self._editor.value != event.new:
            self._editor.value = event.new

    def __panel__(self):
        return self._editor


class OutputCell(pn.viewable.Viewer):
    status = param.Selector(default="idle", objects=["idle", "running", "success", "error"])
    result = param.Dict(default=None, allow_None=True)
    preview_path = param.String(default="")

    def __init__(self, **params):
        super().__init__(**params)
        self._container = pn.Column(
            self._render_idle(),
            sizing_mode="stretch_width",
            min_height=100,
        )
        self.param.watch(self._on_status_change, ["status", "result"])

    def _render_idle(self):
        if self.preview_path:
            if self.preview_path.endswith(".svg"):
                return pn.pane.SVG(self.preview_path, width=600)
            return pn.pane.PNG(self.preview_path, width=600)
        return pn.pane.Str("Output will appear here after execution.", styles={"color": "gray"})

    def _render_running(self):
        return pn.Column(
            pn.indicators.LoadingSpinner(value=True, size=40),
            pn.pane.Str("Computing..."),
        )

    def _render_success(self):
        parts = []
        if self.result:
            plot_type = self.result.get("plot_type", "none")
            plot_data = self.result.get("plot_data")

            if plot_type == "plotly" and plot_data:
                fig_dict = json.loads(plot_data) if isinstance(plot_data, str) else plot_data
                parts.append(pn.pane.Plotly(fig_dict, sizing_mode="stretch_width", height=400))

            elif plot_type == "matplotlib" and plot_data:
                import base64
                svg_bytes = base64.b64decode(plot_data)
                svg_str = svg_bytes.decode("utf-8")
                parts.append(pn.pane.HTML(svg_str, sizing_mode="stretch_width", height=400))

            stdout = self.result.get("output", "").strip()
            if stdout:
                parts.append(pn.pane.Str(
                    stdout,
                    styles={"font-family": "monospace", "white-space": "pre-wrap", "background": "#f5f5f5", "padding": "8px"},
                ))

        if not parts:
            parts.append(pn.pane.Str("Executed successfully (no output).", styles={"color": "gray"}))
        return pn.Column(*parts)

    def _render_error(self):
        output = self.result.get("output", "Unknown error") if self.result else "Unknown error"
        return pn.pane.Str(
            output,
            styles={"color": "red", "font-family": "monospace", "white-space": "pre-wrap", "background": "#fff0f0", "padding": "8px"},
        )

    def _on_status_change(self, *events):
        renderer = {
            "idle": self._render_idle,
            "running": self._render_running,
            "success": self._render_success,
            "error": self._render_error,
        }
        self._container.objects = [renderer[self.status]()]

    def __panel__(self):
        return self._container


class CodeBlock(pn.viewable.Viewer):
    code = param.String(default=DEFAULT_CODE)
    preview_path = param.String(default="")

    def __init__(self, **params):
        super().__init__(**params)
        self._code_cell = CodeCell(code=self.code)
        self._output_cell = OutputCell(preview_path=self.preview_path)
        self._run_btn = pn.widgets.Button(name="Run", button_type="success", sizing_mode="stretch_width")
        self._run_btn.on_click(self._on_run)
        self._code_cell.param.watch(self._sync_code, "code")

    def _sync_code(self, event):
        self.code = event.new

    async def _on_run(self, event):
        global _DEPS_INSTALLED
        self._run_btn.disabled = True
        self._run_btn.name = "Computing..."
        self._output_cell.status = "running"

        try:
            if pn.state._is_pyodide and not _DEPS_INSTALLED:
                import micropip
                await micropip.install(["numpy", "plotly", "matplotlib"])
                _DEPS_INSTALLED = True

            from engine import process_code
            result_json = process_code(self._code_cell.code)
            result = json.loads(result_json)
            self._output_cell.result = result
            self._output_cell.status = "success" if result["status"] == "success" else "error"

        except Exception as exc:
            self._output_cell.result = {"status": "error", "output": str(exc), "plot_type": "none", "plot_data": None}
            self._output_cell.status = "error"

        finally:
            self._run_btn.disabled = False
            self._run_btn.name = "Run"

    def __panel__(self):
        return pn.Column(
            self._output_cell,
            self._run_btn,
            self._code_cell,
            styles={"border": "1px solid #e2e8f0", "border-radius": "8px", "padding": "10px"},
            sizing_mode="stretch_width",
        )
