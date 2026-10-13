"""Put the QR sessions' run cards on the symbolic solvers: EDITS the session zips IN PLACE.

The packers reproduce the thesis cases as they were packed (pinned revisions, the legacy
`zoomy_core.fvm` / `zoomy_jax.fvm` / `zoomy_amrex.solvers` solvers). This step replaces
each session's solver card code (`project.json` override and the card's `code.py`) with
its port in `symsolver/`: the same case, model, mesh and settings, marched by
`SymbolicHyperbolicSolverNumpy` / `SymbolicHyperbolicSolverJax`.  Run it after the packers and
before `merge_sessions.py`.  A card that is already the port is left alone; a card that is
neither the port nor the packed legacy code (the thesis case changed) stops the run.
"""
import json
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.join(HERE, os.pardir)
PORTS = os.path.join(HERE, "symsolver")

#: (zip, session index, port, a line of the legacy run card it replaces, strip comments)
SESSIONS = [
    ("bingham-session.zip", 0, "bingham_run.py",
     "from zoomy_core.fvm.solver_numpy import HyperbolicSolver", True),
    ("zoomy-codeprinter-session.zip", 0, "codeprinter_run.py",
     "from zoomy_core.fvm.solver_numpy import HyperbolicSolver", True),
    ("steffler-session.zip", 0, "steffler_run.py",
     "from zoomy_core.fvm.solver_numpy import HyperbolicSolver", False),
    ("malpasset-session.zip", 0, "malpasset_jax_run.py",
     "from zoomy_jax.fvm.solver_jax import HyperbolicSolver", False),
]
#: Not applied: `symsolver/malpasset_amrex_run.py` (Malpasset AMReX, session 1 of
#: malpasset-session.zip) runs on the symbolic AMReX solver, but `zoomy_amrex.symsolver`
#: builds and runs through `apptainer exec zoomy_amrex.sif` from the host, and the GUI's
#: amrex backend is zoomy-server inside that image (no apptainer, read-only `.symcache`).
#: The session stays on `zoomy_amrex.solvers.HyperbolicSolver` until the driver builds
#: in the container.


def port_code(name, strip_comments):
    with open(os.path.join(PORTS, name)) as f:
        code = f.read()
    if strip_comments:
        import sys
        sys.path.insert(0, HERE)
        from strip_comments import strip
        code = strip(code)
    compile(code, name, "exec")
    return code


def port(zname, jobs):
    """Apply `[(index, port name, legacy line, strip)]` to one zip."""
    path = os.path.join(PROJECTS, zname)
    with zipfile.ZipFile(path) as z:
        items = {n: z.read(n) for n in z.namelist()}
    meta = json.loads(items["project.json"])
    changed = False
    for idx, name, legacy, strip_comments in jobs:
        sess = meta["sessions"][idx]
        card = sess["cardOverrides"][sess["selections"]["solver"]]
        new = port_code(name, strip_comments)
        old = card["code"]
        if old == new:
            print(f"  {zname}#{idx}: already on the symbolic solver")
            continue
        if legacy not in old:
            raise SystemExit(f"{zname}#{idx}: the run card is neither the port nor the legacy "
                             f"card ({legacy!r} missing): re-port {name}")
        files = [n for n in items if n.startswith(sess["title"] + "/solver/")
                 and n.endswith("/code.py") and items[n].decode() == old]
        if len(files) != 1:
            raise SystemExit(f"{zname}#{idx}: {len(files)} solver code.py files match the card")
        card["code"] = new
        items[files[0]] = new.encode()
        changed = True
        print(f"  {zname}#{idx}: run card -> symsolver/{name}")
    if changed:
        items["project.json"] = json.dumps(meta, indent=2).encode()
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for n, b in items.items():
                z.writestr(n, b)


if __name__ == "__main__":
    by_zip = {}
    for zname, idx, name, legacy, strip_comments in SESSIONS:
        by_zip.setdefault(zname, []).append((idx, name, legacy, strip_comments))
    for zname, jobs in by_zip.items():
        port(zname, jobs)
    print("done")
