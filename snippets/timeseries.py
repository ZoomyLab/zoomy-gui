"""Time series of a field at one probe cell — ``zoomy_plotting.line_plot``.

Edit ``cell`` to move the probe. Scope: ``store``, ``field_name``.
"""
import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
import numpy as np
import zoomy_plotting as zp

if store is None:
    raise RuntimeError("No data yet — run a simulation first.")

field = field_name if ("field_name" in dir() and field_name) else next(iter(store.field.keys()))
cell = min(store.n_cells // 2, store.n_cells - 1)          # probe at the middle cell
t = store.times if store.times is not None else np.arange(store.n_snapshots)
y = np.array([store.get_cell(k, field)[cell] for k in range(store.n_snapshots)])

with zp.apply_style():
    fig, ax = plt.subplots()
    zp.line_plot(ax, [{"x": t, "y": y, "label": f"{field} @ cell {cell}"}],
                 xlabel="time t", ylabel=str(field))

display(fig)
