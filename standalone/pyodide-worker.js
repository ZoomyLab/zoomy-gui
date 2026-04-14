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
    await initPyodide();
    postMessage({ type: "log", level: "info", msg: "Installing numpy, plotly, matplotlib, zoomy-core..." });
    var mp = py.pyimport("micropip");
    await mp.install(["numpy", "plotly", "matplotlib", "zoomy-core"]);
    var code = await fetch("engine.py").then(function (r) { return r.text(); });
    await py.runPythonAsync(code);
    execReady = true;
    postMessage({ type: "log", level: "info", msg: "Execution stack ready" });
}

var paramCache = {};

onmessage = async function (e) {
    var msg = e.data;
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
            postMessage({ type: "log", level: "info", msg: "describe_model: installing deps..." });
            await installExec();
            postMessage({ type: "log", level: "info", msg: "describe_model: instantiating " + msg.class_path });
            var descCode = "def _describe_model(class_path, init_kwargs):\n" +
                "    mod_path, cls_name = class_path.rsplit('.', 1)\n" +
                "    mod = __import__(mod_path, fromlist=[cls_name])\n" +
                "    cls = getattr(mod, cls_name)\n" +
                "    try:\n" +
                "        m = cls(**init_kwargs) if init_kwargs else cls()\n" +
                "        if hasattr(m, 'describe'):\n" +
                "            return str(m.describe())\n" +
                "        return cls.__doc__ or cls.__name__\n" +
                "    except Exception as e:\n" +
                "        import traceback; return traceback.format_exc()\n";
            await py.runPythonAsync(descCode);
            var desc = py.globals.get("_describe_model")(msg.class_path, py.toPy(msg.init || {}));
            postMessage({ type: "log", level: "info", msg: "describe_model: done" });
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
        }
        if (count > 0) postMessage({ type: "log", level: "info", msg: "Pre-extracted params for " + count + " models" });
    } catch (e) {}

    await installExec();
    postMessage({ type: "fully_ready" });
})();
