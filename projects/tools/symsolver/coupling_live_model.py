"""SME | VOF live coupling — the reduced arms' model.

A dam break on the reduced arm crosses into a resolved VOF tank (OpenFOAM 13
incompressibleVoF) at x = 0: h 0.18 | 0.04 m at x = -0.4 m, Fr* = 0.752. Each reduced
arm is SME(1) with the Newtonian bulk, a Navier-slip bed and a stress-free surface
(nu = 1e-3, lambda_s = 0.5), a wall at its outer end and the coupled face (preCICE) at
the tank. The arms and the tank exchange the column [b, h, u, v, w, p] on the tank's
40 cells over its height, so the model's `project_from_3d` samples NZ = 40 cell-centre
heights.

Numerics (`arm_numerics`): order 1, the path-conservative Rusanov flux with the
hydrostatic reconstruction (positivity: the reconstruction and the CFL step), its wave
speed from the numerical spectrum of the quasilinear matrix.
"""
import numpy as np

import zoomy_core.model.boundary_conditions as BC
import zoomy_core.model.initial_conditions as IC
from zoomy_core.fvm.riemann_solvers import PositiveNonconservativeRusanov
from zoomy_core.model.models import SME
from zoomy_core.model.models.closures import NavierSlip, Newtonian, StressFree
from zoomy_core.numerics import NumericalSystemModel, ReconstructionSpec
from zoomy_core.systemmodel import SystemModel
from zoomy_core.systemmodel.system_model import SpectralRadius

#: the dam break (m): reservoir depth, still depth everywhere else, dam position
H_HIGH, H_LOW, X_DAM = 0.18, 0.04, -0.4
#: cells of the VOF tank over its height = the column samples = the model's project_nz
NZ = 40
#: the reduced arms, by preCICE participant: (domain, the coupled side, dam or None)
ARMS = {"Swe": ((-0.6, 0.0), "right", X_DAM)}  # packer: ARMS


def arm_model(name):
    """The SystemModel of the reduced arm `name` (`ARMS`), its BCs and IC baked."""
    (x0, x1), coupled, dam = ARMS[name]
    outer = "left" if coupled == "right" else "right"
    high = lambda n: np.array([0.0, H_HIGH] + [0.0] * (n - 2))  # noqa: E731
    low = lambda n: np.array([0.0, H_LOW] + [0.0] * (n - 2))    # noqa: E731
    return SystemModel.from_model(SME(
        level=1, closures=[Newtonian(), NavierSlip(), StressFree()], project_nz=NZ,
        parameters={"nu": 1e-3, "lambda_s": 0.5},
        boundary_conditions=BC.BoundaryConditions(
            [BC.FromModel(tag=outer, definition="wall"),
             BC.Coupled(tag=coupled, mesh_name=f"{name}Mesh")]),
        initial_conditions=IC.RP(high=high if dam is not None else low, low=low,
                                 jump_position_x=x1 if dam is None else dam)))


def arm_numerics(model):
    """The arm's NumericalSystemModel (see the module docstring)."""
    nsm = NumericalSystemModel.from_system_model(
        model, riemann=PositiveNonconservativeRusanov,
        reconstruction=ReconstructionSpec(order=1))
    nsm.spectral_radius_method = SpectralRadius.eig
    return nsm


model = arm_model("Swe")          # the arm with the dam
display(model.describe())
