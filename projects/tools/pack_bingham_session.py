"""Regenerate bingham-session.zip with SELF-CONTAINED card code (stopgap for
the missing sibling-module capability in the case format — case files on disk
stay untouched).

model card = hb_closure.py + wave_length + model.py (sibling imports inlined)
mesh  card = mesh.py
solver card CODE = run.py adapted: guarded sibling imports (notebook OR folder),
  __file__ guard, embedded _CASE_SETTINGS fallback, GUI time_end knob = t',
  unconditional run() + copy to simulation.h5 (standard artifact name)
viz   card = visualize.py (guarded `scales` import, __file__ guard)
solver card PARAMS = {"time_end": <t_end_prime>}  (default = full benchmark)
"""
import json, os, pprint, re, zipfile

ROOT = os.path.expanduser("~/git/Zoomy")
# REQ-150: the roll-wave case moved verbatim into the transient/ sub-case
# (analytics/ is the sibling linear-stability case, packed separately).
CASE = os.path.join(ROOT, "thesis/cases/bingham/transient")
ZIP = os.path.join(ROOT, "library/zoomy_gui/projects/bingham-session.zip")

read = lambda f: open(os.path.join(CASE, f)).read()
strip_future = lambda s: re.sub(r"^from __future__ import.*\n", "", s, flags=re.M)
FILE_GUARD = ('(os.path.dirname(os.path.abspath(__file__))\n'
              '            if "__file__" in globals() else os.getcwd())')
guard_file = lambda s: s.replace(
    "os.path.dirname(os.path.abspath(__file__))", FILE_GUARD, 1)

# ---------------- model card ----------------
hb = strip_future(read("hb_closure.py")).strip()
mesh_src = read("mesh.py")
m = re.search(r"(def wave_length\(.*?\n(?:.*\n)*?)(?=\ndef |\Z)", mesh_src)
wave_len = m.group(1).strip()
model = strip_future(read("model.py"))
model = model.replace("from hb_closure import HerschelBulkley",
                      "# hb_closure.HerschelBulkley: inlined above (GUI card is self-contained)")
model = model.replace("from mesh import wave_length",
                      "# mesh.wave_length: inlined above (GUI card is self-contained)")
model_card = guard_file(model).strip() + "\n"
# splice the inlined siblings right after the module docstring + imports:
# simplest robust placement — AFTER the import block (before CASE_DIR line).
anchor = "# hb_closure.HerschelBulkley: inlined above (GUI card is self-contained)"
model_card = model_card.replace(
    anchor,
    anchor + "\n\n\n# --- inlined case module: hb_closure.py " + "-" * 24 + "\n"
    + hb + "\n\n\n# --- inlined from mesh.py " + "-" * 38 + "\n" + wave_len
    + "\n# " + "-" * 66)

# ---------------- mesh card ----------------
mesh_card = guard_file(strip_future(mesh_src)).strip() + "\n"

# ---------------- solver card (run section) ----------------
settings_json = json.loads(read("settings.json"))
run_src = strip_future(read("run.py"))
run_src = run_src.replace(
    "from mesh import build_mesh\nfrom model import build_model",
    "# Case modules: defined by the Model/Mesh cells in notebook form;\n"
    "# imported from the sibling files in a materialized case folder.\n"
    "try:\n"
    "    build_mesh, build_model  # noqa: B018  (probe the notebook namespace)\n"
    "except NameError:\n"
    "    from mesh import build_mesh\n"
    "    from model import build_model")
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
        if gui.get("time_end") is not None:       # GUI knob = t' (t_end_prime)
            s["run"] = dict(s["run"], t_end_prime=float(gui["time_end"]))
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
viz = strip_future(read("visualize.py"))
viz = viz.replace(
    "from model import scales",
    "try:\n"
    "    scales  # noqa: B018  (defined by the Model cell in notebook form)\n"
    "except NameError:\n"
    "    from model import scales")
# same case-settings fallback as the run card (viz reads model params + name)
viz_read = '''    if settings is None:
        with open(os.path.join(CASE_DIR, "settings.json")) as f:
            settings = json.load(f)'''
assert viz_read in viz
viz = viz.replace(viz_read, "    if settings is None:\n        settings = load_settings()")
anchor_viz = 'CASE_DIR = os.path.dirname(os.path.abspath(__file__))'
assert anchor_viz in viz
viz = viz.replace(anchor_viz, anchor_viz + "\n\n" + new_load, 1)

viz_main = 'if __name__ == "__main__":\n    visualize()'
assert viz_main in viz
viz = viz.replace(viz_main, "visualize()")
viz_card = guard_file(viz).strip() + "\n"

# ---------------- verify: T1 model card standalone ----------------
compile(model_card, "model_card", "exec")
compile(mesh_card, "mesh_card", "exec")
compile(run_card, "run_card", "exec")
compile(viz_card, "viz_card", "exec")
print("T0 compile: all 4 cards OK "
      f"(model {len(model_card)} / mesh {len(mesh_card)} / run {len(run_card)} / viz {len(viz_card)} chars)")

g = {}
exec(model_card, g)
assert "build_model" in g and "HerschelBulkley" in g and "wave_length" in g and "scales" in g
print("T1 model card standalone exec: OK (build_model, HerschelBulkley, wave_length, scales defined)")

# ---------------- write the zip ----------------
with zipfile.ZipFile(ZIP) as z:
    items = {n: z.read(n) for n in z.namelist()}
meta = json.loads(items["project.json"])
meta["sessions"][0]["description"] = (
    "Liu&Mei Bingham roll wave, SME level 2 (numpy). "
    "time_end is t-prime: 200 = full benchmark.")
ov = meta["sessions"][0]["cardOverrides"]
ov["card-sme"] = {"code": model_card}
ov["card-mesh-create-1d"] = {"code": mesh_card}
ov["card-solver-numpy"] = {"code": run_card,
                           "params": {"time_end": settings_json["run"]["t_end_prime"]}}
ov["card-vis-empty-mpl"] = {"code": viz_card}
items["project.json"] = json.dumps(meta, indent=2).encode()
S = "Bingham roll-wave/"
items[S + "model/Shallow Moments (SME)/code.py"] = model_card.encode()
items[S + "mesh/Create 1D/code.py"] = mesh_card.encode()
items[S + "solver/NumPy Solver/code.py"] = run_card.encode()
items[S + "visualization/Empty (Matplotlib)/code.py"] = viz_card.encode()
cj = json.loads(items[S + "solver/NumPy Solver/card.json"])
cj["params"] = {"time_end": settings_json["run"]["t_end_prime"]}
items[S + "solver/NumPy Solver/card.json"] = json.dumps(cj, indent=2).encode()
with zipfile.ZipFile(ZIP, "w", zipfile.ZIP_DEFLATED) as z:
    for n, b in items.items():
        z.writestr(n, b)
print("zip rewritten:", ZIP, os.path.getsize(ZIP), "bytes")

# stash card codes for the runtime tests
out = os.environ.get("CARD_OUT", "/tmp")
for name, code in [("model", model_card), ("mesh", mesh_card),
                   ("run", run_card), ("viz", viz_card)]:
    open(os.path.join(out, f"card_{name}.py"), "w").write(code)
print("cards ->", out)
