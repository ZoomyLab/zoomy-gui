/**
 * Real worker boot test: mocks web worker globals, requires the
 * actual pyodide-worker.js source, and exercises the init → param →
 * exec → run_code flow using real Pyodide loaded in Node.
 *
 * This catches bugs like: "matplotlib not installed", "micropip not
 * installed", message-handling bugs, etc. — the kinds of things the
 * syntax test misses.
 *
 * Usage: node test_worker_boot.js
 */
const { loadPyodide } = require("pyodide");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const GUI_DIR = path.resolve(__dirname, "..");

async function main() {
    console.log("Booting Pyodide...");
    const py = await loadPyodide();

    // Build a fake worker sandbox that matches what pyodide-worker.js expects:
    // - importScripts: no-op (pyodide is loaded by Node's require)
    // - loadPyodide: returns our pre-loaded instance
    // - fetch: reads local files from GUI_DIR
    // - postMessage: captures messages
    // - onmessage: stores handler
    const messages = [];
    const sandbox = {
        console,
        importScripts: () => {},
        loadPyodide: async () => py,
        fetch: async (url) => {
            const filePath = path.join(GUI_DIR, url);
            const content = fs.readFileSync(filePath, "utf8");
            return { text: async () => content };
        },
        postMessage: (msg) => {
            messages.push(msg);
            if (msg.type === "log") console.log("  [worker]", msg.msg);
            if (msg.type === "error") console.log("  [worker ERROR]", msg.error);
        },
        onmessage: null,
        self: {},
        performance,
        AbortSignal,
        setTimeout,
        clearTimeout,
        URL,
        URLSearchParams,
    };
    sandbox.self = sandbox;  // self === global in workers
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);

    const workerSource = fs.readFileSync(path.join(GUI_DIR, "pyodide-worker.js"), "utf8");
    vm.runInContext(workerSource, sandbox);

    // Simulate messages sent from the main thread
    async function send(msg) {
        return new Promise((resolve, reject) => {
            const origPost = sandbox.postMessage;
            sandbox.postMessage = (reply) => {
                origPost(reply);
                if (reply.id === msg.id) {
                    if (reply.type === "result") { sandbox.postMessage = origPost; resolve(reply); }
                    else if (reply.type === "error") { sandbox.postMessage = origPost; reject(new Error(reply.error)); }
                }
            };
            Promise.resolve(sandbox.onmessage({ data: msg })).catch(reject);
        });
    }

    console.log("\nTest 1: initPyodide (via init cmd)");
    await send({ cmd: "init", id: 1 });
    console.log("  ✅ init OK");

    console.log("\nTest 2: run_code — plain numpy (should succeed with plot_type=none)");
    const r1 = await send({ cmd: "run_code", id: 2, code: "import numpy as np\nprint('hello', np.arange(3))" });
    const res1 = JSON.parse(r1.data);
    if (res1.status !== "success") {
        console.log("  ❌ FAIL:", res1.output.substring(0, 400));
        process.exit(1);
    }
    console.log("  ✅ ran plain numpy");

    console.log("\nTest 3: run_code — matplotlib (the bug the user hit)");
    const mpCode = `
import matplotlib
matplotlib.use('agg')
import matplotlib.pyplot as plt
import numpy as np
fig, ax = plt.subplots()
ax.plot(np.arange(10), np.arange(10)**2)
`;
    const r2 = await send({ cmd: "run_code", id: 3, code: mpCode });
    const res2 = JSON.parse(r2.data);
    if (res2.status !== "success") {
        console.log("  ❌ FAIL:");
        console.log("  ", res2.output.substring(0, 500));
        process.exit(1);
    }
    if (res2.plot_type !== "matplotlib" || !res2.plot_data) {
        console.log("  ❌ plot_type =", res2.plot_type, "plot_data =", res2.plot_data ? "present" : "missing");
        process.exit(1);
    }
    console.log("  ✅ matplotlib works, SVG size:", res2.plot_data.length);

    console.log("\nAll worker boot tests passed.");
}

main().catch(err => { console.error("\nTest crashed:", err); process.exit(1); });
