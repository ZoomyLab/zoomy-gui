"""Matplotlib mesh viewer — delegates to ``zoomy_plotting.MatplotlibPlotter``.

The Pyodide worker loads ``zoomy-plotting`` from PyPI at boot; this snippet
is a thin wrapper that picks a field + time step, builds a figure with the
right projection, and lets the library draw. No inline fallback: if
``store`` is missing or malformed the snippet raises, surfacing the real
problem instead of hiding it behind a bar-chart placeholder.

The GUI injects ``time_step`` (from the timeline slider) and
``field_name`` (from the field selector) into scope before exec.
"""
# Force the headless backend before pyplot loads — Pyodide runs the worker
# off-main-thread and the default backend triggers a GUI-thread warning that
# escalates to an exception.
import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
import zoomy_plotting as zp

if store is None:
    raise RuntimeError(
        "store is not populated — run a simulation first. The solver "
        "template writes /tmp/zoomy_sim/sim.h5 and calls open_hdf5()."
    )
if not isinstance(store, zp.SimulationStore):
    raise TypeError(
        f"store must be zoomy_plotting.SimulationStore, got "
        f"{type(store).__name__}"
    )

field_name = field_name if "field_name" in dir() and field_name else next(iter(store.field.keys()))
time_step = int(time_step) if "time_step" in dir() else 0
colormap = "viridis"

plotter = zp.MatplotlibPlotter(store)
# plot_1d has no cmap argument; only pass it for dim>=2.
plot_kwargs = {} if store.dim == 1 else {"cmap": colormap}
with zp.apply_style():
    if store.dim == 3:
        fig = plt.figure()
        ax = fig.add_subplot(111, projection="3d")
    else:
        fig, ax = plt.subplots()
    plotter.plot(ax, time_step=time_step, field=field_name, **plot_kwargs)

# Prefer simulation time in the title. zoomy_plotting >= 0.1.2 does this
# internally; override here so the title is consistent even on 0.1.1
# until the new wheel propagates through PyPI + Pyodide's micropip cache.
if store.times is not None and len(store.times):
    ax.set_title(f"{field_name}  —  t = {float(store.times[time_step]):.3f}")

print(f"[zp] {store.cell_type} dim={store.dim} field={field_name!r} "
      f"snaps={store.n_snapshots} cells={store.n_cells}")

# Single output convention — display(fig) is the only way a snippet
# publishes a plot to the card. The GUI clears the output list at the
# start of every run, so the figure shown is always just this one.
display(fig)
