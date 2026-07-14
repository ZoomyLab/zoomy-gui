"""Add the 'Malpasset (AMReX)' session to gui/projects/malpasset-session.zip
(second session, same zip — one Malpasset artifact, two backends)."""
import json, os, pprint, re, zipfile

ROOT = os.path.expanduser("~/git/Zoomy")
CASE = os.path.join(ROOT, "thesis/cases/malpasset_amrex")
ZIP = os.path.join(ROOT, "library/zoomy_gui/projects/malpasset-session.zip")

_read = lambda f: open(os.path.join(CASE, f)).read()
strip_future = lambda s: re.sub(r"^from __future__ import.*\n", "", s, flags=re.M)
read = lambda f: re.sub(r"^#!.*\n", "", strip_future(_read(f)), count=1)
FILE_GUARD = ('(os.path.dirname(os.path.abspath(__file__))\n'
              '            if "__file__" in globals() else os.getcwd())')
guard_file = lambda s: s.replace(
    "os.path.dirname(os.path.abspath(__file__))", FILE_GUARD)
settings_json = json.loads(_read("settings.json"))
SETTINGS_PY = pprint.pformat(settings_json, width=78, sort_dicts=False)

NEW_LOAD = '''#: Full benchmark settings (the canonical case's settings.json), used whenever
#: the sibling settings.json is absent (notebook) or GUI-generic (no "numerics").
_CASE_SETTINGS = ''' + SETTINGS_PY + '''


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

# ---------------- model card (no siblings) ----------------
model_card = read("model.py").strip() + "\n"

# ---------------- mesh card ----------------
mesh = read("mesh.py")
old = '''    case_dir = case_dir or CASE_DIR
    return os.path.join(case_dir, settings["mesh"])'''
assert old in mesh
mesh = mesh.replace(old, '''    case_dir = case_dir or CASE_DIR
    return _ensure_mesh(settings["mesh"], case_dir)''')
anchor = "def build_mesh(settings, case_dir=None):"
mesh = mesh.replace(anchor, '''MESH_CATALOG = "https://zoomylab.github.io/meshes/meshes/"


def _ensure_mesh(fname, case_dir=None):
    """Case-shipped mesh if present, else fetch from the deployed catalog."""
    p = os.path.join(case_dir or CASE_DIR, fname)
    if not os.path.exists(p):
        import urllib.request
        print("mesh not found locally; fetching", MESH_CATALOG + fname, flush=True)
        urllib.request.urlretrieve(MESH_CATALOG + fname, p)
    return p


''' + anchor)
mesh_card = guard_file(mesh).strip() + "\n"

# ---------------- run card ----------------
run_src = read("run.py")
old_load = '''def load_settings(path=None):
    with open(path or os.path.join(CASE_DIR, "settings.json")) as f:
        return json.load(f)'''
assert old_load in run_src
run_src = run_src.replace(old_load, NEW_LOAD)
old_sib = '''    from zoomy_amrex.solvers import HyperbolicSolver
    from mesh import build_mesh
    from model import build_model'''
assert old_sib in run_src
run_src = run_src.replace(old_sib, '''    from zoomy_amrex.solvers import HyperbolicSolver
    # Case modules: defined by the Model/Mesh cells in notebook form;
    # imported from the sibling files in a materialized case folder.
    try:
        build_mesh, build_model  # noqa: B018  (probe the notebook namespace)
    except NameError:
        from mesh import build_mesh
        from model import build_model''')
old_main = 'if __name__ == "__main__":\n    run()'
assert old_main in run_src
run_src = run_src.replace(old_main, "run()")
run_card = guard_file(run_src).strip() + "\n"

# ---------------- viz card ----------------
dlv = read("deliverable.py")
cut = dlv.index('if __name__ == "__main__":')
dlv = dlv[:cut].rstrip()
viz = read("visualize.py")
viz_read = '''    if settings is None:
        with open(os.path.join(CASE_DIR, "settings.json")) as f:
            settings = json.load(f)'''
assert viz_read in viz
viz = viz.replace(viz_read, "    if settings is None:\n        settings = load_settings()")
assert "    import deliverable\n" in viz
viz = viz.replace("    import deliverable\n", "")
viz = viz.replace("deliverable.render_png(", "render_png(")
viz = viz.replace("deliverable.render_gif(", "render_gif(")
anchor_viz = "def visualize(settings=None, fps=8):"
assert anchor_viz in viz
viz = viz.replace(anchor_viz, "import json\n\n" + NEW_LOAD + "\n\n\n"
                  + "# --- inlined case module: deliverable.py (plot layer) " + "-" * 12 + "\n"
                  + dlv + "\n# " + "-" * 66 + "\n\n\n" + anchor_viz)
old_viz_main = 'if __name__ == "__main__":\n    visualize()'
assert old_viz_main in viz
viz = viz.replace(old_viz_main, "visualize()")
viz_card = guard_file(viz).strip() + "\n"

for name, code in [("model", model_card), ("mesh", mesh_card),
                   ("run", run_card), ("viz", viz_card)]:
    compile(code, name + "_card", "exec")
print("T0 compile OK", {n: len(c) for n, c in [("model", model_card),
      ("mesh", mesh_card), ("run", run_card), ("viz", viz_card)]})

# ---------------- add session 2 to the zip ----------------
TITLE = "Malpasset (AMReX)"
sess = {
    "id": "session-malpasset-amrex",
    "title": TITLE,
    "description": ("Malpasset on AMReX (order-2 well-balanced SWE) — needs an "
                    "amrex backend. time_end 100 s = full deck."),
    "selections": {"model": "card-sme", "mesh": "card-mesh-create-2d",
                   "solver": "card-solver-amrex", "visualization": "card-vis-empty-mpl"},
    "cardOverrides": {
        "card-sme": {"code": model_card},
        "card-mesh-create-2d": {"code": mesh_card},
        "card-solver-amrex": {"code": run_card,
                              "params": {"time_end": settings_json["run"]["t_end"]}},
        "card-vis-empty-mpl": {"code": viz_card},
    },
}
with zipfile.ZipFile(ZIP) as z:
    items = {n: z.read(n) for n in z.namelist()}
meta = json.loads(items["project.json"])
meta["sessions"] = [s for s in meta["sessions"] if s["id"] != sess["id"]] + [sess]
items["project.json"] = json.dumps(meta, indent=2).encode()
titles = {"card-sme": ("model", "Shallow Moments (SME)"),
          "card-mesh-create-2d": ("mesh", "Create 2D"),
          "card-solver-amrex": ("solver", "AMReX Solver"),
          "card-vis-empty-mpl": ("visualization", "Empty (Matplotlib)")}
for cid, (tab, title) in titles.items():
    base = f"{TITLE}/{tab}/{title}/"
    cj = {"id": cid, "title": title, "description": "",
          "params": sess["cardOverrides"][cid].get("params", {}),
          "tab": tab, "subtab": ""}
    items[base + "card.json"] = json.dumps(cj, indent=2).encode()
    items[base + "code.py"] = sess["cardOverrides"][cid]["code"].encode()
with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as z:
    for n, b in items.items():
        z.writestr(n, b)
print("zip updated:", ZIP, os.path.getsize(ZIP), "bytes; sessions:",
      [s["title"] for s in meta["sessions"]])

out = os.environ.get("CARD_OUT", "/tmp")
for n, c in [("model", model_card), ("mesh", mesh_card), ("run", run_card), ("viz", viz_card)]:
    open(os.path.join(out, f"ma_card_{n}.py"), "w").write(c)
print("cards ->", out)
