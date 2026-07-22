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
for (const f of ["core.js", "app.js", "param_widgets.js", "pyodide-worker.js", "sw.js"]) {
    check(f, () => new Function(fs.readFileSync(path.join(GUI_DIR, f), "utf8")));
}

console.log("\nJSON validity:");
for (const f of [
    "cards/tabs.json",
    "cards/meshes/default.json",
    "cards/models/default.json",
    "cards/solvers/default.json",
    "cards/visualizations/default.json",
]) {
    check(f, () => JSON.parse(fs.readFileSync(path.join(GUI_DIR, f), "utf8")));
}

/* Snippet files are DERIVED from the catalogs that reference them, so this
   check cannot go stale when a card is added or removed: every `snippet`
   path named by a card catalog (cards/<dir>/default.json) or by the preview
   manifest (snippets.json) must exist on disk. */
console.log("\nSnippet files exist:");
const referenced = new Set();
for (const d of ["models", "solvers", "meshes", "visualizations"]) {
    for (const c of JSON.parse(fs.readFileSync(path.join(GUI_DIR, "cards", d, "default.json"), "utf8"))) {
        if (c.snippet) referenced.add(c.snippet);
    }
}
const manifest = JSON.parse(fs.readFileSync(path.join(GUI_DIR, "snippets.json"), "utf8"));
for (const tab of manifest.tabs || []) {
    for (const b of tab.blocks || []) if (b.snippet) referenced.add(b.snippet);
}
check("at least one snippet is referenced", () => {
    if (referenced.size === 0) throw new Error("no catalog references any snippet");
});
for (const f of [...referenced].sort()) {
    check(f, () => { if (!fs.existsSync(path.join(GUI_DIR, f))) throw new Error("missing"); });
}

/* And no orphans: every file in snippets/ must be referenced by something. */
console.log("\nNo orphan snippets:");
for (const f of fs.readdirSync(path.join(GUI_DIR, "snippets")).filter((f) => f.endsWith(".py"))) {
    check(f, () => {
        if (!referenced.has("snippets/" + f)) throw new Error("orphan — no catalog references it");
    });
}

process.exit(errors > 0 ? 1 : 0);
