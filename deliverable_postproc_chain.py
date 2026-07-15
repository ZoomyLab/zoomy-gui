"""Post-processing chain deliverable — regenerate the figure of the chain's
transformed product (the 2D->3D lifted store).

What it shows: the GUI/CLI post-processing chain, when a ``postprocess``
backend is connected, routes the just-finished run's store + the enabled steps
to that backend, which runs ``zoomy_prepost`` and hands back the transformed
artifacts. This reproduces the meaningful step — ``lift3d`` — by running the
REAL ``PostprocessAdapter`` in-process (the same code the backend runs) on a
small SWE-1D store, then opens the emitted ``simulation_3d.h5`` (the lifted
store the routing stages into the results shelf) via ``zoomy_plotting`` and
plots its vertical structure. The extra ``simulation_3d.h5`` output is exactly
what makes the lift consumable by the viz cards / shelf (they speak the store
format, not VTK).

Reproducible:

    micromamba run -n zoomy python library/zoomy_gui/deliverable_postproc_chain.py
"""
import json
import os
import shutil
import tempfile

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

import zoomy_plotting as zp
from zoomy_server.adapters.numpy import NumpyAdapter
from zoomy_server.adapters.postprocess import PostprocessAdapter

HERE = os.path.dirname(os.path.abspath(__file__))
ZOOMY = os.path.abspath(os.path.join(HERE, "..", ".."))
CASE = os.path.join(ZOOMY, "thesis", "notebooks", "gui", "case_swe_1d")
OUT_PNG = os.path.join(HERE, "deliverable_postproc_chain.png")


def _make_store(dst):
    """Run the shipped SWE-1D case (short) and drop simulation.h5 + model.py
    into ``dst`` — the RESULTS folder the postprocess adapter consumes."""
    case = tempfile.mkdtemp(prefix="swe1d_")
    for fn in ("model.py", "mesh.py", "settings.json"):
        shutil.copy(os.path.join(CASE, fn), case)
    sp = os.path.join(case, "settings.json")
    s = json.load(open(sp))
    s["time_end"] = 0.4
    s["output_snapshots"] = 6
    json.dump(s, open(sp, "w"))
    out = tempfile.mkdtemp(prefix="swe1d_out_")
    NumpyAdapter().solve(case, out, lambda *a: None)
    shutil.copy(os.path.join(out, "simulation.h5"), os.path.join(dst, "simulation.h5"))
    shutil.copy(os.path.join(case, "model.py"), os.path.join(dst, "model.py"))


def _run_chain(case_dir, out_dir):
    """Run the enabled chain via the REAL adapter (the backend's code path)."""
    with open(os.path.join(case_dir, "steps.json"), "w") as f:
        json.dump({"steps": ["to_vtk", "lift3d"], "nz": 12}, f)
    PostprocessAdapter().solve(case_dir, out_dir, lambda *a: None)
    return os.path.join(out_dir, "simulation_3d.h5")   # the lifted store


def main():
    case_dir = tempfile.mkdtemp(prefix="postproc_case_")
    out_dir = tempfile.mkdtemp(prefix="postproc_out_")
    _make_store(case_dir)
    lifted_h5 = _run_chain(case_dir, out_dir)

    base = zp.read_hdf5(os.path.join(case_dir, "simulation.h5"))   # 1-D input
    lifted = zp.read_hdf5(lifted_h5)                               # 2-D lift (x,z)
    pl_base, pl_lift = zp.MatplotlibPlotter(base), zp.MatplotlibPlotter(lifted)
    ts_b, ts_l = base.n_snapshots - 1, lifted.n_snapshots - 1

    # Pick the lifted field with the most vertical structure (largest range).
    def _rng(name):
        v = np.asarray(pl_lift._cell_values(ts_l, name))
        return float(v.max() - v.min())
    lifted_field = max(lifted.field.keys(), key=_rng)
    base_field = max(base.field.keys(),
                     key=lambda n: float(np.ptp(pl_base._cell_values(ts_b, n))))

    with zp.apply_style():
        fig, (axL, axR) = plt.subplots(1, 2, figsize=(11, 4))
        pl_base.plot(axL, time_step=ts_b, field=base_field)
        axL.set_title(f"Run store (1-D SWE) — {base_field}")
        axL.set_xlabel("x")
        axL.set_ylabel(base_field)
        pl_lift.plot(axR, time_step=ts_l, field=lifted_field,
                     cmap="viridis", colorbar=True)
        axR.set_title(f"Chain -> lift3d store (2-D, x-z)  — {lifted_field}")
        axR.set_xlabel("x")
        axR.set_ylabel("z (extruded)")
        t = float(lifted.times[-1]) if lifted.times is not None and len(lifted.times) else 0.0
        fig.suptitle(f"Post-processing chain routing: run store -> postprocess backend -> "
                     f"lifted store  (t = {t:.2f}, Nz=12)")

    fig.savefig(OUT_PNG, dpi=150, bbox_inches="tight")
    print("figure ->", OUT_PNG)
    print(f"lifted store: dim={lifted.dim} n_cells={lifted.n_cells} "
          f"n_snapshots={lifted.n_snapshots} fields={list(lifted.field.keys())}")


if __name__ == "__main__":
    main()
