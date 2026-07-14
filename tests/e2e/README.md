# GUI four-session end-to-end harness

Proves, headlessly, exactly what a GUI user does with
`projects/zoomy-cases.zip` — for **each** of its four sessions:

| session | backend | port | smoke `time_end` |
|---------|---------|------|------------------|
| Bingham roll-wave        | numpy | 8190 | `0.05` (t′) |
| Malpasset dam break      | jax   | 8191 | `20.0` s |
| Malpasset (AMReX)        | amrex | 8192 | `10.0` s |
| SME-VOF coupling (replay)| numpy | 8193 | — (replay) |

For every session the harness:

1. reads the session's card **selections + overrides** from `project.json`
   (inside the zip);
2. resolves the case **spec** exactly as `app.js::gatherCaseSpec` does — merged
   card catalog (`cards/*/default.json` …, same merge as
   `zoomy_cli/cli.js::_loadCardsFolder`) + overrides + two-level `settings`
   (general keys `time_end/cfl/output_snapshots` + a per-backend branch),
   overriding `time_end` to a **small** smoke value via the solver params;
3. composes the percent-format case `.py` with `zoomy_cli::composeCase`;
4. submits it to the right backend server over the `/api/v1` HTTP API
   (`HttpAdapter.submitCase`: `POST /cases` → poll `GET /jobs/<id>` → download
   `GET /jobs/<id>/results/hdf5`);
5. asserts the downloaded HDF5 is **non-trivial** (HDF5 magic + size);
6. materializes the case folder (`zoomy_prepost.case.to_folder`), places the
   store where the case's `visualize.py` reads it (`simulation.h5` +
   `output/<name>.h5`; the coupling replay runs its `run.py` first to fetch the
   ~29 MB recorded-run payload), runs `visualize.py` headless (`MPLBACKEND=Agg`)
   and asserts **≥ 1 figure** (png/gif) was produced.

## Run it

Self-contained (manages the backend containers for you):

```bash
./run_sessions.sh                       # all four sessions
./run_sessions.sh --session Malpasset   # one session (title/id substring)
./run_sessions.sh --keep                # leave the containers running afterwards
./run_sessions.sh --compose-only        # resolve+compose+materialize, no server
```

`run_sessions.sh` starts one backend server container per requested session on
its dedicated test port, waits for `/api/v1/health`, runs the node driver, and
**always** tears the containers down on exit (`trap`; ports freed with
`fuser -k <port>/tcp`, only for 8190-8193). `--keep` leaves them up.

Driver only (bring your own servers on 8190-8193):

```bash
node run_sessions.mjs [--session <title>] [--url <url>] [--compose-only] [--keep]
```

The driver prints a per-session PASS/FAIL summary and exits non-zero if any
session fails.

## Backend images

sifs come from ghcr (`oras://ghcr.io/zoomylab/<name>_sif:latest`), cached under
`.cache/` on first use (`zoomy_numpy_sif`, `zoomy_jax_sif`, `zoomy_amrex_sif`).
Override a specific image with `ZOOMY_SIF_zoomy_amrex=/abs/path.sif`; if a ghcr
pull fails the wrapper falls back to `containers/<name>/<name>.sif`. jax runs on
CPU (`JAX_PLATFORMS=cpu` is set inside each case's `run.py`).

## Requirements

- `apptainer`, `node` (≥18 fetch), `curl`, `fuser`
- an env python with `zoomy_prepost` + `zoomy_plotting` (override with
  `ZOOMY_PY=/abs/python`; default is the machine's `zoomy` micromamba env)

## Artifacts

Per-session work lands in `work/<session-id>/`: `case.py`, `spec.json`,
`downloaded.h5`, and `folder/` (materialized case + the figures `visualize.py`
produced). `.cache/`, `work/` and logs are gitignored.
