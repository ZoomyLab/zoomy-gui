"""Malpasset (jax backend) — GUI folder-case ``visualize.py`` (REQ-137).

Plots from the run's HDF5 store (``output/<name>.h5``) via ``zoomy_plotting``,
folding the deck deliverables:

  * flood GIF (water depth over the L-shaped domain, gauges marked) —
    reuses :func:`deliverable.render_gif`;
  * survey-gauge bar chart (Experimental / TELEMAC-2D / SWE / SME(1)) —
    reuses :func:`deliverable_gauges.main`, only when the multi-level stores
    (``output/l0``, ``output/l1``) are present.

``postprocess.py`` (mass audit, order1/order2 comparison gif) stays for the
research workflow; this is the single-store GUI view.  Headless (Agg).
"""

import json
import os

import matplotlib as mpl
mpl.use("Agg")

CASE_DIR = (os.path.dirname(os.path.abspath(__file__))
            if "__file__" in globals() else os.getcwd())
FIG = os.path.join(CASE_DIR, "figures")


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


# --- inlined case module: deliverable.py (plot layer) ------------
"""Deck deliverable: the Malpasset *Shallow Moment 1* dam-break GIF.

Re-renders the ECCOMAS/WCCM talk animation (``malpasset_shallow_moment.gif``)
in **pure matplotlib** through the Zoomy plotting stack — no external framework.
The look the deck asked for:

  * bathymetry in **grey** (a truncated ``CMAP_TOPO``), water depth ``h`` in a
    **colormap** (``CMAP_CONTINUOUS``) painted only where the cell is wet, so the
    grey bed shows through dry ground;
  * **both colorbars are horizontal and sit inside the empty lower-left wedge**
    of the L-shaped domain — no vertical colorbar eats the column width and no
    white band is wasted;
  * the survey gauges P6..P14 ringed + labelled on the map (the prior-figure
    detail the deck author wanted kept);
  * a short title ``Malpasset Shallow Moment 1   t = … s``;
  * the map fills the canvas — figure sized to the domain aspect, axis
    decorations off, near-zero margins.

Reads the SME(1) run written by ``malpasset_sme_jax.py`` (``--level 1``)::

    output/malpasset_sme_l1.h5      # state [b, h, q_x0, q_x1, q_y0, q_y1]

and writes ``figures/malpasset_shallow_moment.gif`` (the name the deck uses).

Run in the ``zoomy`` env (has ``zoomy_plotting``; GPU not needed here)::

    python deliverable.py                 # the gif
    python deliverable.py --png 300        # one PNG frame nearest t=300 s
    python deliverable.py --h5 output/other.h5 --fps 12
"""

import argparse
import os

import numpy as np

import matplotlib as mpl
mpl.use("Agg")
import matplotlib.pyplot as plt

from zoomy_plotting import read_hdf5, animate
from zoomy_core.postprocessing import style
style.use("screen")                      # projector-sized fonts
# Deck/presentation scale (REQ-101): bump ~2x so the GIF title, both colorbar
# labels + ticks, and the gauge labels stay legible at 1080p slide scale.  The
# zoomy_plotting `presentation` template (REQ-98) is not yet available, so scale
# case-side (matching deliverable_gauges.py's FONT, and the bingham deliverable).
mpl.rcParams.update({
    "axes.titlesize": 26,
    "axes.labelsize": 22,
    "xtick.labelsize": 20,
    "ytick.labelsize": 20,
})
from zoomy_core.postprocessing import mesh_plots

CASE_DIR = (os.path.dirname(os.path.abspath(__file__))
            if "__file__" in globals() else os.getcwd())
FIG = os.path.join(CASE_DIR, "figures")
DEFAULT_H5 = os.path.join(CASE_DIR, "output", "l1", "malpasset_sme_l1.h5")

# Malpasset survey gauges P6..P14 (x, y) — the police/transformer points the
# deck author likes marked on the map.  Source of truth: postprocess.GAUGES
# (same coordinates); duplicated here so the deliverable stays self-contained.
GAUGES = {
    "P6": (4947, 4289), "P7": (5717, 4407), "P8": (6775, 3869),
    "P9": (7128, 3162), "P10": (8585, 3443), "P11": (9674, 3085),
    "P12": (10939, 3044), "P13": (11724, 2810), "P14": (12723, 2485)}

# Bathymetry greyscale: the house ``CMAP_TOPO`` ("Greys") bottoms out at pure
# white, which makes the low coastal plain read as empty canvas.  Truncate it so
# the lowest bed is still a visible light grey (terrain reads as a filled map);
# the top stays mid-dark so the water colours keep their contrast.
_greys = plt.get_cmap(style.CMAP_TOPO)
GREY_TOPO = mpl.colors.LinearSegmentedColormap.from_list(
    "greys_terrain", _greys(np.linspace(0.22, 0.82, 256)))

TOPO, FIELD = "b", "h"                    # bathymetry, water depth
HIDE_BELOW = 0.05                         # dry cells (h <= this) are not painted
TITLE = "Malpasset Shallow Moment 1"

# Fill the canvas: the figure is sized to the domain's own aspect so the
# (equal-aspect) map fills the axes with no letterboxing, and the two
# horizontal colorbars are dropped INTO the empty lower-left wedge of the
# L-shaped domain (reservoir arm top-left, coastal plain right) rather than
# stealing a band of their own.  Colorbar rects are in *axes* fractions.
MAP_W_IN = 12.6                           # map width [inches]; height set by aspect
TITLE_BAND_IN = 0.62                      # top strip reserved for the title
CBAR_W_AX = [0.035, 0.235, 0.335, 0.032]  # water-depth colorbar (over the wedge)
CBAR_B_AX = [0.035, 0.090, 0.335, 0.032]  # grey bathymetry colorbar


def water_vmax(store, pct=90.0):
    """A stable water-depth colour ceiling: percentile of the wet depths over
    the whole run.  Below the deep reservoir max on purpose so the thin flood
    front stays legible (the reservoir simply saturates at the top colour)."""
    wet = []
    for k in range(store.n_snapshots):
        h = np.asarray(store.get_cell(k, FIELD))
        w = h[h > HIDE_BELOW]
        if w.size:
            wet.append(w)
    if not wet:
        return 1.0
    return float(np.percentile(np.concatenate(wet), pct))


def bed_vlim(store):
    b = np.asarray(store.get_cell(0, TOPO), dtype=float)
    return float(b.min()), float(b.max())


def domain_bbox(store):
    v = np.asarray(store.vertices)[:, :2]
    return (float(v[:, 0].min()), float(v[:, 0].max()),
            float(v[:, 1].min()), float(v[:, 1].max()))


def figure_geometry(store):
    """Figure size + map-axes rect so the equal-aspect map fills the axes with
    no letterbox (box aspect == domain aspect), leaving only a title strip."""
    x0, x1, y0, y1 = domain_bbox(store)
    map_h = MAP_W_IN * (y1 - y0) / (x1 - x0)
    fig_w, fig_h = MAP_W_IN, map_h + TITLE_BAND_IN
    rect = [0.0, 0.0, 1.0, map_h / fig_h]          # map fills width, title on top
    return (fig_w, fig_h), rect, (x0, x1, y0, y1)


def _inset_hcolorbar(ax, rect, cmap, vlim, label):
    sm = mpl.cm.ScalarMappable(norm=mpl.colors.Normalize(*vlim),
                               cmap=plt.get_cmap(cmap))
    sm.set_array([])
    cax = ax.inset_axes(rect)                       # axes-fraction placement
    cb = ax.figure.colorbar(sm, cax=cax, orientation="horizontal")
    cb.set_label(label, fontsize=mpl.rcParams["axes.labelsize"])
    cb.ax.tick_params(labelsize=mpl.rcParams["xtick.labelsize"])
    cb.outline.set_edgecolor("0.35")
    return cb


def make_frame(fig, store, t, vmax, bvlim, rect, bbox):
    """Paint one frame at (nearest) time ``t`` onto ``fig``."""
    times = list(store.times)
    k = min(range(len(times)), key=lambda i: abs(times[i] - t))
    x0, x1, y0, y1 = bbox

    ax = fig.add_axes(rect)
    mesh_plots.plot_topo_field(
        ax, store, topo=TOPO, field=FIELD, time_step=k,
        hide_below=HIDE_BELOW, topo_cmap=GREY_TOPO,
        cmap=style.CMAP_CONTINUOUS, vlim=(0.0, vmax), topo_vlim=bvlim,
        colorbar=False, topo_colorbar=False)          # own colorbars (insets)
    ax.set_xlim(x0, x1)
    ax.set_ylim(y0, y1)
    ax.set_aspect("equal")
    ax.set_axis_off()                                  # fill the canvas

    _mark_gauges(ax)

    _inset_hcolorbar(ax, CBAR_W_AX, style.CMAP_CONTINUOUS, (0.0, vmax),
                     "water depth $h$ [m]")
    _inset_hcolorbar(ax, CBAR_B_AX, GREY_TOPO, bvlim,
                     "bathymetry $b$ [m]")

    fig.suptitle(f"{TITLE}    $t = {times[k]:.0f}$ s", y=0.99,
                 fontsize=mpl.rcParams["axes.titlesize"])


def _mark_gauges(ax):
    """Ring + label each survey gauge P6..P14 (the prior-figure look the deck
    author wanted kept); labels get a white halo so they read over any colour."""
    import matplotlib.patheffects as pe
    halo = [pe.withStroke(linewidth=2.2, foreground="white")]
    gx = [GAUGES[k][0] for k in GAUGES]
    gy = [GAUGES[k][1] for k in GAUGES]
    ax.scatter(gx, gy, s=64, facecolors="none", edgecolors="red",
               linewidths=1.8, zorder=6, path_effects=halo)
    for k, (x, y) in GAUGES.items():
        ax.annotate(k, (x, y), textcoords="offset points", xytext=(6, 5),
                    color="red", fontsize=mpl.rcParams["xtick.labelsize"],
                    fontweight="bold", zorder=7, path_effects=halo)


GIF_FRAMES = 31                          # evenly-time-spaced frames in the gif


def render_gif(store, dst, fps):
    vmax, bvlim = water_vmax(store), bed_vlim(store)
    figsize, rect, bbox = figure_geometry(store)
    # Render on an even TIME schedule (nearest snapshot per target), so the gif
    # is smooth regardless of how the store's frames are distributed — a run's
    # .h5 can carry a dense burst near t=0 from the flaky JAX in-loop writer
    # (REQ-92); this samples t=0..t_end uniformly and lands the clean frames.
    t_end = float(max(store.times))
    times = list(np.linspace(0.0, t_end, GIF_FRAMES))

    def draw(fig, t):
        make_frame(fig, store, t, vmax, bvlim, rect, bbox)

    animate(draw, times, dst, figsize=figsize, fps=fps)
    print("->", dst, f"({len(times)} frames over t=[0,{t_end:.0f}]s, "
          f"vmax={vmax:.1f} m, figsize={figsize[0]:.1f}x{figsize[1]:.1f})")


def render_png(store, t, dst):
    vmax, bvlim = water_vmax(store), bed_vlim(store)
    figsize, rect, bbox = figure_geometry(store)
    fig = plt.figure(figsize=figsize, dpi=110)
    make_frame(fig, store, t, vmax, bvlim, rect, bbox)
    fig.savefig(dst, dpi=110)
    plt.close(fig)
    print("->", dst)
# ------------------------------------------------------------------


def visualize(store, fps=10):
    """Render the folder-case figures from the run's store (``store``: the run card's
    ``open_hdf5`` publishes it; after a backend run, the GUI opens the job's store)."""
    os.makedirs(FIG, exist_ok=True)
    gif = os.path.join(FIG, "malpasset_shallow_moment.gif")
    render_gif(store, gif, fps)
    print("->", gif)

    # Survey-gauge bar chart from THIS single run: the run's own store is the
    # Shallow Moment (1) row and the bed source for TELEMAC-2D (elevation->depth).
    # The SWE l0 row is drawn only if the multi-level output/l0 store is present.
    try:
        import deliverable_gauges
        deliverable_gauges.main(sme_h5=store.source_path)
    except Exception as e:                      # pragma: no cover
        print("gauge chart skipped:", e)


visualize(store)
