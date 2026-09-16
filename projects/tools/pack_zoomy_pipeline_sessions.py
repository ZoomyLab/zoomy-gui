"""Regenerate the four thesis session zips from ``thesis/cases/zoomy_example/gui/``.

These back the QR codes of the Zoomy section of the numerics chapter (the
derivation, the system model, the code printer) and the roll-wave QR of the
outlook (Bingham). Each case folder holds the notebook cells as plain files
(model.py, mesh.py, run.py, visualize.py); the packer strips comments and
docstrings, compiles, and zips them as card overrides of one session.
"""
import json
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from strip_comments import strip  # noqa: E402  (the notebook shows code, not commentary)

ROOT = os.path.expanduser("~/git/Zoomy")
CASES = os.path.join(ROOT, "thesis/cases/zoomy_example/gui")
OUT = os.path.join(ROOT, "library/zoomy_gui/projects")

# card id -> (tab, title, file). The ids are the catalog ids with the `card-`
# prefix, which is what the GUI resolves a selection against; the code below
# overrides each card's body. A session lists only the cards its notebook has:
# a symbolic pipeline has no mesh to build and no field to plot, and the GUI
# composes no section for a card that is not there.
CARDS = {
    "card-swe":            ("model",         "Shallow Water (SWE)",    "model.py"),
    "card-sme":            ("model",         "Shallow Moments (SME)",  "model.py"),
    "card-mesh-create-1d": ("mesh",          "Create 1D",              "mesh.py"),
    "card-solver-numpy":   ("solver",        "NumPy Solver",           "run.py"),
    "card-vis-empty-mpl":  ("visualization", "Empty (Matplotlib)",     "visualize.py"),
}

SESSIONS = [
    {
        "dir": "derivation",
        "zip": "zoomy-derivation-session.zip",
        "id": "session-zoomy-derivation",
        "title": "Deriving the shallow water equations",
        "description": (
            "The shallow water equations derived from the general mass and "
            "momentum balance, one operation at a time, the model displayed "
            "after every step: the balances, the inviscid closure, the "
            "hydrostatic pressure closure, the sigma transform, the level-0 "
            "vertical ansatz, the Galerkin projection and the conservative "
            "fold. Press Run All. The derived model is frozen into a system "
            "model and a numerical system model and solved as a 2:1 dam break "
            "on 200 cells; the last cell draws the initial and the final "
            "free surface and discharge."),
        "cards": ["card-swe", "card-mesh-create-1d", "card-solver-numpy", "card-vis-empty-mpl"],
        "params": {"time_end": 0.5},
    },
    {
        "dir": "systemmodel",
        "zip": "zoomy-systemmodel-session.zip",
        "id": "session-zoomy-systemmodel",
        "title": "System model and dispersion relation",
        "description": (
            "The transition from a model to a system model, and what the frozen "
            "system can answer. Press Run All. The system model is displayed, "
            "linearised about a uniform state, given a plane-wave ansatz and "
            "solved for the dispersion relation, omega = k (u_0 +- sqrt(g h_0)): "
            "both branches are straight and the phase speed does not depend on "
            "the wavenumber, so the shallow water equations carry no dispersion."),
        "cards": ["card-swe", "card-solver-numpy", "card-vis-empty-mpl"],
        "params": {},
    },
    {
        "dir": "codeprinter",
        "zip": "zoomy-codeprinter-session.zip",
        "id": "session-zoomy-codeprinter",
        "title": "Numerical system model and AMReX code",
        "description": (
            "The last two stages of the pipeline. Press Run All. The system "
            "model is handed to the numerical system model, where the numerical "
            "decisions live: 1/h is desingularised into a regularised auxiliary "
            "symbol and the reconstruction and Riemann solver are attached. The "
            "code printer then emits the AMReX header; the printer is syntax "
            "only, the equations were fixed two steps earlier."),
        "cards": ["card-swe", "card-solver-numpy"],
        "params": {},
    },
    {
        "dir": "bingham",
        "zip": "bingham-session.zip",
        "id": "session-bingham",
        "title": "Bingham roll-wave",
        "description": (
            "Liu & Mei (1994) Bingham roll wave, SME level 2 on one seeded "
            "wavelength, NumPy. time_end is the dimensionless t': the default "
            "2 is a short march the browser finishes in minutes; the thesis "
            "benchmark runs to t' = 200 (hours, run it natively). The last "
            "cell draws the initial and the final depth and mean velocity."),
        "cards": ["card-sme", "card-mesh-create-1d", "card-solver-numpy", "card-vis-empty-mpl"],
        "params": {"time_end": 2.0},
    },
]


def build(sess):
    src = os.path.join(CASES, sess["dir"])
    code = {}
    for cid in sess["cards"]:
        _tab, _title, fname = CARDS[cid]
        with open(os.path.join(src, fname)) as f:
            code[cid] = strip(f.read())
        compile(code[cid], f"{sess['dir']}/{fname}", "exec")
    print(f"  compile OK: {sess['dir']}",
          {CARDS[c][2]: len(s) for c, s in code.items()})

    overrides = {cid: {"code": code[cid]} for cid in sess["cards"]}
    if sess["params"]:
        overrides["card-solver-numpy"]["params"] = sess["params"]

    session = {
        "id": sess["id"],
        "title": sess["title"],
        "description": sess["description"],
        "selections": {CARDS[cid][0]: cid for cid in sess["cards"]},
        "cardOverrides": overrides,
    }
    meta = {"version": "1.1", "sessions": [session],
            "activeSession": sess["id"]}

    path = os.path.join(OUT, sess["zip"])
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("project.json", json.dumps(meta, indent=2))
        for cid in sess["cards"]:
            tab, title, _f = CARDS[cid]
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
