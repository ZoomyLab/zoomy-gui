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

$PY pack_bingham_session.py           # -> bingham-session.zip            (roll-wave; thesis/cases/bingham/transient)
$PY pack_bingham_analytics_session.py # -> bingham-analytics-session.zip  (linear-stability analytics; thesis/cases/bingham/analytics)
$PY pack_bingham_threshold_session.py # -> bingham-threshold-session.zip  (measured threshold sweep; thesis/cases/bingham/threshold)
$PY pack_malpasset_session.py         # -> malpasset-session.zip          (session 1: jax)
$PY pack_malpasset_amrex_session.py   # EDITS malpasset-session.zip IN PLACE (adds session 2: AMReX)
$PY pack_coupling_session.py          # -> coupling-session.zip           (pair replay)
$PY pack_coupling_triple_session.py   # -> coupling-triple-session.zip    (triple replay; payload upload GATED — see below)
$PY merge_sessions.py                 # -> zoomy-cases.zip                (6 shipped sessions)
```

`pack_malpasset_amrex_session.py` mutates `malpasset-session.zip`, so it MUST
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
