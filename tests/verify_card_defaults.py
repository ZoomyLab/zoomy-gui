"""PHASE-3 acceptance: every GUI model card's DEFAULT template must exec and then
actually march on the default mesh (BaseMesh.create_1d(domain=(0,10),
n_inner_cells=50) — the `mesh-create-1d` card's init) with the solver the card
names.  Asserts finite state and h > 0, and reports h_min / h_max / mass.

Mass is the discrete integral sum(h)*dx over the 50 INNER cells; with Wall BCs on
both tags it is an exact invariant of the FV update (no flux through either end),
so mass == 15.0 = 25*2 + 25*1 times dx=0.2 is the wall-tightness check, not a
soft tolerance.
"""
import json, pathlib
import numpy as np

from zoomy_core.mesh import BaseMesh
from zoomy_core.numerics import NumericalSystemModel, ReconstructionSpec
from zoomy_core.fvm.solver_numpy import HyperbolicSolver
from zoomy_core.fvm.solver_chorin_vam_numpy import ChorinSplitVAMSolver
import zoomy_core.fvm.timestepping as ts

GUI = pathlib.Path("/Users/adam-obbpb5az1dhsjzf/git/Zoomy/library/zoomy_gui")
CARDS = json.loads((GUI / "cards/models/default.json").read_text())
MESH_INIT = {c["id"]: c for c in json.loads(
    (GUI / "cards/meshes/default.json").read_text())}["mesh-create-1d"]["init"]

assert MESH_INIT["n_cells"] == 50, MESH_INIT
NC = MESH_INIT["n_cells"]
X0, X1 = MESH_INIT["x_min"], MESH_INIT["x_max"]
DX = (X1 - X0) / NC
T_END = 0.05
MASS0 = (25 * 2.0 + 25 * 1.0) * DX

# The card ids that must be present, and nothing else.
    [c["id"] for c in CARDS]

mesh = BaseMesh.create_1d(domain=(X0, X1), n_inner_cells=NC)
rows, failures = [], []

for card in CARDS:
    cid = card["id"]
    ns = {}
    try:
        exec(compile(card["template"], cid, "exec"), ns)   # noqa: S102
        sm = ns["model"]
        names = [str(s) for s in sm.state]

        if "split" in ns:                     # VAM: Chorin projection march
            solver_used = "ChorinSplitVAMSolver(lu, hr)"
            sol = ChorinSplitVAMSolver(
                stages=ns["split"].stages, pressure_solver="lu",
                riemann_solver="hr", time_end=T_END,
                compute_dt=ts.adaptive(CFL=0.3, dimension=1))
            sol.setup_simulation(mesh, write_output=False)
            Q, _ = sol.run_simulation()
        else:                                 # hydrostatic: plain numpy march
            solver_used = "HyperbolicSolver"
            nsm = NumericalSystemModel.from_system_model(
                sm, reconstruction=ReconstructionSpec(order=1))
            sol = HyperbolicSolver(
                time_end=T_END,
                compute_dt=ts.adaptive(CFL=0.3, dimension=1))
            Q, _ = sol.solve(mesh, nsm, write_output=False)

        Q = np.asarray(Q, float)[:, :NC]
        h = Q[names.index("h")]
        assert np.all(np.isfinite(Q)), "non-finite state"
        assert h.min() > 0.0, f"h_min = {h.min()}"
        mass = float(h.sum() * DX)
        xc = X0 + (np.arange(NC) + 0.5) * DX
        h_ic = np.where(xc < 5.0, 2.0, 1.0)
        rows.append((cid, solver_used, len(names), float(h.min()), float(h.max()),
                     mass, abs(mass - MASS0), float(np.abs(h - h_ic).max())))
    except Exception as exc:                  # noqa: BLE001
        failures.append((cid, f"{type(exc).__name__}: {exc}"))
        rows.append((cid, "-", 0, *([float("nan")] * 5)))

print()
print(f"mesh: create_1d(domain=({X0},{X1}), n_inner_cells={NC})  dx={DX}  "
      f"t_end={T_END}  mass_0={MASS0}")
print(f"{'card':9s} {'solver':28s} {'n_state':>7s} {'h_min':>10s} {'h_max':>10s} "
      f"{'mass':>13s} {'|dmass|':>10s} {'max|h-h_IC|':>12s}")
for cid, sv, n, lo, hi, m, dm, dh in rows:
    print(f"{cid:9s} {sv:28s} {n:7d} {lo:10.6f} {hi:10.6f} {m:13.9f} {dm:10.3e} "
          f"{dh:12.6f}")

if failures:
    print("\nFAILURES:")
    for cid, msg in failures:
        print(f"  {cid}: {msg}")
    raise SystemExit(1)
print("\nALL 5 MODEL-CARD DEFAULTS RAN.")
