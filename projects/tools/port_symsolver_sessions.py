"""Put the QR sessions' run cards on the symbolic solvers: EDITS the session zips IN PLACE.

The packers reproduce the thesis cases as they were packed; most thesis run scripts still
march the legacy solvers.  This step replaces each session's solver card code (`project.json`
override and the card's `code.py`) with its port in `symsolver/`: the same case, model, mesh
and settings, marched by the symbolic solvers (`SymbolicHyperbolicSolverNumpy`,
`SymbolicHyperbolicSolverJax`, `SymbolicHyperbolicSolverAmrex`).  The Malpasset sessions also
get their model card ported: the thesis run's model and numerics, which the packed folder case
predates.  A port line `from <module> import *` naming a module in `symsolver/` is replaced by
that module (the cards are self-contained), and a visualization card's `_CASE_SETTINGS` follows
the ported run card's.  Run it after the packers and before `merge_sessions.py`.  A card that
is already the port is left alone; a card that is neither the port nor the packed card it
replaces (identified by its SHA-256: the thesis case changed) stops the run.
"""
import ast
import hashlib
import json
import os
import re
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECTS = os.path.join(HERE, os.pardir)
PORTS = os.path.join(HERE, "symsolver")

#: SHA-256 of the packed Malpasset model cards (navier closure, order 1; MalpassetSWE on AMReX)
MODEL_JAX = "678ddf728db1fa58c08869584ffb009a6c9b5dd2187d56b40f57c34d3c1e540c"
MODEL_AMREX = "e5e63fce7a9ecf6e677e3b640515cb25efbfb91699ee024d2b42779befd60c31"
#: (zip, session index, card role, port, SHA-256 of the packed card it replaces or None (the
#: packer writes the port itself, or the zip has no packer), strip comments)
SESSIONS = [
    ("bingham-session.zip", 0, "solver", "bingham_run.py",
     "e2cf042413c9f5c8750a253117b8ba98e5fc451772666cc128c648657bbd58f2", True),
    ("zoomy-codeprinter-session.zip", 0, "solver", "codeprinter_run.py",
     "fa7ecb14fa7b94905bbe45eef0e303a6596c1df81e89597aa48f6a1529eb2ed6", True),
    ("steffler-session.zip", 0, "solver", "steffler_run.py", None, False),
    ("bingham-threshold-session.zip", 0, "solver", "bingham_threshold_run.py",
     "5463bdaf1b5f8ce059ca3065090bd6c4bbef4f532c58d1785ff6fd5b12a871b8", False),
    ("malpasset-session.zip", 0, "solver", "malpasset_jax_run.py",
     "ec3820738ec470fa45b8761166128cf38cecfef6a992d15bd01f02dcd7dbfe1f", False),
    ("malpasset-session.zip", 0, "model", "malpasset_jax_model.py", MODEL_JAX, False),
    ("malpasset-session.zip", 1, "solver", "malpasset_amrex_run.py", None, False),
    ("malpasset-session.zip", 1, "model", "malpasset_amrex_model.py", MODEL_AMREX, False),
]
#: `from <module> import *` of a sibling module in `symsolver/` (the port runs standalone there)
INLINE = re.compile(r"^from (\w+) import \*.*\n", re.M)

def inline(code):
    """`code` with each `from <module> import *` of a `symsolver/` module replaced by the module
    (its `from __future__` import dropped)."""
    def module(m):
        path = os.path.join(PORTS, m.group(1) + ".py")
        if not os.path.exists(path):
            return m.group(0)
        with open(path) as f:
            src = re.sub(r"^from __future__ import.*\n", "", f.read(), flags=re.M).strip()
        rule = "# " + "-" * 66
        return f"# --- inlined case module: {m.group(1)}.py\n{src}\n{rule}\n"
    return INLINE.sub(module, code)


def case_settings(code):
    """The `_CASE_SETTINGS = {...}` assignment of `code`: `(start, end, text)` or None."""
    for node in ast.parse(code).body:
        if (isinstance(node, ast.Assign) and len(node.targets) == 1
                and getattr(node.targets[0], "id", None) == "_CASE_SETTINGS"):
            lines = code.splitlines(keepends=True)
            start = sum(len(l) for l in lines[:node.lineno - 1])
            end = sum(len(l) for l in lines[:node.end_lineno])
            return start, end, code[start:end]
    return None


def sync_settings(viz, run):
    """`viz` with its `_CASE_SETTINGS` replaced by the run card's (unchanged without one)."""
    a, b = case_settings(viz), case_settings(run)
    if a is None or b is None:
        return viz
    return viz[:a[0]] + b[2] + viz[a[1]:]


def port_code(name, strip_comments):
    with open(os.path.join(PORTS, name)) as f:
        code = inline(f.read())
    if strip_comments:
        import sys
        sys.path.insert(0, HERE)
        from strip_comments import strip
        code = strip(code)
    compile(code, name, "exec")
    return code


def port(zname, jobs):
    """Apply `[(index, role, port name, packed card hash, strip)]` to one zip."""
    path = os.path.join(PROJECTS, zname)
    with zipfile.ZipFile(path) as z:
        items = {n: z.read(n) for n in z.namelist()}
    meta = json.loads(items["project.json"])
    changed = False

    def put(sess, role, old, new):
        """Replace card `role`'s code `old` by `new` in the override and its `code.py`."""
        files = [n for n in items if n.startswith(f"{sess['title']}/{role}/")
                 and n.endswith("/code.py") and items[n].decode() == old]
        if len(files) != 1:
            raise SystemExit(f"{zname}: {len(files)} {role} code.py files match the card")
        sess["cardOverrides"][sess["selections"][role]]["code"] = new
        items[files[0]] = new.encode()

    for idx, role, name, packed, strip_comments in jobs:
        sess = meta["sessions"][idx]
        card = sess["cardOverrides"][sess["selections"][role]]
        new = port_code(name, strip_comments)
        old = card["code"]
        if old == new:
            print(f"  {zname}#{idx}: {role} card already ported")
            continue
        if packed is None or hashlib.sha256(old.encode()).hexdigest() != packed:
            raise SystemExit(f"{zname}#{idx}: the {role} card is neither the port nor the packed "
                             f"card it replaces: re-port {name}")
        put(sess, role, old, new)
        changed = True
        print(f"  {zname}#{idx}: {role} card -> symsolver/{name}")
    for idx in sorted({j[0] for j in jobs}):
        sess = meta["sessions"][idx]
        viz = sess["cardOverrides"].get(sess["selections"].get("visualization"), {})
        if "code" not in viz:
            continue
        new = sync_settings(viz["code"], sess["cardOverrides"][sess["selections"]["solver"]]["code"])
        if new != viz["code"]:
            put(sess, "visualization", viz["code"], new)
            changed = True
            print(f"  {zname}#{idx}: visualization card settings -> the run card's")
    if changed:
        items["project.json"] = json.dumps(meta, indent=2).encode()
        with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
            for n, b in items.items():
                z.writestr(n, b)

if __name__ == "__main__":
    by_zip = {}
    for zname, idx, role, name, packed, strip_comments in SESSIONS:
        by_zip.setdefault(zname, []).append((idx, role, name, packed, strip_comments))
    for zname, jobs in by_zip.items():
        port(zname, jobs)
    print("done")
