# GUI

This repository is a submodule of the the [Zoomy Lab](https://github.com/ZoomyLab/Zoomy) repository.

## Solver cards

The NumPy and JAX solver cards run the symbolic solvers (`zoomy_core.symsolver`, `zoomy_jax.symsolver`).

| card | solver | runs in |
|---|---|---|
| Hyperbolic (NumPy) | `zoomy_core.symsolver.numpy_backend.SymbolicHyperbolicSolverNumpy` | the browser (Pyodide) |
| IMEX (NumPy) | the same with `imex` = `lie` / `ssp2` | the browser |
| Split / Chorin (NumPy) | `SymbolicChorinSolverNumpy` on the VAM model card's `split` | the browser |
| Hyperbolic (JAX), IMEX (JAX) | `zoomy_jax.symsolver.solver.SymbolicHyperbolicSolverJax` (`SymbolicChorinSolverJax` for a `split`) | a jax backend |
| Hyperbolic (AMReX), Split (AMReX) | unchanged, legacy `zoomy_amrex.solvers.HyperbolicSolver` / `SplitSolver`: `zoomy_amrex.symsolver` builds and runs through `apptainer exec zoomy_amrex.sif` from the host, while the amrex backend is zoomy-server inside that image | an amrex backend |
| DMPlex, Firedrake, zoomyFoam, incompressibleVOF | the backend's own solver (no symbolic solver card) | that backend |

- The NumPy cards read the card's Parameters from `settings`; `typed_kwargs(cls, settings)` (`engine.py`) keeps the solver's own parameters and turns a dropdown's string back into the option member (`imex="ssp2"` -> `Imex.ssp2`).
- A backend card carries no code: the case's Run cell is the generated runner (`zoomy_cli` `_runCode`, mirrored by `zoomy_prepost.case._run_code`): the symbolic JAX solver for `settings["backend"] == "jax"`, the symbolic NumPy solver otherwise.
- The thesis QR sessions carry their own run cards, ported by `projects/tools/port_symsolver_sessions.py` (see `projects/tools/README.md`).

## Results shelf — save a run, open it by name from a viz card

A finished run's result store can be **saved under a name** and any
visualization can **open other results by name** — across sessions and runs.

**Save.** After a simulation completes, the Dashboard *Status* card shows a
save (&#128190;) button — *Save result as…*. Name the run and it is shelved:

- a **remote** run (a connected backend) is saved into that server's results
  registry (`POST /api/v1/results {job_id, name}`) and staged locally, so it
  survives the job being GC'd and is reachable by other clients;
- a **local** (in-browser Pyodide) run is saved into the browser's result
  shelf (IDBFS-backed, so it survives a reload).

Names are slugged (`SWE Reference!` → `swe-reference`).

**Open in a viz card.** The Visualization tab has a *Results* picker listing
every reachable result (connected backends + the local shelf). Click one to
stage it into the Pyodide filesystem, then reference it in any viz card:

```python
ref = open_result("swe-reference")        # a zoomy_plotting store
zp.MatplotlibPlotter(store).plot(ax, ...)  # the current run
ax.plot(ref.cell_centers(), ref.field["h"][time_step], "--", label="reference")
# open_results(["run-a", "run-b"]) -> {name: store}; list_results() -> names
```

`open_result(name)` returns a fresh `zoomy_plotting` store and does **not**
touch the current run's `store`, so comparisons compose cleanly.

### CLI surface (`zoomy_cli`)

`ZoomyCLI` mirrors this over both transports:

- `saveResult(tag, jobId, name)` / `listResults(tag)` / `fetchResult(tag, name)`
  / `deleteResult(tag, name)` — the backend's server-side registry;
- `saveResultLocal(name)` / `listResultsLocal()` — the local Pyodide shelf;
- `stageResult(name, {tag}|{bytes})` — put a result into the Pyodide FS so
  `open_result(name)` finds it.

