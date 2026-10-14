import numpy as np
import matplotlib.pyplot as plt
import zoomy_plotting as zp

last = store.n_snapshots - 1
h = store.get_cell(last, "h")
x = np.linspace(0.0, 1.0, h.size, endpoint=False)

with zp.apply_style():
    fig, ax = plt.subplots(figsize=(3.6, 2.6))
    ax.plot(x, np.roll(h / H0, h.size // 2 - int(np.argmax(h))), marker="None",
            label=f"SME({level}), t' = {store.times[last] / tscale:.1f}")
    ax.set(xlabel=r"$x/\lambda$  (shock-aligned)", ylabel="$h/H$", xlim=(0, 1))
    zp.figure_legend(fig)
fig
