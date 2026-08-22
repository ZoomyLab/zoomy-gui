"""Regenerate the three Zoomy-pipeline session zips from
``thesis/cases/zoomy_example/gui/``.

These back the three QR codes of the Zoomy section at the end of the numerics
chapter. Unlike the other packers here, the cards need no rewriting: the case
folders were written as GUI cards to begin with, with the ``__file__`` guard and
the notebook-or-folder import probe already in place, so this only compiles
them, smoke-tests the ones that are cheap to exec, and zips.

  derivation   -> zoomy-derivation-session.zip
                  the shallow water equations derived from the general mass and
                  momentum balance, then run as a dam break
  systemmodel  -> zoomy-systemmodel-session.zip
                  model to system model, and the dispersion relation
  codeprinter  -> zoomy-codeprinter-session.zip
                  system model to numerical system model to AMReX source

Run with the zoomy env:  PYTHONNOUSERSITE=1 micromamba run -n zoomy python <this>
"""
import json
import os
import zipfile

ROOT = os.path.expanduser("~/git/Zoomy")
CASES = os.path.join(ROOT, "thesis/cases/zoomy_example/gui")
OUT = os.path.join(ROOT, "library/zoomy_gui/projects")

# card id -> (tab, title). The ids are the catalog ids with the `card-` prefix,
# which is what the GUI resolves a selection against; the code below overrides
# each card's body.
CARDS = {
    "card-swe":            ("model",         "Shallow Water (SWE)",  "model.py"),
    "card-mesh-create-1d": ("mesh",          "Create 1D",            "mesh.py"),
    "card-solver-numpy":   ("solver",        "NumPy Solver",         "run.py"),
    "card-vis-empty-mpl":  ("visualization", "Empty (Matplotlib)",   "visualize.py"),
}

SESSIONS = [
    {
        "dir": "derivation",
        "zip": "zoomy-derivation-session.zip",
        "id": "session-zoomy-derivation",
        "title": "Deriving the shallow water equations",
        "description": (
            "The shallow water equations derived from the general mass and "
            "momentum balance, one operator at a time, with the system printed "
            "after every step: the balances, the inviscid closure, the "
            "hydrostatic pressure closure, the sigma transform, the level-0 "
            "vertical ansatz, the Galerkin projection and the conservative "
            "fold. Press Run. The derived model is then frozen into a system "
            "model and a numerical system model and solved as a 2:1 dam break "
            "on 200 cells, so the equations that run are the ones the model "
            "card derived. The visualization card draws the free surface and "
            "the discharge."),
        "params": {"time_end": 0.5},
    },
    {
        "dir": "systemmodel",
        "zip": "zoomy-systemmodel-session.zip",
        "id": "session-zoomy-systemmodel",
        "title": "System model and dispersion relation",
        "description": (
            "The transition from a model to a system model, and what the frozen "
            "system can then answer. Press Run. The solver card prints the "
            "extracted flux and eigenvalues, linearises the system about a "
            "uniform state, inserts a plane-wave ansatz and solves for the "
            "dispersion relation. The result is omega = k (u_0 +- sqrt(g h_0)), "
            "so both branches are straight and the phase speed does not depend "
            "on the wavenumber: the shallow water equations carry no "
            "dispersion."),
        "params": {},
    },
    {
        "dir": "codeprinter",
        "zip": "zoomy-codeprinter-session.zip",
        "id": "session-zoomy-codeprinter",
        "title": "Numerical system model and AMReX code",
        "description": (
            "The last two stages of the pipeline. Press Run. The system model "
            "is handed to the numerical system model, which is where the "
            "numerical decisions live: 1/h is desingularised into a regularised "
            "auxiliary symbol and the reconstruction and Riemann solver are "
            "attached, so no backend has to implement them. The code printer "
            "then emits an AMReX header, and the flux kernel is printed and "
            "drawn. The printer is syntax only, the equations were fixed two "
            "steps earlier."),
        "params": {},
    },
]


def build(sess):
    src = os.path.join(CASES, sess["dir"])
    code = {}
    for cid, (_tab, _title, fname) in CARDS.items():
        with open(os.path.join(src, fname)) as f:
            code[cid] = f.read()
        compile(code[cid], f"{sess['dir']}/{fname}", "exec")
    print(f"  compile OK: {sess['dir']}",
          {CARDS[c][2]: len(s) for c, s in code.items()})

    overrides = {cid: {"code": code[cid]} for cid in CARDS}
    if sess["params"]:
        overrides["card-solver-numpy"]["params"] = sess["params"]

    session = {
        "id": sess["id"],
        "title": sess["title"],
        "description": sess["description"],
        "selections": {tab: cid for cid, (tab, _t, _f) in CARDS.items()},
        "cardOverrides": overrides,
    }
    meta = {"version": "1.1", "sessions": [session],
            "activeSession": sess["id"]}

    path = os.path.join(OUT, sess["zip"])
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("project.json", json.dumps(meta, indent=2))
        for cid, (tab, title, _f) in CARDS.items():
            base = f"{sess['title']}/{tab}/{title}/"
            z.writestr(base + "card.json", json.dumps(
                {"id": cid, "title": title, "description": "",
                 "params": overrides[cid].get("params", {}),
                 "tab": tab, "subtab": ""}, indent=2))
            z.writestr(base + "code.py", code[cid])
    print(f"  wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    for s in SESSIONS:
        build(s)
    print("done")
