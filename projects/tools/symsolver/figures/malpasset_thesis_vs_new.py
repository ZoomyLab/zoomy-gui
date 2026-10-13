"""Figure: the Malpasset session (thesis configuration, symbolic JAX solver) against the thesis
run ``thesis/cases/malpasset_jax/output/zp_l1``.

    python malpasset_thesis_vs_new.py THESIS.h5 NEW.h5 REPEAT.h5 [T]

(a) h of the thesis run and (b) of the new run at t = T (default 2000 s), cell values, same
colour limits, dry cells (h <= 1e-3 m) unpainted; (c) h_new - h_thesis, symmetric-log colour
scale (linear within 1 mm); (d) the relative L1 difference of h against the thesis run at the
thesis' snapshot times, with the new run's GPU run-to-run difference (REPEAT: the same run
again) as the noise floor.  Writes malpasset_thesis_vs_new.png / .pdf beside this file.
"""
import os
import sys

import h5py
import numpy as np
import matplotlib as mpl
mpl.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.collections import PolyCollection
from matplotlib.colors import Normalize, SymLogNorm

DRY, VMAX = 1e-3, 10.0
BLUE, ORANGE = "#2a78d6", "#eb6834"


def load(path):
    """`{time: Q}`, the triangle vertices `(n, 3, 2)` and the cell areas."""
    with h5py.File(path, "r") as f:
        snaps = {round(float(f["fields"][k]["time"][()]), 6): np.asarray(f["fields"][k]["Q"])
                 for k in f["fields"]}
        v = np.asarray(f["mesh"]["vertex_coordinates"])
        c = np.asarray(f["mesh"]["cell_vertices"])
    v = v.T if v.shape[0] < v.shape[1] else v
    c = c.T if c.shape[0] < c.shape[1] else c
    tri = v[c[:, :3], :2]
    area = 0.5 * np.abs((tri[:, 1, 0] - tri[:, 0, 0]) * (tri[:, 2, 1] - tri[:, 0, 1])
                        - (tri[:, 2, 0] - tri[:, 0, 0]) * (tri[:, 1, 1] - tri[:, 0, 1]))
    return snaps, tri, area


def cells(ax, tri, values, mask, **kw):
    """The cells `mask` painted with `values`."""
    pc = PolyCollection(tri[mask], array=values[mask], edgecolors="none", **kw)
    ax.add_collection(pc)
    return pc


def main(thesis, new, repeat, t=2000.0):
    A, tri, area = load(thesis)
    B, tri_b, _ = load(new)
    R, _, _ = load(repeat)
    assert np.allclose(tri, tri_b), "different meshes"
    t = round(float(t), 6)
    hA, hB = A[t][1], B[t][1]
    wet = (hA > DRY) | (hB > DRY)
    lo, hi = tri[wet].reshape(-1, 2).min(0), tri[wet].reshape(-1, 2).max(0)
    pad = 0.03 * (hi - lo)

    fig = plt.figure(figsize=(14, 7.8), constrained_layout=True)
    gs = fig.add_gridspec(3, 2, width_ratios=[1.75, 1])
    maps = [fig.add_subplot(gs[k, 0]) for k in range(3)]
    norm = Normalize(0.0, VMAX)
    for ax, h, lab in ((maps[0], hA, "(a) thesis"), (maps[1], hB, "(b) new")):
        pc = cells(ax, tri, h, h > DRY, cmap="Blues", norm=norm)
        fig.colorbar(pc, ax=ax, label="h [m]", extend="max", shrink=0.9)
        ax.set_title(f"{lab}: h at t = {t:.0f} s")
    d = hB - hA
    lim = float(np.abs(d[wet]).max())
    pc = cells(maps[2], tri, d, wet, cmap="RdBu_r",
               norm=SymLogNorm(linthresh=1e-3, vmin=-lim, vmax=lim))
    fig.colorbar(pc, ax=maps[2], label=r"$\Delta h$ [m] (symlog)", shrink=0.9)
    maps[2].set_title(f"(c) new - thesis, t = {t:.0f} s")
    for ax in maps:
        ax.set_xlim(lo[0] - pad[0], hi[0] + pad[0])
        ax.set_ylim(lo[1] - pad[1], hi[1] + pad[1])
        ax.set_aspect("equal")
        ax.set_ylabel("y [m]")
    maps[2].set_xlabel("x [m]")

    times = sorted(set(A) & set(B) & set(R) - {0.0})
    l1 = lambda X, Y, s: np.sum(np.abs(X[s][1] - Y[s][1]) * area) / np.sum(Y[s][1] * area)
    ax = fig.add_subplot(gs[:, 1])
    ax.plot(times, [l1(B, A, s) for s in times], "-o", color=BLUE, lw=2, ms=4,
            label="new - thesis")
    ax.plot(times, [l1(B, R, s) for s in times], "-o", color=ORANGE, lw=2, ms=4,
            label="new - new, repeated (GPU noise)")
    ax.set_xlabel("t [s]")
    ax.set_ylabel(r"$\|\Delta h\|_1 / \|h\|_1$")
    ax.set_title("(d) relative L1 difference of h")
    ax.grid(alpha=0.3)
    ax.legend(loc="lower right")
    ax.set_ylim(bottom=0)
    stem = os.path.join(os.path.dirname(os.path.abspath(__file__)), "malpasset_thesis_vs_new")
    for ext in ("png", "pdf"):
        fig.savefig(f"{stem}.{ext}", dpi=150)
    print(f"-> {stem}.png/.pdf  max|dh|={lim:.3f} m")


if __name__ == "__main__":
    main(*sys.argv[1:4], *(float(x) for x in sys.argv[4:5]))
