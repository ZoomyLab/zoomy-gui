"""Matplotlib mesh viewer — delegates to ``zoomy_plotting.MatplotlibPlotter``.

The Pyodide worker loads ``zoomy-plotting`` from PyPI at boot; this snippet
is a thin wrapper that picks a field + time step, builds a figure with the
right projection, and lets the library draw. No inline fallback: if
``store`` is missing or malformed the snippet raises, surfacing the real
problem instead of hiding it behind a bar-chart placeholder.

The GUI injects ``time_step`` (from the timeline slider) and
``field_name`` (from the field selector) into scope before exec.
"""
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
with zp.apply_style():
    if store.dim == 3:
        fig = plt.figure()
        ax = fig.add_subplot(111, projection="3d")
    else:
        fig, ax = plt.subplots()
    plotter.plot(ax, time_step=time_step, field=field_name, cmap=colormap)

print(f"[zp] {store.cell_type} dim={store.dim} field={field_name!r} "
      f"snaps={store.n_snapshots} cells={store.n_cells}")
