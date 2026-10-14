import matplotlib.pyplot as plt
import zoomy_plotting as zp

x = store.cell_centers[:, 0]
first, last = 0, store.n_snapshots - 1

with zp.apply_style():
    fig, (ax_h, ax_q) = plt.subplots(1, 2, figsize=(7.0, 2.6))
    for step in (first, last):
        label = f"t = {store.times[step]:.2f} s"
        ax_h.plot(x, store.get_cell(step, "b") + store.get_cell(step, "h"),
                  marker="None", label=label)
        ax_q.plot(x, store.get_cell(step, "q_0"), marker="None", label=label)
    ax_h.set(xlabel="$x$ [m]", ylabel="$b + h$ [m]", title="(a) free surface")
    ax_q.set(xlabel="$x$ [m]", ylabel="$q_0$ [m$^2$ s$^{-1}$]", title="(b) discharge")
    zp.figure_legend(fig)
fig
