import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
import numpy as np
import zoomy_plotting as zp

if store is None:
    raise RuntimeError("No data yet — run a simulation first.")

names = list(store.field.keys())
depth = next((n for n in ("h", "height", "q1") if n in names), names[0])
bed = next((n for n in ("b", "bed", "q0") if n in names), None)
step = store.n_snapshots - 1
t = float(store.times[step]) if store.times is not None and len(store.times) else None
title = depth if t is None else f"{depth} at t = {t:.3f} s"

with zp.apply_style():
    fig, ax = plt.subplots()
    if store.dim == 1:
        x = store.cell_centers[:, 0]
        order = np.argsort(x)
        x = x[order]
        h = np.asarray(store.get_cell(step, depth))[order]
        if bed is None:
            series = [{"x": x, "y": h, "label": depth, "role": "water"}]
            ylabel = depth
        else:
            b = np.asarray(store.get_cell(step, bed))[order]
            series = [{"x": x, "y": b + h, "label": "free surface", "role": "water"},
                      {"x": x, "y": b, "label": "bed", "color": "0.35"}]
            ylabel = "elevation [m]"
        zp.line_plot(ax, series, xlabel="x [m]", ylabel=ylabel, title=title)
        ax.legend()
    else:
        zp.MatplotlibPlotter(store).plot(ax, time_step=step, field=depth,
                                         cmap="viridis", colorbar=True)
        ax.set_title(title)

display(fig)
