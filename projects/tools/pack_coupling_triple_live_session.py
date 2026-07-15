"""Build gui/projects/coupling-triple-live-session.zip — the SME<->VOF coupled case as a
LIVE session (foam backend runs the real coupled case in place).

The real run needs the openfoam+preCICE container (~33 s wall on gaia); the
session materializes the recorded run (release asset case-data-v1) and the viz
card recomposes the case's real 3-panel figures from the raw participant
outputs via zoomy_core.postprocessing.column_plots.
"""
import json, os, pprint, re, zipfile

ROOT = os.path.expanduser("~/git/Zoomy")
CASE = os.path.join(ROOT, "thesis/notebooks/coupling/cases/sme_vof_triple")
ZIP = os.path.join(ROOT, "library/zoomy_gui/projects/coupling-triple-live-session.zip")

read = lambda f: open(os.path.join(CASE, f)).read()
strip_future = lambda s: re.sub(r"^from __future__ import.*\n", "", s, flags=re.M)
# shebangs don't survive the percent-format round-trip (to_folder re-emits
# "#!..." as "!...") and cards aren't executables — drop them.
_strip_shebang = lambda s: re.sub(r"^#!.*\n", "", s, count=1)
_orig_read = read
read = lambda f: _strip_shebang(_orig_read(f))
settings_json = json.loads(read("settings.json"))
SETTINGS_PY = pprint.pformat(settings_json, width=78, sort_dicts=False)

HERE_GUARD = ('(Path(__file__).resolve().parent\n'
              '        if "__file__" in globals() else Path(os.getcwd()))')
def guard_here(s):
    s = s.replace("HERE = Path(__file__).resolve().parent",
                  "import os\nHERE = " + HERE_GUARD)
    return s

def guard_settings(s, var):
    old = f'{var} = json.loads((HERE / "settings.json").read_text())'
    assert old in s, old
    return s.replace(old, f'''_SJ = HERE / "settings.json"
#: embedded copy of the case settings; a sibling settings.json is used only
#: when it is the CASE file ("level" key) — the GUI writes a generic one.
{var} = (json.loads(_SJ.read_text()) if _SJ.exists() else {{}})
if "level" not in {var}:
    {var} = {SETTINGS_PY}''')

# ---------------- model card (informational; emit guarded by __main__) ------
model = guard_settings(guard_here(strip_future(read("model.py"))), "SETTINGS")
model_card = model.strip() + "\n"

# ---------------- mesh card (generate.py only when the case tree exists) ----
mesh = guard_settings(guard_here(strip_future(read("mesh.py"))), "S")
old_run = '''args = sys.argv[1:] or [str(S["level"]), str(S["window"]), S["scheme"],
                        S["ghost"], str(S["frozen"]), str(S["ledger"])]
env = {**os.environ, "MODE": "triple"}
subprocess.run([sys.executable, str(HERE / "generate.py"), *args],
               check=True, env=env)
print("mesh dicts in RUNDIR/{swe_case,swe2_case,vof_case}/system/blockMeshDict")'''
assert old_run in mesh
mesh = mesh.replace(old_run, '''_gen = HERE / "generate.py"
if _gen.exists():
    args = sys.argv[1:] or [str(S["level"]), str(S["window"]), S["scheme"],
                            S["ghost"], str(S["frozen"]), str(S["ledger"])]
    env = {**os.environ, "MODE": "triple"}
    subprocess.run([sys.executable, str(_gen), *args], check=True, env=env)
    print("mesh dicts in RUNDIR/{swe_case,swe2_case,vof_case}/system/blockMeshDict")
else:
    print("replay session: the recorded run tree (snap_gui_l1/*/system/"
          "blockMeshDict) already carries both participants' meshes; the full "
          "case regenerates them via generate.py (see the case folder).")''')
mesh_card = mesh.strip() + "\n"

# ---------------- run card: replay fetch ------------------------------------
run_card = '"""sme_vof — LIVE two-way SME(1)<->VOF preCICE coupled run.\n\nDrives the case\'s OWN run.py IN PLACE on the server machine: the coupled case\nneeds its full tree (generate.py, compile.sh, run.sh, vof_template/) which the\ncomposed folder cannot carry. The foam backend container (zoomy_openfoam) sees\nthe host home via apptainer\'s default binds, so the standard gaia checkout\npath works out of the box; override with SME_VOF_CASE for other layouts.\nOn-demand model compile ~30 s (cached binary afterwards); coupled run ~30 s.\n"""\nimport json\nimport os\nimport shutil\nimport subprocess\nimport sys\n\nCASE = os.environ.get(\n    "SME_VOF_TRIPLE_CASE",\n    "/Users/adam-obbpb5az1dhsjzf/git/Zoomy/thesis/notebooks/coupling/cases/sme_vof_triple")\nif not os.path.isdir(CASE):\n    raise SystemExit(\n        "live coupling needs the case tree on the server machine: " + CASE +\n        " not found — set SME_VOF_CASE or bind the Zoomy checkout into the container")\n\n# honor the GUI time knob when present (pair runs t=0..4 by default)\n_gui = globals().get("settings")\nsnap = "gui_live_triple"\ncmd = [sys.executable, os.path.join(CASE, "run.py"), "--snap", snap]\nprint("live coupled run:", " ".join(cmd), flush=True)\nsubprocess.run(cmd, check=True, cwd=CASE)\n\nrun_dir = os.path.join(CASE, "snap_" + snap)\nshutil.copy(os.path.join(run_dir, "outputs", "swe_case.h5"), "simulation.h5")\n# render the case\'s real figures on the fresh run tree, then stage them\nsubprocess.run([sys.executable, os.path.join(CASE, "visualize.py"), run_dir],\n               check=True, cwd=CASE)\nfor name in os.listdir(run_dir):\n    if name.endswith((".png", ".gif")):\n        shutil.copy(os.path.join(run_dir, name), name)\nprint("artifact -> simulation.h5 (SME participant store; full run tree at "\n      + run_dir + ")")\n'


# ---------------- viz card ---------------------------------------------------
viz = guard_settings(guard_here(strip_future(read("visualize.py"))), "S")
old_ap = '''    ap = argparse.ArgumentParser()
    ap.add_argument("rundir", nargs="?",
                    default=str(HERE.as_posix()).replace(
                        "/mnt/userdrive/Users/home/", "/Users/") + "/run")
    ap.add_argument("--level", type=int, default=S["level"])
    ap.add_argument("--no-gif", action="store_true", help="skip the GIF")
    a = ap.parse_args()'''
assert old_ap in viz
viz = viz.replace(old_ap, '''    class a:                     # GUI replay card: fixed args
        rundir = "snap_gui_live_triple"   # materialized by the Run section
        level = S["level"]
        no_gif = False''')
old_main = 'if __name__ == "__main__":\n    main()'
assert old_main in viz
viz = viz.replace(old_main, "main()")
viz_card = viz.strip() + "\n"

for name, code in [("model", model_card), ("mesh", mesh_card),
                   ("run", run_card), ("viz", viz_card)]:
    compile(code, name + "_card", "exec")
print("T0 compile: all 4 cards OK",
      {n: len(c) for n, c in [("model", model_card), ("mesh", mesh_card),
                              ("run", run_card), ("viz", viz_card)]})

TITLE = "SME-VOF coupling (triple, live)"
sess = {
    "id": "session-coupling-triple-live",
    "title": TITLE,
    "description": ("LIVE three-participant SME|VOF|SME preCICE run — needs a foam backend "
                    "(zoomy_openfoam container). ~1 min."),
    "selections": {"model": "card-sme", "mesh": "card-mesh-create-2d",
                   "solver": "card-solver-foam", "visualization": "card-vis-empty-mpl"},
    "cardOverrides": {
        "card-sme": {"code": model_card},
        "card-mesh-create-2d": {"code": mesh_card},
        "card-solver-foam": {"code": run_card, "params": {}},
        "card-vis-empty-mpl": {"code": viz_card},
    },
}
meta = {"version": "1.1", "sessions": [sess], "activeSession": "session-coupling-triple-live"}
titles = {"card-sme": ("model", "Shallow Moments (SME)"),
          "card-mesh-create-2d": ("mesh", "Create 2D"),
          "card-solver-foam": ("solver", "Coupled (Foam+preCICE)"),
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
    open(os.path.join(out, f"cp_card_{n}.py"), "w").write(c)
print("cards ->", out)
