"""Malpasset (AMReX backend): GUI folder-case ``model.py``, the thesis model on the AMReX grid.

The model of the thesis run (Applications, Malpasset, table ``tbl:malpasset-case-setup``; see
the JAX session's model card): SME level 1 with the mixing-length bulk closure and the rough
wall function bed (``k_s = 0.05 m``, ``zeta_p = 0.15 h``), Gauss-Legendre projection of order 5,
the KP-desingularised ``hinv``, the closed-form spectrum and the mode-0 momentum cap, with the
thesis' numerics: HLL with the hydrostatic reconstruction, MUSCL on eta = b + h (bed derived)
with the Venkatakrishnan limiter, every row's limiter tied to the free surface's, the a-priori
front detector beside MOOD, and the point-implicit source.  The case module
``sme_malpasset_model.py`` is inlined into the card.

AMReX is structured: the basin is the bounding box of the triangulation, closed by a reflective
**Wall BC on every structured face** (West = x-lo, East = x-hi, South = y-lo, North = y-hi),
each mirroring ``h`` and the bed and negating the normal momentum of every mode.  The
**initial condition is data**: the run card rasterises the bed and the reservoir depth of the
``.msh`` ``$NodeData`` onto the grid (moments at rest).
"""

from zoomy_core.model.boundary_conditions import BoundaryConditions, Wall
from zoomy_core.numerics import Limiter, NumericalSystemModel, ReconstructionSpec
from zoomy_core.numerics import (
    PositiveNonconservativeHLL, PositiveNonconservativeRusanov)

# the case module, inlined into the card by port_symsolver_sessions.py
from sme_malpasset_model import *  # noqa: F401,F403

_RIEMANN = {"hr": PositiveNonconservativeHLL,
            "rusanov": PositiveNonconservativeRusanov}
#: The sides of the structured grid, by their compass names.
WALLS = ("West", "East", "South", "North")


def momentum_groups(idx):
    """The reflect groups: ``[q_x_k, q_y_k]`` per moment ``k`` (``[hu, hv]`` for SWE)."""
    if "hu" in idx:
        return [[idx["hu"], idx["hv"]]]
    k, groups = 0, []
    while f"q_x_{k}" in idx:
        groups.append([idx[f"q_x_{k}"], idx[f"q_y_{k}"]])
        k += 1
    return groups


def closures_and_parameters(m):
    """``(closures, parameters, quadrature_order)`` of ``settings['model']``; ``closure``:
    ``mixing`` (the thesis run; ``k_s``, ``zeta_p``), ``manning`` (``n``, ``nu``), ``elder``
    (``k_s``) or ``navier`` (``nu``, ``lambda_s``)."""
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
    params["wet_dry_eps"] = float(m.get("wet_dry_eps", 1e-3))
    return closures, params, quad


def build_model(settings):
    """The closed-basin ``MalpassetSME`` NSM with the wall BCs baked, from ``settings``;
    returns ``{nsm, sm, idx}``."""
    m, num = settings["model"], settings["numerics"]
    closures, params, quad = closures_and_parameters(m)
    sme = MalpassetSME(
        level=m.get("level", 1), dimension=m.get("dimension", 3),
        closures=closures, desingularize=m.get("desingularize", True),
        clamp=m.get("clamp", True), u_max=m.get("u_max", 30.0),
        parameters=params, quadrature_order=quad, symbolic_spectrum=True)
    sm = sme.system_model
    idx = {str(s): k for k, s in enumerate(sm.state)}
    sm.attach_boundary_conditions(BoundaryConditions([
        Wall(tag=t, momentum_field_indices=momentum_groups(idx),
             permeability=0.0, wall_slip=1.0) for t in WALLS]))
    order = int(num.get("order", 2))
    nsm = NumericalSystemModel.from_system_model(
        sm, riemann=_RIEMANN[num.get("riemann", "hr")],
        reconstruction=ReconstructionSpec(
            order=order, limiter=Limiter(num.get("limiter", Limiter.venkatakrishnan)),
            ties={str(s): "h" for s in sm.state if str(s) != "h"},
            front_tol=num.get("front_tol") if order >= 2 else None),
        source_treatment=num.get("source_treatment", "linearized"))
    return {"nsm": nsm, "sm": sm, "idx": idx}
