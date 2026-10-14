"""Steffler 270 degree bend -- GUI folder-case ``visualize.py``.

Three deliverables, all recomputed from the run store:

  1. an animation of the bend, water depth over the whole channel;
  2. the same run as a water-surface elevation animation;
  3. the vertical profile of the transverse velocity at the 90, 180 and 270
     degree stations, which is where the secondary circulation is read off.

Thesis matplotlib style, taken from the shared zoomy_plotting template at its
``thesis`` profile, so a GUI figure and a thesis figure agree on font, size and
resolution. Headless (Agg).
"""
import os

import numpy as np
import matplotlib as mpl
mpl.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation, PillowWriter
from numpy.polynomial.legendre import legval

CASE_DIR = (os.path.dirname(os.path.abspath(__file__))
            if "__file__" in globals() else os.getcwd())
OUT = os.path.join(CASE_DIR, "output")
NAME = "steffler_bend"

# Shared thesis style. Falls back to matplotlib defaults where the template is
# not importable, so the card still produces figures outside the Zoomy tree.
try:
    from zoomy_plotting.plot import style as zstyle
    zstyle.use("thesis")
except Exception:
    mpl.rcParams.update({"font.size": 9, "font.family": "serif",
                         "figure.dpi": 130, "savefig.dpi": 130})

RC = 3.66            # centreline radius [m]
STATIONS = (90.0, 180.0, 270.0)


def _read(store):
    """Times, snapshots (state x cells) and cell centres of the run's store."""
    times = np.asarray(store.times, dtype=float)
    n_q = sum(1 for n in store.field.keys() if not str(n).startswith("aux_"))
    snaps = [np.array([store.get_cell(k, i) for i in range(n_q)])
             for k in range(store.n_snapshots)]
    xc, yc = store.cell_centers[:, 0], store.cell_centers[:, 1]
    return times, snaps, xc, yc


def _station_cells(xc, yc):
    """One cell column per station: cells whose polar angle is closest."""
    ang = np.degrees(np.arctan2(yc, xc)) % 360.0
    out = {}
    for s in STATIONS:
        d = np.abs(((ang - s + 180.0) % 360.0) - 180.0)
        band = np.flatnonzero(d < 4.0)
        out[s] = band if band.size else np.array([int(np.argmin(d))])
    return out


def _profile(q, h, level, zeta):
    """u(zeta) = sum_i (q_i/h) P_i(2 zeta - 1), shifted Legendre."""
    prof = np.zeros_like(zeta)
    for i in range(level + 1):
        c = np.zeros(level + 1); c[i] = 1.0
        prof = prof + (q[i] / h) * legval(2.0 * zeta - 1.0, c)
    return prof


def animate(times, snaps, xc, yc, field, label, fname, cmap):
    fig, ax = plt.subplots(figsize=(5.2, 4.4))
    vals = [field(Q) for Q in snaps]
    vmin = min(v.min() for v in vals); vmax = max(v.max() for v in vals)
    sc = ax.scatter(xc, yc, c=vals[0], s=14, marker="s",
                    cmap=cmap, vmin=vmin, vmax=vmax)
    ax.set_aspect("equal"); ax.set_xlabel("$x$ [m]"); ax.set_ylabel("$y$ [m]")
    cb = fig.colorbar(sc, ax=ax); cb.set_label(label)
    ttl = ax.set_title("")

    def upd(k):
        sc.set_array(vals[k]); ttl.set_text(f"$t = {times[k]:.1f}$ s")
        return sc, ttl

    p = os.path.join(OUT, fname)
    FuncAnimation(fig, upd, frames=len(snaps)).save(p, writer=PillowWriter(fps=8))
    plt.close(fig)
    return p


def profiles(snaps, xc, yc, level):
    """RADIAL velocity over the depth at the three bend stations.

    The secondary circulation is the component along the local radius, not the
    global y axis: at the 180 degree station the global y momentum IS the
    streamwise one. Project (q_x, q_y) onto e_r = (cos t, sin t) per cell.
    """
    Q = snaps[-1]
    cells = _station_cells(xc, yc)
    zeta = np.linspace(0.0, 1.0, 60)
    fig, axes = plt.subplots(1, 3, figsize=(7.4, 3.0), sharey=True)
    for ax, s in zip(axes, STATIONS):
        idx = cells[s]
        th = np.arctan2(yc[idx], xc[idx])
        er = np.stack([np.cos(th), np.sin(th)])          # local radial unit vector
        h = Q[1][idx]
        qx = np.array([Q[2 + i][idx] for i in range(level + 1)])
        qy = np.array([Q[2 + (level + 1) + i][idx] for i in range(level + 1)])
        qr = qx * er[0] + qy * er[1]                     # radial moment coefficients
        good = h > 1e-6
        if good.any():
            v = np.array([_profile(qr[:, j], h[j], level, zeta)
                          for j in np.flatnonzero(good)])
            ax.plot(v.mean(axis=0), zeta, lw=1.6, ls="-", marker="",
                    color="#0072b2")
            ax.fill_betweenx(zeta, v.min(axis=0), v.max(axis=0),
                             color="#0072b2", alpha=0.18, lw=0)
        ax.axvline(0.0, color="0.6", lw=0.8, ls="--")
        ax.set_xlabel(r"$v_r$ [m s$^{-1}$]")
        ax.set_title(f"({'abc'[STATIONS.index(s)]}) ${s:.0f}^\\circ$")
    axes[0].set_ylabel(r"$\zeta$")
    fig.tight_layout()
    p = os.path.join(OUT, "fig_bend_profiles.png")
    fig.savefig(p); plt.close(fig)
    return p


def main():
    times, snaps, xc, yc = _read(store)
    level = (snaps[0].shape[0] - 2) // 2 - 1
    os.makedirs(OUT, exist_ok=True)
    p1 = animate(times, snaps, xc, yc, lambda Q: Q[1], r"$h$ [m]",
                 "fig_bend_depth.gif", "Blues")
    p2 = animate(times, snaps, xc, yc, lambda Q: Q[0] + Q[1],
                 r"$b + h$ [m]", "fig_bend_surface.gif", "viridis")
    p3 = profiles(snaps, xc, yc, level)
    for p in (p1, p2, p3):
        print("->", p)


main()
