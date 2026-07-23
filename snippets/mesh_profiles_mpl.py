"""Field + vertical velocity profiles at three cross-sections.

Top: the field on the mesh (same view as the Field Viewer). Bottom: the
vertical velocity profile u(zeta) at three stations, reconstructed from the
moment state the way the coupling contract does it -- zeta = 0 is the bed,
zeta = 1 the free surface. A depth-averaged run (level 0 / SWE) carries a
single moment, so its profile is a vertical line; that is the point of the
panel.

The GUI injects ``store`` (a ``zoomy_plotting.SimulationStore``), ``time_step``
(timeline slider) and ``field_name`` (field selector).
"""
import matplotlib
matplotlib.use("agg")            # headless worker — no GUI backend
import matplotlib.pyplot as plt
import numpy as np
import zoomy_plotting as zp

if store is None:
    raise RuntimeError("No data yet — run a simulation first.")

step = int(time_step) if "time_step" in dir() else 0
names = list(store.field.keys())
field = field_name if ("field_name" in dir() and field_name) else names[0]

cell = lambda name: np.asarray(store.get_cell(step, getattr(store.field, name)),
                               dtype=float)

# --- locate depth + moments -------------------------------------------------
# Two layouts occur: NAMED (h, q_0, q_1, ...) when the writer stored field
# names, and POSITIONAL (q0, q1, ...) when it did not. The state order is
# [b, h, <moments>] either way, so positionally h is slot 1 and the moments
# follow it.
if "h" in names:
    h_name = "h"
    q_names = sorted(n for n in names if n.startswith("q_"))
else:
    pos = sorted((n for n in names if n.startswith("q") and n[1:].isdigit()),
                 key=lambda n: int(n[1:]))
    h_name = pos[1] if len(pos) > 1 else None
    q_names = pos[2:]

# --- cell centres, for stations and the x axis ------------------------------
verts, cells = np.asarray(store.vertices), np.asarray(store.cells)
centers = verts[cells].mean(axis=1)
n = store.n_inner_cells or len(centers)
centers, x = centers[:n], centers[:n, 0]

xs = np.quantile(x, [0.25, 0.50, 0.75])          # three stations across the span
probes = [int(np.argmin(np.abs(x - xq))) for xq in xs]

with zp.apply_style():
    fig = plt.figure(figsize=(9.0, 6.4))
    gs = fig.add_gridspec(2, 3, height_ratios=[1.35, 1.0], hspace=0.42, wspace=0.30)

    # ---- top: the field ----------------------------------------------------
    ax0 = fig.add_subplot(gs[0, :], projection="3d" if store.dim == 3 else None)
    kw = {} if store.dim == 1 else {"cmap": "viridis", "colorbar": True}
    zp.MatplotlibPlotter(store).plot(ax0, time_step=step, field=field, **kw)
    times = getattr(store, "times", None)
    t_now = float(times[step]) if times is not None and len(times) else None
    ax0.set_title(f"{field}" + (f" — t = {t_now:.3f}" if t_now is not None else ""))
    for k in probes:                                  # mark the stations
        if store.dim == 1:
            ax0.axvline(x[k], color="k", lw=1.0, ls="--", alpha=0.7)
        elif store.dim == 2:
            ax0.plot(centers[k, 0], centers[k, 1], "o", ms=7, mfc="none",
                     mew=2, color="k")

    # ---- bottom: u(zeta) at each station -----------------------------------
    if q_names and h_name:
        from zoomy_core.model.derivation.basisfunctions import Legendre_shifted
        basis = Legendre_shifted(len(q_names) - 1)
        zeta = np.linspace(0.0, 1.0, 60)
        h = cell(h_name)
        moments = [cell(q) for q in q_names]
        for j, k in enumerate(probes):
            ax = fig.add_subplot(gs[1, j])
            if h[k] > 1e-9:
                alpha = [m[k] / h[k] for m in moments]
                ax.plot(basis.reconstruct_velocity_profile(alpha, N=zeta.size),
                        zeta, lw=2)
            ax.set_title(f"x = {x[k]:.3f}", fontsize=10)
            ax.set_xlabel(r"$u(\zeta)$")
            ax.set_ylim(0.0, 1.0)
            if j == 0:
                ax.set_ylabel(r"$\zeta$  (0 = bed, 1 = surface)")
    else:
        ax = fig.add_subplot(gs[1, :])
        ax.axis("off")
        ax.text(0.5, 0.5, "No moment state in this result —\n"
                          "profiles need a Shallow Moments / VAM run.",
                ha="center", va="center", fontsize=11)

display(fig)
