"""sme_vof — GUI REPLAY of the recorded SME(1)<->VOF preCICE coupled run.

The REAL solver invocation is the case's own run.py (thesis/notebooks/coupling/
cases/sme_vof): the emitted zoomyFoam_L1w SME participant and stock OpenFOAM
incompressibleVoF run coupled through preCICE inside the openfoam container —
an environment the pullable backend images do not carry. The full coupled
benchmark takes ~33 s wall; rerun it in the case folder with:

    python run.py --level 1 --snap gui_l1

This card materializes that recorded run (raw foam time dirs + h5 stores) and
opens the SME participant's store (``open_hdf5``), so the Visualization card
recomposes the case's real figures from the actual participant outputs. Replayed data, clearly labeled — no simulation happens
here.
"""
import os
import tarfile

from zoomy_core.misc.download import download

PAYLOAD = "sme_vof_snap_gui_l1.tar.gz"
#: The site's copy first (same origin as the GUI, so the browser may read it), then the
#: release asset (GitHub sends no CORS headers for it: CPython only).
SOURCES = ("https://zoomylab.github.io/Zoomy/gui/gui/data/" + PAYLOAD,
           "https://github.com/ZoomyLab/Zoomy/releases/download/case-data-v1/" + PAYLOAD)
RUN = "snap_gui_l1"

if not os.path.isdir(RUN):
    print("fetching recorded coupled run:", PAYLOAD, flush=True)
    with tarfile.open(download(SOURCES, PAYLOAD), mode="r:gz") as t:
        t.extractall(".")
    os.remove(PAYLOAD)
    print("extracted ->", RUN)
else:
    print("recorded run already present ->", RUN)

print("store: the SME participant's; the VOF store is " + RUN + "/outputs/vof_case.h5")
open_hdf5(os.path.join(RUN, "outputs", "swe_case.h5"))
