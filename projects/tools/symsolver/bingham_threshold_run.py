"""Bingham threshold sweep (numpy) — GUI folder-case ``run.py``.

Performs the THREE SME(2)+Bingham transient solves of the Liu & Mei (1994)
linear roll-wave threshold study (a sweep INSIDE one folder-case): for each
``beta`` in ``settings['sweep']['betas']`` (default 3 / 6.35 / 12 at
``alpha=0.5``) it marches the seeded long-wave film down the open incline in ONE
continuous run of the symbolic NumPy solver (``SymbolicHyperbolicSolverNumpy``;
the march lands on every frame time) and records the crest-amplitude history
``max|h - H0|(t)`` (the instability is CONVECTIVE — waves advect out of the
domain, so growth is measured inside a physical transit window, not at late
times on an emptied domain).

Writes ONE primary store ``output/bingham_threshold.npz`` (per-beta amplitude
series ``amp_i`` + full snapshot stacks ``S_i`` + fitted transit-window growth
rates ``rate_i`` + the analytic ``beta_c``), and a minimal server-facing
``output/bingham_threshold.h5`` (``/mesh`` + ``fields/iteration_*``) built from
the UNSTABLE run via the core HDF5 writers, so the results endpoint / vtk
fallback has a real snapshot store to render.  ``run()`` returns the npz path.

GUI time knob: ``settings['run']['t_end_prime']`` is honored as in
``../transient/run.py`` — but here it is the PHYSICAL end time in seconds (the
sweep spans three betas => three ``tscale``s, so a single non-dimensional t'
would map to three different physical horizons and break the shared,
physical growth-rate window).  Default 100 s matches ``bingham_rollwaves.py``.

Standalone: ``python run.py``.
"""

import json
import os
import time

import numpy as np

from zoomy_core.misc.misc import get_main_directory
from zoomy_core.misc.io import write_mesh_to_hdf5, _save_fields_to_hdf5
from zoomy_core.numerics import NonconservativeRusanov, NumericalSystemModel, ReconstructionSpec
from zoomy_core.symsolver.numpy_backend import SymbolicHyperbolicSolverNumpy
from zoomy_core.systemmodel.system_model import SpectralRadius

# Case modules: defined by the Model/Mesh cells in notebook form;
# imported from the sibling files in a materialized case folder.
try:
    build_mesh, build_model, liu_mei_beta_c  # noqa: B018  (probe the notebook namespace)
except NameError:
    from mesh import build_mesh
    from model import build_model, liu_mei_beta_c

CASE_DIR = (os.path.dirname(os.path.abspath(__file__))
             if "__file__" in globals() else os.getcwd())


#: Full sweep settings (the case's settings.json), used whenever the sibling
#: settings.json is absent (notebook) or GUI-generic (no "sweep" key).
_CASE_SETTINGS = {'name': 'bingham_threshold',
 'backend': 'numpy',
 'model': {'type': 'SME',
           'level': 2,
           'quadrature_order': 12,
           'rheology': 'bingham',
           'g': 9.81,
           's': 0.1,
           'H0': 1.0,
           'lambda_s': 50.0},
 'sweep': {'alpha': 0.5, 'betas': [3.0, 6.35, 12.0]},
 'ic': {'seed_amplitude': 0.02, 'seed_wavelength': 60.0},
 'mesh': {'n_inner_cells': 500, 'xmax': 600.0},
 'numerics': {'order': 1,
              'cfl': 0.9,
              'riemann': 'rusanov',
              'reconstruction_variables': 'conservative',
              'dt_cap_safety': 0.4},
 'run': {'solver': 'explicit',
         't_end_prime': 100.0,
         'snapshots': 50,
         'growth_tol': 0.005,
         'marginal_band': 0.15}}


def load_settings(path=None):
    p = path or os.path.join(CASE_DIR, "settings.json")
    s = json.load(open(p)) if os.path.exists(p) else {}
    if "sweep" not in s:                          # GUI-generic or missing
        gui = s or (globals().get("settings")
                    if isinstance(globals().get("settings"), dict) else None) or {}
        s = json.loads(json.dumps(_CASE_SETTINGS))
        if gui.get("time_end") is not None:       # GUI knob = t_end_prime [PHYSICAL s]
            s["run"] = dict(s["run"], t_end_prime=float(gui["time_end"]))
        if gui.get("output_snapshots") is not None:   # GUI knob = frame count
            s["run"] = dict(s["run"], snapshots=int(gui["output_snapshots"]))
    return s


def growth_rate(times, amp, sc, xmax):
    """Transit-window log-amplitude slope (1/s) and the window's exit time.

    The convective instability is measured while the seeded train is still in
    the domain: window = ``5 s .. 0.8 * xmax / c_kin``.  For very short (smoke)
    horizons the window can be empty, so fall back to the full ``t > 0`` span.
    """
    t_exit = 0.8 * xmax / sc["c_kin"]
    mask = (times > 5.0) & (times < t_exit)
    if mask.sum() < 2:
        mask = times > 0.0
    rate = float(np.polyfit(times[mask], np.log(amp[mask] + 1e-12), 1)[0])
    return rate, float(t_exit)


def verdict(beta, beta_c, rate, growth_tol, band):
    """STABLE / MARGINAL / UNSTABLE — the Liu & Mei threshold bracket confirmed
    by the measured transit-window rate.

    A MEASURABLY GROWING film (``rate > growth_tol``) is UNSTABLE — the
    load-bearing measured result (only ``beta > beta_c`` grows).  A non-growing
    film within ``band`` of the analytic threshold ``beta_c`` is MARGINAL (at
    threshold, barely decaying); otherwise it is STABLE (below threshold,
    decaying).  The stable/marginal split is a threshold-PROXIMITY statement:
    both sub-threshold cases decay, so the rate alone cannot rank them (cf. the
    reference ``fig_threshold`` where the ``-0.002`` case is stable and the
    MORE-negative ``-0.004`` case marginal)."""
    if rate > growth_tol:
        return "UNSTABLE"
    if abs(beta - beta_c) <= band * beta_c:
        return "MARGINAL"
    return "STABLE" if beta < beta_c else "UNSTABLE"


def _solve_beta(settings, mesh, beta, frame_times, num, h0, xmax, nc):
    """One continuous march for one ``beta``, the state kept at every frame time; returns
    (S, amp, Qaux_list, sc)."""
    bundle = build_model(settings, mesh, beta, CASE_DIR)
    sm, sc, dtc = bundle["sm"], bundle["sc"], bundle["dt_cap"]
    print(f"  beta={beta}: nu={sc['nu']:.4f} tau_y={sc['tau_y']:.3f} "
          f"eps={sc['eps_reg']:.3f} c_kin={sc['c_kin']:.3f} dt_cap={dtc:.5f}",
          flush=True)
    # The film never dries: the plain path-conservative Rusanov flux (a hydrostatic
    # reconstruction would under-represent the 10 % slope by s dx / 2 H0 = 6 % on this mesh)
    # with the numerical eigenvalues as its wave speed, and the source-stiffness cap as the
    # NSM's dt_max (the IC is on sm, set before lowering).
    sm.spectral_radius_method = SpectralRadius.eig
    nsm = NumericalSystemModel.from_system_model(
        sm, riemann=NonconservativeRusanov,
        reconstruction=ReconstructionSpec(order=num.get("order", 1)), dt_max=dtc)

    snaps, qauxs = [], []

    def keep(time, Q, Qaux):
        if time > 0.0:
            snaps.append(np.asarray(Q, float)[:, :nc].copy())
            qauxs.append(np.asarray(Qaux, float)[:, :nc].copy())

    t0 = time.perf_counter()
    solver = SymbolicHyperbolicSolverNumpy(
        time_end=float(frame_times[-1]), cfl=num.get("cfl", 0.9),
        dt_write=float(frame_times[0]), on_write=keep)
    Q, Qaux = solver.setup(mesh, nsm)
    solver.run(Q, Qaux)
    snaps = snaps[:len(frame_times)]
    for k, f in enumerate(snaps):
        if not np.all(np.isfinite(f)):
            print(f"    NON-FINITE at t={frame_times[k]:.1f}", flush=True)
            snaps = snaps[:k + 1]
            break
    qauxs = qauxs[:len(snaps)]
    S = np.stack(snaps)
    amp = np.array([np.abs(f[1] - h0).max() for f in snaps])
    print(f"    marched {time.perf_counter()-t0:.0f}s  "
          f"amp {amp[0]:.4f} -> {amp[-1]:.4f}", flush=True)
    return S, amp, qauxs, sc


def _write_server_h5(mesh, S, qauxs, frame_times, name):
    """Minimal server-facing store from the unstable run (core HDF5 writers)."""
    h5_abs = os.path.join(CASE_DIR, "output", name + ".h5")
    h5_rel = os.path.relpath(h5_abs, get_main_directory())
    if os.path.exists(h5_abs):
        os.remove(h5_abs)
    write_mesh_to_hdf5(h5_rel, mesh)          # /mesh (self-describing)
    for i in range(len(S)):
        _save_fields_to_hdf5(h5_rel, i, float(frame_times[i]), S[i], qauxs[i])
    return h5_abs


def run(settings=None):
    """Sweep the betas, fit growth rates, write the npz (+ server h5).  Returns
    the npz path."""
    if settings is None:
        settings = load_settings()
    name = settings.get("name", "bingham_threshold")
    m, num, run_cfg = settings["model"], settings["numerics"], settings["run"]
    sw = settings["sweep"]
    betas = [float(b) for b in sw["betas"]]
    alpha = float(sw["alpha"])
    h0 = float(m["H0"])
    xmax = float(settings["mesh"]["xmax"])
    nc = int(settings["mesh"]["n_inner_cells"])
    growth_tol = float(run_cfg.get("growth_tol", 0.005))
    band = float(run_cfg.get("marginal_band", 0.15))

    t_end = float(run_cfg["t_end_prime"])              # PHYSICAL seconds (see docstring)
    nfrm = int(run_cfg.get("snapshots", 50))
    frame_times = np.linspace(0.0, t_end, nfrm + 1)[1:]
    beta_c = liu_mei_beta_c(alpha)

    mesh = build_mesh(settings, CASE_DIR)
    print(f"[{name}] mesh: {mesh.n_inner_cells} cells x{xmax}; "
          f"betas={betas} alpha={alpha}; Liu&Mei beta_c={beta_c:.2f}; "
          f"T={t_end:.0f}s x{nfrm} frames", flush=True)

    S_list, amp_list, sc_list, qaux_list, rates, verdicts, exits = (
        [], [], [], [], [], [], [])
    t_all = time.perf_counter()
    for beta in betas:
        S, amp, qauxs, sc = _solve_beta(
            settings, mesh, beta, frame_times, num, h0, xmax, nc)
        t_fit = frame_times[:len(amp)]
        rate, t_exit = growth_rate(t_fit, amp, sc, xmax)
        vd = verdict(beta, beta_c, rate, growth_tol, band)
        print(f"  beta={beta}: rate {rate:+.4f} 1/s (window 5..{t_exit:.0f}s)"
              f"  -> {vd}", flush=True)
        S_list.append(S); amp_list.append(amp); sc_list.append(sc)
        qaux_list.append(qauxs); rates.append(rate); verdicts.append(vd)
        exits.append(t_exit)
    print(f"[{name}] full sweep wall {time.perf_counter()-t_all:.0f}s", flush=True)

    out_dir = os.path.join(CASE_DIR, "output")
    os.makedirs(out_dir, exist_ok=True)
    npz = os.path.join(out_dir, name + ".npz")
    xc = np.linspace(xmax / nc / 2, xmax - xmax / nc / 2, nc)
    np.savez_compressed(
        npz, times=frame_times, xc=xc,
        betas=np.array(betas), alpha=alpha, beta_c=beta_c, H0=h0,
        g=float(m["g"]), s=float(m["s"]), xmax=xmax,
        growth_tol=growth_tol, marginal_band=band,
        rates=np.array(rates), t_exits=np.array(exits),
        verdicts=np.array(verdicts, dtype=object),
        nus=np.array([s["nu"] for s in sc_list]),
        **{f"amp_{i}": amp_list[i] for i in range(len(betas))},
        **{f"S_{i}": S_list[i] for i in range(len(betas))})
    print(f"[{name}] wrote {npz}", flush=True)

    # server h5 from the most-unstable (largest beta) run
    iu = int(np.argmax(betas))
    h5 = _write_server_h5(mesh, S_list[iu], qaux_list[iu], frame_times, name)
    print(f"[{name}] wrote {h5}", flush=True)

    for b, r, v in zip(betas, rates, verdicts):
        print(f"  VERDICT beta={b:<6}: rate {r:+.4f} 1/s -> {v}", flush=True)
    return npz


_npz = run()
import shutil

# run.py writes a server-facing store output/<name>.h5; copy it to the standard
# artifact name so the compose viz prelude's read_hdf5 succeeds (the figure
# itself is recomputed from the .npz by visualize.py).
shutil.copy(_npz[:-4] + ".h5", "simulation.h5")
print("artifact -> simulation.h5")
