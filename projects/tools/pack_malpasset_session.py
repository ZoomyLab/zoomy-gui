"""Build gui/projects/malpasset-session.zip — self-contained cards from
thesis/cases/malpasset_jax (packaging-level inlining; case files untouched).

model card = sme_malpasset_model.py inlined into model.py
mesh  card = mesh.py + catalog download fallback (geo_malpasset-small.msh)
run   card (solver-jax code) = run.py + guarded imports + _CASE_SETTINGS +
            GUI time_end knob -> run.t_end [s] + simulation.h5 copy
viz   card = deliverable.py (plot layer) inlined into visualize.py
"""
import json, os, pprint, re, zipfile

ROOT = os.path.expanduser("~/git/Zoomy")
CASE = os.path.join(ROOT, "thesis/cases/malpasset_jax")
ZIP = os.path.join(ROOT, "library/zoomy_gui/projects/malpasset-session.zip")

read = lambda f: open(os.path.join(CASE, f)).read()
strip_future = lambda s: re.sub(r"^from __future__ import.*\n", "", s, flags=re.M)
FILE_GUARD = ('(os.path.dirname(os.path.abspath(__file__))\n'
              '            if "__file__" in globals() else os.getcwd())')
guard_file = lambda s: s.replace(
    "os.path.dirname(os.path.abspath(__file__))", FILE_GUARD)

# ---------------- model card ----------------
smm = strip_future(read("sme_malpasset_model.py")).strip()
model = strip_future(read("model.py"))
sib = '''from sme_malpasset_model import (
    MalpassetSME, malpasset_closures, malpasset_elder_closures,
    MALPASSET_ELDER_PARAMS)'''
assert sib in model
anchor = "# sme_malpasset_model: inlined below (GUI card is self-contained)"
model = model.replace(sib, anchor)
model = model.replace(
    anchor,
    anchor + "\n\n# --- inlined case module: sme_malpasset_model.py " + "-" * 16 + "\n"
    + smm + "\n# " + "-" * 66)
model_card = guard_file(model).strip() + "\n"

# ---------------- mesh card ----------------
mesh = strip_future(read("mesh.py"))
old_load_mesh = 'return LSQMesh.from_msh(os.path.join(case_dir, settings["mesh"]))'
assert old_load_mesh in mesh
mesh = mesh.replace(old_load_mesh,
                    'return LSQMesh.from_msh(_ensure_mesh(settings["mesh"], case_dir))')
mesh = mesh.replace('def build_mesh(settings, case_dir=None):', '''\
MESH_CATALOG = "https://zoomylab.github.io/meshes/meshes/"


def _ensure_mesh(fname, case_dir=None):
    """Case-shipped mesh if present, else fetch from the deployed catalog."""
    p = os.path.join(case_dir or CASE_DIR, fname)
    if not os.path.exists(p):
        import urllib.request
        print("mesh not found locally; fetching", MESH_CATALOG + fname, flush=True)
        urllib.request.urlretrieve(MESH_CATALOG + fname, p)
    return p


def build_mesh(settings, case_dir=None):''')
mesh_card = guard_file(mesh).strip() + "\n"

# ---------------- run card ----------------
settings_json = json.loads(read("settings.json"))
run_src = strip_future(read("run.py"))
sib_run = "from mesh import build_mesh\nfrom model import build_model"
assert sib_run in run_src
run_src = run_src.replace(sib_run, '''\
# Case modules: defined by the Model/Mesh cells in notebook form;
# imported from the sibling files in a materialized case folder.
try:
    build_mesh, build_model  # noqa: B018  (probe the notebook namespace)
except NameError:
    from mesh import build_mesh
    from model import build_model''')
run_src = guard_file(run_src)
old_load = '''def load_settings(path=None):
    with open(path or os.path.join(CASE_DIR, "settings.json")) as f:
        return json.load(f)'''
new_load = '''#: Full benchmark settings (the canonical case's settings.json), used whenever
#: the sibling settings.json is absent (notebook) or GUI-generic (no "numerics").
_CASE_SETTINGS = ''' + pprint.pformat(settings_json, width=78, sort_dicts=False) + '''


def load_settings(path=None):
    p = path or os.path.join(CASE_DIR, "settings.json")
    s = json.load(open(p)) if os.path.exists(p) else {}
    if "numerics" not in s:                       # GUI-generic or missing
        gui = s or (globals().get("settings")
                    if isinstance(globals().get("settings"), dict) else None) or {}
        s = json.loads(json.dumps(_CASE_SETTINGS))
        if gui.get("time_end") is not None:       # GUI knob = t_end [s]
            s["run"] = dict(s["run"], t_end=float(gui["time_end"]))
    return s'''
assert old_load in run_src
run_src = run_src.replace(old_load, new_load)
old_main = 'if __name__ == "__main__":\n    run()'
assert old_main in run_src
run_src = run_src.replace(old_main, '''_h5 = run()
import shutil

shutil.copy(_h5, "simulation.h5")   # standard artifact name (viz prelude / postproc)
print("artifact -> simulation.h5")''')
run_card = run_src.strip() + "\n"

# ---------------- viz card ----------------
dlv = strip_future(read("deliverable.py"))
cut = dlv.index("def main():")
dlv = dlv[:cut].rstrip()
viz = strip_future(read("visualize.py"))
viz_read = '''    if settings is None:
        with open(os.path.join(CASE_DIR, "settings.json")) as f:
            settings = json.load(f)'''
assert viz_read in viz
viz = viz.replace(viz_read, "    if settings is None:\n        settings = load_settings()")
assert "    import deliverable\n" in viz
viz = viz.replace("    import deliverable\n", "")
viz = viz.replace("deliverable.render_gif(", "render_gif(")
anchor_viz = "def visualize(settings=None, fps=10):"
assert anchor_viz in viz
viz = viz.replace(anchor_viz, new_load + "\n\n\n"
                  + "# --- inlined case module: deliverable.py (plot layer) " + "-" * 12 + "\n"
                  + dlv + "\n# " + "-" * 66 + "\n\n\n" + anchor_viz)
old_viz_main = 'if __name__ == "__main__":\n    visualize()'
assert old_viz_main in viz
viz = viz.replace(old_viz_main, "visualize()")
viz_card = guard_file(viz).strip() + "\n"

# ---------------- verify compile + model exec ----------------
for name, code in [("model", model_card), ("mesh", mesh_card),
                   ("run", run_card), ("viz", viz_card)]:
    compile(code, name + "_card", "exec")
print("T0 compile: all 4 cards OK",
      {n: len(c) for n, c in [("model", model_card), ("mesh", mesh_card),
                              ("run", run_card), ("viz", viz_card)]})
g = {}
exec(model_card, g)
assert "build_model" in g and "MalpassetSME" in g and "MeshDataIC" in g
print("T1 model card standalone exec: OK")

# ---------------- write the zip ----------------
TITLE = "Malpasset dam break"
sess = {
    "id": "session-malpasset",
    "title": TITLE,
    "description": ("Malpasset dam break, SME level 1 — needs a jax backend. "
                    "time_end 2000 s = full run."),
    "selections": {"model": "card-sme", "mesh": "card-mesh-create-2d",
                   "solver": "card-solver-jax", "visualization": "card-vis-empty-mpl"},
    "cardOverrides": {
        "card-sme": {"code": model_card},
        "card-mesh-create-2d": {"code": mesh_card},
        "card-solver-jax": {"code": run_card,
                            "params": {"time_end": settings_json["run"]["t_end"]}},
        "card-vis-empty-mpl": {"code": viz_card},
    },
}
meta = {"version": "1.1", "sessions": [sess], "activeSession": "session-malpasset"}
titles = {"card-sme": ("model", "Shallow Moments (SME)"),
          "card-mesh-create-2d": ("mesh", "Create 2D"),
          "card-solver-jax": ("solver", "JAX Solver"),
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
for n, c in [("model", model_card), ("mesh", mesh_card), ("run", run_card), ("viz", viz_card)]:
    open(os.path.join(out, f"mp_card_{n}.py"), "w").write(c)
print("cards ->", out)
