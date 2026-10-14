"""Malpasset (jax backend): GUI folder-case ``run.py``, the thesis run.

Reads ``settings.json``, builds the mesh + model (IC/BC baked; the thesis model and numerics,
see the model card), constructs the symbolic JAX solver (``SymbolicHyperbolicSolverJax``) with
the thesis' time integration: SSP-RK2 with the point-implicit source in every stage, the CFL
step from the cells' wave speeds at CFL 0.4, MOOD at order 2; solves into the run's store
(``run_h5_path()``: ``/mesh`` + ``iteration_*`` snapshots, every 50 s of the 2000 s event like
the thesis run ``output/zp_l1``) and opens it (``open_hdf5``).  The JAX backend's server runs
the composed case (``zoomy_server.case_run``, which provides both helpers, as the GUI does).
"""

import json
import os

# Let the environment pick the device (server/GPU sets cuda); default cpu so the
# case runs on a CPU host.  MUST precede any jax-touching import.
os.environ.setdefault("JAX_PLATFORMS", "cpu")

from zoomy_core.symsolver.discretization.time import CflWaveSpeed, Imex
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
           'closure': 'mixing',
           'k_s': 0.05,
           'zeta_p': 0.15,
           'quadrature_order': 5,
           'wet_dry_eps': 0.001,
           'u_max': 30.0,
           'desingularize': True,
           'clamp': True},
 'numerics': {'order': 2,
              'limiter': 'venkatakrishnan',
              'front_tol': 0.5,
              'mood': True,
              'riemann': 'hr',
              'source_treatment': 'linearized',
              'cfl': 0.4,
              'cfl_wave_speed': 'cells'},
 'run': {'imex': None, 't_end': 2000.0, 'snapshots': 41}}


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
    the run's store path."""
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
    h5 = run_h5_path()
    num = settings["numerics"]
    # imex None: the source is point-implicit inside every explicit stage (the thesis);
    # 'lie' / 'ssp2' step the source implicitly instead
    imex = Imex(run_cfg["imex"]) if run_cfg.get("imex") else False
    solver = SymbolicHyperbolicSolverJax(
        time_end=t_end, cfl=num.get("cfl", 0.4), mood=num.get("mood", True),
        cfl_wave_speed=CflWaveSpeed(num.get("cfl_wave_speed", CflWaveSpeed.cells)),
        imex=imex, dt_write=t_end / (run_cfg.get("snapshots", 41) - 1), output=h5)

    print(f"[{name}] solving t_end={t_end}s "
          f"(order={num.get('order', 2)}, "
          f"platform={os.environ['JAX_PLATFORMS']}) ...", flush=True)
    Q, Qaux = solver.setup(mesh, nsm)
    solver.run(Q, Qaux)
    print(f"[{name}] done -> {h5}", flush=True)
    return h5


open_hdf5(run())
