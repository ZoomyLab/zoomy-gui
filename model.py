import param
import panel as pn

from basicelements import Card, Section

pn.extension('katex')

# Model descriptions for the card view
_MODELS = [
    {
        "title": "Scalar Advection",
        "latex": r"$\partial_t u + a \, \partial_x u = 0$",
        "desc": "Linear advection of a scalar field at constant speed.",
    },
    {
        "title": "SWE (SME L0)",
        "latex": r"$\partial_t \begin{pmatrix} h \\ hu \end{pmatrix} + \partial_x \begin{pmatrix} hu \\ hu^2/h + gh^2/2 \end{pmatrix} = 0$",
        "desc": "Shallow water equations (depth-averaged, inviscid).",
    },
    {
        "title": "SME L1",
        "latex": r"$\partial_t Q + \nabla \cdot F(Q) + NC(Q) : \nabla Q = S(Q)$",
        "desc": "Shallow Moment Equations level 1 (vertical velocity profile).",
    },
    {
        "title": "Advection-Diffusion",
        "latex": r"$\partial_t u + a \, \partial_x u = \nu \, \partial_{xx} u$",
        "desc": "Scalar advection with diffusion (IMEX time integration).",
    },
]


class ModelCard(Card):

    def __init__(self, parent_app, latex_description, description="", **params):
        super().__init__(parent_app, **params)
        latex = pn.pane.LaTeX(latex_description, width=300)
        desc = pn.pane.Markdown(description, width=300)
        self._layout = pn.Column(self.title, latex, desc, self._btn,
                                  styles=self._default_style)

    def get_controls(self):
        return [pn.widgets.StaticText(value="Select a model, then configure in Simulation tab.")]


class ModelSection(Section):

    def __init__(self, parent_app, **params):
        super().__init__(**params)
        self.title = 'Model'

        cards = []
        for m in _MODELS:
            card = ModelCard(
                parent_app,
                latex_description=m["latex"],
                description=m.get("desc", ""),
                title=m["title"],
            )
            self.manager.add_card(card)
            cards.append(card)

        if cards:
            self.manager.selected_card = cards[0]
