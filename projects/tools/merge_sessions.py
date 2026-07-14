"""Merge the per-session zips into ONE project zip (all sessions, one file).

Session order follows SRC (sessions within a zip keep their project.json order):
Bingham (analytics) · Bingham (threshold) · Bingham roll-wave · Malpasset dam
break · Malpasset (AMReX) · SME-VOF coupling (replay)  [ · SME-VOF coupling
(triple, replay) — see the note below].

The TRIPLE replay session (``coupling-triple-session.zip``) is BUILT and verified
but its recorded-run payload (``case-data-v1/sme_vof_snap_gui_triple.tar.gz``) is
NOT yet on the public release, so its run card would fetch a 404. It is therefore
held OUT of the shipped merge. To enable it once the payload is uploaded, just
add ``"coupling-triple-session.zip"`` to SRC (after the pair) — the count auto-
adjusts.
"""
import json, os, zipfile

P = os.path.expanduser("~/git/Zoomy/library/zoomy_gui/projects")
SRC = ["bingham-analytics-session.zip", "bingham-threshold-session.zip",
       "bingham-session.zip", "malpasset-session.zip", "coupling-session.zip"]
# SRC.append("coupling-triple-session.zip")   # enable after payload upload
OUT = os.path.join(P, "zoomy-cases.zip")

sessions, items, expected = [], {}, 0
for z in SRC:
    with zipfile.ZipFile(os.path.join(P, z)) as f:
        names = f.namelist()
        meta = json.loads(f.read("project.json"))
        expected += len(meta["sessions"])
        for s in meta["sessions"]:
            if s["id"] not in {x["id"] for x in sessions}:
                sessions.append(s)
        for n in names:
            if n != "project.json":
                items[n] = f.read(n)   # folders are namespaced by session title -> no collisions

merged = {
    "version": "1.1",
    "title": "Zoomy showcase cases",
    "description": ("Zoomy showcase cases as GUI sessions: Bingham linear-"
                    "stability analytics (numpy), Bingham measured threshold "
                    "sweep (numpy), Bingham roll wave (numpy), Malpasset dam "
                    "break (jax), Malpasset (AMReX), SME-VOF coupling replay."),
    "sessions": sessions,
    "activeSession": sessions[0]["id"],
}
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as f:
    f.writestr("project.json", json.dumps(merged, indent=2))
    for n, b in items.items():
        f.writestr(n, b)
print("merged ->", OUT, os.path.getsize(OUT), "bytes")
print("sessions:", [s["title"] for s in sessions])
# sanity: reload + check overrides intact
with zipfile.ZipFile(OUT) as f:
    m = json.loads(f.read("project.json"))
    assert len(m["sessions"]) == expected, [s["title"] for s in m["sessions"]]
    for s in m["sessions"]:
        assert s["cardOverrides"], s["title"]
    n_code = sum(1 for n in f.namelist() if n.endswith("code.py"))
print("sanity OK:", len(m["sessions"]), "sessions,", n_code, "code.py entries")
