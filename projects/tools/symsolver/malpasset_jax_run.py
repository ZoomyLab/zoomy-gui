"""Malpasset (jax backend) — GUI folder-case ``run.py`` (REQ-137).

Reads ``settings.json``, builds the mesh + model (IC/BC baked), constructs the
symbolic JAX solver (``SymbolicHyperbolicSolverJax``; the wet/dry numerics are the
model's: KP-desingularised ``hinv`` aux, positive HLL, MOOD at order 2), solves,
and writes ``output/<name>.h5`` (``/mesh`` + ``iteration_*`` snapshots).  The server
executes this file as-is in the backend container.

Standalone: ``python run.py``.  Reproduces ``malpasset_sme_jax.py --level 1``.
The multi-order deck-comparison orchestrator is ``run_orders.py`` (separate).
"""

import json
import os

# Let the environment pick the device (server/GPU sets cuda); default cpu so the
# case runs standalone.  MUST precede any jax-touching import.
os.environ.setdefault("JAX_PLATFORMS", "cpu")

from zoomy_core.misc.misc import get_main_directory
from zoomy_core.symsolver.discretization.time import Imex
from zoomy_jax.symsolver.solver import SymbolicHyperbolicSolverJax

# Case modules: defined by the Model/Mesh cells in notebook form;
# imported from the sibling files in a materialized case folder.
try:
    build_mesh, build_model  # noqa: B018  (probe the notebook namespace)
except NameError:
    from mesh import build_mesh
    from model import build_model

CASE_DIR = (os.path.dirname(os.path.abspath(__file__))
            if "__file__" in globals() else os.getcwd())


#: Full benchmark settings (the canonical case's settings.json), used whenever
#: the sibling settings.json is absent (notebook) or GUI-generic (no "numerics").
_CASE_SETTINGS = {'name': 'malpasset_sme_l1',
 'backend': 'jax',
 'mesh': 'geo_malpasset-small.msh',
 'model': {'type': 'MalpassetSME',
           'level': 1,
           'dimension': 3,
           'closure': 'navier',
           'nu': 1.0,
           'lambda_s': 0.5,
           'wet_dry_eps': 0.001,
           'desingularize': True,
           'clamp': True},
 'numerics': {'order': 1,
              'cfl': 0.4,
              'riemann': 'hr',
              'reconstruction_variables': 'eta',
              'positivity_method': 'zhang_shu'},
 'run': {'solver': 'explicit',
         'source_mode': 'local',
         't_end': 2000.0,
         'snapshots': 60}}


def load_settings(path=None):
    p = path or os.path.join(CASE_DIR, "settings.json")
    s = json.load(open(p)) if os.path.exists(p) else {}
    if "numerics" not in s:                       # GUI-generic or missing
        gui = s or (globals().get("settings")
                    if isinstance(globals().get("settings"), dict) else None) or {}
        s = json.loads(json.dumps(_CASE_SETTINGS))
        if gui.get("time_end") is not None:       # GUI knob = t_end [s]
            s["run"] = dict(s["run"], t_end=float(gui["time_end"]))
    return s


def run(settings=None):
    """Build + solve from ``settings`` (dict or None → settings.json).  Returns
    the output ``.h5`` path."""
    if settings is None:
        settings = load_settings()
    name = settings.get("name", "malpasset_sme_l1")
    run_cfg = settings["run"]

    mesh = build_mesh(settings, CASE_DIR)
    bundle = build_model(settings, mesh, CASE_DIR)
    nsm = bundle["nsm"]
    print(f"[{name}] mesh: {mesh.n_inner_cells} cells, tags={bundle['tags']}; "
          f"states={[str(s) for s in bundle['sm'].state]}", flush=True)

    t_end = float(run_cfg["t_end"])
    out_rel = os.path.relpath(os.path.join(CASE_DIR, "output", name + ".h5"),
                              get_main_directory())
    solver = SymbolicHyperbolicSolverJax(
        time_end=t_end, cfl=settings["numerics"].get("cfl", 0.4),
        imex=Imex.lie if run_cfg.get("solver") == "imex" else False,
        dt_write=t_end / (run_cfg.get("snapshots", 60) - 1), output=out_rel)

    print(f"[{name}] solving t_end={t_end}s "
          f"(order={settings['numerics'].get('order', 1)}, "
          f"platform={os.environ['JAX_PLATFORMS']}) ...", flush=True)
    Q, Qaux = solver.setup(mesh, nsm)
    solver.run(Q, Qaux)
    h5 = os.path.join(CASE_DIR, "output", name + ".h5")
    print(f"[{name}] done -> {h5}", flush=True)
    return h5


_h5 = run()
import shutil

shutil.copy(_h5, "simulation.h5")   # standard artifact name (viz prelude / postproc)
print("artifact -> simulation.h5")
