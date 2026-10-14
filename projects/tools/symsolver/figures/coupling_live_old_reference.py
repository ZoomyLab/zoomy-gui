"""The old solver's run of the live SME | VOF sessions: the reduced arm(s) on zoomyFoam (the
SME participant the sessions ran before the symbolic solvers: `library/zoomy_foam`
zoomyFoam.C + PreciceManager.H, built against `create_model.py --level 1 --closure newtonian
--bcs coupling --outer wall`, project_nz 40), the same VOF tank (`zoomy_foam.vof`), the
sessions' configuration (Fr* = 0.752, window 2 ms, the characteristic ghost with the frozen
`rp` mass row, lambda_s 0.5, nu 1e-3, adaptive steps at maxCo 0.9 in zoomyFoam's 1-D step
convention, t_end 2.5 s). Writes the arms' snapshots and the seam ledger to an npz.

    python coupling_live_old_reference.py pair|triple OUT.npz [WORK] [--perturb 1e-9]

`--perturb` raises the reservoir depth by that much: the run's own sensitivity, the floor
of any old-vs-new comparison. Needs apptainer and the OpenFOAM image (`ZOOMY_OF_SIF`);
builds in WORK (default a temporary directory).
"""
import argparse
import csv
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

from zoomy_foam import vof
from zoomy_foam._pipeline import FOAM_ROOT, _apptainer, _apptainer_cmd

H_HIGH, H_LOW, X_DAM, NZ, N_ARM = 0.18, 0.04, -0.4, 40, 120
T_END, WINDOW, DT_WRITE = 2.5, 2e-3, 0.05
ARMS = {"pair": {"Swe": ((-0.6, 0.0), "right", X_DAM)},
        "triple": {"Swe": ((-0.6, 0.0), "right", X_DAM), "Swe2": ((1.5, 2.1), "left", None)}}
FO = {"pair": {}, "triple": {"imposeMode": "fluxonly", "imposeVertical": "no"}}
HDR = "FoamFile {{ format ascii; class {c}; object {o}; }}"


def build(work):
    """zoomyFoam against the SME(1) headers, in a copy of library/zoomy_foam under `work`."""
    src = work / "zoomy_foam"
    if (work / "bin" / "zoomyFoam").exists():
        return work / "bin" / "zoomyFoam"
    shutil.copytree(FOAM_ROOT, src, ignore=shutil.ignore_patterns(
        ".bincache", "__pycache__", "lnInclude", "linux64*", "tests"), dirs_exist_ok=True)
    subprocess.run([sys.executable, str(src / "create_model.py"), "--level", "1", "--closure",
                    "newtonian", "--bcs", "coupling", "--outer", "wall", "--out", str(src)],
                   check=True)
    (work / "bin").mkdir(exist_ok=True)
    _apptainer(f"export FOAM_USER_APPBIN={work}/bin; cd {src}; wmake > wmake.log 2>&1",
               binds=[work], check=True)
    return work / "bin" / "zoomyFoam"


def sme_case(case, name, domain, side, dam, config, h_high):
    """The zoomyFoam case of arm `name`, as thesis/notebooks/coupling/cases/sme_vof/generate.py
    wrote it."""
    (x0, x1) = domain
    left, right = ("outer", "coupled") if side == "right" else ("coupled", "outer")
    w = lambda p, t: (p.parent.mkdir(parents=True, exist_ok=True), p.write_text(t))  # noqa
    w(case / "system/blockMeshDict", f"""{HDR.format(c="dictionary", o="blockMeshDict")}
convertToMeters 1;
vertices ( ({x0} 0 0) ({x1} 0 0) ({x1} 1 0) ({x0} 1 0) ({x0} 0 1) ({x1} 0 1) ({x1} 1 1) ({x0} 1 1) );
blocks ( hex (0 1 2 3 4 5 6 7) ({N_ARM} 1 1) simpleGrading (1 1 1) );
boundary (
  {left}  {{ type patch; faces ((0 4 7 3)); }}
  {right} {{ type patch; faces ((1 2 6 5)); }}
  sides        {{ type empty; faces ((0 1 5 4) (3 7 6 2)); }}
  topAndBottom {{ type empty; faces ((0 3 2 1) (4 5 6 7)); }}
);
mergePatchPairs ();
""")
    data = " ".join(f"{f}_S" for f in vof.FIELDS), " ".join(f"{f}_V" for f in vof.FIELDS)
    w(case / "system/controlDict", f"""{HDR.format(c="dictionary", o="controlDict")}
application zoomyFoam;
startFrom startTime; startTime 0; stopAt endTime; endTime {T_END};
deltaT {WINDOW}; writeControl runTime; writeInterval {DT_WRITE};
purgeWrite 0; writeFormat ascii; writePrecision 10; timeFormat general;
runTimeModifiable true; adjustTimeStep no; maxCo 0.9; reconstructionOrder 1;
modelParameters {{ lambda_s 0.5; nu 0.001; }}
preciceParticipant {name};
preciceConfig "{config}";
preciceMeshes ( {name}Mesh );
preciceWriteData ( {data[0]} );
preciceReadData ( {data[1]} );
preciceGhost characteristic;
preciceZSamples {NZ};
preciceFrozenMass yes;
preciceMassRow rp;
""")
    w(case / "system/fvSchemes", HDR.format(c="dictionary", o="fvSchemes") + """
ddtSchemes { default Euler; }
gradSchemes { default cellLimited Gauss linear 1; }
divSchemes { default Gauss linear; }
laplacianSchemes { default Gauss linear corrected; }
interpolationSchemes { default linear; }
snGradSchemes { default corrected; }
""")
    w(case / "system/fvSolution", HDR.format(c="dictionary", o="fvSolution")
      + '\nsolvers { "Q.*" { solver diagonal; } }\n')
    if dam is not None:
        w(case / "system/setFieldsDict", f"""{HDR.format(c="dictionary", o="setFieldsDict")}
defaultFieldValues ( volScalarFieldValue Q1 {H_LOW} );
regions ( boxToCell {{ box ({x0 - 1} -100 -100) ({dam} 100 100);
  fieldValues ( volScalarFieldValue Q1 {h_high} ); }} );
""")
    (case / "constant").mkdir(parents=True, exist_ok=True)
    for i, val in enumerate([0.0, H_LOW, 0.0, 0.0]):
        w(case / "0" / f"Q{i}", f"""{HDR.format(c="volScalarField", o=f"Q{i}")}
dimensions [0 0 0 0 0 0 0]; internalField uniform {val};
boundaryField {{
  outer {{ type zeroGradient; }}
  coupled {{ type zeroGradient; }}
  sides {{ type empty; }}
  topAndBottom {{ type empty; }}
}}
""")


def read_case(case):
    """`(t, Q)` of a zoomyFoam case's time directories."""
    def field(d, n):
        a = (d / n).read_text().split("internalField")[1]
        if "nonuniform" in a[:60]:
            return np.array(a.split("(", 1)[1].split(")", 1)[0].split(), float)
        return np.full(N_ARM, float(a.split("uniform")[1].split(";")[0]))
    dirs = sorted((d for d in case.iterdir() if d.is_dir() and (d / "Q1").exists()),
                  key=lambda d: float(d.name))
    return (np.array([float(d.name) for d in dirs]),
            np.stack([np.stack([field(d, f"Q{i}") for i in range(4)]) for d in dirs]))


def ledger(path):
    """The seam ledger rows `(t, interface, q*)` (the interfaces in the function object's
    order)."""
    out, seen = [], {}
    for r in csv.DictReader(open(path)):
        t = round(float(r["t"]), 9)
        k = seen[t] = seen.get(t, -1) + 1
        out.append((t, k, float(r["target"])))
    return np.array(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=("pair", "triple"))
    ap.add_argument("out")
    ap.add_argument("work", nargs="?")
    ap.add_argument("--perturb", type=float, default=0.0)
    a = ap.parse_args()
    work = Path(a.work or tempfile.mkdtemp(prefix="sme_vof_old_")).resolve()
    work.mkdir(parents=True, exist_ok=True)
    binary = build(work)
    run = work / f"run_{a.mode}{'_p' if a.perturb else ''}"
    shutil.rmtree(run, ignore_errors=True)
    run.mkdir()
    arms = [vof.Arm(n, f"{n}Mesh", "VofInletMesh" if s == "right" else "VofOutletMesh",
                    "left" if s == "right" else "right") for n, (_, s, _) in ARMS[a.mode].items()]
    config = vof.write_config(run / "precice-config.xml", arms=arms, t_end=T_END,
                              window=WINDOW, exchange=run)
    tank = vof.Tank(h0=H_LOW)
    tank.fo.update(FO[a.mode])
    case = vof.write_case(run / "vof_case", tank, arms=arms, config=config, t_end=T_END,
                          window=WINDOW, write_interval=DT_WRITE)
    for n, (dom, side, dam) in ARMS[a.mode].items():
        sme_case(run / f"{n}_case", n, dom, side, dam, config, H_HIGH + a.perturb)
    import importlib.util
    spec = importlib.util.spec_from_file_location("create_model", FOAM_ROOT / "create_model.py")
    cm = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cm)
    lib = vof.coupling_library(cm.build_system_model(1, outer="wall", closure="newtonian",
                                                     bcs="coupling", project_nz=NZ))
    lines = [f"export LD_LIBRARY_PATH={lib}:$LD_LIBRARY_PATH", "unset FOAM_SIGFPE FOAM_SETNAN"]
    for n in ARMS[a.mode]:
        lines.append(f"(cd {run}/{n}_case && blockMesh > log.blockMesh 2>&1 && "
                     "{ [ ! -f system/setFieldsDict ] || setFields > log.setFields 2>&1; })")
    lines.append(f"(cd {run}/vof_case && blockMesh > log.blockMesh 2>&1 && "
                 "setFields > log.setFields 2>&1)")
    lines.append(f"cd {run}")
    for n in ARMS[a.mode]:
        lines.append(f"{binary} -case {n}_case > log.{n} 2>&1 &")
    lines.append("foamRun -case vof_case > log.vof 2>&1; R=$?; wait; exit $R")
    r = subprocess.run(_apptainer_cmd("\n".join(lines), binds=[work, lib]))
    if r.returncode:
        raise SystemExit(f"old reference run failed (see {run}/log.*)")
    res = {"t_end": T_END, "mode": a.mode, "perturb": a.perturb}
    for n in ARMS[a.mode]:
        t, Q = read_case(run / f"{n}_case")
        res[f"{n}_t"], res[f"{n}_Q"] = t, Q
    res["ledger"] = ledger(case / "ledger.csv")
    np.savez(a.out, **res)
    print("->", a.out)


if __name__ == "__main__":
    main()
