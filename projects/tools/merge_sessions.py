"""Merge the per-session zips into ONE project zip (all sessions, one file).

Session order follows SRC (sessions within a zip keep their project.json order):
Bingham (analytics) · Bingham roll-wave · Malpasset dam break · Malpasset (AMReX)
· SME-VOF coupling (replay).
"""
import json, os, zipfile

P = os.path.expanduser("~/git/Zoomy/library/zoomy_gui/projects")
SRC = ["bingham-analytics-session.zip", "bingham-session.zip",
       "malpasset-session.zip", "coupling-session.zip"]
OUT = os.path.join(P, "zoomy-cases.zip")

sessions, items = [], {}
for z in SRC:
    with zipfile.ZipFile(os.path.join(P, z)) as f:
        names = f.namelist()
        meta = json.loads(f.read("project.json"))
        for s in meta["sessions"]:
            if s["id"] not in {x["id"] for x in sessions}:
                sessions.append(s)
        for n in names:
            if n != "project.json":
                items[n] = f.read(n)   # folders are namespaced by session title -> no collisions

merged = {
    "version": "1.1",
    "title": "Zoomy showcase cases",
    "description": ("Five Zoomy showcase cases as GUI sessions: Bingham "
                    "linear-stability analytics (numpy), Bingham roll wave "
                    "(numpy), Malpasset dam break (jax), Malpasset (AMReX), "
                    "SME-VOF coupling replay."),
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
    assert len(m["sessions"]) == 5, [s["title"] for s in m["sessions"]]
    for s in m["sessions"]:
        assert s["cardOverrides"], s["title"]
    n_code = sum(1 for n in f.namelist() if n.endswith("code.py"))
print("sanity OK:", len(m["sessions"]), "sessions,", n_code, "code.py entries")
