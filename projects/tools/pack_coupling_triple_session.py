"""Build gui/projects/coupling-triple-session.zip — the SME|VOF|SME THREE-
participant coupled case (thesis/notebooks/coupling/cases/sme_vof_triple) as a
REPLAY session (packaging-level; case files untouched), the triple sibling of
pack_coupling_session.py.

The real run needs the openfoam+preCICE container (three participants); the
session materializes the recorded run (release asset
``case-data-v1/sme_vof_snap_gui_triple.tar.gz`` — the snap_gui_triple foam trees
with VTK/logs/pngs stripped) and the viz card recomposes the case's real
five-station final PNG + GIF + closed-box mass audit from the raw participant
outputs via zoomy_core.postprocessing.column_plots.  The mass-audit figure needs
the case's ``analysis/total_mass_audit.py`` sibling (imports only column_plots),
so the viz card re-materializes it next to itself (to_folder ships no extra
modules).
"""
import json, os, pprint, re, zipfile

ROOT = os.path.expanduser("~/git/Zoomy")
CASE = os.path.join(ROOT, "thesis/notebooks/coupling/cases/sme_vof_triple")
ZIP = os.path.join(ROOT, "library/zoomy_gui/projects/coupling-triple-session.zip")

_orig_read = lambda f: open(os.path.join(CASE, f)).read()
strip_future = lambda s: re.sub(r"^from __future__ import.*\n", "", s, flags=re.M)
_strip_shebang = lambda s: re.sub(r"^#!.*\n", "", s, count=1)
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

# ---------------- model card (informational) --------------------------------
model_card = guard_settings(guard_here(strip_future(read("model.py"))), "SETTINGS").strip() + "\n"

# ---------------- mesh card (generate.py only when the case tree exists) -----
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
    print("replay session: the recorded run tree (snap_gui_triple/*/system/"
          "blockMeshDict) already carries all three participants' meshes; the "
          "full case regenerates them via generate.py MODE=triple (see the "
          "case folder).")''')
mesh_card = mesh.strip() + "\n"

# ---------------- run card: replay fetch ------------------------------------
run_card = '''"""sme_vof_triple — GUI REPLAY of the recorded SME(1)|VOF|SME(1) triple run.

The REAL solver invocation is the case's own run.py (thesis/notebooks/coupling/
cases/sme_vof_triple): three preCICE participants (two zoomyFoam_L1 SME channels
+ a stock incompressibleVoF box) coupled inside the openfoam container — an
environment the pullable backend images do not carry. Rerun it in the case
folder with:

    python run.py --level 1 --snap gui_triple

This card materializes that recorded run (raw foam time dirs + h5 stores, VTK/
logs stripped) so the Visualization card recomposes the case's real five-station
figure + mass audit from the actual participant outputs. Replayed data, clearly
labeled — no simulation happens here.
"""
import io
import os
import shutil
import tarfile
import urllib.request

PAYLOAD = ("https://github.com/ZoomyLab/Zoomy/releases/download/"
           "case-data-v1/sme_vof_snap_gui_triple.tar.gz")
RUN = "snap_gui_triple"

if not os.path.isdir(RUN):
    print("fetching recorded triple run:", PAYLOAD, flush=True)
    with urllib.request.urlopen(PAYLOAD, timeout=300) as r:
        _buf = io.BytesIO(r.read())
    with tarfile.open(fileobj=_buf, mode="r:gz") as t:
        t.extractall(".")
    print("extracted ->", RUN)
else:
    print("recorded run already present ->", RUN)

shutil.copy(os.path.join(RUN, "outputs", "swe_case.h5"), "simulation.h5")
print("artifact -> simulation.h5 (SME participant store; VOF store at "
      + RUN + "/outputs/vof_case.h5, second SME at " + RUN + "/outputs/swe2_case.h5)")
'''

# ---------------- viz card ---------------------------------------------------
# The mass audit imports analysis/total_mass_audit (column_plots only, no case
# siblings): re-materialize it next to the card so the mass-audit figure renders.
TMA_SRC = strip_future(read("analysis/total_mass_audit.py"))
VIZ_BOOT = (
    "import os as _os\n"
    "_HERE = (_os.path.dirname(_os.path.abspath(__file__))\n"
    "         if \"__file__\" in globals() else _os.getcwd())\n"
    "_os.makedirs(_os.path.join(_HERE, \"analysis\"), exist_ok=True)\n"
    "_tma = _os.path.join(_HERE, \"analysis\", \"total_mass_audit.py\")\n"
    "if not _os.path.exists(_tma):\n"
    "    open(_tma, \"w\").write(" + repr(TMA_SRC) + ")\n"
)
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
        rundir = "snap_gui_triple"   # materialized by the Run section
        level = S["level"]
        no_gif = False''')
old_main = 'if __name__ == "__main__":\n    main()'
assert old_main in viz
viz = viz.replace(old_main, "main()")
viz_card = VIZ_BOOT + "\n" + viz.strip() + "\n"

# ---------------- verify compile --------------------------------------------
for name, code in [("model", model_card), ("mesh", mesh_card),
                   ("run", run_card), ("viz", viz_card)]:
    compile(code, name + "_card", "exec")
print("T0 compile: all 4 cards OK",
      {n: len(c) for n, c in [("model", model_card), ("mesh", mesh_card),
                              ("run", run_card), ("viz", viz_card)]})

# ---------------- write the zip ---------------------------------------------
TITLE = "SME-VOF coupling (triple, replay)"
sess = {
    "id": "session-coupling-triple",
    "title": TITLE,
    "description": ("Replay of the recorded SME(1)|VOF|SME(1) three-participant "
                    "preCICE coupled run (numpy backend fetches it)."),
    "selections": {"model": "card-sme", "mesh": "card-mesh-create-2d",
                   "solver": "card-solver-numpy", "visualization": "card-vis-empty-mpl"},
    "cardOverrides": {
        "card-sme": {"code": model_card},
        "card-mesh-create-2d": {"code": mesh_card},
        "card-solver-numpy": {"code": run_card, "params": {}},
        "card-vis-empty-mpl": {"code": viz_card},
    },
}
meta = {"version": "1.1", "sessions": [sess], "activeSession": "session-coupling-triple"}
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
    open(os.path.join(out, f"ct_card_{n}.py"), "w").write(c)
print("cards ->", out)
