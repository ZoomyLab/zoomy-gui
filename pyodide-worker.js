/* Pyodide Web Worker — runs Python in a background thread, never blocks UI */

var py = null;

importScripts("https://cdn.jsdelivr.net/pyodide/v0.29.3/full/pyodide.js");

/* Silence the chatty "Loading <pkg> from CDN" stdout that Pyodide emits
   during loadPackage. We still capture unexpected stderr. */
var _origConsoleLog = self.console.log;
self.console.log = function () { /* drop pyodide package-download chatter */ };

/* SharedArrayBuffer-backed interrupt wiring. The main thread posts a
   SAB via the "set_interrupt_buffer" command; Pyodide's setInterruptBuffer
   polls it between bytecodes and raises KeyboardInterrupt when the main
   thread writes 2. If the buffer arrives before Pyodide has finished
   loading we stash it and wire it up at the end of initPyodide. */
var _pendingInterruptBuffer = null;

async function initPyodide() {
    if (py) return py;
    postMessage({ type: "log", level: "info", msg: "Booting Pyodide…" });
    py = await loadPyodide({ stdout: function () {}, stderr: function () {} });
    await py.loadPackage("micropip");
    if (_pendingInterruptBuffer) {
        try {
            py.setInterruptBuffer(new Uint8Array(_pendingInterruptBuffer));
            postMessage({ type: "log", level: "info", msg: "Cooperative interrupt enabled (SAB)" });
        } catch (e) {
            postMessage({ type: "log", level: "warn", msg: "setInterruptBuffer failed: " + (e.message || e) });
        }
        _pendingInterruptBuffer = null;
    }
    return py;
}

/* Each install phase caches its Promise so concurrent callers share the same
   in-flight work instead of racing to install the same packages twice. */
var _paramPromise = null;
var _execPromise = null;
var _mplPromise = null;
var _plotlyPromise = null;

function installParam() {
    if (_paramPromise) return _paramPromise;
    _paramPromise = (async function () {
        await initPyodide();
        /* h5py must load BEFORE zoomy_core is imported. zoomy_core.mesh.base_mesh
           does a try/except import of h5py at module scope and caches
           _HAVE_H5PY; if h5py isn't available at that first import, later
           write_to_hdf5 / from_hdf5 calls will RuntimeError even after the
           package loads. The pre-extract loop imports zoomy_core, so h5py
           must land inside installParam, not later. */
        try {
            await py.loadPackage(["h5py"]);
        } catch (e) {
            postMessage({ type: "log", level: "warn", msg: "h5py failed: " + (e.message || e) });
        }
        var mp = py.pyimport("micropip");
        await mp.install(["param", "zoomy-core"]);
        var code = await fetch("param_extract.py").then(function (r) { return r.text(); });
        await py.runPythonAsync(code);
    })();
    return _paramPromise;
}

function installExec() {
    if (_execPromise) return _execPromise;
    _execPromise = (async function () {
        await installParam();
        /* zoomy-plotting is no longer loaded here — it moved to tier 2
           (background). The engine.py function open_hdf5() imports it
           lazily, and any run_code that touches the HDF5 path waits on
           installZoomyPlotting() through ensureVizDeps(). */
        var code = await fetch("engine.py").then(function (r) { return r.text(); });
        await py.runPythonAsync(code);

        /* Register display callback: funnels rich output to main thread */
        self._zoomyDisplayBridge = function (cellJson) {
            postMessage({ type: "display", cell: cellJson });
        };
        await py.runPythonAsync([
            "import sys, json as _json",
            "from js import _zoomyDisplayBridge",
            "def _zoomy_display_cb(cell):",
            "    _zoomyDisplayBridge(_json.dumps(cell))",
            "sys._zoomy_display_callback = _zoomy_display_cb"
        ].join("\n"));
    })();
    return _execPromise;
}

/* Lazy per-library installers. Triggered by run_code when the user's snippet
   actually references the library. Each is promise-guarded so concurrent
   viz refreshes don't try to install twice. */
function installMatplotlib() {
    if (_mplPromise) return _mplPromise;
    _mplPromise = (async function () {
        postMessage({ type: "log", level: "info", msg: "Installing matplotlib in background…" });
        try {
            await py.loadPackage(["matplotlib"]);
            postMessage({ type: "log", level: "info", msg: "matplotlib ready" });
        } catch (e) {
            postMessage({ type: "log", level: "warn", msg: "matplotlib failed: " + (e.message || e) });
        }
    })();
    return _mplPromise;
}

function installPlotly() {
    if (_plotlyPromise) return _plotlyPromise;
    _plotlyPromise = (async function () {
        postMessage({ type: "log", level: "info", msg: "Installing plotly (optional — first plotly viz)…" });
        try {
            var mp = py.pyimport("micropip");
            await mp.install(["plotly"]);
            postMessage({ type: "log", level: "info", msg: "plotly ready" });
        } catch (e) {
            postMessage({ type: "log", level: "warn", msg: "plotly failed: " + (e.message || e) });
        }
    })();
    return _plotlyPromise;
}

var _zpPromise = null;
function installZoomyPlotting() {
    if (_zpPromise) return _zpPromise;
    _zpPromise = (async function () {
        postMessage({ type: "log", level: "info", msg: "Installing zoomy-plotting in background…" });
        try {
            var mp = py.pyimport("micropip");
            await mp.install(["zoomy-plotting"]);
            postMessage({ type: "log", level: "info", msg: "zoomy-plotting ready" });
        } catch (e) {
            postMessage({ type: "log", level: "warn", msg: "zoomy-plotting failed: " + (e.message || e) });
        }
    })();
    return _zpPromise;
}

var _jediPromise = null;
function installJedi() {
    if (_jediPromise) return _jediPromise;
    _jediPromise = (async function () {
        postMessage({ type: "log", level: "info", msg: "Installing jedi in background…" });
        try {
            var mp = py.pyimport("micropip");
            await mp.install(["jedi"]);
            postMessage({ type: "log", level: "info", msg: "jedi ready" });
        } catch (e) {
            postMessage({ type: "log", level: "warn", msg: "jedi failed: " + (e.message || e) });
        }
    })();
    return _jediPromise;
}

/* Regex sniffing of user code to decide which background / optional
   installs must be awaited before run_code proceeds. Each regex maps
   to a promise-guarded installer; callers hook onto the in-flight
   promise so a snippet that arrives mid-install just waits its turn. */
var _MPL_RE    = /\b(import\s+matplotlib|from\s+matplotlib|matplotlib\.)/;
var _PLOTLY_RE = /\b(import\s+plotly|from\s+plotly)/;
/* zoomy-plotting is used via engine.open_hdf5 — every solver-template
   snippet ends with `open_hdf5(path)`, which lazy-imports zp inside
   Python. Run_code must block on the zp install if the snippet needs it. */
var _ZP_RE     = /\b(open_hdf5|zoomy_plotting)\b/;

async function ensureVizDeps(code) {
    var needs = [];
    if (_ZP_RE.test(code))     needs.push(installZoomyPlotting());
    if (_MPL_RE.test(code))    needs.push(installMatplotlib());
    if (_PLOTLY_RE.test(code)) needs.push(installPlotly());
    if (needs.length) await Promise.all(needs);
}

var paramCache = {};

onmessage = async function (e) {
    var msg = e.data;
    /* Only log user-visible commands (run_code, describe_model); cache hits
       and param extraction are invisible plumbing. */
    if (msg.cmd === "run_code" || msg.cmd === "describe_model") {
        postMessage({ type: "log", level: "info", msg: msg.cmd + " (id=" + msg.id + ")" });
    }
    try {
        if (msg.cmd === "set_interrupt_buffer") {
            /* Wire it in now if Pyodide is already up; otherwise stash it
               for initPyodide to install as soon as the runtime is ready. */
            if (py) {
                try {
                    py.setInterruptBuffer(new Uint8Array(msg.buffer));
                    postMessage({ type: "log", level: "info", msg: "Cooperative interrupt enabled (SAB)" });
                } catch (e) {
                    postMessage({ type: "log", level: "warn", msg: "setInterruptBuffer failed: " + (e.message || e) });
                }
            } else {
                _pendingInterruptBuffer = msg.buffer;
            }
            return;

        } else if (msg.cmd === "init") {
            await initPyodide();
            postMessage({ type: "ready", id: msg.id });

        } else if (msg.cmd === "extract_params") {
            var cacheKey = msg.class_path + "|" + JSON.stringify(msg.init || {});
            if (paramCache[cacheKey]) {
                postMessage({ type: "log", level: "info", msg: "Param cache hit for " + msg.class_path.split(".").pop() });
                postMessage({ type: "result", id: msg.id, data: paramCache[cacheKey] });
                return;
            }
            var wt0 = performance.now();
            await installParam();
            var wt1 = performance.now();
            var result = py.globals.get("extract_param_schema")(msg.class_path, py.toPy(msg.init || {}));
            var wt2 = performance.now();
            paramCache[cacheKey] = result;
            postMessage({ type: "log", level: "info", msg: "Worker timing: installParam=" + (wt1-wt0).toFixed(0) + "ms, extract=" + (wt2-wt1).toFixed(0) + "ms" });
            postMessage({ type: "result", id: msg.id, data: result });

        } else if (msg.cmd === "preload_params") {
            await installParam();
            for (var i = 0; i < msg.cards.length; i++) {
                var c = msg.cards[i];
                var key = c.class_path + "|" + JSON.stringify(c.init || {});
                if (!paramCache[key]) {
                    try {
                        paramCache[key] = py.globals.get("extract_param_schema")(c.class_path, py.toPy(c.init || {}));
                    } catch (err) {}
                }
            }
            postMessage({ type: "log", level: "info", msg: "Pre-extracted params for " + msg.cards.length + " models" });

        } else if (msg.cmd === "run_code") {
            await installExec();
            await ensureVizDeps(msg.code);
            var result = py.globals.get("process_code")(msg.code);
            postMessage({ type: "result", id: msg.id, data: result });

        } else if (msg.cmd === "complete_code") {
            /* Autocomplete via jedi. First call micropip-installs jedi
               (~2 MB; 3-5 s on a warm Pyodide); subsequent calls are
               cache hits and resolve in 30-100 ms. */
            await installExec();
            await installJedi();
            var completions = py.globals.get("complete_code")(msg.code, msg.row, msg.col);
            /* Pyodide proxies Python dicts as PyProxy objects; convert
               to a plain JS value before posting. */
            var converted = completions.toJs ? completions.toJs({ dict_converter: Object.fromEntries }) : completions;
            if (completions.destroy) completions.destroy();
            postMessage({ type: "result", id: msg.id, data: converted });

        } else if (msg.cmd === "open_hdf5") {
            /* Point the store at an HDF5 file already on Pyodide's VFS
               (written by the solver template) or at one we just wrote
               via write_hdf5_bytes. engine.open_hdf5 lazy-imports
               zoomy_plotting, so the install must finish first. */
            await installExec();
            await installZoomyPlotting();
            py.globals.get("open_hdf5")(msg.path);
            postMessage({ type: "result", id: msg.id, data: "ok" });

        } else if (msg.cmd === "write_hdf5_bytes") {
            /* Stream an HDF5 binary (e.g. downloaded from the server's
               /jobs/{id}/results/hdf5 endpoint) into Pyodide's VFS, then
               hand the path to engine.open_hdf5 (which requires zp). */
            await installExec();
            await installZoomyPlotting();
            var dir = msg.path.replace(/\/[^\/]*$/, "");
            if (dir) py.FS.mkdirTree(dir);
            py.FS.writeFile(msg.path, new Uint8Array(msg.bytes));
            py.globals.get("open_hdf5")(msg.path);
            postMessage({ type: "result", id: msg.id, data: "ok" });

        } else if (msg.cmd === "describe_model") {
            postMessage({ type: "log", level: "info", msg: "describe_model for " + msg.class_path.split(".").pop() + " (may take 30-60s)" });
            await installExec();
            /* Use runPythonAsync so the event loop can breathe */
            var descCode = [
                "import sys as _sys",
                "def _describe_model(class_path, init_kwargs):",
                "    _sys.stdout.write('describe: importing ' + class_path + '\\n')",
                "    mod_path, cls_name = class_path.rsplit('.', 1)",
                "    mod = __import__(mod_path, fromlist=[cls_name])",
                "    cls = getattr(mod, cls_name)",
                "    try:",
                "        _sys.stdout.write('describe: instantiating ' + cls_name + '...\\n')",
                "        m = cls(**init_kwargs) if init_kwargs else cls()",
                "        _sys.stdout.write('describe: calling describe()\\n')",
                "        if hasattr(m, 'describe'):",
                "            return str(m.describe())",
                "        return cls.__doc__ or cls.__name__",
                "    except Exception as e:",
                "        import traceback; return traceback.format_exc()",
            ].join("\n");
            await py.runPythonAsync(descCode);
            /* (calling Python — silent) */
            var desc = await py.runPythonAsync(
                "_describe_model('" + msg.class_path + "', " + JSON.stringify(msg.init || {}) + ")"
            );
            postMessage({ type: "log", level: "info", msg: "describe_model done (" + (desc ? desc.length : 0) + " chars)" });
            postMessage({ type: "result", id: msg.id, data: desc });
        }
    } catch (err) {
        postMessage({ type: "error", id: msg.id, error: err.message || String(err) });
    }
};

/* Start loading everything immediately when worker is created */
(async function () {
    await initPyodide();
    await installParam();

    /* Pre-extract params for all cards with a class — cold imports happen here, not on gear click */
    try {
        /* Load cards from the folder structure (default + generated) */
        var allCards = [];
        var dirs = ["cards/models/default.json", "cards/models/generated.json",
                    "cards/solvers/default.json", "cards/solvers/generated.json"];
        for (var di = 0; di < dirs.length; di++) {
            try {
                var arr = await fetch(dirs[di]).then(function (r) { return r.ok ? r.json() : []; });
                allCards = allCards.concat(arr);
            } catch (e) {}
        }
        var count = 0;
        for (var j = 0; j < allCards.length; j++) {
            var c = allCards[j];
            if (c["class"]) {
                var key = c["class"] + "|" + JSON.stringify(c.init || {});
                if (!paramCache[key]) {
                    try {
                        paramCache[key] = py.globals.get("extract_param_schema")(c["class"], py.toPy(c.init || {}));
                        count++;
                    } catch (e) {}
                }
            }
        }
    } catch (e) {}

    await installExec();
    postMessage({ type: "log", level: "info", msg: "Python runtime ready" });
    postMessage({ type: "fully_ready" });

    /* --- Install tiers ---
     *   1. CORE (boot-blocking, above): zoomy-core + param + h5py +
     *      engine.py + display hook. h5py stays here because
     *      zoomy_core.mesh.base_mesh caches _HAVE_H5PY at module
     *      import time; the boot pre-extract loop imports zoomy_core,
     *      so h5py must already be present when that happens.
     *
     *   2. BACKGROUND (eager but non-blocking, here):
     *        jedi                — autocomplete; first click is
     *                              usually a gear or editor; kick off
     *                              FIRST so it has the most wall-
     *                              clock time to finish before use.
     *        zoomy-plotting      — needed at end of every Pyodide
     *                              solver run (open_hdf5) and for
     *                              every viz refresh. ensureVizDeps
     *                              blocks run_code on this if the
     *                              snippet touches open_hdf5 / zp.
     *        matplotlib          — needed only by mpl viz cards; last
     *                              in the priority line but still
     *                              pre-warmed so the first viz
     *                              refresh is instant.
     *
     *   3. OPTIONAL (fully lazy, in run_code): plotly. Many snippets
     *      never touch it, so we don't spend the install budget until
     *      a snippet actually imports it.
     *
     * All four installers are promise-guarded, so concurrent callers
     * attach to the in-flight install instead of starting a duplicate. */
    /* Fire tier-2 installs, then post background_ready once they all
       resolve so the main thread can hide the "Installing…" toast.
       Individual "… ready" log lines keep showing up in the debug
       pane as each install completes. */
    Promise.all([
        installJedi(),              // highest-priority tier 2
        installZoomyPlotting(),
        installMatplotlib(),
    ]).then(function () {
        postMessage({ type: "log", level: "info", msg: "All background dependencies ready" });
        postMessage({ type: "background_ready" });
    });
})();
