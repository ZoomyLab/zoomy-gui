"""Deliverable for the phase-3 card rework: PROVE the authored model-card defaults run,
straight from the catalog, on the symbolic NumPy solver.

For each card in ``cards/models/default.json`` that builds a zoomy model this
  1. execs the card's ``template`` verbatim (the same string the GUI ships and
     ``tests/test_registry.py`` gates),
  2. builds the mesh from the ``mesh-create-1d`` card's ``init``
     (domain 0..10, 50 cells — no numbers are re-typed here),
  3. marches it with the solver the card implies — ``SymbolicChorinSolverNumpy``
     when the template binds ``split`` (VAM is non-hydrostatic; the predictor from
     ``predictor_nsm``), ``SymbolicHyperbolicSolverNumpy`` otherwise,
  4. writes the run to HDF5 and reads it back through
     ``zoomy_plotting.read_hdf5`` — the same store the GUI's Visualization
     cards see — then plots ``h(x)`` at t=0 and t=t_end via
     ``zoomy_plotting.MatplotlibPlotter``.

The per-panel annotation is the acceptance number: the discrete mass
``Σ h·dx`` over the inner cells.  Wall BCs on both tags make this an EXACT
invariant of the FV update (no flux crosses either end), so ``Δmass`` is a
wall-tightness check, not a tolerance.

Reproduce::

    micromamba run -n zoomy python library/zoomy_gui/deliverable_default_cards.py
"""

import json
import os
import tempfile

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

import zoomy_plotting as zp
from zoomy_core.mesh import BaseMesh
from zoomy_core.numerics import NumericalSystemModel, ReconstructionSpec
from zoomy_core.symsolver.numpy_backend import (SymbolicChorinSolverNumpy,
                                                SymbolicHyperbolicSolverNumpy)
from zoomy_core.symsolver.strategies.chorin import predictor_nsm
from zoomy_core.systemmodel import SystemModel

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_PNG = os.path.join(HERE, "deliverable_default_cards.png")
T_END = 1.0
CFL = 0.9
SNAPSHOTS = 20


def _catalog(name):
    with open(os.path.join(HERE, "cards", name, "default.json")) as fh:
        return {c["id"]: c for c in json.load(fh)}


def run_card(card, mesh, h5_path):
    """Exec the card template and march it with the solver the card implies.
    Returns (state_names, solver_label)."""
    ns = {"display": lambda *a, **k: None}
    exec(compile(card["template"], card["id"], "exec"), ns)  # noqa: S102
    sm = ns["model"]
    names = [str(s) for s in sm.state]
    opts = dict(time_end=T_END, cfl=CFL, dt_write=T_END / SNAPSHOTS, output=h5_path)
    if "split" in ns:                       # non-hydrostatic → Chorin projection
        split = ns["split"]
        solver = SymbolicChorinSolverNumpy(**opts)
        Q, Qaux = solver.setup(mesh, predictor_nsm(split.SM_pred, split.SM_press, split.SM_corr),
                               split.SM_press, split.SM_corr)
        solver.run(Q, Qaux)
        return names, "SymbolicChorinSolverNumpy"

    nsm = NumericalSystemModel.from_system_model(
        sm, reconstruction=ReconstructionSpec(order=1))
    solver = SymbolicHyperbolicSolverNumpy(**opts)
    Q, Qaux = solver.setup(mesh, nsm)
    solver.run(Q, Qaux)
    return names, "SymbolicHyperbolicSolverNumpy"


def main():
    models = _catalog("models")
    mesh_init = _catalog("meshes")["mesh-create-1d"]["init"]
    n_cells = int(mesh_init["n_cells"])
    x0, x1 = float(mesh_init["x_min"]), float(mesh_init["x_max"])
    dx = (x1 - x0) / n_cells
    mesh = BaseMesh.create_1d(domain=(x0, x1), n_inner_cells=n_cells)

    tmp = tempfile.mkdtemp(prefix="zoomy_gui_cards_")
    ids = [cid for cid in models if "SystemModel" in models[cid].get("template", "")]
    with zp.apply_style():
        fig, axes = plt.subplots(1, len(ids), figsize=(4.0 * len(ids), 3.4),
                                 sharey=True)
        for ax, cid in zip(np.atleast_1d(axes), ids):
            card = models[cid]
            h5_path = os.path.join(tmp, f"{cid}.h5")
            names, solver_label = run_card(card, mesh, h5_path)

            store = zp.read_hdf5(h5_path)          # what a viz card sees
            h_field = "h"                          # the store names its fields
            plotter = zp.MatplotlibPlotter(store)
            last = len(store.times) - 1
            plotter.plot(ax, time_step=0, field=h_field,
                         line_color="0.6", line_linestyle="--"
                         )["line"].set_label("t = 0")
            plotter.plot(ax, time_step=last, field=h_field
                         )["line"].set_label(f"t = {float(store.times[last]):.2f}")

            mass = float(np.asarray(
                plotter._cell_values(last, h_field), float)[:n_cells].sum() * dx)
            mass0 = float(np.asarray(
                plotter._cell_values(0, h_field), float)[:n_cells].sum() * dx)
            ax.set_title(f"{cid} — {card['title']}\n{solver_label}", fontsize=9)
            ax.set_xlabel("x [m]")
            ax.annotate(f"$\\Delta$mass = {mass - mass0:+.2e}", (0.04, 0.06),
                        xycoords="axes fraction", fontsize=8,
                        color=("firebrick" if abs(mass - mass0) > 1e-9 else "0.25"))
            ax.legend(fontsize=7, loc="upper right")
            ax.set_ylabel("")          # the plotter labels with the raw q-name
        np.atleast_1d(axes)[0].set_ylabel("h [m]")
        fig.suptitle(
            "GUI model-card defaults: wall-bounded 1-D dam break "
            f"(h = 2 | 1 at x = 5), {n_cells} cells, t_end = {T_END}",
            fontsize=11)
        fig.tight_layout()
        fig.savefig(OUT_PNG, dpi=150)
    print("wrote", OUT_PNG)


if __name__ == "__main__":
    main()
