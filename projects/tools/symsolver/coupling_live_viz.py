"""SME | VOF live coupling — the reduced arm with the dam, from the run's store.

(a) the free surface h(x) of the arm at a few instants; (b) the depth and the discharge
q_0 of the cell at the coupled face over time: the bore leaves the arm into the VOF tank
at t ~ 0.3 s, the tank's reflection comes back at t ~ 2.5 s. The tank's own store is the
run's `vof_case.h5`.
"""
import numpy as np
import matplotlib as mpl
mpl.use("Agg")
import matplotlib.pyplot as plt

times = np.asarray(store.times, dtype=float)
x = np.asarray(store.cell_centers)[:, 0]
snap = [np.array([store.get_cell(k, i) for i in range(4)]) for k in range(store.n_snapshots)]
face = int(np.argmax(x)) if ARMS["Swe"][1] == "right" else int(np.argmin(x))

fig, (a, b) = plt.subplots(1, 2, figsize=(10, 3.6))
for k in np.unique(np.linspace(0, len(times) - 1, 6).round().astype(int)):
    a.plot(x, snap[k][1], label=f"t = {times[k]:.2f} s")
a.set(xlabel="x [m]", ylabel="h [m]")
a.legend(fontsize=8)
a.text(0.02, 0.95, "(a)", transform=a.transAxes, va="top")
b.plot(times, [s[1][face] for s in snap], label="h [m]")
b.plot(times, [s[2][face] for s in snap], label="q$_0$ [m$^2$/s]")
b.set(xlabel="t [s]", ylabel="coupled cell")
b.legend(fontsize=8)
b.text(0.02, 0.95, "(b)", transform=b.transAxes, va="top")
fig.tight_layout()
fig.savefig("sme_vof_live.png", dpi=120)
display(fig)
