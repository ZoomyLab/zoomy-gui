# GUI

This repository is a submodule of the the [Zoomy Lab](https://github.com/ZoomyLab/Zoomy) repository.

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

