"""Build gui/projects/coupling-session.zip — the SME<->VOF coupled case as a
REPLAY session (packaging-level; case files untouched).

The real run needs the openfoam+preCICE container (~33 s wall on gaia); the
session materializes the recorded run (release asset case-data-v1) and the viz
card recomposes the case's real 3-panel figures from the raw participant
outputs via zoomy_core.postprocessing.column_plots.
"""
import json, os, pprint, re, zipfile

ROOT = os.path.expanduser("~/git/Zoomy")
CASE = os.path.join(ROOT, "thesis/notebooks/coupling/cases/sme_vof")
ZIP = os.path.join(ROOT, "library/zoomy_gui/projects/coupling-session.zip")

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
subprocess.run([sys.executable, str(HERE / "generate.py"), *args], check=True)
print("mesh dicts in RUNDIR/{swe_case,vof_case}/system/blockMeshDict")'''
assert old_run in mesh
mesh = mesh.replace(old_run, '''_gen = HERE / "generate.py"
if _gen.exists():
    args = sys.argv[1:] or [str(S["level"]), str(S["window"]), S["scheme"],
                            S["ghost"], str(S["frozen"]), str(S["ledger"])]
    subprocess.run([sys.executable, str(_gen), *args], check=True)
    print("mesh dicts in RUNDIR/{swe_case,vof_case}/system/blockMeshDict")
else:
    print("replay session: the recorded run tree (snap_gui_l1/*/system/"
          "blockMeshDict) already carries both participants' meshes; the full "
          "case regenerates them via generate.py (see the case folder).")''')
mesh_card = mesh.strip() + "\n"

# ---------------- run card: replay fetch ------------------------------------
run_card = '''"""sme_vof — GUI REPLAY of the recorded SME(1)<->VOF preCICE coupled run.

The REAL solver invocation is the case's own run.py (thesis/notebooks/coupling/
cases/sme_vof): the emitted zoomyFoam_L1w SME participant and stock OpenFOAM
incompressibleVoF run coupled through preCICE inside the openfoam container —
an environment the pullable backend images do not carry. The full coupled
benchmark takes ~33 s wall; rerun it in the case folder with:

    python run.py --level 1 --snap gui_l1

This card materializes that recorded run (raw foam time dirs + h5 stores) so
the Visualization card recomposes the case's real figures from the actual
participant outputs. Replayed data, clearly labeled — no simulation happens
here.
"""
import io
import os
import shutil
import tarfile
import urllib.request

PAYLOAD = ("https://github.com/ZoomyLab/Zoomy/releases/download/"
           "case-data-v1/sme_vof_snap_gui_l1.tar.gz")
RUN = "snap_gui_l1"

if not os.path.isdir(RUN):
    print("fetching recorded coupled run:", PAYLOAD, flush=True)
    with urllib.request.urlopen(PAYLOAD, timeout=180) as r:
        _buf = io.BytesIO(r.read())
    with tarfile.open(fileobj=_buf, mode="r:gz") as t:
        t.extractall(".")
    print("extracted ->", RUN)
else:
    print("recorded run already present ->", RUN)

shutil.copy(os.path.join(RUN, "outputs", "swe_case.h5"), "simulation.h5")
print("artifact -> simulation.h5 (SME participant store; VOF store at "
      + RUN + "/outputs/vof_case.h5)")
'''

# ---------------- viz card ---------------------------------------------------
viz = guard_settings(guard_here(strip_future(read("visualize.py"))), "S")
old_ap = '''    ap = argparse.ArgumentParser()
    ap.add_argument("rundir", nargs="?",
                    default=str(HERE.as_posix()).replace(
                        "/mnt/userdrive/Users/home/", "/Users/") + "/run")
    ap.add_argument("--level", type=int, default=S["level"])
    ap.add_argument("--gif", action="store_true", help="also write the GIF")
    a = ap.parse_args()'''
assert old_ap in viz
viz = viz.replace(old_ap, '''    class a:                     # GUI replay card: fixed args
        rundir = "snap_gui_l1"   # materialized by the Run section
        level = S["level"]
        gif = True''')
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

TITLE = "SME-VOF coupling (replay)"
sess = {
    "id": "session-coupling",
    "title": TITLE,
    "description": ("Replay of the recorded SME(1)-VOF preCICE coupled run "
                    "(numpy backend fetches it)."),
    "selections": {"model": "card-sme", "mesh": "card-mesh-create-2d",
                   "solver": "card-solver-numpy", "visualization": "card-vis-empty-mpl"},
    "cardOverrides": {
        "card-sme": {"code": model_card},
        "card-mesh-create-2d": {"code": mesh_card},
        "card-solver-numpy": {"code": run_card, "params": {}},
        "card-vis-empty-mpl": {"code": viz_card},
    },
}
meta = {"version": "1.1", "sessions": [sess], "activeSession": "session-coupling"}
titles = {"card-sme": ("model", "Shallow Moments (SME)"),
          "card-mesh-create-2d": ("mesh", "Create 2D"),
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
for n, c in [("model", model_card), ("mesh", mesh_card), ("run", run_card), ("viz", viz_card)]:
    open(os.path.join(out, f"cp_card_{n}.py"), "w").write(c)
print("cards ->", out)
