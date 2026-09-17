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

# card id -> (tab, title). The ids are the catalog ids with the `card-` prefix,
# which is what the GUI resolves a selection against; a session lists only the
# cards its notebook has (a symbolic pipeline has no mesh, no solver and no
# field to plot; the GUI composes no section for a card that is not there).
CARDS = {
    "card-swe":            ("model",         "Shallow Water (SWE)"),
    "card-sme":            ("model",         "Shallow Moments (SME)"),
    "card-mesh-create-1d": ("mesh",          "Create 1D"),
    "card-solver-numpy":   ("solver",        "NumPy Solver"),
    "card-vis-empty-mpl":  ("visualization", "Empty (Matplotlib)"),
}

# The three Zoomy-pipeline sessions share ONE derivation of the shallow water
# equations (derivation/model.py) and differ in the steps that follow it;
# each step is a named notebook section ("System model", ...).
DERIVATION = "derivation/model.py"

SESSIONS = [
    {
        "zip": "zoomy-derivation-session.zip",
        "id": "session-zoomy-derivation",
        "title": "Deriving the shallow water equations",
        "description": (
            "The shallow water equations derived from the general mass and "
            "momentum balance, one operation at a time, then frozen into a "
            "system model and displayed."),
        "cards": {"card-swe": DERIVATION},
        "steps": [("System model", "derivation/system_model.py")],
        "params": {},
    },
    {
        "zip": "zoomy-systemmodel-session.zip",
        "id": "session-zoomy-systemmodel",
        "title": "System model and dispersion relation",
        "description": (
            "The derived shallow water equations frozen into a system model "
            "and displayed, then the dispersion relation of the system from "
            "the analysis tools: omega = k (u_0 +- sqrt(g h_0)), so the phase "
            "speed does not depend on the wavenumber."),
        "cards": {"card-swe": DERIVATION},
        "steps": [("System model", "systemmodel/system_model.py"),
                  ("Dispersion relation", "systemmodel/dispersion.py")],
        "params": {},
    },
    {
        "zip": "zoomy-codeprinter-session.zip",
        "id": "session-zoomy-codeprinter",
        "title": "Numerical system model and AMReX code",
        "description": (
            "The derived shallow water equations frozen into a system model, "
            "handed to the numerical system model (1/h desingularised, "
            "reconstruction and Riemann solver attached) and displayed, printed "
            "as an AMReX header, and solved as a 2:1 dam break on 200 cells."),
        "cards": {"card-swe": DERIVATION,
                  "card-mesh-create-1d": "codeprinter/mesh.py",
                  "card-solver-numpy": "codeprinter/run.py",
                  "card-vis-empty-mpl": "codeprinter/visualize.py"},
        "steps": [("System model", "codeprinter/system_model.py"),
                  ("Numerical system model", "codeprinter/numerical_system_model.py"),
                  ("Code", "codeprinter/code.py")],
        "params": {"time_end": 0.5},
    },
    {
        "zip": "bingham-session.zip",
        "id": "session-bingham",
        "title": "Bingham roll-wave",
        "description": (
            "Roll waves of a Bingham film on an incline, against Liu & Mei (1994), "
            "*Roll waves on a layer of a muddy fluid flowing down a gentle "
            "slope — a Bingham model*, Phys. Fluids 6, 2577–2590. "
            "SME(2) with the Bingham closure "
            "τ_xz = (ρ ν + τ_y / √((∂_z u)² + ε²)) ∂_z u, "
            "Navier slip at the bed and a stress-free surface."),
        "cards": {"card-sme": "bingham/model.py",
                  "card-mesh-create-1d": "bingham/mesh.py",
                  "card-solver-numpy": "bingham/run.py",
                  "card-vis-empty-mpl": "bingham/visualize.py"},
        "steps": [],
        "params": {"time_end": 2.0},
    },
]


def read(rel):
    with open(os.path.join(CASES, rel)) as f:
        code = strip(f.read())
    compile(code, rel, "exec")
    return code


def build(sess):
    code = {cid: read(rel) for cid, rel in sess["cards"].items()}
    steps = [{"title": title, "code": read(rel)} for title, rel in sess["steps"]]
    print(f"  compile OK: {sess['zip']}",
          {rel: len(code[cid]) for cid, rel in sess["cards"].items()},
          [(t, len(st["code"])) for (t, _r), st in zip(sess["steps"], steps)])

    overrides = {cid: {"code": code[cid]} for cid in sess["cards"]}
    if sess["params"]:
        overrides["card-solver-numpy"]["params"] = sess["params"]

    session = {
        "id": sess["id"],
        "title": sess["title"],
        "description": sess["description"],
        "selections": {CARDS[cid][0]: cid for cid in sess["cards"]},
        "cardOverrides": overrides,
        "steps": steps,
    }
    meta = {"version": "1.1", "sessions": [session],
            "activeSession": sess["id"]}

    path = os.path.join(OUT, sess["zip"])
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("project.json", json.dumps(meta, indent=2))
        for cid in sess["cards"]:
            tab, title = CARDS[cid]
            base = f"{sess['title']}/{tab}/{title}/"
            z.writestr(base + "card.json", json.dumps(
                {"id": cid, "title": title, "description": "",
                 "params": overrides[cid].get("params", {}),
                 "tab": tab, "subtab": ""}, indent=2))
            z.writestr(base + "code.py", code[cid])
        for i, st in enumerate(steps):
            z.writestr(f"{sess['title']}/step/{i + 1:02d} {st['title']}/code.py", st["code"])
    print(f"  wrote {path} ({os.path.getsize(path)} bytes)")


if __name__ == "__main__":
    for s in SESSIONS:
        build(s)
    print("done")
