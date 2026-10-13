# projects/tools — showcase-session regeneration

Regenerates the pre-baked GUI project zips in `../` from the live cases in
`thesis/cases/` (+ the coupling notebook). Each packer inlines the case's
model / mesh / solver(run) / viz code as self-contained card overrides and
writes a per-session zip; `merge_sessions.py` combines them into the single
`zoomy-cases.zip` the GUI ships.

## Run order (matters)

```sh
PY=<zoomy env python>            # e.g. micromamba run -n zoomy python
export CARD_OUT=/tmp            # where the packers stash card_*.py for smoke tests

$PY pack_zoomy_pipeline_sessions.py   # -> zoomy-{derivation,systemmodel,codeprinter}-session.zip + bingham-session.zip (thesis/cases/zoomy_example/gui)
$PY pack_bingham_analytics_session.py # -> bingham-analytics-session.zip  (linear-stability analytics; thesis/cases/bingham/analytics)
$PY pack_bingham_threshold_session.py # -> bingham-threshold-session.zip  (measured threshold sweep; thesis/cases/bingham/threshold)
$PY pack_malpasset_session.py         # -> malpasset-session.zip          (session 1: jax)
$PY pack_malpasset_amrex_session.py   # EDITS malpasset-session.zip IN PLACE (adds session 2: AMReX)
$PY pack_coupling_session.py          # -> coupling-session.zip           (pair replay)
$PY pack_coupling_triple_session.py   # -> coupling-triple-session.zip    (triple replay; payload upload GATED — see below)
$PY port_symsolver_sessions.py       # EDITS the QR session zips IN PLACE: run cards on the symbolic solvers
$PY merge_sessions.py                 # -> zoomy-cases.zip                (6 shipped sessions)
```

`port_symsolver_sessions.py` swaps the run (solver) card of the QR sessions (Bingham roll-wave,
code printer, Steffler, Malpasset JAX) for its port in `symsolver/`: the packed case, marched by
`SymbolicHyperbolicSolverNumpy` / `SymbolicHyperbolicSolverJax` instead of the legacy
`zoomy_core.fvm` / `zoomy_jax.fvm` solvers (the thesis cases still use those). It stops when a
packed run card is neither the port nor the legacy card it replaces, i.e. when the thesis case
changed: re-port that file. Malpasset (AMReX) stays on `zoomy_amrex.solvers`:
`zoomy_amrex.symsolver` builds and runs through `apptainer exec zoomy_amrex.sif` from the host,
and the amrex backend is zoomy-server inside that image; `symsolver/malpasset_amrex_run.py` is
its port for when the driver builds in the container.

The packers write into `../` (this checkout's `projects/`). The Malpasset and coupling
packers read their thesis case at a pinned revision (`REV`, via `git show`; `ZOOMY_THESIS`
names the thesis checkout, default `~/git/Zoomy/thesis`): the revision the shipped session
was packed from, so a regeneration changes only what the packer changes. The Malpasset case
has moved on since (its deliverable imports `postprocess.py`, which the packer does not
inline); re-pin only together with the packer. `steffler-session.zip` has no packer (packed
by hand, 2e2c7b7).

Browser sessions fetch files with `zoomy_core.misc.download` (synchronous XHR in Pyodide's
worker, urllib in CPython), from URLs a browser may read: the GUI's own site or a
CORS-enabled host. The coupling replay payload is a release asset (no CORS), so the deploy
mirrors it to `gui/gui/data/` and the run card tries that first.

`pack_zoomy_pipeline_sessions.py` writes comment-free card code (`strip_comments.py`)
for the four thesis QR sessions. `pack_malpasset_amrex_session.py` mutates `malpasset-session.zip`, so it MUST
run after `pack_malpasset_session.py`. `merge_sessions.py` reads the per-session
zips, so it runs last (shipped session order: Bingham analytics · Bingham
threshold · Bingham roll-wave · Malpasset dam break · Malpasset (AMReX) · SME-VOF
coupling replay).

The Bingham split (REQ-150) is three cases: `transient/` (roll-wave, the h5-store
run), `analytics/` (linear stability, no time-stepping), and `threshold/` (a
measured 3-beta sweep run.py does itself). The analytics cards re-materialize
their sibling engines (`hb_dispersion`/`hb_visc_analytic`/`hb_closure`) next to
each card (the GUI card format has no sibling-module slot); analytics + threshold
ship as LOCAL runs (`run.py` + `visualize.py`; figures come from `.npz` stores,
and run.py writes a minimal/real `simulation.h5` for the compose viz prelude) —
see `tests/e2e/run_sessions.mjs` (`localOnly`).

**Triple replay (built, NOT shipped):** `pack_coupling_triple_session.py` builds
the SME|VOF|SME session and its viz card is verified, but its recorded-run
payload `case-data-v1/sme_vof_snap_gui_triple.tar.gz` is NOT yet on the public
release (the run card would 404). It is held out of `merge_sessions.py`
(commented SRC) until the payload is uploaded — then add it to SRC + re-merge.

## Editing the session blurbs

The one-line session descriptions the GUI shows in the session box live as
`sess["description"]` in each packer (Bingham's is set on
`meta["sessions"][0]["description"]` since that packer reuses the existing
zip's project.json). The combined project's blurb is
`merged["description"]` in `merge_sessions.py`. Edit those strings, then
re-run the chain above.

## Verify

```sh
$PY -c 'import zipfile,json; m=json.loads(zipfile.ZipFile("../zoomy-cases.zip").read("project.json")); \
print(len(m["sessions"]),"sessions"); [print(s["title"],"|",s["description"]) for s in m["sessions"]]'
```

Expect 6 sessions, terse descriptions, each with 4 `cardOverrides` carrying code.
