#!/usr/bin/env bash
# Self-contained E2E for the GUI post-processing chain routing.
#
# 1. Resolves the postprocess sif (ghcr :latest -> .cache/, else local
#    containers/zoomy_postprocess.sif). The image is bind-mounted with the
#    working-tree zoomy_server so the server exposes the chain-routing routes.
# 2. Generates a small SWE-1D result store (+ model.py) with ZOOMY_PY.
# 3. Serves the postprocess backend on port 8197 ONLY, waits for /health.
# 4. Runs postproc_chain.mjs — drives HttpAdapter.runPostprocChain (the exact
#    GUI client path): submit {to_vtk, lift3d} -> poll -> fetch artifacts.
# 5. Asserts the lifted store (simulation_3d.h5) opens via zoomy_plotting.
# The container is ALWAYS torn down on exit (trap); only port 8197 is touched.
set -euo pipefail

E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$E2E/../../../.." && pwd)"           # -> repo root
CACHE="$E2E/.cache"; mkdir -p "$CACHE"
PORT=8197
WORK="$E2E/work/postproc_chain"; rm -rf "$WORK"; mkdir -p "$WORK"
export ZOOMY_PY="${ZOOMY_PY:-/mnt/userdrive/Users/home/adam-obbpb5az1dhsjzf/micromamba/envs/zoomy/bin/python}"

SERVER_PID=""
cleanup() {
    local rc=$?
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
    fuser -k "$PORT/tcp" 2>/dev/null || true
    return $rc
}
trap cleanup EXIT INT TERM

# ---- 1. resolve the postprocess sif ----
SIF=""
CACHED="$CACHE/zoomy_postprocess_sif.sif"
if [ -f "$CACHED" ]; then
    SIF="$CACHED"
else
    echo ">> pulling oras://ghcr.io/zoomylab/zoomy_postprocess_sif:latest -> $CACHED"
    if apptainer pull "$CACHED" "oras://ghcr.io/zoomylab/zoomy_postprocess_sif:latest" 2>/dev/null; then
        SIF="$CACHED"
    else
        echo ">> ghcr pull failed; falling back to local containers/zoomy_postprocess.sif"
        SIF="$ROOT/containers/zoomy_postprocess/zoomy_postprocess.sif"
    fi
fi
[ -f "$SIF" ] || { echo "!! no postprocess sif available"; exit 1; }
echo ">> sif: $SIF"

# ---- 2. generate a small SWE-1D store + model.py ----
echo ">> generating SWE-1D fixture store"
"$ZOOMY_PY" "$E2E/make_store_fixture.py" "$WORK" || { echo "!! fixture generation failed"; exit 1; }
STORE="$WORK/simulation.h5"; MODEL="$WORK/model.py"
[ -f "$STORE" ] && [ -f "$MODEL" ] || { echo "!! fixture missing store/model"; exit 1; }

# ---- 3. serve postprocess on 8197 (working-tree zoomy_server bind-mounted) ----
fuser -k "$PORT/tcp" 2>/dev/null || true
SP="/usr/local/lib/python3.11/site-packages/zoomy_server"
echo ">> starting postprocess server on :$PORT"
( cd "$ROOT" && exec apptainer run \
    --bind "$ROOT/library/zoomy_server/zoomy_server:$SP" \
    "$SIF" "$PORT" ) >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
deadline=$(( $(date +%s) + 180 ))
until curl -sf "http://localhost:$PORT/api/v1/health" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || { echo "!! server never healthy"; tail -30 "$WORK/server.log"; exit 1; }
    sleep 2
done
echo ">> health: $(curl -s http://localhost:$PORT/api/v1/health)"

# ---- 4. drive the chain via the real client (HttpAdapter.runPostprocChain) ----
node "$E2E/postproc_chain.mjs" --url "http://localhost:$PORT" \
    --store "$STORE" --model "$MODEL" --out "$WORK/artifacts" --steps to_vtk,lift3d

# ---- 5. the lifted store must open via zoomy_plotting ----
echo ">> opening the lifted store (simulation_3d.h5) via zoomy_plotting"
"$ZOOMY_PY" - "$WORK/artifacts/simulation_3d.h5" <<'PY'
import sys, zoomy_plotting as zp
s = zp.read_hdf5(sys.argv[1])
assert s.n_snapshots > 0 and s.n_cells > 0, s
print(f"OK lifted store: dim={s.dim} n_cells={s.n_cells} n_snapshots={s.n_snapshots} fields={list(s.field.keys())}")
PY

echo ">> POSTPROC CHAIN E2E: PASS"
