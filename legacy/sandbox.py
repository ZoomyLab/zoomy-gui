import param
import panel as pn

from basicelements import Section
from codeblock import CodeBlock, DEFAULT_CODE


class SandboxSection(Section):
    def __init__(self, parent_app, **params):
        super().__init__(**params)
        self.title = "Sandbox"
        self._block = CodeBlock(code=DEFAULT_CODE)

    @param.depends("manager.selected_card")
    def main_view(self):
        return pn.Column(
            f"## {self.title}",
            pn.Spacer(height=10),
            self._block,
            sizing_mode="stretch_width",
        )
