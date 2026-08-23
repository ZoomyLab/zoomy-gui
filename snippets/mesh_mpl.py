import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
import zoomy_plotting as zp

if store is None:
    raise RuntimeError("No data yet — run a simulation first.")

names = list(store.field.keys())
field = field_name if ("field_name" in dir() and field_name) else next(
    (n for n in ("h", "height", "q1") if n in names), names[0])
step = (int(time_step) if ("time_step" in dir() and time_step is not None)
        else store.n_snapshots - 1)
step = max(0, min(step, store.n_snapshots - 1))
kw = {} if store.dim == 1 else {"cmap": "viridis", "colorbar": True}

with zp.apply_style():
    if store.dim == 3:
        fig = plt.figure(); ax = fig.add_subplot(111, projection="3d")
    else:
        fig, ax = plt.subplots()
    zp.MatplotlibPlotter(store).plot(ax, time_step=step, field=field, **kw)
    if store.times is not None and len(store.times):
        ax.set_title(f"{field} — t = {float(store.times[step]):.3f}")

display(fig)
