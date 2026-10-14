"""Malpasset (AMReX backend) — GUI folder-case ``visualize.py`` (REQ-138).

Thin GUI view: plots from the run's HDF5 store (``output/<name>.h5``, produced by
``run.py`` via ``zoomy_prepost.vtk_to_hdf5``) through ``zoomy_plotting``, folding
the deck deliverable — the flood depth PNG (final time) + GIF over the run.  All
the rendering lives in :mod:`deliverable`; this file only locates the store and
calls it.  Headless (Agg).
"""

import json
import os

import matplotlib as mpl
mpl.use("Agg")

CASE_DIR = (os.path.dirname(os.path.abspath(__file__))
            if "__file__" in globals() else os.getcwd())
FIG = os.path.join(CASE_DIR, "figures")


import json

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


# --- inlined case module: deliverable.py (plot layer) ------------
"""Deck deliverable: the Malpasset AMReX dam-break flood figure + GIF.

Re-renders the water-depth flood over the (bbox-embedded) L-shaped catchment from
the run store through the Zoomy plotting stack — the SAME
``zoomy_prepost.vtk_to_hdf5`` → ``zoomy_plotting`` bridge every other backend
feeds, so the AMReX figure is stylistically identical to numpy/jax/foam.

Reads the store ``run.py`` writes (``output/<name>.h5`` — state ``[b, h, hu, hv]``,
one snapshot series) and writes

  * ``figures/malpasset_amrex_flood.png``  — depth field at the final time
  * ``figures/malpasset_amrex_flood.gif``  — depth over the whole run

Run in the ``zoomy`` env (has ``zoomy_plotting``; GPU not needed)::

    python deliverable.py                 # PNG (final frame) + GIF
    python deliverable.py --png 60        # one PNG frame nearest t=60 s
    python deliverable.py --h5 output/malpasset_amrex.h5 --fps 8
"""

import argparse
import os

import numpy as np

import matplotlib as mpl
mpl.use("Agg")
import matplotlib.pyplot as plt

from zoomy_plotting import read_hdf5, MatplotlibPlotter, animate, use

CASE_DIR = (os.path.dirname(os.path.abspath(__file__))
            if "__file__" in globals() else os.getcwd())
FIG = os.path.join(CASE_DIR, "figures")
DEFAULT_H5 = os.path.join(CASE_DIR, "output", "malpasset_amrex.h5")

B, H = 0, 1                    # structured state layout [b, h, hu, hv]
DRY = 0.05                     # depths <= this read as dry (excluded from vmax)
BED_CMAP = "Greys"             # bathymetry relief underlay
WATER_CMAP = "Blues"           # water-depth overlay (deck flood styling)
TITLE = "Malpasset dam break — AMReX"


def water_vmax(store, pct=95.0):
    """Stable colour ceiling: percentile of the wet depths over the whole run
    (below the deep-reservoir max so the thin flood front stays legible)."""
    wet = []
    for k in range(store.n_snapshots):
        h = np.asarray(store.get_cell(k, H), dtype=float)
        w = h[h > DRY]
        if w.size:
            wet.append(w)
    if not wet:
        return 1.0
    return float(np.percentile(np.concatenate(wet), pct))


def _draw_depth(fig, store, plotter, k, vmax):
    """Paint the flood at snapshot ``k``: greyscale bed relief with the water
    depth (Blues) overlaid only where wet — the deck flood styling (matches the
    old ``zoomy_amrex.deliverable._frame_flood``, adapted to the unstructured
    plotter: dry cells (h <= DRY) are made transparent so the bed shows through).
    """
    ax = fig.add_subplot(111)
    # greyscale bathymetry relief underlay (bed = state field 0)
    bed = np.asarray(store.get_cell(k, B), dtype=float)
    plotter.plot_2d(ax, time_step=k, field=B, cmap=BED_CMAP,
                    vlim=(float(bed.min()), float(bed.max())), colorbar=False)
    # water depth (Blues) overlay; dry cells transparent so the relief shows
    out = plotter.plot_2d(ax, time_step=k, field=H, cmap=WATER_CMAP,
                          vlim=(0.0, vmax), colorbar=True)
    h = np.asarray(store.get_cell(k, H), dtype=float)
    coll = out["mesh"]
    coll.set_alpha(None)                         # honour the per-cell alpha below
    fc = coll.get_facecolors()
    fc[h <= DRY, 3] = 0.0                         # DRY-mask: transparent
    coll.set_facecolors(fc)
    fig.axes[-1].set_ylabel("$h$ [m]")           # name the colorbar
    ax.set_aspect("equal")
    ax.set_xlabel("$x$ [m]"); ax.set_ylabel("$y$ [m]")
    ax.set_title(f"{TITLE}    $t = {store.times[k]:.1f}$ s")
    fig.tight_layout()


def render_png(store, k, dst, vmax=None):
    use("print")
    plotter = MatplotlibPlotter(store)
    vmax = water_vmax(store) if vmax is None else vmax
    fig = plt.figure(figsize=(7.5, 5.0))
    _draw_depth(fig, store, plotter, k, vmax)
    fig.savefig(dst, dpi=200); plt.close(fig)
    print("->", dst, f"(t={store.times[k]:.1f}s, vmax={vmax:.2f} m)")


def render_gif(store, dst, fps=8):
    use("print")
    plotter = MatplotlibPlotter(store)
    vmax = water_vmax(store)
    frames = list(range(store.n_snapshots))

    def draw(fig, k):
        _draw_depth(fig, store, plotter, int(k), vmax)

    animate(draw, frames, dst, fps=fps, figsize=(7.5, 5.0), dpi=110)
    print("->", dst, f"({len(frames)} frames, vmax={vmax:.2f} m)")


def main():
    p = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--h5", default=DEFAULT_H5, help="run store to render")
    p.add_argument("--fps", type=int, default=8)
    p.add_argument("--png", type=float, default=None, metavar="T",
                   help="render a single PNG frame nearest time T instead of the pair")
    args = p.parse_args()

    if not os.path.exists(args.h5):
        raise SystemExit(f"missing run output: {args.h5} — run run.py first")
    os.makedirs(FIG, exist_ok=True)
    store = read_hdf5(args.h5)

    if args.png is not None:
        k = min(range(store.n_snapshots),
                key=lambda i: abs(store.times[i] - args.png))
        render_png(store, k,
                   os.path.join(FIG, f"malpasset_amrex_flood_t{args.png:.0f}.png"))
    else:
        render_png(store, store.n_snapshots - 1,
                   os.path.join(FIG, "malpasset_amrex_flood.png"))
        render_gif(store, os.path.join(FIG, "malpasset_amrex_flood.gif"), args.fps)
# ------------------------------------------------------------------


def visualize(store, fps=8):
    """Render the folder-case figures from the run's store (``store``: the run card's
    ``open_hdf5`` publishes it; after a backend run, the GUI opens the job's store)."""
    os.makedirs(FIG, exist_ok=True)
    png = os.path.join(FIG, "malpasset_amrex_flood.png")
    gif = os.path.join(FIG, "malpasset_amrex_flood.gif")
    render_png(store, store.n_snapshots - 1, png)
    render_gif(store, gif, fps)


visualize(store)
