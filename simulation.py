"""Simulation tab: configure and run simulations via the Zoomy server."""

import os
import json
import time
import tempfile
import threading

import param
import panel as pn
import numpy as np

from basicelements import Section

pn.extension("katex")


# ── Model templates ──────────────────────────────────────────────────────────

MODEL_TEMPLATES = {
    "Scalar Advection": {
        "model_code": """\
from zoomy_core.model.models.advection_model import ScalarAdvection
import zoomy_core.model.boundary_conditions as BC
import zoomy_core.model.initial_conditions as IC
import numpy as np

model = ScalarAdvection(dimension=1)
model.parameter_values = np.array([1.0])
model.initial_conditions = IC.UserFunction(
    function=lambda x: np.array([np.exp(-100 * (x[0] - 0.3) ** 2)])
)
model.boundary_conditions = BC.BoundaryConditions([
    BC.Extrapolation(tag="left"),
    BC.Extrapolation(tag="right"),
])
""",
        "solver": "HyperbolicSolver",
    },
    "SWE (SME L0)": {
        "model_code": """\
from zoomy_core.model.models.sme_model import SMEInviscid
import zoomy_core.model.boundary_conditions as BC
import zoomy_core.model.initial_conditions as IC
import numpy as np

model = SMEInviscid(level=0)
pv = np.array(model.parameter_values, dtype=float)
pv[list(model.parameters.keys()).index("g")] = 9.81
model.parameter_values = pv

def dam_break_ic(x):
    Q = np.zeros(model.n_variables)
    Q[1] = 2.0 if x[0] < 5.0 else 1.0
    return Q

model.initial_conditions = IC.UserFunction(function=dam_break_ic)
model.boundary_conditions = BC.BoundaryConditions([
    BC.Extrapolation(tag="left"),
    BC.Wall(tag="right", momentum_field_indices=[[2]]),
])
""",
        "solver": "FreeSurfaceFlowSolver",
    },
    "SME L1": {
        "model_code": """\
from zoomy_core.model.models.sme_model import SMEInviscid
import zoomy_core.model.boundary_conditions as BC
import zoomy_core.model.initial_conditions as IC
import numpy as np

model = SMEInviscid(level=1)
pv = np.array(model.parameter_values, dtype=float)
pv[list(model.parameters.keys()).index("g")] = 9.81
model.parameter_values = pv

nv = model.n_variables
def dam_break_ic(x, _nv=nv):
    Q = np.zeros(_nv)
    Q[1] = 2.0 if x[0] < 5.0 else 1.0
    return Q

model.initial_conditions = IC.UserFunction(function=dam_break_ic)
model.boundary_conditions = BC.BoundaryConditions([
    BC.Extrapolation(tag="left"),
    BC.Extrapolation(tag="right"),
])
""",
        "solver": "FreeSurfaceFlowSolver",
    },
    "Advection-Diffusion (IMEX)": {
        "model_code": """\
from zoomy_core.model.models.advection_model import ScalarAdvectionDiffusion
import zoomy_core.model.boundary_conditions as BC
import zoomy_core.model.initial_conditions as IC
import numpy as np

nu = 0.01
model = ScalarAdvectionDiffusion(dimension=1, nu=nu)
model.parameter_values = np.array([1.0, nu])
model.initial_conditions = IC.UserFunction(
    function=lambda x: np.array([np.exp(-100 * (x[0] - 0.3) ** 2)])
)
model.boundary_conditions = BC.BoundaryConditions([
    BC.Extrapolation(tag="left"),
    BC.Extrapolation(tag="right"),
])
""",
        "solver": "IMEXSolver",
    },
}


# ── Simulation Section ───────────────────────────────────────────────────────

class SimulationSection(Section):
    """Configure and run simulations."""

    def __init__(self, parent_app, **params):
        super().__init__(**params)
        self.title = "Simulation"

        # ── Widgets ──
        self._model_select = pn.widgets.Select(
            name="Model",
            options=list(MODEL_TEMPLATES.keys()),
            value="SWE (SME L0)",
        )
        self._solver_select = pn.widgets.Select(
            name="Solver",
            options=["HyperbolicSolver", "FreeSurfaceFlowSolver", "IMEXSolver"],
            value="FreeSurfaceFlowSolver",
        )
        self._order = pn.widgets.IntSlider(
            name="Reconstruction order", value=1, start=1, end=2
        )
        self._cfl = pn.widgets.FloatSlider(
            name="CFL", value=0.3, start=0.05, end=0.9, step=0.05
        )
        self._time_end = pn.widgets.FloatInput(
            name="End time", value=0.1, start=0.001, step=0.01
        )
        self._n_cells = pn.widgets.IntInput(
            name="N cells", value=100, start=10, step=10
        )
        self._domain_min = pn.widgets.FloatInput(name="x_min", value=0.0, step=0.1)
        self._domain_max = pn.widgets.FloatInput(name="x_max", value=10.0, step=0.1)

        self._server_url = pn.widgets.TextInput(
            name="Server URL", value="http://localhost:8000"
        )

        self._run_btn = pn.widgets.Button(
            name="Run Simulation", button_type="primary"
        )
        self._run_btn.on_click(self._on_run)

        self._run_local_btn = pn.widgets.Button(
            name="Run Local (no server)", button_type="success"
        )
        self._run_local_btn.on_click(self._on_run_local)

        self._status = pn.pane.Markdown("*Ready*")
        self._result_plot = pn.pane.Matplotlib(None, tight=True)

        # Sync solver when model changes
        self._model_select.param.watch(self._sync_solver, "value")

    def _sync_solver(self, event):
        tpl = MODEL_TEMPLATES.get(event.new, {})
        solver = tpl.get("solver", "HyperbolicSolver")
        self._solver_select.value = solver

    def main_view(self):
        config = pn.Column(
            "## Simulation",
            pn.Row(
                pn.Column(
                    self._model_select,
                    self._solver_select,
                    self._order,
                    self._cfl,
                    self._time_end,
                    width=250,
                ),
                pn.Column(
                    self._n_cells,
                    self._domain_min,
                    self._domain_max,
                    self._server_url,
                    width=250,
                ),
            ),
            pn.Row(self._run_btn, self._run_local_btn),
            self._status,
            self._result_plot,
        )
        return config

    def sidebar(self):
        return pn.Column(
            pn.pane.Markdown("### Simulation"),
            pn.pane.Markdown("Configure model, solver, and mesh.\n\n"
                             "**Run Local** executes in-process.\n"
                             "**Run Simulation** submits to server."),
        )

    # ── Local execution (no server needed) ────────────────────────────

    def _on_run_local(self, event):
        self._status.object = "*Running locally...*"
        self._run_local_btn.disabled = True
        threading.Thread(target=self._run_local_worker, daemon=True).start()

    def _run_local_worker(self):
        try:
            model_name = self._model_select.value
            tpl = MODEL_TEMPLATES[model_name]

            # Execute model code to get `model` object
            scope = {}
            exec(tpl["model_code"], scope)
            model = scope["model"]

            # Build mesh
            from zoomy_core.mesh import BaseMesh
            mesh = BaseMesh.create_1d(
                domain=(self._domain_min.value, self._domain_max.value),
                n_inner_cells=self._n_cells.value,
            )

            # Build solver
            solver_cls = self._get_solver_class(self._solver_select.value)
            import zoomy_core.fvm.timestepping as ts
            solver = solver_cls(
                time_end=self._time_end.value,
                compute_dt=ts.adaptive(CFL=self._cfl.value),
                reconstruction_order=self._order.value,
            )

            Q, Qaux = solver.solve(mesh, model, write_output=False)

            # Plot
            from zoomy_core.mesh import ensure_lsq_mesh
            lsq = ensure_lsq_mesh(mesh, model)
            nc = lsq.n_inner_cells
            xc = lsq.cell_centers[0, :nc]

            import matplotlib.pyplot as plt
            fig, ax = plt.subplots(figsize=(8, 4))
            for v in range(min(Q.shape[0], 4)):
                vname = list(model.variables.keys())[v] if hasattr(model, "variables") else f"Q[{v}]"
                ax.plot(xc, Q[v, :nc], label=vname)
            ax.set_xlabel("x")
            ax.set_ylabel("Q")
            ax.set_title(f"{model_name} — t={self._time_end.value}")
            ax.legend()
            ax.grid(True, alpha=0.3)

            self._result_plot.object = fig
            self._status.object = f"**Done** — {solver.last_stats.n_steps} steps"
            plt.close(fig)

        except Exception as e:
            self._status.object = f"**Error:** {e}"
        finally:
            self._run_local_btn.disabled = False

    # ── Server execution ──────────────────────────────────────────────

    def _on_run(self, event):
        self._status.object = "*Submitting to server...*"
        self._run_btn.disabled = True
        threading.Thread(target=self._run_server_worker, daemon=True).start()

    def _run_server_worker(self):
        try:
            import requests

            model_name = self._model_select.value
            tpl = MODEL_TEMPLATES[model_name]

            # Write case files to temp dir
            case_dir = tempfile.mkdtemp(prefix="zoomy_case_")
            with open(os.path.join(case_dir, "model.py"), "w") as f:
                f.write(tpl["model_code"])

            with open(os.path.join(case_dir, "mesh.py"), "w") as f:
                f.write(f"""\
from zoomy_core.mesh import BaseMesh
mesh = BaseMesh.create_1d(
    domain=({self._domain_min.value}, {self._domain_max.value}),
    n_inner_cells={self._n_cells.value},
)
""")

            settings = {
                "solver": self._solver_select.value,
                "reconstruction_order": self._order.value,
                "CFL": self._cfl.value,
                "time_end": self._time_end.value,
            }
            with open(os.path.join(case_dir, "settings.json"), "w") as f:
                json.dump(settings, f)

            # Submit job
            base = self._server_url.value.rstrip("/")
            resp = requests.post(f"{base}/api/v1/jobs", json={"case_dir": case_dir})
            resp.raise_for_status()
            job_id = resp.json()["job_id"]
            self._status.object = f"*Job submitted: {job_id}*"

            # Poll status
            for _ in range(600):
                time.sleep(1)
                resp = requests.get(f"{base}/api/v1/jobs/{job_id}")
                status = resp.json()
                if status["status"] == "complete":
                    self._status.object = f"**Complete** — job {job_id}"
                    break
                elif status["status"] == "failed":
                    self._status.object = f"**Failed:** {status.get('error', 'unknown')}"
                    break
                else:
                    prog = status.get("progress", {})
                    self._status.object = (
                        f"*Running... it={prog.get('iteration', '?')}, "
                        f"t={prog.get('time', '?'):.4f}*"
                    )
            else:
                self._status.object = "**Timeout** — job still running"

        except Exception as e:
            self._status.object = f"**Error:** {e}"
        finally:
            self._run_btn.disabled = False

    @staticmethod
    def _get_solver_class(name):
        if name == "FreeSurfaceFlowSolver":
            from zoomy_core.fvm.solver_numpy import FreeSurfaceFlowSolver
            return FreeSurfaceFlowSolver
        elif name == "IMEXSolver":
            from zoomy_core.fvm.solver_imex_numpy import IMEXSolver
            return IMEXSolver
        else:
            from zoomy_core.fvm.solver_numpy import HyperbolicSolver
            return HyperbolicSolver
