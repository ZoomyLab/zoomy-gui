"""Build gui/projects/bingham-threshold-session.zip — the Bingham MEASURED
linear-threshold sweep sub-case (thesis/cases/bingham/threshold) as a
self-contained GUI session (packaging-level; case files on disk stay untouched).

The threshold case is a numpy transient study that runs its OWN sweep: run.py
marches the seeded long-wave film for THREE betas (3 / 6.35 / 12 at alpha=0.5),
fits transit-window growth rates, and writes ``output/bingham_threshold.npz``
(per-beta amplitude series) + a server-facing ``output/bingham_threshold.h5``
(the most-unstable run's snapshots).  visualize.py renders the two-panel measured
threshold figure ``output/fig_bingham_threshold_measured.png`` FROM THE NPZ.

NO siblings to inline — the case builds the CORE ``Bingham`` closure directly
(``SystemModel.from_model``, REQ-143).  GUI knobs: ``time_end`` maps to
``run.t_end_prime`` which here is the PHYSICAL end time in SECONDS (the sweep
spans three tscales, so a shared physical window is required — see the case
run.py docstring); ``output_snapshots`` maps to ``run.snapshots`` (frame count).
The FULL sweep is ~100 min (numpy); the GUI ships time_end=100 s as the default.

Because visualize.py reads the NPZ (produced by run.py), the e2e harness runs
this session LOCALLY (run.py then visualize.py, small t_end) — see
tests/e2e/run_sessions.mjs (localOnly); run.py also copies the server h5 to
simulation.h5 so the compose viz prelude's read_hdf5 succeeds.
"""
import json, os, pprint, re, tempfile, zipfile

ROOT = os.path.expanduser("~/git/Zoomy")
CASE = os.path.join(ROOT, "thesis/cases/bingham/threshold")
ZIP = os.path.join(ROOT, "library/zoomy_gui/projects/bingham-threshold-session.zip")

read = lambda f: open(os.path.join(CASE, f)).read()
strip_future = lambda s: re.sub(r"^from __future__ import.*\n", "", s, flags=re.M)
FILE_GUARD = ('(os.path.dirname(os.path.abspath(__file__))\n'
              '             if "__file__" in globals() else os.getcwd())')
guard_file = lambda s: s.replace(
    "os.path.dirname(os.path.abspath(__file__))", FILE_GUARD)

settings_json = json.loads(read("settings.json"))

# ---------------- model card (no siblings; core Bingham) ----------------
model_card = guard_file(strip_future(read("model.py"))).strip() + "\n"

# ---------------- mesh card ----------------
mesh_card = guard_file(strip_future(read("mesh.py"))).strip() + "\n"

# ---------------- solver card (run section) ----------------
run_src = strip_future(read("run.py"))
sib_run = "from mesh import build_mesh\nfrom model import build_model, liu_mei_beta_c"
assert sib_run in run_src
run_src = run_src.replace(sib_run, '''# Case modules: defined by the Model/Mesh cells in notebook form;
# imported from the sibling files in a materialized case folder.
try:
    build_mesh, build_model, liu_mei_beta_c  # noqa: B018  (probe the notebook namespace)
except NameError:
    from mesh import build_mesh
    from model import build_model, liu_mei_beta_c''')
run_src = guard_file(run_src)
old_load = '''def load_settings(path=None):
    with open(path or os.path.join(CASE_DIR, "settings.json")) as f:
        return json.load(f)'''
assert old_load in run_src
new_load = '''#: Full sweep settings (the case's settings.json), used whenever the sibling
#: settings.json is absent (notebook) or GUI-generic (no "sweep" key).
_CASE_SETTINGS = ''' + pprint.pformat(settings_json, width=78, sort_dicts=False) + '''


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
    return s'''
run_src = run_src.replace(old_load, new_load)
old_main = 'if __name__ == "__main__":\n    run()'
assert old_main in run_src
run_src = run_src.replace(old_main, '''_npz = run()
import shutil

# run.py writes a server-facing store output/<name>.h5; copy it to the standard
# artifact name so the compose viz prelude's read_hdf5 succeeds (the figure
# itself is recomputed from the .npz by visualize.py).
shutil.copy(_npz[:-4] + ".h5", "simulation.h5")
print("artifact -> simulation.h5")''')
run_card = run_src.strip() + "\n"

# ---------------- viz card ----------------
viz = strip_future(read("visualize.py"))
viz = guard_file(viz)
viz_main = '''if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(CASE_DIR, "output"))
    visualize(ap.parse_args().src)'''
assert viz_main in viz
viz = viz.replace(viz_main, "visualize()")
viz_card = viz.strip() + "\n"

# ---------------- verify: compile + standalone exec of model/mesh ----------------
for name, code in [("model", model_card), ("mesh", mesh_card),
                   ("run", run_card), ("viz", viz_card)]:
    compile(code, name + "_card", "exec")
print("T0 compile: all 4 cards OK",
      {n: len(c) for n, c in [("model", model_card), ("mesh", mesh_card),
                              ("run", run_card), ("viz", viz_card)]})

g = {}
_cwd = os.getcwd()
with tempfile.TemporaryDirectory() as _td:
    os.chdir(_td)
    try:
        exec(compile(model_card, "model_card", "exec"), g)
        exec(compile(mesh_card, "mesh_card", "exec"), g)
    finally:
        os.chdir(_cwd)
assert "build_model" in g and "liu_mei_beta_c" in g and "build_mesh" in g and "scales" in g
print("T1 model+mesh cards standalone exec: OK "
      "(build_model, liu_mei_beta_c, build_mesh, scales defined)")

# ---------------- write the zip ----------------
TITLE = "Bingham (threshold)"
sess = {
    "id": "session-bingham-threshold",
    "title": TITLE,
    "description": ("Measured linear-threshold sweep — run.py does the 3 "
                    "beta-solves itself (STABLE/MARGINAL/UNSTABLE at alpha=0.5); "
                    "~100 min full sweep (numpy). time_end is PHYSICAL seconds."),
    "selections": {"model": "card-sme", "mesh": "card-mesh-create-1d",
                   "solver": "card-solver-numpy", "visualization": "card-vis-empty-mpl"},
    "cardOverrides": {
        "card-sme": {"code": model_card},
        "card-mesh-create-1d": {"code": mesh_card},
        "card-solver-numpy": {"code": run_card,
                              "params": {"time_end": settings_json["run"]["t_end_prime"]}},
        "card-vis-empty-mpl": {"code": viz_card},
    },
}
meta = {"version": "1.1", "sessions": [sess],
        "activeSession": "session-bingham-threshold"}
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

out = os.environ.get("CARD_OUT", "/tmp")
for name, code in [("model", model_card), ("mesh", mesh_card),
                   ("run", run_card), ("viz", viz_card)]:
    open(os.path.join(out, f"bt_card_{name}.py"), "w").write(code)
print("cards ->", out)
