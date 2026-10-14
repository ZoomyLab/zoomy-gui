"""Build gui/projects/coupling-live-session.zip and coupling-triple-live-session.zip — the
SME | VOF coupling as LIVE sessions on the symbolic solvers.

The session runs on the OpenFOAM backend (its solver card): that backend marches the VOF
tank and submits the reduced SME arm(s) to the JAX backend, where they march
`SymbolicHyperbolicSolverJax` as preCICE participants; the participants meet in a directory
both backends see (`zoomy_server.peers`). The cards are `symsolver/coupling_live_*.py`;
the two sessions differ in their arms (`ARMS`, the model cell) and the function object's
settings (`FO`, the run cell):

  pair    one arm, the dam on it; the star-state imposition (the production path of the
          Fr* = 0.752 configuration)
  triple  a second arm right of the tank; the flux-only imposition without the vertical
          velocity (with the star state the zoomyFoam participants of the old session lost
          the tank at the outflow seam, t ~ 1.25 s)

Both run the Fr* = 0.752 dam break (h 0.18 | 0.04 m) to t = 2.5 s: past t ~ 2.5 s, the
return of the tank's reflection, the run amplifies a 1e-9 perturbation of the dam height
by ~1e6 by t = 3.6 s and the tank's step collapses (the old zoomyFoam pair as well).
"""
import json
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.join(HERE, os.pardir)
CARDS = os.path.join(HERE, "symsolver")
PARAMS = {"time_end": 2.5, "cfl": 0.45}

SESSIONS = [
    dict(zip="coupling-live-session.zip", id="session-coupling-live",
         title="SME-VOF coupling (live)",
         description=("LIVE two-way SME(1) | VOF preCICE run at Fr* = 0.752 (h 0.18 -> 0.04 m): "
                      "the VOF tank on the OpenFOAM backend, the SME arm on the JAX backend "
                      "(both connected). ~1 min, plus ~35 s for the first compile."),
         arms='ARMS = {"Swe": ((-0.6, 0.0), "right", X_DAM)}',
         fo="FO = {}"),
    dict(zip="coupling-triple-live-session.zip", id="session-coupling-triple-live",
         title="SME-VOF coupling (triple, live)",
         description=("LIVE three-participant SME | VOF | SME preCICE run at Fr* = 0.752: the "
                      "VOF tank on the OpenFOAM backend, both SME arms on the JAX backend "
                      "(both connected). ~1 min, plus ~35 s for the first compile."),
         arms=('ARMS = {"Swe": ((-0.6, 0.0), "right", X_DAM),\n'
               '        "Swe2": ((1.5, 2.1), "left", None)}'),
         fo='FO = {"imposeMode": "fluxonly", "imposeVertical": "no"}'),
]
TABS = {"card-sme": ("model", "Shallow Moments (SME)", "coupling_live_model.py"),
        "card-mesh-create-2d": ("mesh", "Create 2D", "coupling_live_mesh.py"),
        "card-solver-foam": ("solver", "Coupled (Foam+preCICE)", "coupling_live_run.py"),
        "card-vis-empty-mpl": ("visualization", "Empty (Matplotlib)", "coupling_live_viz.py")}


def card(path, s):
    """The card code with the session's `ARMS` / `FO`."""
    code = open(os.path.join(CARDS, path)).read()
    for marker, line in (("# packer: ARMS", s["arms"]), ("# packer: FO", s["fo"])):
        lines = code.split("\n")
        hit = [i for i, ln in enumerate(lines) if ln.endswith(marker)]
        if hit:
            lines[hit[0]] = line + "  " + marker
            code = "\n".join(lines)
    compile(code, path, "exec")
    return code


for s in SESSIONS:
    codes = {cid: card(f, s) for cid, (_, _, f) in TABS.items()}
    sess = {"id": s["id"], "title": s["title"], "description": s["description"],
            "selections": {"model": "card-sme", "mesh": "card-mesh-create-2d",
                           "solver": "card-solver-foam",
                           "visualization": "card-vis-empty-mpl"},
            "cardOverrides": {cid: ({"code": c, "params": dict(PARAMS)}
                                    if cid == "card-solver-foam" else {"code": c})
                              for cid, c in codes.items()}}
    meta = {"version": "1.1", "sessions": [sess], "activeSession": s["id"]}
    out = os.path.join(PROJECTS, s["zip"])
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("project.json", json.dumps(meta, indent=2))
        for cid, (tab, title, _) in TABS.items():
            base = f"{s['title']}/{tab}/{title}/"
            cj = {"id": cid, "title": title, "description": "",
                  "params": sess["cardOverrides"][cid].get("params", {}),
                  "tab": tab, "subtab": ""}
            z.writestr(base + "card.json", json.dumps(cj, indent=2))
            z.writestr(base + "code.py", codes[cid])
    print("->", out, os.path.getsize(out), "bytes")
