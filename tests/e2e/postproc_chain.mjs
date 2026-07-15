/**
 * Post-processing chain E2E driver (HTTP-only).
 *
 * Proves the GUI's chain routing against a REAL postprocess backend: it drives
 * the SAME client code the browser runs — `HttpAdapter.runPostprocChain` —
 * uploading a result store + the enabled steps to `POST /api/v1/postprocess`,
 * polling, and downloading the transformed artifacts. It then asserts the
 * expected artifacts exist and writes them to disk so the wrapper can open the
 * lifted store via zoomy_plotting.
 *
 * Usage:
 *   node postproc_chain.mjs --url http://localhost:8197 \
 *        --store <simulation.h5> --model <model.py> --out <dir> \
 *        [--steps to_vtk,lift3d]
 */
import fs from "node:fs";
import path from "node:path";
import { HttpAdapter } from "../../../zoomy_cli/src/adapters/http_adapter.mjs";

function arg(name, def) {
    const i = process.argv.indexOf("--" + name);
    return i !== -1 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const url = arg("url", "http://localhost:8197");
const storePath = arg("store");
const modelPath = arg("model");
const outDir = arg("out");
const steps = arg("steps", "to_vtk,lift3d").split(",").map((s) => s.trim()).filter(Boolean);

if (!storePath || !outDir) {
    console.error("need --store <h5> and --out <dir>");
    process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

const storeBytes = new Uint8Array(fs.readFileSync(storePath));
const modelPy = modelPath ? fs.readFileSync(modelPath, "utf8") : null;

function fail(msg) { console.error("FAIL: " + msg); process.exit(1); }

const a = new HttpAdapter({ url, pollMs: 1000 });

const health = await a.connect().catch((e) => fail("connect: " + e.message));
console.log(">> connected:", url, "tag=" + a.tag);
if (a.tag !== "postprocess") fail("backend tag is '" + a.tag + "', expected 'postprocess'");

console.log(">> submitting chain [" + steps.join(", ") + "] with store " +
            storeBytes.byteLength + " B" + (modelPy ? " + model.py" : ""));
const res = await a.runPostprocChain({
    storeBytes, steps, nz: 6, modelPy,
    onStatus: (s) => { if (s && s.status) process.stdout.write("   job " + (s.job_id || "") + " " + s.status + "\r"); },
}).catch((e) => fail("runPostprocChain: " + e.message));
console.log("\n>> chain complete: job " + res.job_id + ", " + res.artifacts.length + " artifact(s)");

const names = res.artifacts.map((x) => x.name);
console.log("   artifacts:", names.join(", "));
for (const art of res.artifacts) {
    fs.writeFileSync(path.join(outDir, art.name), Buffer.from(art.bytes));
}

// Assertions: what the enabled steps must have produced.
function has(re) { return names.some((n) => re.test(n)); }
const expected = [];
if (steps.includes("to_vtk")) {
    expected.push(["to_vtk .pvd", /^simulation\.pvd$/]);
    expected.push(["to_vtk .vtu", /^simulation_\d+\.vtu$/]);
}
if (steps.includes("lift3d")) {
    expected.push(["lift3d .pvd", /^simulation_3d\.pvd$/]);
    expected.push(["lift3d .vtu", /^simulation_3d_\d+\.vtu$/]);
    expected.push(["lift3d .h5 (lifted store)", /^simulation_3d\.h5$/]);
}
expected.push(["normalized store", /^simulation\.h5$/]);

let ok = true;
for (const [label, re] of expected) {
    const present = has(re);
    console.log("   " + (present ? "PASS" : "FAIL") + "  " + label);
    ok = ok && present;
}
// every artifact non-empty
for (const art of res.artifacts) {
    if (!art.bytes.byteLength) { console.log("   FAIL  empty artifact " + art.name); ok = false; }
}
if (!ok) fail("missing/empty expected artifacts");

console.log(">> all artifact assertions passed; wrote " + res.artifacts.length + " file(s) to " + outDir);
process.exit(0);
