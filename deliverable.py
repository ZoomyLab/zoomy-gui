"""Results-shelf deliverable — regenerate the "open other results in a viz
card" figure from the named result store.

What it shows (the user's ask, "can we not access other results for the
visualizations?"): two runs of the same case are SAVED UNDER NAMES into the
results shelf, then a single figure OPENS BOTH BY NAME and overlays them —
exactly what a Visualization card does with
``ref = open_result("swe-o1")``.

It exercises the real shelf code: ``zoomy_server.results.save`` writes the
named stores; the read path mirrors ``engine.open_result`` (a plain
``zoomy_plotting.read_hdf5`` of the shelf path, which does NOT clobber the
current run's store). Reproducible:

    micromamba run -n zoomy python library/zoomy_gui/deliverable.py
"""

import json
import os
import shutil
import tempfile

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

import zoomy_plotting as zp
from zoomy_server import results as shelf
from zoomy_server.adapters.numpy import NumpyAdapter

HERE = os.path.dirname(os.path.abspath(__file__))
ZOOMY = os.path.abspath(os.path.join(HERE, "..", ".."))
CASE = os.path.join(ZOOMY, "thesis", "notebooks", "gui", "case_swe_1d")
OUT_PNG = os.path.join(HERE, "deliverable_results_shelf.png")


def _run_variant(order, name, shelf_dir):
    """Run case_swe_1d at a given reconstruction order and shelve the store
    under ``name`` (via the real zoomy_server.results.save)."""
    case = tempfile.mkdtemp(prefix=f"swe_o{order}_")
    for fn in ("model.py", "mesh.py", "settings.json"):
        shutil.copy(os.path.join(CASE, fn), case)
    settings_path = os.path.join(case, "settings.json")
    s = json.load(open(settings_path))
    s["reconstruction_order"] = order
    json.dump(s, open(settings_path, "w"))

    out = tempfile.mkdtemp(prefix=f"swe_o{order}_out_")
    NumpyAdapter().solve(case, out, lambda *a: None)
    shelf.save(os.path.join(out, "simulation.h5"), name)


def open_result(name):
    """Mirror engine.open_result: read a shelved store by name."""
    return zp.read_hdf5(shelf.get_path(name))


def main():
    shelf.RESULTS_DIR = tempfile.mkdtemp(prefix="zoomy_results_")
    _run_variant(1, "swe-o1", shelf.RESULTS_DIR)
    _run_variant(2, "swe-o2", shelf.RESULTS_DIR)
    print("shelf:", shelf.list_results())

    s1 = open_result("swe-o1")   # a first-order run, opened BY NAME
    s2 = open_result("swe-o2")   # a second-order run, opened BY NAME

    # Pick the most informative field: the largest spatial range at the final
    # step (skips a flat bed / all-zero column). This is the height here.
    p1, p2 = zp.MatplotlibPlotter(s1), zp.MatplotlibPlotter(s2)
    ts = s1.n_snapshots - 1

    def _range(name):
        import numpy as np
        v = np.asarray(p1._cell_values(ts, name))
        return float(v.max() - v.min())

    field = max(s1.field.keys(), key=_range)

    with zp.apply_style():
        fig, ax = plt.subplots()
        p1.plot(ax, time_step=ts, field=field)
        p2.plot(ax, time_step=s2.n_snapshots - 1, field=field)
        # Label the two overlaid, name-opened results.
        lines = [ln for ln in ax.get_lines() if ln.get_xydata().size]
        if len(lines) >= 2:
            lines[0].set_label("open_result('swe-o1')  (order 1)")
            lines[1].set_label("open_result('swe-o2')  (order 2)")
            lines[1].set_linestyle("--")
            ax.legend()
        t = float(s1.times[-1]) if s1.times is not None and len(s1.times) else 0.0
        ax.set_title(f"Results shelf — two named runs overlaid  (field {field}, t = {t:.2f})")
        ax.set_xlabel("x")
        ax.set_ylabel(field)

    fig.savefig(OUT_PNG, dpi=150, bbox_inches="tight")
    print("figure ->", OUT_PNG)


if __name__ == "__main__":
    main()
