/**
 * Fast syntax + JSON validation for all GUI files.
 * Runs in seconds without loading Pyodide.
 */
const fs = require("fs");
const path = require("path");

const GUI_DIR = path.resolve(__dirname, "..");
let errors = 0;

function check(label, fn) {
    try {
        fn();
        console.log("  ✅", label);
    } catch (e) {
        console.log("  ❌", label, "—", e.message);
        errors++;
    }
}

console.log("JS syntax:");
for (const f of ["core.js", "app.js", "backend.js", "param_widgets.js", "pyodide-worker.js", "sw.js"]) {
    check(f, () => new Function(fs.readFileSync(path.join(GUI_DIR, f), "utf8")));
}

console.log("\nJSON validity:");
for (const f of [
    "cards/tabs.json",
    "cards/meshes/default.json",
    "cards/meshes/generated.json",
    "cards/models/default.json",
    "cards/solvers/default.json",
    "cards/visualizations/default.json",
]) {
    check(f, () => JSON.parse(fs.readFileSync(path.join(GUI_DIR, f), "utf8")));
}

console.log("\nSnippet files exist:");
for (const f of ["snippets/mesh_2d_mpl.py", "snippets/mesh_3d_plotly.py", "snippets/sine_wave.py", "snippets/topo.py"]) {
    check(f, () => { if (!fs.existsSync(path.join(GUI_DIR, f))) throw new Error("missing"); });
}

process.exit(errors > 0 ? 1 : 0);
