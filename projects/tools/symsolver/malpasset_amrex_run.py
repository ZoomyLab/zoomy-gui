"""Malpasset (AMReX backend): GUI folder-case ``run.py``, the thesis run on the AMReX grid.

Reads ``settings.json``, builds the mesh (real ``.msh``) + model (the thesis model and
numerics, wall BCs baked) and runs the symbolic AMReX solver (``SymbolicHyperbolicSolverAmrex``)
in ONE continuous run on the structured grid: the bounding box of the triangulation at
``numerics.n_cells``, its West/East/South/North faces the model's walls, the bed and the
reservoir depth rasterised from the ``.msh`` ``$NodeData``
(``zoomy_amrex.malpasset.prepare_rasters``).  The thesis' time integration: SSP-RK2 with the
point-implicit source in every stage, the CFL step from the cells' wave speeds at CFL 0.4, MOOD
at order 2.  Writes ``output/<name>.h5`` (the shared zoomy store) and copies it to
``./simulation.h5``.  The server executes this file as-is in the AMReX backend container.

Standalone: ``python run.py`` with ``zoomy_amrex``: in the AMReX backend container the solver
is printed, built and run natively, on a host through ``apptainer exec`` of the AMReX image
(built once, cached).  Set ``ZOOMY_T_END`` to override ``t_end`` (smoke runs).
"""

import json
import os
import shutil

import numpy as np

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
_CASE_SETTINGS = {'name': 'malpasset_amrex',
 'backend': 'amrex',
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
              'cfl_wave_speed': 'cells',
              'n_cells': [180, 96]},
 'run': {'imex': None, 't_end': 2000.0, 'snapshots': 40}}

#: create_2d's side tags -> the compass names of the model's wall BCs
COMPASS = {"left": "West", "right": "East", "bottom": "South", "top": "North"}


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


def structured_case(mesh_path, n_cells, raster_dir, idx):
    """The Cartesian mesh over the triangulation's bounding box (compass side tags) and the
    initial state in its cell order: bed and depth in the rows `idx['b']`, `idx['h']`, every
    momentum at rest."""
    from zoomy_amrex.malpasset import prepare_rasters
    from zoomy_core.mesh import LSQMesh

    nx, ny = (int(n) for n in n_cells)
    info = prepare_rasters(mesh_path, raster_dir, ncell_x=nx, ncell_y=ny)
    (x0, y0), (x1, y1) = info["prob_lo"], info["prob_hi"]
    mesh = LSQMesh.create_2d((x0, x1, y0, y1), nx, ny)
    mesh.boundary_conditions_sorted_names = [
        COMPASS.get(t, t) for t in mesh.boundary_conditions_sorted_names]
    bed = np.fromfile(info["dem_file"]).reshape(ny, nx)
    depth = np.fromfile(info["release_file"]).reshape(ny, nx)
    xc = np.asarray(mesh.cell_centers)[:2, :mesh.n_inner_cells]
    i = np.clip(((xc[0] - x0) / info["dx"]).astype(int), 0, nx - 1)
    j = np.clip(((xc[1] - y0) / info["dy"]).astype(int), 0, ny - 1)
    Q0 = np.zeros((len(idx), mesh.n_inner_cells))
    Q0[idx["b"]], Q0[idx["h"]] = bed[j, i], depth[j, i]
    return mesh, Q0


def run(settings=None):
    """Build + solve from ``settings`` (dict or None → settings.json).  Returns
    the output ``.h5`` path."""
    if settings is None:
        settings = load_settings()
    name = settings.get("name", "malpasset_amrex")
    num, run_cfg = settings["numerics"], settings["run"]
    t_end = float(os.environ.get("ZOOMY_T_END", run_cfg["t_end"]))

    from zoomy_amrex.symsolver import SymbolicHyperbolicSolverAmrex
    from zoomy_core.misc.io import _save_fields_to_hdf5, write_mesh_to_hdf5
    from zoomy_core.misc.misc import get_main_directory
    from zoomy_core.symsolver.discretization.time import CflWaveSpeed, Imex

    out_dir = os.path.join(CASE_DIR, "output")
    bundle = build_model(settings)                # MalpassetSME + wall BCs, as an NSM
    nsm, sm = bundle["nsm"], bundle["sm"]
    mesh, Q0 = structured_case(build_mesh(settings, CASE_DIR), num.get("n_cells", [180, 96]),
                               os.path.join(out_dir, "raster"), bundle["idx"])
    n_snap = int(run_cfg.get("snapshots", 40))
    # imex None: the source is point-implicit inside every explicit stage (the thesis)
    imex = Imex(run_cfg["imex"]) if run_cfg.get("imex") else False
    solver = SymbolicHyperbolicSolverAmrex(
        time_end=t_end, cfl=num.get("cfl", 0.4), mood=num.get("mood", True),
        cfl_wave_speed=CflWaveSpeed(num.get("cfl_wave_speed", CflWaveSpeed.cells)),
        imex=imex, dt_write=t_end / n_snap)

    print(f"[{name}] structured grid {num.get('n_cells', [180, 96])} "
          f"({mesh.n_inner_cells} cells); solving t_end={t_end}s "
          f"(CFL={solver.cfl}, order={nsm.reconstruction.order}) ...", flush=True)
    solver.run(mesh, nsm, Q0, os.path.join(out_dir, "amrex"))

    h5 = os.path.join(out_dir, name + ".h5")
    rel = os.path.relpath(h5, get_main_directory())
    write_mesh_to_hdf5(rel, mesh, names=[str(v) for v in sm.state])
    for k, (time, Q) in enumerate(solver.snapshots):
        _save_fields_to_hdf5(rel, k, time, Q)
    shutil.copy2(h5, os.path.join(CASE_DIR, "simulation.h5"))
    print(f"[{name}] done ({solver.steps} steps) -> {h5}  "
          f"(+ {os.path.join(CASE_DIR, 'simulation.h5')})", flush=True)
    return h5


run()
