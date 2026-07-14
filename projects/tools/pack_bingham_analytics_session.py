"""Build gui/projects/bingham-analytics-session.zip — the Bingham/HB
linear-stability ANALYTICS sub-case (REQ-150) as a SELF-CONTAINED GUI session
(packaging-level; case files on disk stay untouched).

The analytics case (thesis/cases/bingham/analytics) is analysis-only — NO
time-stepping: run.py computes the Liu&Mei beta_c(alpha) threshold bracket and
the SME(N)+Herschel-Bulkley linear dispersion (Re_c, cutoff), writing two small
.npz stores; visualize.py plots the threshold + dispersion figures from them.

model.py / run.py / visualize.py all import the sibling engines
``hb_dispersion`` (which itself imports ``hb_closure`` + ``hb_visc_analytic``),
used module-qualified as ``HB.compute`` / ``HB.RE`` / … .  ``to_folder`` only
materializes model/mesh/run/visualize.py + settings.json — no extra modules — so
each card that needs them carries a BOOT preamble that re-materializes the three
sibling .py files next to the card and puts the dir on ``sys.path``; then the
case's own ``import hb_dispersion as HB`` resolves unchanged in BOTH forms
(notebook: one scratch dir; folder: python run.py / visualize.py).  This is the
same "GUI card format has no sibling-module slot" stopgap the transient packer
documents — but re-materialized as files, because the ``HB.`` module-qualified
use across three files rules out inlining bare definitions.

Analysis-only ⇒ NO simulation.h5 (the case writes .npz, not an FVM field store).
The e2e harness therefore runs this session LOCALLY (run.py then visualize.py),
NOT the server h5-download flow — see tests/e2e/run_sessions.mjs (localOnly).
"""
import json, os, pprint, re, tempfile, zipfile
import sys as _sys

ROOT = os.path.expanduser("~/git/Zoomy")
CASE = os.path.join(ROOT, "thesis/cases/bingham/analytics")
ZIP = os.path.join(ROOT, "library/zoomy_gui/projects/bingham-analytics-session.zip")

read = lambda f: open(os.path.join(CASE, f)).read()
strip_future = lambda s: re.sub(r"^from __future__ import.*\n", "", s, flags=re.M)
FILE_GUARD = ('(os.path.dirname(os.path.abspath(__file__))\n'
              '             if "__file__" in globals() else os.getcwd())')
guard_file = lambda s: s.replace(
    "os.path.dirname(os.path.abspath(__file__))", FILE_GUARD)

# ---------------- sibling engines (materialized at card runtime) ----------------
# hb_dispersion imports hb_closure + hb_visc_analytic; write all three.  repr()
# embeds each source as a single-line literal (\n-escaped) so the percent-format
# round-trip through composeCase/to_folder cannot mangle them.
SIB_NAMES = ("hb_closure", "hb_visc_analytic", "hb_dispersion")
SIBS = {n: strip_future(read(n + ".py")) for n in SIB_NAMES}
BOOT = (
    "import os\n"
    "import sys\n"
    "\n"
    "_CASE_DIR = " + FILE_GUARD + "\n"
    "# Re-materialize the case sibling engines next to this card so\n"
    "# ``import hb_dispersion`` resolves in BOTH the notebook (one scratch dir)\n"
    "# and the folder form (python run.py / visualize.py).  The GUI card format\n"
    "# has no sibling-module slot; these three modules are used module-qualified\n"
    "# (HB.compute / HB.RE / …) across model/run/visualize, so they are shipped\n"
    "# as files rather than inlined bare definitions.\n"
    "_SIBS = {\n"
    + "".join(f"    {n!r}: {SIBS[n]!r},\n" for n in SIB_NAMES)
    + "}\n"
    "for _n, _s in _SIBS.items():\n"
    "    _p = os.path.join(_CASE_DIR, _n + \".py\")\n"
    "    if not os.path.exists(_p):\n"
    "        open(_p, \"w\").write(_s)\n"
    "if _CASE_DIR not in sys.path:\n"
    "    sys.path.insert(0, _CASE_DIR)\n"
)

# ---------------- shared settings fallback (marker = 'dispersion') --------------
settings_json = json.loads(read("settings.json"))
NEW_LOAD = '''#: Full analytics settings (the case's settings.json), used whenever the sibling
#: settings.json is absent (notebook) or GUI-generic (no "dispersion" key).
_CASE_SETTINGS = ''' + pprint.pformat(settings_json, width=78, sort_dicts=False) + '''


def load_settings(path=None):
    p = path or os.path.join(CASE_DIR, "settings.json")
    s = json.load(open(p)) if os.path.exists(p) else {}
    if "dispersion" not in s:                     # GUI-generic or missing
        s = json.loads(json.dumps(_CASE_SETTINGS))
    return s'''

# ---------------- model card ----------------
model_card = BOOT + "\n\n" + guard_file(strip_future(read("model.py"))).strip() + "\n"

# ---------------- mesh card (stub build_mesh -> None; no siblings) ----------------
mesh_card = strip_future(read("mesh.py")).strip() + "\n"

# ---------------- solver card (run section) ----------------
run_src = strip_future(read("run.py"))
sib_run = "from model import build_model, liu_mei_beta_c"
assert sib_run in run_src
run_src = run_src.replace(sib_run, '''# Case module: defined by the Model cell in notebook form; imported from the
# sibling model.py in a materialized case folder.
try:
    build_model, liu_mei_beta_c  # noqa: B018  (probe the notebook namespace)
except NameError:
    from model import build_model, liu_mei_beta_c''')
old_load = '''def load_settings(path=None):
    with open(path or os.path.join(CASE_DIR, "settings.json")) as f:
        return json.load(f)'''
assert old_load in run_src
run_src = run_src.replace(old_load, NEW_LOAD)
old_main = 'if __name__ == "__main__":\n    run()'
assert old_main in run_src
run_src = run_src.replace(old_main, '''_p = run()

# Analysis-only case: run.py writes .npz analytics stores (dispersion +
# threshold), NOT a time-stepped FVM field store.  But the GUI/compose
# visualization prelude (zoomy_cli.vizPrelude) UNCONDITIONALLY opens
# ``simulation.h5``, so write a MINIMAL but genuine zoomy store here: a tiny
# line mesh whose single field carries the Liu&Mei threshold ``beta_c`` (read
# back from the summary .npz).  This satisfies the prelude's read_hdf5; the REAL
# figures are recomputed from the .npz stores by visualize.py.  The GUI ships
# this session as a LOCAL run (run.py then visualize.py) — the store stays local,
# NOT the server h5-download flow.
import numpy as _np
from zoomy_core.mesh import BaseMesh as _BaseMesh
from zoomy_core.misc import io as _io

_beta_c = float(dict(_np.load(_p, allow_pickle=True))["beta_c"])
_h5 = os.path.abspath("simulation.h5")
_mesh = _BaseMesh.create_1d(domain=(0.0, 1.0), n_inner_cells=8)   # >3 vertices: reader-orientable
_io.write_mesh_to_hdf5(_h5, _mesh)
_io._save_fields_to_hdf5(_h5, 0, 0.0, _np.full((1, _mesh.n_cells), _beta_c))
print("analytics stores ->", _p, "(+ output/hb_dispersion.npz)")
print("minimal store -> simulation.h5  (beta_c=%.3f as a constant field; the "
      "compose viz prelude needs it — figures come from the .npz)" % _beta_c)''')
run_card = BOOT + "\n\n" + guard_file(run_src).strip() + "\n"

# ---------------- viz card ----------------
viz = strip_future(read("visualize.py"))
viz_read = '''    if settings is None:
        with open(os.path.join(CASE_DIR, "settings.json")) as f:
            settings = json.load(f)'''
assert viz_read in viz
viz = viz.replace(viz_read, "    if settings is None:\n        settings = load_settings()")
anchor_viz = 'OUT = os.path.join(CASE_DIR, "output")'
assert anchor_viz in viz
viz = viz.replace(anchor_viz, anchor_viz + "\n\n" + NEW_LOAD, 1)
viz_main = 'if __name__ == "__main__":\n    visualize()'
assert viz_main in viz
viz = viz.replace(viz_main, "visualize()")
viz_card = BOOT + "\n\n" + guard_file(viz).strip() + "\n"

# ---------------- verify: compile + model-card standalone exec ----------------
for name, code in [("model", model_card), ("mesh", mesh_card),
                   ("run", run_card), ("viz", viz_card)]:
    compile(code, name + "_card", "exec")
print("T0 compile: all 4 cards OK",
      {n: len(c) for n, c in [("model", model_card), ("mesh", mesh_card),
                              ("run", run_card), ("viz", viz_card)]})

g = {}
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as _td:      # exec pollutes cwd (writes hb_*.py) -> isolate
    os.chdir(_td)
    try:
        exec(compile(model_card, "model_card", "exec"), g)
    finally:
        os.chdir(_cwd)
assert "build_model" in g and "liu_mei_beta_c" in g and "scales" in g and "HB" in g
assert "hb_dispersion" in _sys.modules, "BOOT must materialize + import hb_dispersion"
print("T1 model card standalone exec: OK "
      "(build_model, liu_mei_beta_c, scales, HB defined; siblings materialized)")

# ---------------- write the zip ----------------
TITLE = "Bingham (analytics)"
sess = {
    "id": "session-bingham-analytics",
    "title": TITLE,
    "description": ("Linear-stability analytics: Re_c, cutoff, threshold "
                    "bracket — seconds, no time-stepping (numpy)."),
    "selections": {"model": "card-sme", "mesh": "card-mesh-create-1d",
                   "solver": "card-solver-numpy", "visualization": "card-vis-empty-mpl"},
    "cardOverrides": {
        "card-sme": {"code": model_card},
        "card-mesh-create-1d": {"code": mesh_card},
        "card-solver-numpy": {"code": run_card, "params": {}},
        "card-vis-empty-mpl": {"code": viz_card},
    },
}
meta = {"version": "1.1", "sessions": [sess],
        "activeSession": "session-bingham-analytics"}
titles = {"card-sme": ("model", "Shallow Moments (SME)"),
          "card-mesh-create-1d": ("mesh", "Create 1D"),
          "card-solver-numpy": ("solver", "NumPy Solver"),
          "card-vis-empty-mpl": ("visualization", "Empty (Matplotlib)")}
with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("project.json", json.dumps(meta, indent=2))
    for cid, (tab, title) in titles.items():
        base = f"{TITLE}/{tab}/{title}/"
        cj = {"id": cid, "title": title, "description": "",
              "params": sess["cardOverrides"][cid].get("params", {}),
              "tab": tab, "subtab": ""}
        z.writestr(base + "card.json", json.dumps(cj, indent=2))
        z.writestr(base + "code.py", sess["cardOverrides"][cid]["code"])
print("zip written:", ZIP, os.path.getsize(ZIP), "bytes")

# stash card codes for the runtime tests
out = os.environ.get("CARD_OUT", "/tmp")
for name, code in [("model", model_card), ("mesh", mesh_card),
                   ("run", run_card), ("viz", viz_card)]:
    open(os.path.join(out, f"ba_card_{name}.py"), "w").write(code)
print("cards ->", out)
