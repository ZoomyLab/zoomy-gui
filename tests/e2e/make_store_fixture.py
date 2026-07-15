"""Generate a small SWE-1D result store + model.py for the post-processing
chain E2E. Runs the numpy adapter on the shipped ``case_swe_1d`` at a small
``time_end`` and copies the store + model cell to <out>/.

    python make_store_fixture.py <out_dir>
"""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ZOOMY = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
CASE = os.path.join(ZOOMY, "thesis", "notebooks", "gui", "case_swe_1d")


def main(out_dir):
    os.makedirs(out_dir, exist_ok=True)
    from zoomy_server.adapters.numpy import NumpyAdapter

    case = tempfile.mkdtemp(prefix="swe1d_fixture_")
    for fn in ("model.py", "mesh.py", "settings.json"):
        shutil.copy(os.path.join(CASE, fn), case)
    # Keep the smoke run short.
    sp = os.path.join(case, "settings.json")
    s = json.load(open(sp))
    s["time_end"] = 0.1
    s["output_snapshots"] = 4
    json.dump(s, open(sp, "w"))

    run_out = tempfile.mkdtemp(prefix="swe1d_out_")
    NumpyAdapter().solve(case, run_out, lambda *a: None)

    shutil.copy(os.path.join(run_out, "simulation.h5"), os.path.join(out_dir, "simulation.h5"))
    shutil.copy(os.path.join(case, "model.py"), os.path.join(out_dir, "model.py"))
    print("fixture:", out_dir,
          os.path.getsize(os.path.join(out_dir, "simulation.h5")), "bytes")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else ".")
