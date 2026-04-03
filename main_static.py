import param
import panel as pn

from sandbox import SandboxSection

pn.extension("plotly", "codeeditor")


class StaticApp(param.Parameterized):
    def __init__(self, **params):
        super().__init__(**params)
        self.sandbox = SandboxSection(parent_app=self)

    def view(self):
        template = pn.template.BootstrapTemplate(title="Zoomy")
        template.main.append(self.sandbox.main_view)
        return template


layout = StaticApp().view()
layout.servable()
