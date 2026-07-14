#!/usr/bin/env bash
# Self-contained container manager for the four-session GUI e2e harness.
#
# Brings up one Zoomy backend server container per session on a dedicated test
# port (8190-8193), waits for /api/v1/health, then runs run_sessions.mjs (the
# HTTP-only node driver) which resolves each session's card overrides, composes
# the case, submits it, downloads the HDF5 and runs the case's visualize.py.
# Containers are ALWAYS torn down on exit (trap); --keep leaves them running.
#
# Usage:
#   ./run_sessions.sh [--session <title>] [--keep] [--compose-only] [-- <extra mjs args>]
#
# Backends: numpy_sif (bingham + coupling), jax_sif (malpasset), amrex_sif
# (malpasset-amrex). sifs are taken from containers/<name>/<name>.sif if present,
# else tests/e2e/.cache/<name>_sif.sif, else pulled from ghcr into .cache/.
set -euo pipefail

E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$E2E/../../../.." && pwd)"          # library/zoomy_gui/tests/e2e -> repo root
CACHE="$E2E/.cache"
mkdir -p "$CACHE"

export ZOOMY_PY="${ZOOMY_PY:-/mnt/userdrive/Users/home/adam-obbpb5az1dhsjzf/micromamba/envs/zoomy/bin/python}"

# ---- parse args (session filter + flags pass through to the node driver) ----
SESSION_FILTER=""; KEEP=0; MJS_ARGS=()
while [ $# -gt 0 ]; do
    case "$1" in
        --session) SESSION_FILTER="$2"; MJS_ARGS+=(--session "$2"); shift 2 ;;
        --keep)    KEEP=1; MJS_ARGS+=(--keep); shift ;;
        --compose-only) MJS_ARGS+=(--compose-only); shift ;;
        --) shift; while [ $# -gt 0 ]; do MJS_ARGS+=("$1"); shift; done ;;
        *) MJS_ARGS+=("$1"); shift ;;
    esac
done

# ---- session -> (sif-name, adapter, port) table ----
# rows: "id|title|sifname|port"
ROWS=(
    "session-bingham|Bingham roll-wave|zoomy_numpy|8190"
    "session-malpasset|Malpasset dam break|zoomy_jax|8191"
    "session-malpasset-amrex|Malpasset (AMReX)|zoomy_amrex|8192"
    "session-coupling|SME-VOF coupling (replay)|zoomy_numpy|8193"
)

ALL_PORTS=(8190 8191 8192 8193)
PIDS=()

cleanup() {
    local rc=$?
    if [ "$KEEP" = "1" ]; then
        echo ">> --keep: leaving containers running on ${ALL_PORTS[*]}"
        return 0
    fi
    echo ">> tearing down containers"
    for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null || true; done
    # backstop: free ONLY these dedicated test ports
    for p in "${ALL_PORTS[@]}"; do fuser -k "$p/tcp" 2>/dev/null || true; done
    return $rc
}
trap cleanup EXIT INT TERM

resolve_sif() {   # echo a usable sif path for a sif-name, pulling if needed
    # The ghcr :latest image is the source of truth (the local containers/*.sif
    # can lag the case API — e.g. zoomy_amrex.solvers). Order:
    #   $ZOOMY_SIF_<name> override -> cached ghcr pull -> pull -> local fallback.
    local name="$1"
    local override_var="ZOOMY_SIF_${name}"
    local override="${!override_var:-}"
    local cached_sif="$CACHE/${name}_sif.sif"
    local local_sif="$ROOT/containers/$name/$name.sif"
    if [ -n "$override" ] && [ -f "$override" ]; then echo "$override"; return 0; fi
    if [ -f "$cached_sif" ]; then echo "$cached_sif"; return 0; fi
    echo ">> pulling oras://ghcr.io/zoomylab/${name}_sif:latest -> $cached_sif" >&2
    if apptainer pull "$cached_sif" "oras://ghcr.io/zoomylab/${name}_sif:latest" >&2; then
        echo "$cached_sif"; return 0
    fi
    echo ">> ghcr pull failed; falling back to local $local_sif" >&2
    [ -f "$local_sif" ] && { echo "$local_sif"; return 0; }
    echo "!! no sif for $name (ghcr + local both unavailable)" >&2; return 1
}

wait_health() {   # port, timeout-seconds
    local port="$1" deadline=$(( $(date +%s) + ${2:-180} ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if curl -sf "http://localhost:$port/api/v1/health" >/dev/null 2>&1; then return 0; fi
        sleep 2
    done
    echo "!! server on :$port never became healthy" >&2
    return 1
}

start_container() {   # sifname, port
    local sif; sif="$(resolve_sif "$1")"
    local port="$2"
    echo ">> starting $(basename "$sif") on :$port"
    fuser -k "$port/tcp" 2>/dev/null || true      # ensure the test port is free first
    ( cd "$ROOT" && exec apptainer run "$sif" "$port" ) \
        >"$CACHE/server_$port.log" 2>&1 &
    PIDS+=($!)
    wait_health "$port" 240
}

# ---- start only the containers the requested sessions need ----
for row in "${ROWS[@]}"; do
    IFS='|' read -r id title sifname port <<<"$row"
    if [ -n "$SESSION_FILTER" ]; then
        case "${title,,}::${id,,}" in
            *"${SESSION_FILTER,,}"*) : ;;
            *) continue ;;
        esac
    fi
    start_container "$sifname" "$port"
done

echo ">> running node driver: run_sessions.mjs ${MJS_ARGS[*]:-}"
node "$E2E/run_sessions.mjs" ${MJS_ARGS[@]+"${MJS_ARGS[@]}"}
