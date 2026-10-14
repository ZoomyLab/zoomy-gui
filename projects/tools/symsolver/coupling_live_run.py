"""SME | VOF live coupling — the run, on the OpenFOAM backend.

This backend marches the resolved arm: the VOF tank (OpenFOAM 13 incompressibleVoF)
with the `swePreciceCoupling` function object, which imposes the reduced arm's column on
the coupled patch (`zoomy_foam.vof`; the function object is compiled against the arm's
model, ~35 s the first time, cached after). The reduced arm(s) run on the JAX backend:
this case's model and mesh cells plus `PARTICIPANT_RUN`, submitted to the JAX backend's
zoomy-server as the GUI submits a case, march `SymbolicHyperbolicSolverJax` as a preCICE
participant (`zoomy_jax.symsolver.coupling`): the column exchange, the Riemann problem
towards the characteristic ghost and the depth row held over each window at the value
the tank charges. The participants meet over preCICE sockets in a directory both
backends see.

Backend setup (each server's environment, `zoomy_server.peers`): `ZOOMY_PEERS` names the
JAX backend (`{"jax": "http://host:port"}`, or a file holding it) and
`ZOOMY_COUPLE_DIR` a directory both containers see at the same path.

Coupling: window 2 ms (parallel-explicit; with two arms preCICE's multi scheme, one
iteration); the arms step adaptively inside each window at CFL `cfl` (0.45: the
effective Courant number of the zoomyFoam participant this session ran before, which
sized its 1-D step with a factor 1/2) from the cells' wave speeds; snapshots every 0.05 s.
The function object's settings (`FO`): the star-state imposition with the characteristic
mass row and no debt ledger, the production path of the Fr* = 0.752 configuration
(thesis/cases/applications/sme_vof_overshoot).

Results: `simulation.h5`, the arm with the dam (the store the GUI opens); with a second
arm `swe2.h5`; the tank `vof_case.h5`.
"""
import os
import signal
import time
from pathlib import Path

from zoomy_foam import vof
from zoomy_server import peers

T_END = float(settings.get("time_end") or 2.5)       # the GUI's time knob (s)
CFL = float(settings.get("cfl") or 0.45)
WINDOW, DT_WRITE = 2e-3, 0.05
#: the function object's settings on top of zoomy_foam.vof.FO_STARSTATE
FO = {}  # packer: FO

#: the reduced arm's run cell on the JAX backend (after this case's model and mesh cells)
PARTICIPANT_RUN = '''"""SME | VOF live coupling: one reduced arm as a preCICE participant on JAX."""
import os
import threading
import time
from pathlib import Path

os.environ.setdefault("JAX_PLATFORMS", "cpu")
from zoomy_core.symsolver.discretization.time import CflWaveSpeed
from zoomy_jax.symsolver.coupling import column_participant


def _watch(flag):
    """The tank's run died: preCICE would wait for it forever."""
    while not flag.exists():
        time.sleep(1)
    print("the VOF participant failed: aborting", flush=True)
    os._exit(3)


threading.Thread(target=_watch, args=(Path(settings["abort"]),), daemon=True).start()
p = dict(settings["participant"])
p["cfl_wave_speed"] = CflWaveSpeed(p["cfl_wave_speed"])
name = p["participant"]
print(f"reduced arm {name}: preCICE {p['config']}", flush=True)
open_hdf5(column_participant(arm_numerics(arm_model(name)), arm_mesh(name),
                             store=run_h5_path(), **p))
'''

# ── the coupling: configuration, the tank, the function object ─────────────────
run = peers.couple_dir()                                 # seen by both backends
arms = [vof.Arm(name, f"{name}Mesh", "VofInletMesh" if side == "right" else "VofOutletMesh",
                "left" if side == "right" else "right")
        for name, (_, side, _) in ARMS.items()]
config = vof.write_config(run / "precice-config.xml", arms=arms, t_end=T_END,
                          window=WINDOW, exchange=run)
tank = vof.Tank(**TANK)
tank.fo.update(FO)
case = vof.write_case(Path("vof_case").resolve(), tank, arms=arms, config=config,
                      t_end=T_END, window=WINDOW, write_interval=DT_WRITE)
t0 = time.monotonic()
lib = vof.coupling_library(model)
print(f"function object: {lib} ({time.monotonic() - t0:.0f} s)", flush=True)

# ── the reduced arms on the JAX backend ────────────────────────────────────────
jax_backend = peers.Peer(peers.peer_url("jax"))
cells = {f: Path(f).read_text() for f in ("model.py", "mesh.py")}
jobs = {}
for a in arms:
    side = ARMS[a.participant][1]
    jobs[a.participant] = jax_backend.submit(peers.compose(
        cells["model.py"], cells["mesh.py"],
        {"participant": dict(participant=a.participant, config=str(config),
                             mesh_name=a.mesh, tag=side, nz=NZ, dt_write=DT_WRITE,
                             cfl=CFL, cfl_wave_speed="cells"),
         "abort": str(run / "abort")},
        PARTICIPANT_RUN, title=a.participant))
print("reduced arms on the JAX backend:", jobs, flush=True)

# ── march: the tank here, the arms there ───────────────────────────────────────
proc = vof.start(case, lib, log=Path("log.vof").resolve())


def _status(job):
    """The arm job's status (a transient HTTP error reads as running)."""
    try:
        return jax_backend.status(job)
    except OSError:
        return {"status": "running"}


failed = None
try:
    while failed is None:
        bad = {n: s for n, s in ((n, _status(j)) for n, j in jobs.items())
               if s.get("status") in ("failed", "cancelled")}
        if bad:
            failed = "reduced arm " + ", ".join(f"{n}: {s.get('error') or s['status']}"
                                                for n, s in bad.items())
        elif proc.poll() is not None:
            if proc.returncode:
                failed = f"VOF tank (foamRun rc {proc.returncode})"
            break
        time.sleep(2)
finally:
    if failed or proc.poll() is None:
        (run / "abort").touch()              # the arms' watchdog ends a waiting participant
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGKILL)
if failed:
    for j in jobs.values():
        jax_backend.wait(j, timeout=60)
    tail = Path("log.vof").read_text(errors="replace").splitlines()[-15:]
    raise RuntimeError(f"live coupling failed: {failed}\n--- log.vof ---\n" + "\n".join(tail))
for n, j in jobs.items():
    s = jax_backend.wait(j)
    if s.get("status") != "complete":
        raise RuntimeError(f"reduced arm {n}: {s.get('error') or s.get('status')}")

# ── the stores ────────────────────────────────────────────────────────────────
for n, j in jobs.items():
    jax_backend.store(j, "simulation.h5" if n == "Swe" else f"{n.lower()}.h5")
vof.to_hdf5(case, "vof_case.h5")
print(f"done in {time.monotonic() - t0:.0f} s: simulation.h5 (arm Swe), "
      + "".join(f"{n.lower()}.h5, " for n in jobs if n != "Swe") + "vof_case.h5", flush=True)
open_hdf5("simulation.h5")
