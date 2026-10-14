"""Steffler 270 degree bend -- GUI folder-case ``run.py`` (numpy backend).

Builds the bend mesh and the SME model, solves with the symbolic NumPy solver
(explicit finite volumes) into the run's store (``run_h5_path()``) and opens it
(``open_hdf5``), which publishes ``store`` for the visualization card. The time step
is ADAPTIVE, set from the CFL condition.
"""
import json
import os
import time

from zoomy_core.symsolver.numpy_backend import SymbolicHyperbolicSolverNumpy

try:
    build_mesh, build_model  # noqa: B018
except NameError:
    from mesh import build_mesh
    from model import build_model

CASE_DIR = (os.path.dirname(os.path.abspath(__file__))
            if "__file__" in globals() else os.getcwd())

_CASE_SETTINGS = {
    "name": "steffler_bend",
    "backend": "numpy",
    "model": {"type": "SME", "level": 1},
    "mesh": {"file": "curved_curved_open_channel_mesh_v2.msh"},
    "numerics": {"order": 1, "cfl": 0.45},
    "run": {"time_end": 20.0, "snapshots": 40},
}


def load_settings(path=None):
    p = path or os.path.join(CASE_DIR, "settings.json")
    s = json.load(open(p)) if os.path.exists(p) else {}
    if "numerics" not in s:
        gui = s or (globals().get("settings")
                    if isinstance(globals().get("settings"), dict) else None) or {}
        s = json.loads(json.dumps(_CASE_SETTINGS))
        if gui.get("time_end") is not None:
            s["run"] = dict(s["run"], time_end=float(gui["time_end"]))
    return s


def run(settings=None):
    settings = settings or load_settings()
    name = settings.get("name", "steffler_bend")
    num, run_cfg = settings["numerics"], settings["run"]

    mesh = build_mesh(settings, CASE_DIR)
    bundle = build_model(settings, mesh, CASE_DIR)

    h5 = run_h5_path()
    time_end = float(run_cfg["time_end"])
    solver = SymbolicHyperbolicSolverNumpy(
        time_end=time_end, cfl=num.get("cfl", 0.45),
        dt_write=time_end / (int(run_cfg.get("snapshots", 40)) - 1), output=h5)

    print(f"[{name}] solving t_end={run_cfg['time_end']}s on "
          f"{mesh.n_inner_cells} cells (order={num.get('order', 1)}, "
          f"adaptive dt at CFL={num.get('cfl', 0.45)}) ...", flush=True)
    t0 = time.perf_counter()
    Q, Qaux = solver.setup(mesh, bundle["nsm"])
    solver.run(Q, Qaux)
    print(f"[{name}] done ({time.perf_counter()-t0:.0f}s) -> {h5}", flush=True)
    return h5


open_hdf5(run())

