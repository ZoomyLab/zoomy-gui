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

$PY pack_bingham_session.py         # -> bingham-session.zip   (1 session)
$PY pack_malpasset_session.py       # -> malpasset-session.zip (session 1: jax)
$PY pack_malpasset_amrex_session.py # EDITS malpasset-session.zip IN PLACE (adds session 2: AMReX)
$PY pack_coupling_session.py        # -> coupling-session.zip  (1 session)
$PY merge_sessions.py               # -> zoomy-cases.zip       (all 4 sessions)
```

`pack_malpasset_amrex_session.py` mutates `malpasset-session.zip`, so it MUST
run after `pack_malpasset_session.py`. `merge_sessions.py` reads the three
per-session zips, so it runs last.

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

Expect 4 sessions, terse descriptions, each with 4 `cardOverrides` carrying code.
