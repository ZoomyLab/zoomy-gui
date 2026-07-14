#!/usr/bin/env node
/**
 * Five-session end-to-end harness for the Zoomy GUI.
 *
 * Proves, headlessly, exactly what a GUI user does with
 * ``projects/zoomy-cases.zip``: for each of its five sessions
 *   Bingham (analytics) / Bingham roll-wave / Malpasset dam break /
 *   Malpasset (AMReX) / SME-VOF coupling (replay)
 * it
 *   1. reads the session's card selections + overrides from project.json,
 *   2. resolves the case spec exactly as app.js::gatherCaseSpec does
 *      (merged card catalog + overrides + two-level settings),
 *   3. composes the percent-format case .py via zoomy_cli::composeCase,
 *   4. submits it to the right backend server over the /api/v1 HTTP API
 *      (HttpAdapter.submitCase: POST /cases -> poll -> download simulation.h5),
 *   5. asserts the downloaded HDF5 is non-trivial, and
 *   6. materializes the case folder (zoomy_prepost.case.to_folder) and runs
 *      the case's OWN visualize.py, asserting >= 1 figure (png/gif).
 *
 * This driver is HTTP-only: it assumes each session's backend server is
 * already reachable on its port (run_sessions.sh brings the containers up).
 *
 * Usage:
 *   node run_sessions.mjs [--session <title>] [--url <url>] [--compose-only] [--keep]
 *   --session       run only the session whose title contains this string
 *   --url           backend base URL for the single --session run (else localhost:<port>)
 *   --compose-only  resolve + compose + materialize only; skip server + viz
 *   --keep          accepted for parity with run_sessions.sh (no-op here; work/ is always kept)
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const E2E = __dirname;
const GUI = path.resolve(E2E, "..", "..");            // library/zoomy_gui
const LIB = path.resolve(GUI, "..");                  // library
const CLI = path.join(LIB, "zoomy_cli");              // library/zoomy_cli
const ZIP = path.join(GUI, "projects", "zoomy-cases.zip");
const WORK = path.join(E2E, "work");

// jszip lives in zoomy_cli's node_modules; resolve from there.
const cliRequire = createRequire(path.join(CLI, "node.mjs"));
const JSZip = cliRequire("jszip");
const { ZoomyCLI, HttpAdapter } = await import(pathToFileURL(path.join(CLI, "node.mjs")));

const PY = process.env.ZOOMY_PY ||
    "/mnt/userdrive/Users/home/adam-obbpb5az1dhsjzf/micromamba/envs/zoomy/bin/python";

// ------------------------------------------------------------------ config
// Per-session harness knobs. selections + overrides come from project.json;
// only the backend routing + smoke-run time_end + viz-check hints live here.
const SESSIONS = [
    { id: "session-bingham-analytics", title: "Bingham (analytics)",
      tag: "numpy", port: 8190, timeEnd: null, timeoutMs: 6 * 60e3,
      outputH5: null, localRun: false, localOnly: true },
    // threshold runs its OWN 3-beta sweep in run.py (visualize.py reads the npz),
    // so it is localOnly with a SMALL t_end override (physical seconds — do NOT
    // run the ~100 min full sweep); GUI output_snapshots default trims frames.
    { id: "session-bingham-threshold", title: "Bingham (threshold)",
      tag: "numpy", port: 8190, timeEnd: 4.0, timeoutMs: 10 * 60e3,
      outputH5: null, localRun: false, localOnly: true },
    { id: "session-bingham",         title: "Bingham roll-wave",
      tag: "numpy", port: 8190, timeEnd: 0.05, timeoutMs: 8 * 60e3,
      outputH5: "output/bingham_permanent_rollwave.h5", localRun: false },
    { id: "session-malpasset",       title: "Malpasset dam break",
      tag: "jax",   port: 8191, timeEnd: 20.0, timeoutMs: 20 * 60e3,
      outputH5: "output/malpasset_sme_l1.h5",  localRun: false },
    { id: "session-malpasset-amrex", title: "Malpasset (AMReX)",
      tag: "amrex", port: 8192, timeEnd: 10.0, timeoutMs: 20 * 60e3,
      outputH5: "output/malpasset_amrex.h5",   localRun: false },
    { id: "session-coupling",        title: "SME-VOF coupling (replay)",
      tag: "numpy", port: 8193, timeEnd: null, timeoutMs: 15 * 60e3,
      outputH5: null, localRun: true },
];

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const opt = { session: null, url: null, composeOnly: false, keep: false };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--session") opt.session = argv[++i];
    else if (a === "--url") opt.url = argv[++i];
    else if (a === "--port") opt.port = parseInt(argv[++i], 10);
    else if (a === "--compose-only") opt.composeOnly = true;
    else if (a === "--keep") opt.keep = true;
    else { console.error("unknown arg:", a); process.exit(2); }
}

// ------------------------------------------------------------------ catalog
const stripCard = (id) => String(id || "").replace(/^card-/, "");

function loadJsonSafe(p) {
    try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { return null; }
}

/** Mirror zoomy_cli/cli.js::_loadCardsFolder — merge default/generated/user
 *  per category by id, first-wins. Returns { model:{id:card}, mesh, solver,
 *  visualization }. */
function loadCatalog(guiDir) {
    const categories = [
        { dir: "models", tab: "model" },
        { dir: "solvers", tab: "solver" },
        { dir: "meshes", tab: "mesh" },
        { dir: "visualizations", tab: "visualization" },
    ];
    const out = {};
    for (const cat of categories) {
        const cardsDir = path.join(guiDir, "cards", cat.dir);
        const merged = {};
        // Authored registry: the single default.json per tab (the
        // generated.json / user.json merge tiers were removed).
        const list = loadJsonSafe(path.join(cardsDir, "default.json")) || [];
        for (const c of list) if (!merged[c.id]) merged[c.id] = c;
        out[cat.tab] = merged;
    }
    return out;
}

// ------------------------------------------------------------------ project.json
async function loadProject(zipPath) {
    const buf = fs.readFileSync(zipPath);
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file("project.json");
    if (!entry) throw new Error("project.json not found in " + zipPath);
    return JSON.parse(await entry.async("string"));
}

// ------------------------------------------------------------------ spec (gatherCaseSpec mirror)
const fillTemplate = (t, init) => String(t || "").replace(/\{(\w+)\}/g,
    (_m, k) => (init && init[k] !== undefined ? init[k] : "{" + k + "}"));

/** app.js::gatherCaseSpec::_rc — resolved code for a card, override-first. */
function resolveCode(state, card) {
    const d = (card && (card.template || card.snippet)) || "";
    if (state.code && state.code !== d) return state.code;
    if (card && card.template) {
        const init = (state.params && Object.keys(state.params).length) ? state.params : card.init;
        return fillTemplate(card.template, init);
    }
    return state.code || "";
}

const GENERAL_KEYS = { time_end: 1, TIME_END: 1, cfl: 1, CFL: 1, output_snapshots: 1, mesh: 1 };

/** Faithful port of app.js::gatherCaseSpec for a project session. */
function resolveSpec(session, project, catalog, cli, timeEnd) {
    const sess = project.sessions.find((s) => s.id === session.id);
    if (!sess) throw new Error("session not in project.json: " + session.id);
    const sel = sess.selections, ov = sess.cardOverrides || {};

    const modelCard = catalog.model[stripCard(sel.model)];
    const meshCard = catalog.mesh[stripCard(sel.mesh)];
    const solverCard = catalog.solver[stripCard(sel.solver)];
    const vizCard = sel.visualization ? catalog.visualization[stripCard(sel.visualization)] : null;
    if (!modelCard || !meshCard || !solverCard)
        throw new Error("missing catalog card for " + JSON.stringify(sel));

    const state = (cid) => ({
        code: (ov[cid] && ov[cid].code) || "",
        params: (ov[cid] && ov[cid].params) || {},
    });
    const modelState = state(sel.model), meshState = state(sel.mesh), solverState = state(sel.solver);

    const tag = solverCard.requires_tag || "numpy";

    // TWO-LEVEL settings: general keys valid for every backend + a per-backend branch.
    const general = { time_end: 0.1, cfl: 0.45, output_snapshots: 10 };
    const branch = {};
    const params = Object.assign({}, solverState.params);
    if (timeEnd != null) params.time_end = timeEnd;   // HARNESS smoke-run override
    for (const k of Object.keys(params)) {
        if (GENERAL_KEYS[k]) general[k.toLowerCase()] = params[k];
        else branch[k] = params[k];
    }
    const settings = Object.assign({}, general, { backend: tag });
    if (Object.keys(branch).length) settings[tag] = branch;

    const spec = {
        meta: {
            title: (modelCard.title || "model") + " · " + (meshCard.title || "mesh"),
            description: "Composed by the Zoomy GUI e2e harness",
        },
        model: { code: resolveCode(modelState, modelCard), class_path: modelCard["class"] || null, init: modelCard.init || {} },
        mesh: { code: resolveCode(meshState, meshCard), spec: meshCard.init || null },
        settings,
        solver: { tag, params },
    };
    // Custom run section: a solver card whose CODE was overridden carries the
    // case's own runner -> spec.run (composeCase keeps it over the default).
    const solverDefault = (solverCard.template || solverCard.snippet || "");
    if (solverState.code && solverState.code !== solverDefault && solverState.code.trim())
        spec.run = { code: solverState.code };
    // Visualization: selected viz card code wrapped in the notebook prelude.
    if (vizCard) {
        const vizCode = resolveCode(state(sel.visualization), vizCard);
        if (vizCode) spec.visualization = { code: cli.vizPrelude() + "\n" + vizCode };
    }
    return spec;
}

// ------------------------------------------------------------------ helpers
function sh(cmd, args, o = {}) {
    return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20, ...o });
}

/** HDF5 magic + size check — a non-trivial store, node-only (no python). */
function assertNonTrivialH5(p) {
    const st = fs.statSync(p);
    if (st.size < 2048) throw new Error(`HDF5 too small (${st.size} B)`);
    const fd = fs.openSync(p, "r");
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    fs.closeSync(fd);
    const MAGIC = Buffer.from([0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!head.equals(MAGIC)) throw new Error("not an HDF5 file (bad magic)");
    return st.size;
}

function figuresNewerThan(dir, sinceMs) {
    const found = [];
    const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const fp = path.join(d, e.name);
            if (e.isDirectory()) walk(fp);
            else if (/\.(png|gif)$/i.test(e.name)) {
                if (fs.statSync(fp).mtimeMs >= sinceMs - 1500) found.push(fp);
            }
        }
    };
    walk(dir);
    return found;
}

// ------------------------------------------------------------------ per-session
async function runSession(session, project, catalog, cli) {
    const t0 = Date.now();
    const dir = path.join(WORK, session.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    // 1-3. resolve + compose + materialize
    const spec = resolveSpec(session, project, catalog, cli, session.timeEnd);
    const casePy = cli.composeCase(spec);
    const casePath = path.join(dir, "case.py");
    fs.writeFileSync(casePath, casePy);
    fs.writeFileSync(path.join(dir, "spec.json"), JSON.stringify(spec, null, 2));

    const folder = path.join(dir, "folder");
    const mk = sh(PY, ["-c",
        "import sys; from zoomy_prepost import case; case.to_folder(open(sys.argv[1]).read(), sys.argv[2])",
        casePath, folder]);
    if (mk.status !== 0)
        throw new Error("to_folder failed: " + (mk.stderr || mk.stdout).trim().split("\n").slice(-4).join(" | "));
    const wrote = fs.readdirSync(folder).sort().join(", ");

    if (opt.composeOnly) {
        return { ok: true, note: `compose-only; folder={${wrote}}`, secs: (Date.now() - t0) / 1e3 };
    }

    // Analysis-only session (Bingham analytics): NO server-side time-stepping and
    // NO simulation.h5 (the case writes .npz analytics stores, so the numpy
    // runner's results/hdf5 would 404). Run the composed folder's run.py (writes
    // the stores) then its visualize.py LOCALLY — mirrors the coupling row's
    // local run.py, minus the h5-download flow — and assert figures only.
    if (session.localOnly) {
        const vizStart = Date.now();
        const env = { ...process.env, MPLBACKEND: "Agg" };
        const rp = sh(PY, ["run.py"], { cwd: folder, env });
        if (rp.status !== 0)
            throw new Error("run.py (analytics) failed: " +
                (rp.stderr || rp.stdout).trim().split("\n").slice(-6).join(" | "));
        const vz = sh(PY, ["visualize.py"], { cwd: folder, env });
        if (vz.status !== 0)
            throw new Error("visualize.py failed: " +
                (vz.stderr || vz.stdout).trim().split("\n").slice(-6).join(" | "));
        const figs = figuresNewerThan(folder, vizStart);
        if (!figs.length) throw new Error("no figure (png/gif) produced by visualize.py");
        return {
            ok: true,
            secs: (Date.now() - t0) / 1e3,
            note: `local-only (no server); figs=${figs.length} ` +
                  `[${figs.map((f) => path.relative(folder, f)).join(", ")}]`,
        };
    }

    // 4. submit to the backend server + download simulation.h5
    const url = opt.url && opt.session ? opt.url : `http://localhost:${opt.port || session.port}`;
    const http = new HttpAdapter({ url, tag: session.tag, pollMs: 3000 });
    await http.connect();
    const signal = AbortSignal.timeout(session.timeoutMs);
    let lastLog = 0;
    const res = await http.submitCase({ case_py: casePy }, {
        signal,
        onStatus: (s) => {
            const now = Date.now();
            if (now - lastLog > 20e3) {
                lastLog = now;
                const pr = s.progress != null ? ` ${(s.progress * 100).toFixed(0)}%` : "";
                process.stdout.write(`    [${session.id}] ${s.status}${pr} (t+${((now - t0) / 1e3).toFixed(0)}s)\n`);
            }
        },
    });
    http.disconnect();
    if (res.status !== "complete" || !res.hdf5) throw new Error("job did not complete: " + res.status);

    const dlH5 = path.join(dir, "downloaded.h5");
    fs.writeFileSync(dlH5, Buffer.from(res.hdf5));
    const h5size = assertNonTrivialH5(dlH5);

    // 5-6. execute the case's own visualization from the downloaded store
    const vizStart = Date.now();
    const env = { ...process.env, MPLBACKEND: "Agg" };
    if (session.localRun) {
        // coupling: the run card downloads the replay payload tree the viz reads
        const rp = sh(PY, ["run.py"], { cwd: folder, env });
        if (rp.status !== 0)
            throw new Error("run.py (replay download) failed: " +
                (rp.stderr || rp.stdout).trim().split("\n").slice(-4).join(" | "));
    } else {
        // bingham/malpasset/amrex: place the store where visualize.py reads it
        fs.copyFileSync(dlH5, path.join(folder, "simulation.h5"));
        const outAbs = path.join(folder, session.outputH5);
        fs.mkdirSync(path.dirname(outAbs), { recursive: true });
        fs.copyFileSync(dlH5, outAbs);
    }
    const vz = sh(PY, ["visualize.py"], { cwd: folder, env });
    if (vz.status !== 0)
        throw new Error("visualize.py failed: " +
            (vz.stderr || vz.stdout).trim().split("\n").slice(-6).join(" | "));

    const figs = figuresNewerThan(folder, vizStart);
    if (!figs.length) throw new Error("no figure (png/gif) produced by visualize.py");

    return {
        ok: true,
        secs: (Date.now() - t0) / 1e3,
        note: `h5=${(h5size / 1024).toFixed(0)}KB, figs=${figs.length} ` +
              `[${figs.map((f) => path.relative(folder, f)).join(", ")}]`,
    };
}

// ------------------------------------------------------------------ main
async function main() {
    fs.mkdirSync(WORK, { recursive: true });
    const project = await loadProject(ZIP);
    const catalog = loadCatalog(GUI);
    const cli = new ZoomyCLI({ storage: {}, pyodide: {} });   // stubs: composeCase is pure

    let sessions = SESSIONS;
    if (opt.session) {
        const q = opt.session.toLowerCase();
        sessions = SESSIONS.filter((s) => s.title.toLowerCase().includes(q) || s.id.includes(q));
        if (!sessions.length) { console.error("no session matches:", opt.session); process.exit(2); }
    }

    console.log(`\nZoomy GUI e2e — ${sessions.length} session(s)` +
        (opt.composeOnly ? " (compose-only)" : "") + `\n${"=".repeat(60)}`);

    const results = [];
    for (const s of sessions) {
        console.log(`\n>>> ${s.title}  [${s.tag} @ :${opt.port || s.port}]`);
        try {
            const r = await runSession(s, project, catalog, cli);
            console.log(`    PASS (${r.secs.toFixed(0)}s) — ${r.note}`);
            results.push({ title: s.title, ok: true, secs: r.secs, note: r.note });
        } catch (e) {
            console.log(`    FAIL — ${e.message}`);
            results.push({ title: s.title, ok: false, secs: 0, note: e.message });
        }
    }

    console.log(`\n${"=".repeat(60)}\nSUMMARY`);
    for (const r of results)
        console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.title.padEnd(28)} ${r.ok ? r.secs.toFixed(0) + "s  " + r.note : r.note}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(`${"=".repeat(60)}\n${results.length - failed}/${results.length} passed\n`);
    process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("harness error:", e); process.exit(1); });
