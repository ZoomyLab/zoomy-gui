# %% [markdown] zoomy={"role":"meta","title":"VAM dam break (1D)","description":"Vertically-averaged moment."}
# # VAM dam break (1D)
# 
# Vertically-averaged moment.

# %% [markdown] zoomy={"role":"heading","section":"model"}
# ## Model

# %% zoomy={"role":"model","class_path":"zoomy_core.model.models.VAM","init":{"level":2}}


# %% [markdown] zoomy={"role":"heading","section":"mesh"}
# ## Mesh

# %% zoomy={"role":"mesh","spec":{"x_min":0,"x_max":10,"n_cells":50}}


# %% [markdown] zoomy={"role":"heading","section":"settings"}
# ## Solver settings

# %% zoomy={"role":"settings","settings":{"backend":"split-numpy"}}
settings = {
  "backend": "split-numpy"
}

# %% [markdown] zoomy={"role":"heading","section":"run"}
# ## Run

# %% zoomy={"role":"run"}
# Runs IN-PROCESS on a symbolic solver (zoomy_core.symsolver): JAX for the jax backend,
# AMReX for amrex, foam for OpenFOAM, NumPy otherwise (no server needed: JupyterLite, the
# GUI's browser kernel, any env with zoomy_core). Standalone as `python run.py` in a
# materialized case folder (the zoomy-server generic runner executes exactly this file).
import json
import os

# Headless shim: the model/mesh cards end in display(model.describe()),
# a Jupyter builtin. Define a no-op so `python run.py` runs on any
# backend / plain env (the GUI worker & Jupyter provide the real one).
try:
    display
except NameError:
    def display(*_a, **_k):
        pass

# Folder form: the notebook defines model/mesh/settings in the cells above;
# a standalone run.py loads them from the sibling case-folder files.
if "model" not in globals():
    exec(open("model.py").read())
if "mesh" not in globals():
    exec(open("mesh.py").read())
if "settings" not in globals():
    settings = json.load(open("settings.json"))

from zoomy_core.numerics import Limiter, NumericalSystemModel, ReconstructionSpec
from zoomy_core.symsolver.discretization.time import Imex
from zoomy_core.symsolver.strategies.chorin import predictor_nsm

# effective settings = general keys + this backend's branch
_backend = settings.get("backend", "numpy")
_eff = {k: v for k, v in settings.items() if not isinstance(v, dict)}
_eff.update(settings.get(_backend, {}))
_split = globals().get("split")         # a VAM model card binds the Chorin split

_reconstruction = ReconstructionSpec(
    order=int(_eff.get("reconstruction_order", _eff.get("order", 1))),
    limiter=Limiter(_eff["limiter"]) if "limiter" in _eff else Limiter.venkatakrishnan)
if _split is None:
    nsm = NumericalSystemModel.from_system_model(model, reconstruction=_reconstruction)
    _systems = ()
else:   # the predictor on the full state: positive Rusanov, rescaled momenta
    nsm = predictor_nsm(_split.SM_pred, _split.SM_press, _split.SM_corr, _reconstruction)
    _systems = (_split.SM_press, _split.SM_corr)

_time_end = float(_eff.get("time_end", 0.1))
_options = dict(time_end=_time_end, cfl=float(_eff.get("cfl", 0.9)),
                dt_write=_time_end / int(_eff.get("output_snapshots", 10)),
                imex=Imex(_eff["imex"]) if _eff.get("imex") else False)
_h5 = os.path.abspath("simulation.h5")
if _backend in ("amrex", "OpenFOAM", "foam"):   # C++: print, build, march, read back
    from zoomy_core.mesh import ensure_lsq_mesh
    from zoomy_core.symsolver.backend_cxx import initial_state, write_snapshots
    if _backend == "amrex":
        from zoomy_amrex.symsolver import (SymbolicChorinSolverAmrex as Chorin,
                                           SymbolicHyperbolicSolverAmrex as Hyperbolic)
    else:
        from zoomy_foam.symsolver import (SymbolicChorinSolverFoam as Chorin,
                                          SymbolicHyperbolicSolverFoam as Hyperbolic)
    _mesh = ensure_lsq_mesh(mesh, nsm)
    solver = (Chorin if _systems else Hyperbolic)(**_options)
    _model = (nsm, *_systems) if _systems else nsm
    solver.run(_mesh, _model, initial_state(_mesh, nsm), os.path.abspath("_" + _backend))
    write_snapshots(_h5, _mesh, nsm, solver.snapshots)
else:
    if _backend == "jax":       # in the jax backend's container
        from zoomy_jax.symsolver.solver import (SymbolicChorinSolverJax as Chorin,
                                                SymbolicHyperbolicSolverJax as Hyperbolic)
    else:
        from zoomy_core.symsolver.numpy_backend import (SymbolicChorinSolverNumpy as Chorin,
                                                        SymbolicHyperbolicSolverNumpy as Hyperbolic)
    solver = (Chorin if _systems else Hyperbolic)(**_options, output=_h5)
    Q, Qaux = solver.setup(mesh, nsm, *_systems)
    solver.run(Q, Qaux)
print("done -> simulation.h5")

# %% [markdown] zoomy={"role":"heading","section":"visualization"}
# ## Visualization

# %% zoomy={"role":"visualization"}
import matplotlib
import matplotlib.pyplot as plt
import zoomy_plotting as zp

store = zp.read_hdf5("simulation.h5")
time_step = store.n_snapshots - 1        # last snapshot
field_name = None                        # None -> first field
try:
    display                              # provided by Jupyter
except NameError:
    display = lambda *a: None            # plain-script fallback
field = next(iter(store.field.keys()))
with zp.apply_style():
    fig, ax = plt.subplots()
    zp.MatplotlibPlotter(store).plot(ax, time_step=time_step, field=field,
                                     **({} if store.dim == 1 else {"cmap": "viridis", "colorbar": True}))
    if store.times is not None and len(store.times):
        ax.set_title(f"{field} — t = {float(store.times[time_step]):.3f}")
fig.savefig("simulation.png", dpi=150, bbox_inches="tight")
display(fig)
print("figure -> simulation.png")
