/* Pyodide Web Worker — runs Python in a background thread, never blocks UI */

var py = null;
var paramReady = false;
var execReady = false;

importScripts("https://cdn.jsdelivr.net/pyodide/v0.25.0/full/pyodide.js");

async function initPyodide() {
    if (py) return py;
    postMessage({ type: "log", level: "info", msg: "Loading Pyodide runtime..." });
    py = await loadPyodide();
    await py.loadPackage("micropip");
    postMessage({ type: "log", level: "info", msg: "Pyodide ready" });
    return py;
}

async function installParam() {
    if (paramReady) return;
    await initPyodide();
    postMessage({ type: "log", level: "info", msg: "Installing param + zoomy-core..." });
    var mp = py.pyimport("micropip");
    await mp.install(["param", "zoomy-core"]);
    var code = await fetch("param_extract.py").then(function (r) { return r.text(); });
    await py.runPythonAsync(code);
    paramReady = true;
    postMessage({ type: "log", level: "info", msg: "Param extraction ready" });
}

async function installExec() {
    if (execReady) return;
    await installParam();  /* ensures zoomy-core + numpy + scipy are installed */
    postMessage({ type: "log", level: "info", msg: "Loading matplotlib..." });
    try {
        await py.loadPackage(["matplotlib"]);
    } catch (e) {
        postMessage({ type: "log", level: "warn", msg: "matplotlib load failed: " + (e.message || e) });
    }
    postMessage({ type: "log", level: "info", msg: "Installing plotly..." });
    try {
        var mp = py.pyimport("micropip");
        await mp.install(["plotly"]);
    } catch (e) {
        postMessage({ type: "log", level: "warn", msg: "plotly install failed: " + (e.message || e) });
    }
    postMessage({ type: "log", level: "info", msg: "Loading execution engine..." });
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

    execReady = true;
    postMessage({ type: "log", level: "info", msg: "Execution stack ready (display enabled)" });
}

var paramCache = {};

onmessage = async function (e) {
    var msg = e.data;
    postMessage({ type: "log", level: "info", msg: "Worker received: cmd=" + msg.cmd + " id=" + msg.id });
    try {
        if (msg.cmd === "init") {
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
            var result = py.globals.get("process_code")(msg.code);
            postMessage({ type: "result", id: msg.id, data: result });

        } else if (msg.cmd === "describe_model") {
            postMessage({ type: "log", level: "info", msg: "describe_model: starting for " + msg.class_path.split(".").pop() + " (may take 30-60s in Pyodide)..." });
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
            postMessage({ type: "log", level: "info", msg: "describe_model: calling Python..." });
            var desc = await py.runPythonAsync(
                "_describe_model('" + msg.class_path + "', " + JSON.stringify(msg.init || {}) + ")"
            );
            postMessage({ type: "log", level: "info", msg: "describe_model: done (" + (desc ? desc.length : 0) + " chars)" });
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
        if (count > 0) postMessage({ type: "log", level: "info", msg: "Pre-extracted params for " + count + " models" });
    } catch (e) {}

    postMessage({ type: "log", level: "info", msg: "Startup: installing exec stack..." });
    await installExec();
    postMessage({ type: "log", level: "info", msg: "Startup: IIFE complete — worker ready for commands" });
    postMessage({ type: "fully_ready" });
})();
