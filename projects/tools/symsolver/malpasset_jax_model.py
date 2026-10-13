"""Malpasset (jax backend): GUI folder-case ``model.py``, the thesis run.

The model the thesis reports (Applications, Malpasset, table ``tbl:malpasset-case-setup``):
SME level 1 with the mixing-length bulk closure and the rough wall function bed
(``k_s = 0.05 m``, matching height ``zeta_p = 0.15 h``), Gauss-Legendre projection of order
5, the KP-desingularised ``hinv``, the closed-form spectrum and the mode-0 momentum cap; IC
from the survey node data of the mesh, reflective walls.  Its run: ``output/zp_l1`` of
``thesis/cases/malpasset_jax``, behind the flood-wave animation and the gauge figures,
from

    malpasset_sme_jax.py --level 1 --order 2 --closure mixing --k-s 0.05 --positivity none
        --front-tol 0.5 --cfl 0.4 --recon-vars eta --riemann hr --eps-wet 1e-3
        --source-treatment linearized --t-end 2000 --windows 40

The case module ``sme_malpasset_model.py`` (``symsolver/sme_malpasset_model.py``, inlined into
the card) is the one that ran (2026-08-14; the thesis keeps that revision uncommitted, in its
stash "wip-other-sessions").  ``build_model``
binds it to the numerics of that run on the symbolic solvers: HLL with the hydrostatic
reconstruction, MUSCL on eta = b + h (bed derived) with the Venkatakrishnan limiter, every row's
limiter tied to the free surface's, the a-priori front detector (``front_tol``) beside MOOD,
and the point-implicit source (I - dt J)^-1 S.
"""

import os

import numpy as np

import zoomy_core.model.initial_conditions as IC
from zoomy_core.mesh import initial_conditions_from_mesh
from zoomy_core.model.boundary_conditions import BoundaryConditions, Wall
from zoomy_core.numerics import (
    Limiter, NumericalSystemModel, ReconstructionSpec, SourceTreatment)
from zoomy_core.numerics import (
    PositiveNonconservativeHLL, PositiveNonconservativeRusanov)

# the case module, inlined into the card by port_symsolver_sessions.py
from sme_malpasset_model import *  # noqa: F401,F403

CASE_DIR = (os.path.dirname(os.path.abspath(__file__))
            if "__file__" in globals() else os.getcwd())
# Default mesh = the case-shipped copy (self-contained folder case).
DEFAULT_MESH_PATH = os.path.join(CASE_DIR, "geo_malpasset-small.msh")

_RIEMANN = {"hr": PositiveNonconservativeHLL,
            "rusanov": PositiveNonconservativeRusanov}


def momentum_layout(idx):
    """Name-aware (x0, y0, wall_groups) for the depth-averaged momentum.

    SWE state ``[b,h,hu,hv]`` -> x0=hu, y0=hv, one reflect group.
    SME state ``[b,h,q_x_0,q_x_1,q_y_0,q_y_1,...]`` -> x0=q_x_0, y0=q_y_0,
    and the mode-0 + mode-1 momenta each form a reflect group."""
    if "hu" in idx:                                   # SWE / MalpassetSWE
        return "hu", "hv", [[idx["hu"], idx["hv"]]]
    if "q_x_0" not in idx:                             # SME 1-D (dimension=2)
        groups = [[idx["q_0"]]] + ([[idx["q_1"]]] if "q_1" in idx else [])
        return "q_0", None, groups
    x0, y0 = "q_x_0", "q_y_0"
    groups = [[idx[x0], idx[y0]]]
    if "q_x_1" in idx and "q_y_1" in idx:
        groups.append([idx["q_x_1"], idx["q_y_1"]])
    return x0, y0, groups


def mesh_ic_field_map(idx):
    """The case-specific B/H/U/V (mesh node data) -> state recipe, by name:
    ``b<-B``, ``h<-H``, ``h u<-H U`` / ``h v<-H V`` on the mode-0 slots (higher
    moments default to 0)."""
    x0, y0, _ = momentum_layout(idx)
    fmap = {"b": "B", "h": "H",
            x0: (lambda f: f["H"] * f["U"])}       # h u
    if y0 is not None:
        fmap[y0] = (lambda f: f["H"] * f["V"])    # h v (2-D map)
    return fmap


class MeshDataIC(IC.InitialConditions):
    """Array-form IC: core reads the ``.msh`` node data and assembles the
    per-cell state ONCE (each cell takes its nearest survey node).  NO h floor:
    dry cells start at exactly h=0."""

    def __init__(self, mesh_path, field_map, state_names, method="nearest", **p):
        super().__init__(**p)
        self._mesh_path = mesh_path
        self._field_map = field_map
        self._state_names = list(state_names)
        self._method = method

    def apply(self, X, Q):
        """Apply."""
        arr = initial_conditions_from_mesh(
            self._mesh_path, self._field_map, state_names=self._state_names,
            method=self._method,
            query_points=np.asarray(X, dtype=float).T)
        Q[...] = np.asarray(arr, dtype=Q.dtype)
        return Q


def build_ic(sm, mesh_path=None):
    """IC from the mesh point-data, mapped onto the state by name; returns
    ``(ic, idx)``."""
    names = [str(s) for s in sm.state]
    idx = {n: k for k, n in enumerate(names)}
    ic = MeshDataIC(mesh_path or DEFAULT_MESH_PATH, mesh_ic_field_map(idx), names)
    return ic, idx


def wall_bcs(sm, idx, mesh):
    """Solid walls: reflect the momentum vectors on every physical boundary tag."""
    _, _, mom_groups = momentum_layout(idx)
    tags = list(getattr(mesh, "boundary_conditions_sorted_names", []) or ["tag_0"])
    return BoundaryConditions([
        Wall(tag=tg, momentum_field_indices=mom_groups,
             permeability=0.0, wall_slip=1.0) for tg in tags
    ]), tags


def closures_and_parameters(m):
    """``(closures, parameters, quadrature_order)`` of ``settings['model']``.

    ``closure``: ``mixing`` (the thesis run: mixing-length bulk, rough wall function bed at
    ``zeta_p`` of the depth, stress-free surface; ``k_s``, ``zeta_p``), ``manning``
    (``n``, ``nu``), ``elder`` (``k_s``) or ``navier`` (``nu``, ``lambda_s``)."""
    closure = m.get("closure", "mixing")
    quad = int(m.get("quadrature_order", 0))
    if closure == "mixing":
        closures = malpasset_mixinglength_closures()
        params, knobs = dict(MALPASSET_MIXINGLENGTH_PARAMS), ("k_s", "zeta_p")
        quad = quad or 5                     # the bulk stress is nonlinear in zeta
    elif closure == "manning":
        closures = malpasset_manning_closures()
        params, knobs = dict(MALPASSET_MANNING_PARAMS), ("n", "nu")
    elif closure == "elder":
        closures = malpasset_elder_closures()
        params, knobs = dict(MALPASSET_ELDER_PARAMS), ("k_s",)
    elif closure == "navier":
        closures = malpasset_closures()
        params, knobs = dict(MALPASSET_SME_PARAMS), ("nu", "lambda_s")
    else:
        raise ValueError(f"closure {closure!r}: mixing, manning, elder or navier")
    params.update({k: float(m[k]) for k in knobs if k in m})
    # the wet/dry threshold is the NSM-owned model parameter
    params["wet_dry_eps"] = float(m.get("wet_dry_eps", 1e-3))
    return closures, params, quad


def build_model(settings, mesh, case_dir=None):
    """Build the Malpasset ``MalpassetSME`` NSM with IC/BC baked, from
    ``settings``; returns ``{nsm, sm, idx, tags}``."""
    case_dir = case_dir or CASE_DIR
    m = settings["model"]
    num = settings["numerics"]

    closures, params, quad = closures_and_parameters(m)
    sme = MalpassetSME(
        level=m.get("level", 1), dimension=m.get("dimension", 3),
        closures=closures, desingularize=m.get("desingularize", True),
        clamp=m.get("clamp", True), u_max=m.get("u_max", 30.0),
        parameters=params, quadrature_order=quad, symbolic_spectrum=True)
    sm = sme.system_model

    # IC (mesh point-data) + wall BCs
    mesh_path = os.path.join(case_dir, settings["mesh"])
    ic, idx = build_ic(sm, mesh_path=mesh_path)
    bcs, tags = wall_bcs(sm, idx, mesh)
    sm.attach_boundary_conditions(bcs)
    sm.initial_conditions = ic
    sm.aux_initial_conditions = IC.Constant(constants=lambda n: np.zeros(n))

    # numerics: HLL with the hydrostatic reconstruction; order 2: MUSCL on the model's
    # variables (eta = b + h with the bed derived, u = hinv q), every row's limiter tied to the
    # free surface's and the a-priori front detector; the point-implicit source
    order = int(num.get("order", 2))
    nsm = NumericalSystemModel.from_system_model(
        sm, riemann=_RIEMANN[num.get("riemann", "hr")],
        reconstruction=ReconstructionSpec(
            order=order, limiter=Limiter(num.get("limiter", Limiter.venkatakrishnan)),
            ties={str(s): "h" for s in sm.state if str(s) != "h"},
            front_tol=num.get("front_tol") if order >= 2 else None),
        source_treatment=SourceTreatment(
            num.get("source_treatment", SourceTreatment.linearized)))
    return {"nsm": nsm, "sm": sm, "idx": idx, "tags": tags}
