"""Mesh wireframe — cell edges over a faint field, to inspect resolution.

Built on ``zoomy_plotting.MatplotlibPlotter`` (``show_mesh=True``). Scope:
``store``, ``time_step``, ``field_name``. Unified 1D / 2D / 3D.
"""
import matplotlib
matplotlib.use("agg")
import matplotlib.pyplot as plt
import zoomy_plotting as zp

if store is None:
    raise RuntimeError("No data yet — run a simulation first.")

field = field_name if ("field_name" in dir() and field_name) else next(iter(store.field.keys()))
step = int(time_step) if "time_step" in dir() else 0
kw = {"show_nodes": True} if store.dim == 1 else {"show_mesh": True, "alpha": 0.25, "colorbar": False}

with zp.apply_style():
    if store.dim == 3:
        fig = plt.figure(); ax = fig.add_subplot(111, projection="3d")
    else:
        fig, ax = plt.subplots()
    zp.MatplotlibPlotter(store).plot(ax, time_step=step, field=field, **kw)
    ax.set_title("mesh")

display(fig)
