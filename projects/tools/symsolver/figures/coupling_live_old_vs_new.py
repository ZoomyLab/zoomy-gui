"""The live SME | VOF session on the symbolic solvers against the old solver's run of the same
configuration (`coupling_live_old_reference.py`), and the old run's own sensitivity (the same
run with the reservoir 1e-9 m deeper) as the floor.

    python coupling_live_old_vs_new.py OLD.npz OLD_PERTURBED.npz CASE_DIR OUT_PREFIX

CASE_DIR: the session's case folder on the OpenFOAM backend (`simulation.h5`: the arm Swe,
`swe2.h5`: the arm Swe2 of the triple, `vof_case/ledger.csv`: the seam flux). Writes
OUT_PREFIX.json (the metrics), OUT_PREFIX.png (opaque) and OUT_PREFIX.svg (transparent).

Metrics, per arm, of the cell at the coupled face over the snapshots (every 0.05 s) and of the
profiles at t_end: rel_l2 = ||new - old||_2 / ||old||_2, rel_linf = max|new - old| / max|old|;
per seam, the same of the mass flux q* the tank charges each window.
"""
import json
import sys
from pathlib import Path

import h5py
import numpy as np
import matplotlib as mpl
mpl.use("Agg")
import matplotlib.pyplot as plt

OLD_C, NEW_C, FLOOR_C = "#2a78d6", "#eb6834", "#7f7f7f"


def rel(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    return {"rel_l2": float(np.linalg.norm(a - b) / max(np.linalg.norm(b), 1e-300)),
            "rel_linf": float(np.abs(a - b).max() / max(np.abs(b).max(), 1e-300))}


def store(path):
    """`(t, Q)` of a zoomy HDF5 store."""
    with h5py.File(path, "r") as f:
        it = sorted(f["fields"], key=lambda k: int(k.split("_")[1]))
        return (np.array([float(f["fields"][k]["time"][()]) for k in it]),
                np.stack([np.asarray(f["fields"][k]["Q"]) for k in it]))


def ledger(path):
    import csv
    out, seen = [], {}
    for r in csv.DictReader(open(path)):
        t = round(float(r["t"]), 9)
        k = seen[t] = seen.get(t, -1) + 1
        out.append((t, k, float(r["target"])))
    return np.array(out)


def common(ta, tb):
    keys = sorted(set(np.round(ta, 6)) & set(np.round(tb, 6)))
    ia = [int(np.argmin(np.abs(ta - k))) for k in keys]
    ib = [int(np.argmin(np.abs(tb - k))) for k in keys]
    return np.array(keys), ia, ib


def seam(L, k):
    m = L[:, 1] == k
    return {round(t, 9): q for t, q in zip(L[m, 0], L[m, 2])}


def main(old_path, oldp_path, case, prefix):
    old, oldp, case = np.load(old_path), np.load(oldp_path), Path(case)
    arms = [k[:-2] for k in old.files if k.endswith("_Q")]
    stores = {"Swe": case / "simulation.h5", "Swe2": case / "swe2.h5"}
    out = {"mode": str(old["mode"]), "t_end": float(old["t_end"]), "arms": {}, "seams": {}}
    series = {}
    for arm in arms:
        tn, Qn = store(stores[arm])
        to, Qo = old[f"{arm}_t"], old[f"{arm}_Q"]
        tp, Qp = oldp[f"{arm}_t"], oldp[f"{arm}_Q"]
        t, io, jn = common(to, tn)
        _, io2, jp = common(to, tp)
        face = -1 if arm == "Swe" else 0
        o, n, p = Qo[io], Qn[jn], Qp[jp]
        m = {}
        for name, row in (("h", 1), ("q0", 2)):
            m[f"interface_{name}"] = rel(n[:, row, face], o[:, row, face])
            m[f"interface_{name}_floor"] = rel(p[:, row, face], o[:, row, face])
        for name, row in (("h", 1), ("q0", 2), ("q1", 3)):
            m[f"final_{name}"] = rel(n[-1, row], o[-1, row])
            m[f"final_{name}_floor"] = rel(p[-1, row], o[-1, row])
        m["frames"], m["t_last"] = len(t), float(t[-1])
        out["arms"][arm] = m
        series[arm] = (t, o, n, p, face)
    Lo, Lp, Ln = old["ledger"], oldp["ledger"], ledger(case / "vof_case" / "ledger.csv")
    for k, arm in enumerate(arms):
        so, sn, sp_ = seam(Lo, k), seam(Ln, k), seam(Lp, k)
        ts = sorted(set(so) & set(sn) & set(sp_))
        out["seams"][arm] = {"q_star": rel([sn[t] for t in ts], [so[t] for t in ts]),
                             "q_star_floor": rel([sp_[t] for t in ts], [so[t] for t in ts]),
                             "windows": len(ts)}
    Path(prefix + ".json").write_text(json.dumps(out, indent=1))

    fig, axes = plt.subplots(len(arms), 3, figsize=(12, 3.4 * len(arms)), squeeze=False)
    lab = iter("abcdefghi")
    for r, arm in enumerate(arms):
        t, o, n, p, face = series[arm]
        x = np.linspace(-0.6, 0.0, 121) if arm == "Swe" else np.linspace(1.5, 2.1, 121)
        x = 0.5 * (x[1:] + x[:-1])
        a, b, c = axes[r]
        a.plot(t, o[:, 1, face], color=OLD_C, lw=2.2, label="old (zoomyFoam)")
        a.plot(t, n[:, 1, face], color=NEW_C, lw=1.2, ls="--", label="new (JAX symbolic)")
        a.set(xlabel="t [s]", ylabel=f"h at the coupled face, arm {arm} [m]")
        a.legend(fontsize=8, frameon=False)
        b.plot(x, o[-1, 1], color=OLD_C, lw=2.2, label="old")
        b.plot(x, n[-1, 1], color=NEW_C, lw=1.2, ls="--", label="new")
        b.set(xlabel="x [m]", ylabel=f"h at t = {t[-1]:.2f} s [m]")
        b.legend(fontsize=8, frameon=False)
        c.semilogy(t, np.abs(n[:, 1] - o[:, 1]).max(axis=1) + 1e-16, color=NEW_C,
                   label="max |new - old|")
        c.semilogy(t, np.abs(p[:, 1] - o[:, 1]).max(axis=1) + 1e-16, color=FLOOR_C,
                   label="max |old(+1e-9 m) - old|")
        c.set(xlabel="t [s]", ylabel="max over the arm of |dh| [m]")
        c.legend(fontsize=8, frameon=False, loc="lower right")
        for ax in (a, b, c):
            ax.text(0.02, 0.96, f"({next(lab)})", transform=ax.transAxes, va="top",
                    fontweight="bold")
    fig.tight_layout()
    fig.savefig(prefix + ".png", dpi=150, facecolor="white")
    fig.savefig(prefix + ".svg", transparent=True)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main(*sys.argv[1:5])
