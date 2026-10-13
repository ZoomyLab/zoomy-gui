"""Put the QR sessions' run cards on the symbolic solvers: EDITS the session zips IN PLACE.

The packers reproduce the thesis cases as they were packed; most thesis run scripts still
march the legacy solvers.  This step replaces each session's solver card code (`project.json`
override and the card's `code.py`) with its port in `symsolver/`: the same case, model, mesh
and settings, marched by the symbolic solvers (`SymbolicHyperbolicSolverNumpy`,
`SymbolicHyperbolicSolverJax`, `SymbolicHyperbolicSolverAmrex`).  Run it after the packers and
before `merge_sessions.py`.  A card that is already the port is left alone; a card that is
neither the port nor a card it replaces (the packed card or an earlier port, identified by its
SHA-256: the thesis case changed) stops the run.
"""
import hashlib
import json
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.join(HERE, os.pardir)
PORTS = os.path.join(HERE, "symsolver")

#: (zip, session index, port, SHA-256s of the run cards it replaces: the packed card and earlier
#: versions of the port (none: the packer writes the port itself, or the zip has no packer),
#: strip comments)
SESSIONS = [
    ("bingham-session.zip", 0, "bingham_run.py",
     ("e2cf042413c9f5c8750a253117b8ba98e5fc451772666cc128c648657bbd58f2",
      "1bee87ebb816a251a3f816e050132beabbbe4b5bbe30c6c24f795ef6a06ef527"), True),
    ("zoomy-codeprinter-session.zip", 0, "codeprinter_run.py",
     ("fa7ecb14fa7b94905bbe45eef0e303a6596c1df81e89597aa48f6a1529eb2ed6",
      "5854289f854617fa81ccdcd8391afc0e997979b0f17ec4163b61da66b2cb60af"), True),
    ("steffler-session.zip", 0, "steffler_run.py", (), False),
    ("bingham-threshold-session.zip", 0, "bingham_threshold_run.py",
     ("5463bdaf1b5f8ce059ca3065090bd6c4bbef4f532c58d1785ff6fd5b12a871b8",), False),
    ("malpasset-session.zip", 0, "malpasset_jax_run.py",
     ("ec3820738ec470fa45b8761166128cf38cecfef6a992d15bd01f02dcd7dbfe1f",), False),
    ("malpasset-session.zip", 1, "malpasset_amrex_run.py", (), False),
]


def port_code(name, strip_comments):
    with open(os.path.join(PORTS, name)) as f:
        code = f.read()
    if strip_comments:
        import sys
        sys.path.insert(0, HERE)
        from strip_comments import strip
        code = strip(code)
    compile(code, name, "exec")
    return code


def port(zname, jobs):
    """Apply `[(index, port name, hashes of the cards it replaces, strip)]` to one zip."""
    path = os.path.join(PROJECTS, zname)
    with zipfile.ZipFile(path) as z:
        items = {n: z.read(n) for n in z.namelist()}
    meta = json.loads(items["project.json"])
    changed = False
    for idx, name, packed, strip_comments in jobs:
        sess = meta["sessions"][idx]
        card = sess["cardOverrides"][sess["selections"]["solver"]]
        new = port_code(name, strip_comments)
        old = card["code"]
        if old == new:
            print(f"  {zname}#{idx}: already on the symbolic solver")
            continue
        if hashlib.sha256(old.encode()).hexdigest() not in packed:
            raise SystemExit(f"{zname}#{idx}: the run card is neither the port nor the packed "
                             f"card it replaces: re-port {name}")
        files = [n for n in items if n.startswith(sess["title"] + "/solver/")
                 and n.endswith("/code.py") and items[n].decode() == old]
        if len(files) != 1:
            raise SystemExit(f"{zname}#{idx}: {len(files)} solver code.py files match the card")
        card["code"] = new
        items[files[0]] = new.encode()
        changed = True
        print(f"  {zname}#{idx}: run card -> symsolver/{name}")
    if changed:
        items["project.json"] = json.dumps(meta, indent=2).encode()
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for n, b in items.items():
                z.writestr(n, b)


if __name__ == "__main__":
    by_zip = {}
    for zname, idx, name, packed, strip_comments in SESSIONS:
        by_zip.setdefault(zname, []).append((idx, name, packed, strip_comments))
    for zname, jobs in by_zip.items():
        port(zname, jobs)
    print("done")
