/* === Utilities === */

window._aceReady = null;
window._plotlyReady = null;

function loadScript(src) {
    return new Promise(function (ok, fail) {
        var s = document.createElement("script");
        s.src = src;
        /* Request cross-origin scripts with CORS so the response isn't
           opaque — opaque responses can't satisfy COEP require-corp even
           with the CORP header our service worker injects. */
        if (/^https?:\/\//.test(src) && !src.startsWith(location.origin)) {
            s.crossOrigin = "anonymous";
        }
        s.onload = ok;
        s.onerror = fail;
        document.head.appendChild(s);
    });
}
/* === Toast stack ===
   Small notification manager that renders into #toast-stack. Multiple
   toasts can coexist; each has a stable id so updates morph in place
   instead of replacing. Progress→confirmation is ONE toast's lifecycle
   (show sticky → update with success kind, non-sticky ttl), not two.
   Unrelated events stack as separate rows.

   API:
     toast.show({id?, text, kind?, sticky?, ttl?})  -> id
     toast.update(id, {text?, kind?, sticky?, ttl?})
     toast.dismiss(id)
     toast.info(text, opts)
     toast.success(text, opts)    auto-dismisses 2.5s by default
     toast.error(text, opts)      sticky by default; caller dismisses

   Legacy showToast(msg)/hideToast() are shims onto a single default
   slot so existing call sites keep working unchanged. */
var toast = (function () {
    var _byId = Object.create(null);   // id -> {el, timer}
    var _seq = 0;
    function _stack() { return document.getElementById("toast-stack"); }
    function _clearTimer(entry) { if (entry && entry.timer) { clearTimeout(entry.timer); entry.timer = null; } }
    function _applyKind(el, kind) { el.className = "toast" + (kind ? " toast-" + kind : ""); }
    function show(opts) {
        opts = opts || {};
        var id = opts.id || ("t" + (++_seq));
        var stack = _stack();
        if (!stack) return id;
        var entry = _byId[id];
        if (entry) {
            if (opts.text !== undefined) entry.el.textContent = opts.text;
            _applyKind(entry.el, opts.kind);
            _clearTimer(entry);
        } else {
            var el = document.createElement("div");
            el.textContent = opts.text || "";
            _applyKind(el, opts.kind);
            stack.appendChild(el);
            entry = { el: el, timer: null };
            _byId[id] = entry;
        }
        var sticky = !!opts.sticky;
        var ttl = opts.ttl || (sticky ? 0 : 3000);
        if (!sticky && ttl > 0) {
            entry.timer = setTimeout(function () { dismiss(id); }, ttl);
        }
        return id;
    }
    function update(id, opts) { opts = opts || {}; opts.id = id; return show(opts); }
    function dismiss(id) {
        var entry = _byId[id];
        if (!entry) return;
        _clearTimer(entry);
        entry.el.classList.add("toast-leaving");
        var el = entry.el;
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
        delete _byId[id];
    }
    function _merge(a, b) { var o = {}; for (var k in a) o[k] = a[k]; if (b) for (var j in b) o[j] = b[j]; return o; }
    function info(text, o)    { return show(_merge({text: text}, o)); }
    function success(text, o) { return show(_merge({text: text, kind: "success", ttl: 2500}, o)); }
    function error(text, o)   { return show(_merge({text: text, kind: "error", sticky: true}, o)); }
    return { show: show, update: update, dismiss: dismiss, info: info, success: success, error: error };
})();
window.toast = toast;

/* Legacy shims — old call sites write to a single "__default__" slot.
   This preserves today's clobber-the-one-toast behaviour for code
   paths that haven't been migrated to explicit ids yet (worker install
   log spam, job submission messages, etc.) while new code can use
   toast.show({id:"..."}) to stack independently. */
function showToast(msg) { toast.show({ id: "__default__", text: msg, sticky: true }); }
function hideToast()    { toast.dismiss("__default__"); }

/* Minimal markdown → HTML.
 * Handles: headers (# .. ####), bold, italic, inline code, fenced code
 * blocks, ordered / unordered lists, horizontal rules, $$…$$ display
 * math (KaTeX picks it up), paragraph breaks, and preserves single
 * newlines inside paragraphs as <br>. Good enough for model
 * describe() output which is the main consumer post-Phase-2. */
function miniMarkdown(s) {
    if (!s) return "";
    /* Already contains HTML tags → pass through */
    if (/<[a-z][\s\S]*>/i.test(s)) return s;

    /* Protect $$ math blocks: wrap in div so KaTeX renders them as display math */
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, function (_, math) {
        return '\n<div class="math-block">$$' + math + '$$</div>\n';
    });

    /* Fenced code blocks ``` → <pre><code>. Done before the inline
       passes so backticks inside don't get double-processed. */
    s = s.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, body) {
        var esc = body.replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return '<pre class="md-code"><code>' + esc + '</code></pre>';
    });

    /* Split into blocks separated by blank lines — each block becomes a
       paragraph, header, list, or hr. Keep list items contiguous so we
       can wrap them in <ul> / <ol> below. */
    var blocks = s.split(/\n{2,}/);
    var out = [];
    blocks.forEach(function (block) {
        var trimmed = block.trim();
        if (!trimmed) return;

        /* Skip already-promoted HTML blocks (pre, div.math-block). */
        if (/^<(pre|div)\b/.test(trimmed)) { out.push(trimmed); return; }

        /* Headers. */
        var h = /^(#{1,4})\s+(.+)$/.exec(trimmed);
        if (h && !trimmed.includes("\n")) {
            var level = h[1].length + 1;   // # -> h2
            out.push('<h' + level + '>' + _inlineMd(h[2]) + '</h' + level + '>');
            return;
        }

        /* Horizontal rule. */
        if (/^(-{3,}|\*{3,})$/.test(trimmed)) { out.push('<hr>'); return; }

        /* Lists: bullet (-, *) or ordered (1.). Must hit every line of
           the block for the block to count as a list. */
        var lines = trimmed.split("\n");
        var ulItems = lines.every(function (l) { return /^\s*[-*]\s+/.test(l); });
        var olItems = lines.every(function (l) { return /^\s*\d+\.\s+/.test(l); });
        if (ulItems) {
            out.push('<ul>' + lines.map(function (l) {
                return '<li>' + _inlineMd(l.replace(/^\s*[-*]\s+/, "")) + '</li>';
            }).join("") + '</ul>');
            return;
        }
        if (olItems) {
            out.push('<ol>' + lines.map(function (l) {
                return '<li>' + _inlineMd(l.replace(/^\s*\d+\.\s+/, "")) + '</li>';
            }).join("") + '</ol>');
            return;
        }

        /* Default: paragraph. Preserve internal newlines as <br>. */
        out.push('<p>' + _inlineMd(trimmed).replace(/\n/g, '<br>') + '</p>');
    });
    return out.join("\n");
}

function _inlineMd(s) {
    return s
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/* === Per-session runtime state ===
 *
 * Each session carries its own log, run-state, and (lazy-created)
 * Pyodide worker. The global module only knows "which session is
 * active"; everything else is looked up through _sessionRuntime(session).
 *
 * The very first session re-uses the worker that app boot already
 * created (no double cold-boot). Every subsequent session creates a
 * fresh worker the first time it tries to run code — 30-ish second
 * boot tax paid once per session, paid lazily. Sessions are truly
 * independent: their VFS, installed packages, Pyodide runtime state
 * are isolated because the workers are physically separate. */

function _activeSession() {
    return (_project && _project.sessions) ? _project.sessions.active() : null;
}

function _sessionRuntime(session) {
    if (!session) return null;
    if (!session._runtime) {
        session._runtime = {
            log: [],          // [{ts, level, msg}, ...] scoped to this session
            runningMode: null,
            activeJob: null,
            currentPyRunId: null,
            pyodide: null,    // assigned on first runCode in this session
        };
    }
    return session._runtime;
}

/* The boot-time PyodideAdapter exists before any session does. The
   first session to run code "claims" it — that session avoids the
   ~30 s cold-boot tax. Every subsequent session lazy-creates its own
   Worker on first run, so its Python state / VFS / installed packages
   are independent of every other session's. */
var _bootAdapterClaimed = false;

/* Wrapper over getCli() that, for any backend-touching operation,
   first ensures the active session owns a PyodideAdapter (lazy-
   creating a fresh worker when the session hadn't claimed one yet)
   and swaps the CLI's pyodide pointer to it. The rest of the code
   keeps using cli.pyodide / cli.runCode as before. */
async function _readyCli() {
    var cli = await getCli();
    var session = _activeSession();
    if (session) {
        await _ensureSessionPyodide(session);
        cli.pyodide = _sessionRuntime(session).pyodide;
    }
    return cli;
}

/* Lazy-assign a PyodideAdapter to a session. The first call for the
   first-ever session reuses the boot-time adapter (no extra ~30 s
   Pyodide cold boot). Every subsequent session creates its own
   Worker, so its Python state — VFS, installed packages, solver
   state — is fully isolated. A cooperative-cancel SharedArrayBuffer
   is allocated per adapter so Stop in session A can't accidentally
   interrupt a run in session B. */
async function _ensureSessionPyodide(session) {
    if (!session) return null;
    var rt = _sessionRuntime(session);
    if (rt.pyodide) return rt.pyodide;
    var cli = await getCli();

    if (!_bootAdapterClaimed) {
        _bootAdapterClaimed = true;
        rt.pyodide = cli.pyodide;    // boot-time adapter
        logDebug("info", "Session '" + session.title + "' claimed the boot Pyodide worker");
    } else {
        logDebug("info", "Session '" + session.title + "' — spawning a fresh Pyodide worker (isolated VFS + runtime)…");
        showToast("Booting worker for '" + session.title + "' (~30s)…");
        var mod = await import("./zoomy_cli/browser.mjs");
        var ib = null;
        if (typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated) {
            ib = new SharedArrayBuffer(1);
        }
        var adapter = new mod.PyodideAdapter({
            workerUrl: "pyodide-worker.js",
            interruptBuffer: ib,
            onLog: _onAdapterLog,
            onDisplay: _onAdapterDisplay,
            onReady: function () { hideToast(); logDebug("info", "Worker for '" + session.title + "' ready"); },
            onBackgroundReady: function () { hideToast(); },
        });
        adapter._ensureWorker();
        adapter._sessionInterruptBuffer = ib;
        adapter._sessionInterruptView = ib ? new Uint8Array(ib) : null;
        rt.pyodide = adapter;
    }
    return rt.pyodide;
}

/* Called after sessionMgr swaps sessions. Swaps CLI's active Pyodide
   adapter, re-renders the debug-log panel and the run button from the
   arriving session's runtime state. */
function _applySessionRuntime() {
    var session = _activeSession();
    var rt = _sessionRuntime(session);

    /* Swap the CLI to this session's worker. If the session hasn't
       claimed one yet, leave cli.pyodide alone — _readyCli() (called
       from every Pyodide-bound action) will lazy-create it on first
       use so the user doesn't pay a cold-boot cost just for switching
       a tab. */
    if (_cli && rt && rt.pyodide) _cli.pyodide = rt.pyodide;

    /* Re-render the debug log for the arriving session. */
    var el = document.getElementById("debug-log");
    if (el && rt) {
        el.innerHTML = "";
        rt.log.forEach(function (entry) { _appendLogLine(el, entry); });
        el.scrollTop = el.scrollHeight;
    }

    /* Re-render run-button state + dashboard summary. */
    _runningMode = rt ? rt.runningMode : null;
    _activeJob = rt ? rt.activeJob : null;
    _currentPyRunId = rt ? rt.currentPyRunId : null;
    setRunBtnState(!!_runningMode);
    if (rt && rt.runningMode === "server" && rt.activeJob) {
        updateDashboardJob({ job_id: rt.activeJob.jobId, status: "running" });
    } else if (rt && rt.runningMode === "pyodide") {
        updateDashboardJob({ job_id: "pyodide", status: "running" });
    } else {
        updateDashboardJob();   // idle
    }
}

function _appendLogLine(el, entry) {
    var color = entry.level === "error" ? "#dc2626" : entry.level === "warn" ? "#d97706" : "var(--c-muted)";
    el.innerHTML += '<div style="color:' + color + '">[' + entry.ts + '] ' + entry.level.toUpperCase() + ': ' + entry.msg.replace(/</g, "&lt;") + '</div>';
}

/* === Debug log ===
 * Before sessions exist (boot phase), logs go into _bootLog. Once a
 * session is active, logs live in session._runtime.log. */
var _bootLog = [];
function logDebug(level, msg) {
    var ts = new Date().toLocaleTimeString();
    var entry = { ts: ts, level: level, msg: msg };

    /* Route into the active session's log so switching sessions swaps
       the log view. Before any session exists (app boot) fall back to
       the shared _bootLog; the first session created absorbs that
       backlog via snapshotBootLog(). */
    var session = _activeSession();
    var rt = session ? _sessionRuntime(session) : null;
    var log = rt ? rt.log : _bootLog;
    log.push(entry);
    if (log.length > 300) log.shift();

    var el = document.getElementById("debug-log");
    if (el) {
        _appendLogLine(el, entry);
        el.scrollTop = el.scrollHeight;
    }
    if (level === "error") console.error("[zoomy]", msg);
    else console.log("[zoomy]", msg);
}

/* Pull any log lines recorded before the first session existed (app
   boot) into the now-active session's log. Called once when
   _project.sessions.active() returns a value for the first time. */
function _snapshotBootLog() {
    var session = _activeSession();
    if (!session) return;
    var rt = _sessionRuntime(session);
    if (_bootLog.length) {
        rt.log = _bootLog.concat(rt.log);
        _bootLog = [];
    }
}

/* === Isomorphic CLI façade (Phase 3) =====================================
 * app.js routes every backend call through a single ZoomyCLI instance.
 * The CLI owns the Pyodide worker (via PyodideAdapter) and any HTTP
 * backends (HttpAdapter, registered at connect time). No more direct
 * _pyWorker.postMessage or legacy ZoomyBackend calls from app.js —
 * everything flows through cli.* methods.
 *
 * The GUI is not itself a module, so the CLI loads via dynamic
 * import(). Every worker-bound action goes through `await getCli()`
 * followed by `cli.runCode(...)` / `cli.extractParams(...)` / etc.
 * For the few places that need the raw Worker object (set_interrupt_
 * buffer during boot, terminate() during hard-stop fallback) we expose
 * `cli.pyodide._worker`, still through the façade. */

/* Cooperative-cancel channel. If the page is cross-origin isolated
   (served with COOP/COEP headers — our service worker injects those)
   SharedArrayBuffer is available; we stash a 1-byte shared buffer here
   and the PyodideAdapter hands the same SAB to the worker so Pyodide's
   setInterruptBuffer watches it. Writing 2 (SIGINT) interrupts Python
   between bytecodes — no terminate, no reboot. */
var _pyInterruptBuffer = null;
var _pyInterruptView = null;
if (typeof SharedArrayBuffer !== "undefined" && self.crossOriginIsolated) {
    _pyInterruptBuffer = new SharedArrayBuffer(1);
    _pyInterruptView = new Uint8Array(_pyInterruptBuffer);
}

/* The CLI load is async (dynamic import). Kick it off at boot; every
   caller uses `await getCli()` before touching the façade. `_cli` is
   exposed on window so debug tooling can reach it. */
var _cli = null;
var _cliReady = null;

/* --- Autocomplete readiness tracker ---
   Autocomplete needs BOTH jedi (installed in Pyodide) and Ace
   (loaded + language_tools + our completer registered). We watch the
   worker log for the "jedi ready" marker, preload Ace at boot, and
   flash a confirmation toast once both are done so the user has an
   explicit "you can now use Ctrl-Space" signal. */
var _resolveJediReady;
var _jediReady = new Promise(function (resolve) { _resolveJediReady = resolve; });

function _onAdapterLog(msg) {
    logDebug(msg.level || "info", "[Worker] " + msg.msg);
    /* Show as toast for coarse progress markers — booting the
       runtime, loading a CDN script, installing a pip package. The
       background_ready signal hides the toast when the final tier-2
       install finishes. */
    if (/^(Booting|Loading|Installing)\b/.test(msg.msg)) showToast(msg.msg);
    /* Surface jedi's zoomy_core indexing phase in the autocomplete
       toast specifically — this 15-25 s parser warm-up is the reason
       "Autocomplete ready" is delayed vs. just "jedi installed". Users
       otherwise see "Setting up autocomplete…" frozen for 20 s with
       no explanation. */
    if (msg.msg.indexOf("Indexing zoomy_core") !== -1) {
        toast.update("autocomplete", { text: "Indexing zoomy_core for autocomplete (~20 s)…", sticky: true });
    }
    /* Resolve the jedi gate when the worker announces the install is
       done. Worker logs "jedi ready" (see installJedi in pyodide-worker.js). */
    if (_resolveJediReady && msg.msg.indexOf("jedi ready") !== -1) {
        _resolveJediReady();
        _resolveJediReady = null;
    }
}

function _onAdapterDisplay(cellOrJson) {
    /* The adapter forwards the raw message cell; engine.py may have
       already JSON-encoded it, so handle both shapes defensively. */
    var cell = (typeof cellOrJson === "string") ? JSON.parse(cellOrJson) : cellOrJson;
    /* Live stdout streaming from engine._LiveStdout — route to the
       dashboard debug log instead of a notebook cell so users see
       solver iteration progress while a long simulation is running. */
    if (cell.mime === "text/x-log") { logDebug("info", "[py] " + cell.content); return; }
    var target = _activeOutputTarget ? document.getElementById(_activeOutputTarget) : null;
    if (target) renderOutputCell(cell, target);
}

window.getCli = getCli;    // expose for tests and debugging
function getCli() {
    if (_cliReady) return _cliReady;
    _cliReady = import("./zoomy_cli/browser.mjs").then(function (m) {
        var pyodide = new m.PyodideAdapter({
            workerUrl: "pyodide-worker.js",
            interruptBuffer: _pyInterruptBuffer,
            onLog: _onAdapterLog,
            onDisplay: _onAdapterDisplay,
            onReady: function () { hideToast(); },
            /* Tier-2 installs (matplotlib / jedi / zoomy-plotting) finish
               after fully_ready; each one individually retriggers the
               toast via "Installing…" log lines. Hide it for good once
               the last of them resolves so a user sitting idle on the
               page sees the banner vanish on its own. */
            onBackgroundReady: function () { hideToast(); },
        });
        /* Boot the worker immediately — matches the legacy behaviour
           of creating the Worker at top-of-app.js. Without this, the
           first extractParams() call pays a cold-boot tax. */
        pyodide._ensureWorker();
        _cli = new m.ZoomyCLI({
            storage: new m.FetchStorage(),
            pyodide: pyodide,
        });
        window._cli = _cli;
        return _cli;
    }).catch(function (err) {
        logDebug("error", "ZoomyCLI failed to load: " + (err.message || err));
        throw err;
    });
    return _cliReady;
}
getCli();

/* Preload Ace (editor + language_tools + zoomy completer) in parallel
   with Pyodide tier-2 installs. Without this preload Ace only loads on
   the first card click, which creates a dead window (seen in the logs
   as: "jedi ready" at T+8s, then 20s idle, then "Loading Ace editor"
   on the first interaction). Preloading overlaps both halves so that
   by the time the user clicks anything, autocomplete is fully live. */
ensureAce();

/* Autocomplete has its own toast slot (id:"autocomplete"), separate
   from the default slot the worker install-log spam writes to. That
   way the "Setting up autocomplete…" message stays visible through
   the whole setup (jedi install + Ace CDN load) and morphs to a
   "Autocomplete ready" success on completion — one toast, one
   lifecycle. */
toast.show({ id: "autocomplete", text: "Setting up autocomplete…", sticky: true });
Promise.all([_jediReady, window._aceReady]).then(function () {
    toast.update("autocomplete", { text: "Autocomplete ready", kind: "success", sticky: false, ttl: 1800 });
    logDebug("info", "Autocomplete ready (jedi + Ace)");
}, function (err) {
    toast.update("autocomplete", { text: "Autocomplete setup failed", kind: "error" });
    logDebug("error", "Autocomplete setup failed: " + (err && err.message || err));
});

/* No more pyCall / runCode / extractParams wrappers in app.js — every
   backend interaction goes through the CLI façade (cli.runCode,
   cli.extractParams, cli.describeModel, cli.writeHdf5Bytes,
   cli.submitCase, cli.cancel). The old wrappers used to live here. */

/* Thin sync helpers for the "is this tag connected?" and "what URL"
   checks that card rendering does on every card. The CLI might not yet
   be constructed (dynamic import is async), so we fall back to the
   single-source answer: Pyodide ("numpy") is always connected. */
function _cliIsTagConnected(tag) {
    if (tag === "numpy") return true;
    return !!(_cli && _cli.isTagConnected(tag));
}
function _cliGetUrlForTag(tag) {
    return (_cli && _cli.getUrlForTag(tag)) || null;
}

/* === Ace + Plotly (still main thread, they need DOM access) === */

function ensureAce() {
    if (!window._aceReady) window._aceReady = (async function () {
        logDebug("info", "Loading Ace editor (autocomplete UI)...");
        /* NOTE: We intentionally don't showToast/hideToast here —
           ensureAce() is called at boot and the Pyodide "Installing X"
           toasts are already visible. The combined "Autocomplete ready"
           confirmation is orchestrated by the _jediReady + _aceReady
           Promise.all near getCli(). */
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.7/ace.js");
        /* Pull in language_tools to enable Ace's autocomplete framework.
           Our custom zoomy_core completer is registered via
           registerZoomyCompleter() below, which hooks into Pyodide+jedi
           to answer `.method` / kwarg-in-call queries. */
        await loadScript("https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.7/ext-language_tools.js");
        registerZoomyCompleter();
        logDebug("info", "Ace editor ready");
    })();
    return window._aceReady;
}
function ensurePlotly() { if (!window._plotlyReady) window._plotlyReady = (async function () { logDebug("info","Loading Plotly..."); showToast("Loading plotting..."); await loadScript("https://cdn.plot.ly/plotly-2.27.0.min.js"); logDebug("info","Plotly ready"); hideToast(); })(); return window._plotlyReady; }

function makeAceEditor(id, code) {
    var e = ace.edit(id);
    e.setTheme("ace/theme/monokai");
    e.session.setMode("ace/mode/python");
    /* Passing the Zoomy completer as an ARRAY (rather than the `true`
       shorthand) tells Ace to use ONLY this completer — no Python
       keyword list, no buffer-word completer. Jedi already covers
       in-scope names, so the built-in completers only added noise
       (`if`, `def`, `True`, random identifiers typed elsewhere in the
       snippet). */
    var onlyZoomy = window._zoomyCompleter ? [window._zoomyCompleter] : true;
    e.setOptions({
        fontSize: "14px",
        showPrintMargin: false,
        useSoftTabs: true,
        tabSize: 4,
        enableBasicAutocompletion: onlyZoomy,
        enableLiveAutocompletion: onlyZoomy,     // trigger on typing, not just Ctrl-Space
        enableSnippets: false,
    });
    e.setValue(code, -1);
    /* Live autocompletion in Ace only opens the popup on word-character
       keystrokes — typing `.` or `(` never triggers it. Force-open the
       popup after those two punctuations so typing `model.` (or
       `describe(`) shows completions / kwargs immediately. */
    e.commands.on("afterExec", function (evt) {
        if (!evt.command || evt.command.name !== "insertstring") return;
        if (evt.args === "." || evt.args === "(") {
            evt.editor.execCommand("startAutocomplete");
        }
    });
    return e;
}

/* === zoomy_core autocomplete (jedi inside Pyodide) ===
 *
 * Goal: when the user types `model.describe(` inside a card editor we
 * want a completion popup listing the methods of whatever class
 * `model` actually is, with signatures and docstrings.
 *
 * The completer handles the request by forwarding the buffer + cursor
 * to `cli.complete(...)` which runs `jedi.Script(code).complete(row,
 * col)` inside the Pyodide worker. Jedi already knows zoomy_core
 * (it's installed in the worker), so import resolution, subclass
 * walks, type inference, method-chain return types, metaclass-level
 * magic — all handled by jedi without us writing a Python parser in
 * JS. Trade: one worker round-trip per completion call (~30-200 ms).
 * jedi installs lazily on first completion via micropip. */

/* Type-based ranking for jedi completions. Higher score = higher in
   the popup. Jedi's `type` field: param, property, function / method,
   class, module, statement, instance, keyword. The ordering here
   reflects "what is the user most likely to want", with keyword-
   arguments (type=param) pinned to the very top because those are
   what you want when cursor is inside `fn(`. */
var _ZOOMY_TYPE_SCORE = {
    param:       1000,
    property:     900,
    function:     850,
    method:       850,
    instance:     800,
    class:        700,
    module:       600,
    statement:    500,
    keyword:      100,
};

function registerZoomyCompleter() {
    if (window._zoomyCompleterRegistered || !window.ace) return;
    var langTools;
    try { langTools = ace.require("ace/ext/language_tools"); } catch (e) { return; }
    if (!langTools || !langTools.addCompleter) return;
    window._zoomyCompleterRegistered = true;

    var completer = {
        getCompletions: async function (editor, session, pos, prefix, callback) {
            try {
                var cli = await _readyCli();
                /* Convert 0-indexed Ace (row, col) to jedi's 1-indexed line. */
                var result = await cli.complete(session.getValue(), pos.row + 1, pos.column);
                var items = (result && result.completions) || [];
                /* Hide dunders / privates unless the user typed `_`
                   explicitly — fewer distractions in the common case. */
                var wantPrivate = prefix && prefix.indexOf("_") === 0;
                var filtered = items.filter(function (c) {
                    if (!c.name) return false;
                    if (!wantPrivate && c.name.indexOf("_") === 0) return false;
                    return true;
                });
                callback(null, filtered.map(function (c) {
                    var t = (c.type || "").toLowerCase();
                    var base = _ZOOMY_TYPE_SCORE[t] != null ? _ZOOMY_TYPE_SCORE[t] : 400;
                    return {
                        caption: c.name,
                        value: c.name,
                        meta: t || "member",
                        score: base,
                        docHTML: _zoomyDocHtml(c),
                    };
                }));
            } catch (e) {
                callback(null, []);
            }
        },
        getDocTooltip: function (item) { return { docHTML: item.docHTML }; },
    };
    langTools.addCompleter(completer);
    window._zoomyCompleter = completer;
}

function _zoomyDocHtml(c) {
    var esc = function (s) {
        return String(s || "").replace(/[&<>"']/g, function (ch) {
            return { "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch];
        });
    };
    var sig = c.signature ? esc(c.signature) : esc(c.name);
    var doc = esc(c.docstring || "").replace(/\n/g, "<br>");
    return "<div style='max-width:480px'>"
         + "<div style='font-family:monospace;font-weight:600'>" + sig + "</div>"
         + (c.module ? "<div style='font-size:11px;color:#888;margin:4px 0'>" + esc(c.module) + "</div>" : "")
         + (doc ? "<div>" + doc + "</div>" : "")
         + "</div>";
}

/* === Output Cells (notebook-style display) === */

var _activeOutputTarget = null;  /* cardId of the currently running editor */
var _mermaidReady = false;

function renderOutputCell(cell, container) {
    var div = document.createElement("div");
    div.className = "output-cell";

    switch (cell.mime) {
        case "text/plain":
            div.className += " output-cell-text";
            div.textContent = cell.content;
            break;
        case "text/html":
            div.className += " output-cell-html";
            div.innerHTML = cell.content;
            break;
        case "image/svg+xml":
            div.className += " output-cell-svg";
            div.innerHTML = cell.content;
            break;
        case "text/x-mermaid":
            div.className += " output-cell-mermaid";
            var mermaidId = "mermaid-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
            div.id = mermaidId;
            div.textContent = cell.content;
            if (window.mermaid) {
                if (!_mermaidReady) { mermaid.initialize({ startOnLoad: false, theme: "neutral" }); _mermaidReady = true; }
                mermaid.render(mermaidId + "-svg", cell.content).then(function (result) { div.innerHTML = result.svg; });
            }
            break;
        case "text/x-latex":
            div.className += " output-cell-latex";
            div.textContent = cell.content;
            if (window.katex) {
                try { katex.render(cell.content, div, { displayMode: true, throwOnError: false }); } catch (e) { div.textContent = cell.content; }
            }
            break;
        case "application/vnd.plotly+json":
            div.className += " output-cell-plotly";
            div.style.minHeight = "280px";
            container.appendChild(div);
            if (window.Plotly) {
                try {
                    var plotData = JSON.parse(cell.content);
                    Plotly.newPlot(div, plotData.data || [], plotData.layout || {}, { responsive: true });
                } catch (e) { div.textContent = "Plot error: " + e.message; }
            } else {
                div.textContent = "(Plotly not loaded)";
            }
            return;  /* already appended */
        default:
            div.className += " output-cell-text";
            div.textContent = cell.content;
    }
    container.appendChild(div);
}

/* Count completed display() calls in source code (balanced parens on one logical line) */
function countDisplayCalls(code) {
    var count = 0;
    var re = /\bdisplay\s*\(/g;
    var match;
    while ((match = re.exec(code)) !== null) {
        /* Walk forward from the opening paren to find balanced close */
        var depth = 1, i = match.index + match[0].length;
        while (i < code.length && depth > 0) {
            if (code[i] === "(") depth++;
            else if (code[i] === ")") depth--;
            i++;
        }
        if (depth === 0) count++;
    }
    return count;
}

/* Resolve a card's code from (in order): user-edited ace buffer, saved
   cState.code, card.snippet (fetch), card.template with {init}
   substitution, class + init auto-generator, fallback placeholder. Used
   by both the unified play handler and the editor-open path so the
   "run without opening the editor" flow produces the same code the user
   would see in ace. */
async function resolveCardCode(targetId, card) {
    var container = document.getElementById(targetId);
    var cState = _project && _project.cardState ? _project.cardState.get(targetId) : null;
    if (container && container._editor) return container._editor.getValue();
    var defCode = cardDefaults[targetId] ? cardDefaults[targetId].code : "";
    if (cState && cState.code && cState.code !== defCode) return cState.code;
    if (card.snippet) {
        var cli = await getCli();
        var text = await cli.fetchSnippet(card.snippet);
        return text || "# snippet not found\n";
    }
    if (card.template) {
        var tpl = card.template;
        if (card.init) Object.keys(card.init).forEach(function (k) { tpl = tpl.split("{" + k + "}").join(String(card.init[k])); });
        return tpl;
    }
    if (card["class"]) {
        var parts = card["class"].split(".");
        var cls = parts[parts.length - 1];
        var mod = parts.slice(0, -1).join(".");
        var kwargs = card.init ? Object.keys(card.init).map(function (k) {
            var v = card.init[k];
            return k + "=" + (typeof v === "string" ? "'" + v + "'" : v);
        }).join(", ") : "";
        return "from " + mod + " import " + cls + "\n\nmodel = " + cls + "(" + kwargs + ")\n";
    }
    return "# edit here\n";
}

/* Unified play handler. Replaces both the old setupOutputPanel.run
   button and the vis refresh button. Knows how to inject time_step /
   field_name for viz cards, updates timeline + field selector from
   store_meta, and renders results into the card's .output-cells list.

   Options:
     - timelineEl / fieldSelEl: DOM elements for the per-frame controls
       (optional; only passed by vis cards so non-vis cards don't try
       to read a slider value). */
async function executeCard(targetId, card, options) {
    options = options || {};
    var container = document.getElementById(targetId);
    if (!container) return;
    var cells = document.getElementById(targetId + "-output");
    if (!cells) return;
    if (container._running) return;
    container._running = true;
    _activeOutputTarget = targetId + "-output";

    /* Clear the output cell list at the START of every run. The only way
       a snippet publishes output is through display() (engine.py no longer
       sniffs the scope for a `fig` variable); display callbacks fire
       asynchronously while process_code runs and append cells into this
       container, so clearing up front means "one plot in, one plot out"
       even when the snippet produces multiple display() calls. */
    cells.innerHTML = "";

    var runBtn = document.getElementById(targetId + "-run");
    var prevLabel = runBtn ? runBtn.innerHTML : "";
    if (runBtn) { runBtn.disabled = true; runBtn.innerHTML = "&hellip;"; }

    try {
        var code = await resolveCardCode(targetId, card);

        /* Timeline + field-selector injection — only present on vis cards. */
        if (options.timelineEl) {
            code = "time_step = " + options.timelineEl.value + "\n" + code;
        }
        if (options.fieldSelEl && !options.fieldSelEl.disabled &&
            options.fieldSelEl.value && options.fieldSelEl.value !== "\u2014") {
            var safe = options.fieldSelEl.value.replace(/"/g, '\\"');
            code = 'field_name = "' + safe + '"\n' + code;
        }

        /* Plotly is needed only when the snippet imports it; ensure it's
           loaded before the first display() callback arrives. For simple
           stdout-only runs this is a no-op cache hit. */
        if (/\bplotly\b/.test(code)) await ensurePlotly();

        var cli = await _readyCli();    // scope runCode to the active session's worker
        var resultJson = await cli.runCode(code);
        var result = JSON.parse(resultJson);

        /* stdout (print) lands here — display()-produced plots have
           already been appended by the display callback during runCode. */
        if (result.output && result.output.trim()) {
            renderOutputCell({ mime: "text/plain", content: result.output }, cells);
        }
        if (result.status === "error") {
            /* result.output already contains the traceback; but if it was
               empty we still want a visible error marker. */
            if (!result.output || !result.output.trim()) {
                renderOutputCell({ mime: "text/plain", content: "(error — no message)" }, cells);
            }
        }
        if (result.status === "cancelled") {
            renderOutputCell({ mime: "text/plain", content: "(cancelled)" }, cells);
        }

        /* Update timeline + field selector from store metadata (viz cards). */
        if (result.store_meta) {
            if (options.timelineEl) {
                var nSnaps = result.store_meta.n_snapshots || 0;
                if (nSnaps >= 1) {
                    options.timelineEl.max = Math.max(0, nSnaps - 1);
                    if (parseInt(options.timelineEl.value, 10) > options.timelineEl.max) {
                        options.timelineEl.value = options.timelineEl.max;
                    }
                    options.timelineEl.disabled = (nSnaps <= 1);
                    var tsLabel = document.getElementById(targetId + "-ts");
                    if (tsLabel) tsLabel.textContent = options.timelineEl.value + "/" + options.timelineEl.max;
                }
            }
            if (options.fieldSelEl) {
                var fields = result.store_meta.fields || [];
                if (fields.length) {
                    var prev = options.fieldSelEl.value;
                    var optHtml = "";
                    fields.forEach(function (name) {
                        optHtml += '<option value="' + name + '">' + name + '</option>';
                    });
                    options.fieldSelEl.innerHTML = optHtml;
                    if (fields.indexOf(prev) !== -1) options.fieldSelEl.value = prev;
                    options.fieldSelEl.disabled = false;
                }
            }
        }
    } catch (err) {
        renderOutputCell({ mime: "text/plain", content: "Error: " + (err.message || err) }, cells);
    } finally {
        _activeOutputTarget = null;
        container._running = false;
        if (runBtn) { runBtn.disabled = false; runBtn.innerHTML = prevLabel || "&#9654;"; }
    }
}

/* Wire auto-run: watch the editor for completed display() calls and
   re-execute when the count grows, honouring cState.auto_run. Default:
   ON for model/mesh/vis, OFF for solver (per plan — solver cards can
   run 30+ seconds; silent re-runs on edit are a footgun). */
function setupAutoRun(targetId, card, cState, cardType, options) {
    var container = document.getElementById(targetId);
    if (!container || !container._editor) return;
    var _lastCount = countDisplayCalls(container._editor.getValue());
    var _debounce = null;
    container._editor.session.on("change", function () {
        var on = (cState.auto_run !== undefined) ? !!cState.auto_run : (cardType !== "solver");
        if (!on) return;
        if (_debounce) clearTimeout(_debounce);
        _debounce = setTimeout(function () {
            var code = container._editor.getValue();
            var n = countDisplayCalls(code);
            if (n > _lastCount) {
                _lastCount = n;
                executeCard(targetId, card, options);
            } else {
                _lastCount = n;
            }
        }, 800);
    });
}

/* display() message routing is wired inside attachPyWorkerHandlers above;
   re-creating the worker (stop-simulation path) rewires it automatically. */

/* === CardManager ===
 * layout: "stack" (full width, default) or "grid" (multi-column)
 * columns: number of grid columns (default 2, only for layout:"grid")
 * selectable: whether cards highlight on click (default true)
 * collapseUnselected: if true, non-selected cards show title only
 */

function CardManager(id, opts) {
    opts = opts || {};
    this.id = id;
    this.cards = [];
    this.selectedId = null;
    this.layout = opts.layout || "stack";
    this.columns = opts.columns || 2;
    this.selectable = opts.selectable !== false;
    this.collapseUnselected = !!opts.collapseUnselected;
    this.onSelect = opts.onSelect || null;
    this.containerEl = null;
}

CardManager.prototype.add = function (cardData) { this.cards.push(cardData); };

CardManager.prototype.select = function (cardId) {
    if (!this.selectable) return;
    if (this.collapseUnselected && this.selectedId === cardId) {
        this.selectedId = null;
    } else {
        this.selectedId = cardId;
    }
    this.updateUI();
    if (this.onSelect) this.onSelect(this.selectedId);
};

CardManager.prototype.updateUI = function () {
    var self = this;
    var container = this.containerEl || document.getElementById("tab-" + this.id);
    if (!container) return;
    container.querySelectorAll(".card[data-mgr='" + this.id + "']").forEach(function (c) {
        var isSel = c.id === self.selectedId;
        if (self.selectable) c.classList.toggle("selected", isSel);
        if (self.collapseUnselected) c.classList.toggle("collapsed", !isSel);
    });
};

CardManager.prototype.render = function (parentEl) {
    var wrapper = document.createElement("div");
    if (this.layout === "grid") {
        wrapper.className = "card-grid";
        wrapper.style.gridTemplateColumns = "repeat(" + this.columns + ", 1fr)";
    }
    this.containerEl = wrapper;
    parentEl.appendChild(wrapper);
    return wrapper;
};

var managers = {};

/* === Core state (from core.js) === */

var _project = null;
var cardState = null;
var cardDefaults = null;

function initProject(config) {
    _project = ZoomyCore.Project.fromConfig(config);
    cardState = _project.cardState.cards;
    cardDefaults = _project.cardState.defaults;
}

function getCardState(cardId, defaults, tabId, subtab) {
    return _project.cardState.init(cardId, defaults, tabId, subtab);
}

function isCardModified(cardId) {
    return _project.cardState.isModified(cardId);
}

function buildProjectZip() {
    /* Sync UI selections into core project */
    Object.keys(managers).forEach(function (tabId) {
        if (managers[tabId].selectedId) _project.selections.select(tabId, managers[tabId].selectedId);
    });
    /* Sync session list from UI into core */
    _project.sessions.sessions.forEach(function (coreSess) {
        var uiSess = sessionMgr.cards.find(function (s) { return s.id === coreSess.id; });
        if (uiSess) { coreSess.title = uiSess.title; coreSess.description = uiSess.description; }
    });
    _project.sessions.activeId = sessionMgr.selectedId;

    var data = _project.buildSaveData();
    var zip = new JSZip();
    zip.file("project.json", JSON.stringify(data.projectJson, null, 2));
    data.cards.forEach(function (c) {
        zip.file(c.folder + "/card.json", JSON.stringify(c.meta, null, 2));
        if (c.code) zip.file(c.folder + "/code.py", c.code);
    });
    logDebug("info", "Project: " + data.cards.length + " modified cards across " + _project.sessions.sessions.length + " session(s) saved");
    return zip;
}

async function saveProject() {
    var zip = buildProjectZip();
    var blob = await zip.generateAsync({ type: "blob" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "zoomy-project.zip";
    a.click();
    URL.revokeObjectURL(a.href);
    logDebug("info", "Project saved as zoomy-project.zip");
}

async function loadProject(file) {
    try {
        var zip = await JSZip.loadAsync(file);

        var projectFile = null;
        zip.forEach(function (path, entry) {
            if (!entry.dir && path.endsWith("project.json")) projectFile = entry;
        });

        var project = {};
        if (projectFile) {
            project = JSON.parse(await projectFile.async("string"));
        }

        /* Parse card files from ZIP */
        var cardFiles = {};
        zip.forEach(function (relativePath, entry) {
            if (entry.dir) return;
            if (relativePath.endsWith("project.json")) return;
            var parts = relativePath.split("/");
            var filename = parts[parts.length - 1];
            var folderParts = parts.slice(0, -1);
            var folderKey = folderParts.join("/");
            if (!cardFiles[folderKey]) cardFiles[folderKey] = {};
            if (filename === "card.json") cardFiles[folderKey].json = entry;
            else if (filename === "code.py") cardFiles[folderKey].code = entry;
        });

        /* Build card entries array for applySaveData */
        var cardEntries = [];
        for (var folderKey in cardFiles) {
            var cf = cardFiles[folderKey];
            if (!cf.json) continue;
            var metaStr = await cf.json.async("string");
            var meta = JSON.parse(metaStr);
            var code = cf.code ? await cf.code.async("string") : null;

            /* Determine sessionId from folder path (first segment matches session title) */
            var folderSession = folderKey.split("/")[0];
            var sessionId = null;
            if (project.sessions) {
                for (var si = 0; si < project.sessions.length; si++) {
                    var sTitle = ZoomyCore.safeFolderName(project.sessions[si].title);
                    if (sTitle === folderSession) { sessionId = project.sessions[si].id; break; }
                }
            }

            cardEntries.push({ meta: meta, code: code, sessionId: sessionId, folder: folderKey });
        }

        /* Apply via core.js (handles v1.0 and v1.1) */
        var restoredCount = _project.applySaveData(project, cardEntries);

        /* Sync session sidebar from core sessions */
        sessionMgr.cards = _project.sessions.sessions.map(function (s) {
            return { id: s.id, title: s.title, description: s.description || "" };
        });
        sessionMgr.selectedId = _project.sessions.activeId;
        renderSessionSidebar();
        renderDashboardSessionCard();

        /* Sync UI managers with restored selections */
        var sel = _project.selections.toDict();
        Object.keys(sel).forEach(function (tabId) {
            if (managers[tabId]) managers[tabId].select(sel[tabId]);
        });
        /* If the restored selection in the active tab lives inside a
           subtab, jump to that subtab so the card is visible. (On
           later tab switches the same is done by switchTab.) */
        if (activeTabId) _focusSubtabOfSelection(activeTabId);

        /* Refresh any open editors with restored card state */
        Object.keys(_project.cardState.cards).forEach(function (cardId) {
            var cs = _project.cardState.cards[cardId];
            var titleEl = document.querySelector("#" + CSS.escape(cardId) + " .card-title");
            if (titleEl) titleEl.textContent = cs.title;
            var descEl = document.querySelector("#" + CSS.escape(cardId) + " .card-description");
            if (descEl) {
                descEl.innerHTML = cs.description;
                if (window.renderMathInElement) {
                    renderMathInElement(descEl, { delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}] });
                }
            }
            var cEl = document.getElementById(cardId);
            if (cEl && cEl._editor && cs.code) cEl._editor.setValue(cs.code, -1);
        });

        logDebug("info", "Project loaded: " + restoredCount + " session(s) restored from " + Object.keys(cardFiles).length + " card entries");
    } catch (err) {
        logDebug("error", "Load failed: " + err.message);
    }
}

/* === URL-based project loading (relative, GitHub, Zenodo) === */

function resolveProjectUrl(raw) {
    /* zenodo:12345 or zenodo:12345/filename.zip */
    if (raw.startsWith("zenodo:")) {
        var parts = raw.slice(7).split("/");
        var recordId = parts[0];
        var filename = parts[1] || null;
        if (filename) {
            return { url: "https://zenodo.org/api/records/" + recordId + "/files/" + filename + "/content", type: "direct" };
        }
        return { url: "https://zenodo.org/api/records/" + recordId, type: "zenodo-metadata" };
    }
    /* Full URL (GitHub releases, any HTTPS host) */
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
        return { url: raw, type: "direct" };
    }
    /* Relative path (same-origin) */
    return { url: raw, type: "direct" };
}

async function loadProjectFromUrl(raw) {
    var resolved = resolveProjectUrl(raw);
    var downloadUrl = resolved.url;

    if (resolved.type === "zenodo-metadata") {
        /* Fetch Zenodo record metadata, find first .zip file */
        logDebug("info", "Fetching Zenodo record metadata...");
        var metaResp = await fetch(resolved.url);
        if (!metaResp.ok) throw new Error("Zenodo record not found (HTTP " + metaResp.status + ")");
        var record = await metaResp.json();
        var files = record.files || [];
        var zipFile = files.find(function (f) { return (f.key || "").endsWith(".zip"); });
        if (!zipFile) throw new Error("No .zip file found in Zenodo record");
        downloadUrl = zipFile.links && zipFile.links.self ? zipFile.links.self
                    : "https://zenodo.org/api/records/" + raw.slice(7).split("/")[0] + "/files/" + zipFile.key + "/content";
        logDebug("info", "Found Zenodo file: " + zipFile.key);
    }

    logDebug("info", "Downloading project: " + downloadUrl);
    var resp = await fetch(downloadUrl);
    if (!resp.ok) throw new Error("Failed to fetch project (HTTP " + resp.status + ")");
    var blob = await resp.blob();
    await loadProject(blob);
}

async function checkUrlProject() {
    var params = new URLSearchParams(window.location.search);
    var projectUrl = params.get("project");
    if (!projectUrl) return;
    logDebug("info", "Auto-loading project from URL: " + projectUrl);
    showToast("Loading project...");
    try {
        await loadProjectFromUrl(projectUrl);
        hideToast();
        /* Auto-switch to specific session if requested */
        var sessionName = params.get("session");
        if (sessionName && _project) {
            var target = _project.sessions.sessions.find(function (s) { return s.title === sessionName || s.id === sessionName; });
            if (target) {
                _project.sessions.switchTo(target.id, _project);
                sessionMgr.selectedId = target.id;
                renderSessionSidebar();
                renderDashboardSessionCard();
                var sel = _project.selections.toDict();
                Object.keys(sel).forEach(function (tab) { if (managers[tab]) managers[tab].select(sel[tab]); });
            }
        }
        /* Auto-run if #run hash */
        if (window.location.hash === "#run") {
            logDebug("info", "Auto-running simulation (#run)");
            document.getElementById("btn-run-sim").click();
        }
    } catch (err) {
        logDebug("error", "Failed to load project from URL: " + err.message);
        hideToast();
    }
}

/* === Session manager (cards in sidebar, full card on dashboard) === */

var sessionMgr = new CardManager("sessions", {
    onSelect: function () {
        if (_project) {
            /* Snapshot departing session, restore arriving session in core.js. */
            var arriving = sessionMgr.selectedId;
            _project.sessions.switchTo(arriving, _project);

            /* Sync UI managers with restored selections. Every tab's
               manager must match the arriving session exactly — tabs
               NOT in the arriving session's selections get cleared so
               the previous session's selection doesn't bleed through. */
            var sel = _project.selections.toDict();
            Object.keys(managers).forEach(function (tab) {
                var mgr = managers[tab];
                if (!mgr) return;
                if (sel[tab]) {
                    mgr.select(sel[tab]);
                } else {
                    mgr.selectedId = null;
                    mgr.updateUI();
                }
            });

            /* Refresh open editors with restored card state */
            Object.keys(_project.cardState.cards).forEach(function (cardId) {
                var cEl = document.getElementById(cardId);
                var cs = _project.cardState.cards[cardId];
                if (cEl && cEl._editor && cs) cEl._editor.setValue(cs.code || "", -1);
            });

            /* Per-session UI state (log + run status + worker) gets
               swapped in by the session-runtime helpers below. */
            _applySessionRuntime();
        }
        renderSessionSidebar();
        renderDashboardSessionCard();
    }
});

function createSession(name) {
    var id = "session-" + Date.now();
    /* Snapshot the CURRENT session (if any) so its selections stick
       before we switch away. Then push the new record with an empty
       selections dict. DO NOT set activeId here — that would short-
       circuit switchTo() when sessionMgr.select fires below, leaving
       project.selections untouched (= still showing the old
       session's picks). Instead we let the onSelect handler's
       switchTo do the transition: snapshot OLD -> activeId = NEW ->
       restoreSession(NEW) which clears project.selections and applies
       the new (empty) session's selections. */
    if (_project) {
        _project.sessions.snapshotSession(_project);
        var session = {
            id: id, title: name, description: "Simulation session.",
            selections: {}, cardOverrides: {},
        };
        _project.sessions.sessions.push(session);
        /* Absorb any boot-phase log entries the moment a session
           exists (only relevant for the very first session). */
        _snapshotBootLog();
    }
    sessionMgr.add({ id: id, title: name, description: "Simulation session." });
    sessionMgr.select(id);   // ← triggers onSelect → switchTo → clean transition
}

function renderSessionSidebar() {
    var list = document.getElementById("session-list");
    if (!list) return;
    list.innerHTML = "";
    sessionMgr.cards.forEach(function (s) {
        var li = document.createElement("li");
        li.className = "sidebar-list-item" + (s.id === sessionMgr.selectedId ? " active" : "");
        li.textContent = s.title;
        li.onclick = function () { sessionMgr.select(s.id); };
        list.appendChild(li);
    });
}

function getActiveSession() {
    return sessionMgr.cards.find(function (s) { return s.id === sessionMgr.selectedId; });
}

function renderDashboardSessionCard() {
    var el = document.getElementById("dashboard-session-card");
    if (!el) return;
    var s = getActiveSession();
    if (!s) { el.innerHTML = ""; return; }
    createSlotCard(el.id, {
        title: s.title,
        actions: ["gear"],
        slots: [
            { type: "description", content: s.description },
            {
                type: "params",
                localParams: { name: { type: "String", default: s.title, doc: "Session name" } },
                onParamChange: function (n, v) {
                    if (n === "name") { s.title = v; renderSessionSidebar(); }
                }
            }
        ]
    }, null);
}

function renderDashboardConnections() {
    var el = document.getElementById("dashboard-connections");
    if (!el || !_cli) return;
    var html = '<span class="session-conn-tag">numpy (pyodide)</span>';
    for (var tag of _cli.http.keys()) {
        if (!_cli.isHttpConnected(tag)) continue;
        html += '<span class="session-conn-tag">' + tag + ' <button class="session-conn-x" data-tag="' + tag + '">&times;</button></span>';
    }
    el.innerHTML = html;
    el.querySelectorAll(".session-conn-x").forEach(function (btn) {
        btn.onclick = function (e) {
            e.stopPropagation();
            if (_cli) _cli.disconnect(this.dataset.tag);
        };
    });
}

/* === Tabs === */

var activeTabId = null;
function switchTab(tabId) {
    activeTabId = tabId;
    document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === tabId); });
    document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.toggle("active", p.id === "tab-" + tabId); });
    _focusSubtabOfSelection(tabId);
}

/* When the user switches into a tab that has its selected card living
   inside a specific subtab, jump to that subtab so the selection is
   visible without the user having to hunt for it. No-op for tabs with
   no subtabs or no current selection. */
function _focusSubtabOfSelection(tabId) {
    var mgr = managers[tabId];
    if (!mgr || !mgr.selectedId) return;
    var sel = mgr.cards.find(function (c) { return "card-" + c.id === mgr.selectedId; });
    if (!sel || !sel.subtab) return;
    var panel = document.getElementById("tab-" + tabId);
    if (!panel) return;
    var btn = panel.querySelector('.subtab-btn[data-subtab="' + sel.subtab + '"]');
    if (btn && !btn.classList.contains("active")) btn.click();
}

/* === Exclusive toggle === */

function exclusiveToggle(btn, panel, otherBtn, otherPanel, loadFn) {
    if (!btn || !panel) return;
    btn.onclick = async function (e) {
        e.stopPropagation();
        if (panel.classList.contains("open")) { panel.classList.remove("open"); btn.classList.remove("open"); return; }
        if (otherPanel && otherPanel.classList.contains("open")) { otherPanel.classList.remove("open"); if (otherBtn) otherBtn.classList.remove("open"); }
        if (loadFn) { btn.disabled = true; await loadFn(); btn.disabled = false; }
        panel.classList.add("open"); btn.classList.add("open");
    };
}

/* === Slot-based card rendering === */

function createSlotCard(targetId, cfg, mgr) {
    var container = document.getElementById(targetId);
    if (!container) return;

    container.className = "card";
    if (cfg.variant) container.classList.add("card--" + cfg.variant);
    if (mgr) container.dataset.mgr = mgr.id;
    if (cfg.actions && cfg.actions.length) container.dataset.hasActions = "true";

    var html = '<div class="card-header"><span class="card-title">' + cfg.title + '</span>';
    html += '<div class="card-header-actions">';
    if (cfg.titleActions) {
        cfg.titleActions.forEach(function (a) {
            html += '<button class="icon-btn sm" id="' + a.id + '" title="' + (a.title || '') + '">' + a.icon + '</button>';
        });
    }
    if (cfg.actions && cfg.actions.indexOf("gear") !== -1)
        html += '<button class="icon-btn" id="' + targetId + '-gear" title="Parameters">&#9881;</button>';
    html += '</div></div>';

    html += '<div class="card-body">';
    (cfg.slots || []).forEach(function (slot, idx) {
        if (slot.type === "description" || slot.type === "text") {
            html += '<p class="card-description">' + (slot.content || '') + '</p>';
        } else if (slot.type === "custom") {
            html += '<div id="' + slot.id + '"></div>';
        } else if (slot.type === "log") {
            html += '<div class="card-slot-log" id="' + slot.id + '"></div>';
        }
    });
    html += '</div>';

    var hasGear = cfg.actions && cfg.actions.indexOf("gear") !== -1;
    if (hasGear) html += '<div class="expandable" id="' + targetId + '-params"></div>';

    container.innerHTML = html;

    if (mgr && mgr.selectable) {
        container.onclick = function (e) {
            if (e.target.closest(".icon-btn,.expandable")) return;
            mgr.select(targetId);
        };
    }

    if (cfg.titleActions) {
        cfg.titleActions.forEach(function (a) {
            if (a.onclick) {
                var btn = document.getElementById(a.id);
                if (btn) btn.onclick = function (e) { e.stopPropagation(); a.onclick(); };
            }
        });
    }

    if (hasGear) {
        var gearBtn = document.getElementById(targetId + "-gear");
        var paramsDiv = document.getElementById(targetId + "-params");
        var gearLoaded = false;

        var paramSlot = null;
        (cfg.slots || []).forEach(function (s) { if (s.type === "params") paramSlot = s; });

        exclusiveToggle(gearBtn, paramsDiv, null, null, async function () {
            if (gearLoaded) return;
            if (paramSlot && paramSlot.localParams) {
                paramsDiv.appendChild(renderParamWidgets({ params: paramSlot.localParams }, function (n, v) {
                    if (paramSlot.onParamChange) paramSlot.onParamChange(n, v);
                    var titleEl = container.querySelector(".card-title");
                    if (n === "name" && titleEl) titleEl.textContent = v;
                }));
            }
            gearLoaded = true;
        });
    }
}

/* === Unified card ===
 *
 *            gear  edit  refresh  sizeSelector  timeline  preview  maximize
 *  model:     Y     Y      -          -            -         -       Y
 *  solver:    Y     Y      -          -            -         -       Y
 *  mesh:      Y     *      -          *            -         -       -
 *  vis:       Y     Y      Y          -            *         *       Y
 *  session:   Y     -      -          -            -         -       -
 */

function createCard(targetId, card, mgr, cardType) {
    var container = document.getElementById(targetId);
    if (!container) return;

    var hasEdit     = cardType === "model" || cardType === "solver" || cardType === "vis" || (cardType === "mesh" && !!card.template);
    var hasPlay     = hasEdit;                          // every code-bearing card gets the unified play button
    var hasSizes    = cardType === "mesh" && card.mesh_sizes && card.mesh_sizes.length > 0;
    var hasTimeline = cardType === "vis" && !!card.has_timeline;
    var hasMaximize = hasEdit;                          // same set as code-bearing
    var hasClass    = !!card["class"];
    var hasLocal    = !!card._localParams;
    var hasGear     = true;
    /* Preview: explicit path or auto-detect by convention previews/{id}.svg */
    if (!card.preview) card._autoPreview = "previews/" + card.id + ".svg";
    var previewSrc  = card.preview || card._autoPreview;

    container.className = "card" + (hasPlay ? " has-code" : " slot-only");
    if (card.requires_tag) {
        container.dataset.requiresTag = card.requires_tag;
        if (!_cliIsTagConnected(card.requires_tag)) container.classList.add("disabled");
    }
    if (mgr) container.dataset.mgr = mgr.id;

    var hasConnectionStatus = !!card.requires_tag;

    /* --- Header: title + connection badge + maximize --- */
    var html = '<div class="card-header"><span class="card-title">' + card.title + '</span>';
    html += '<div class="card-header-actions">';
    if (hasConnectionStatus) {
        var tagConnected = _cliIsTagConnected(card.requires_tag);
        html += '<span class="card-connection-status' + (tagConnected ? ' connected' : '') + '">' +
                (tagConnected ? 'Connected' : 'Disconnected') + '</span>';
    }
    if (hasMaximize) html += '<button class="icon-btn sm" id="' + targetId + '-max" title="Maximize">&#9723;</button>';
    html += '</div></div>';

    /* A `has-vis` class keeps the play button visible on vis cards by
       default (it's hidden elsewhere until the edit panel opens).
       `edit-open` is toggled by exclusiveToggle when the editor
       expandable opens; see the CSS rules under .card-play-btn.

       Every code-bearing card starts COLLAPSED. The tab-level
       CardManager runs with collapseUnselected=true, so selection
       state (body click or title click) is what toggles visibility.
       The CardManager normally wouldn't add .collapsed to every card
       at render time — only to unselected ones during updateUI — so
       we apply it here to cover the just-rendered state. */
    if (cardType === "vis") container.classList.add("has-vis");
    container.classList.add("collapsed");

    html += '<div class="card-body">';
    if (card.description) html += '<div class="card-description">' + miniMarkdown(card.description) + '</div>';

    /* --- Controls bar: gear / edit / play live together. Play is
       hidden by default for non-vis cards; CSS reveals it only when
       the edit panel is open, or when the card is a vis card. --- */
    html += '<div class="card-controls">';
    if (hasTimeline) html += '<div class="card-timeline"><input type="range" min="0" max="100" value="0" id="' + targetId + '-tl"><span id="' + targetId + '-ts">0</span></div>';
    if (cardType === "vis") html += '<select class="card-select" id="' + targetId + '-field-select" disabled title="Field"><option>\u2014</option></select>';
    if (hasGear) html += '<button class="icon-btn" id="' + targetId + '-gear" title="Parameters">&#9881;</button>';
    if (hasEdit) html += '<button class="icon-btn" id="' + targetId + '-edit" title="Edit code">&#9998;</button>';
    if (hasPlay) html += '<button class="icon-btn card-play-btn" id="' + targetId + '-run" title="Run">&#9654;</button>';
    if (hasSizes) {
        html += '<select class="card-select" id="' + targetId + '-size">';
        card.mesh_sizes.forEach(function (s) { html += '<option>' + s + '</option>'; });
        html += '</select>';
    }
    html += '</div>';

    /* --- Expandable panels (params + code), before the output cell. --- */
    if (hasGear) html += '<div class="expandable" id="' + targetId + '-params"></div>';
    if (hasEdit) html += '<div class="expandable card-code" id="' + targetId + '-editor-wrap"></div>';

    /* --- Output list (always at the bottom for code-bearing cards). --- */
    if (hasPlay) {
        html += '<div class="card-output"><div class="output-cells" id="' + targetId + '-output">';
        /* Preview image appears initially when no output exists. Cleared on first run. */
        if (previewSrc) {
            html += '<img class="card-output-preview" id="' + targetId + '-preview" loading="lazy" decoding="async" src="' + previewSrc + '" onerror="this.style.display=\'none\'">';
        }
        html += '</div></div>';
    }

    html += '</div>';   /* .card-body */

    container.innerHTML = html;

    /* Click anywhere on the card body → select. The filter below skips
       interactive widgets so clicking a button/select/slider/output
       cell doesn't also reselect. Title click still bubbles through
       this handler (it's not in the skip list), so selecting via the
       title works the same as selecting by clicking the body. */
    if (mgr) {
        container.onclick = function (e) {
            if (e.target.closest(".icon-btn,.expandable,select,.card-timeline,.card-play,.card-output,.play-btn,.output-cells")) return;
            mgr.select(targetId);
        };
    }

    /* Title click ALSO toggles .collapsed. Don't stopPropagation — we
       want the container click handler above to still fire so the
       card also becomes the selection when its title is clicked. */
    var titleEl = container.querySelector(".card-title");
    if (titleEl) {
        titleEl.style.cursor = "pointer";
        titleEl.onclick = function () {
            container.classList.toggle("collapsed");
        };
    }

    /* Maximize */
    if (hasMaximize) {
        document.getElementById(targetId + "-max").onclick = function (e) {
            e.stopPropagation();
            container.classList.toggle("maximized");
            this.innerHTML = container.classList.contains("maximized") ? "&#10005;" : "&#9723;";
            /* Re-size any plot(s) that live inside the shared output-cells
               list now that the container has changed size. */
            var plots = container.querySelectorAll(".output-cell-plotly");
            if (plots.length && window.Plotly) {
                setTimeout(function () {
                    plots.forEach(function (p) { try { Plotly.Plots.resize(p); } catch (e) {} });
                }, 100);
            }
            if (container._editor) {
                setTimeout(function () { container._editor.resize(); }, 100);
            }
        };
    }

    /* The timeline slider's label + auto-refresh, and the field
       selector's auto-refresh, need the per-frame control elements —
       captured here so the play-button wiring below can reuse them. */
    var tlSlider = hasTimeline ? document.getElementById(targetId + "-tl") : null;
    var tsLabel = hasTimeline ? document.getElementById(targetId + "-ts") : null;
    var fieldSelEl = cardType === "vis" ? document.getElementById(targetId + "-field-select") : null;

    if (tlSlider) {
        tlSlider.oninput = function () {
            if (tsLabel) tsLabel.textContent = tlSlider.value + "/" + tlSlider.max;
        };
        var _tlDebounce = null;
        tlSlider.addEventListener("change", function () {
            if (_tlDebounce) clearTimeout(_tlDebounce);
            _tlDebounce = setTimeout(function () {
                var runBtn = document.getElementById(targetId + "-run");
                if (runBtn && !runBtn.disabled) runBtn.click();
            }, 300);
        });
    }
    if (fieldSelEl) {
        var _fsDebounce = null;
        fieldSelEl.addEventListener("change", function () {
            if (_fsDebounce) clearTimeout(_fsDebounce);
            _fsDebounce = setTimeout(function () {
                var runBtn = document.getElementById(targetId + "-run");
                if (runBtn && !runBtn.disabled) runBtn.click();
            }, 200);
        });
    }

    /* Gear + Edit */
    var gearBtn = document.getElementById(targetId + "-gear");
    var paramsDiv = document.getElementById(targetId + "-params");
    var editBtn = hasEdit ? document.getElementById(targetId + "-edit") : null;
    var editorWrap = hasEdit ? document.getElementById(targetId + "-editor-wrap") : null;
    var gearLoaded = false, editorLoaded = false;

    var cState = getCardState(targetId, card, mgr ? mgr.id : "", card.subtab || "");

    var hasDescription = !!card.description || cardType === "vis";
    var descEditorReady = false;

    /* Auto-run default: ON for model/mesh/vis, OFF for solver. */
    var autoRunDefault = (cardType !== "solver");
    if (cState.auto_run === undefined) cState.auto_run = autoRunDefault;

    exclusiveToggle(gearBtn, paramsDiv, editBtn, editorWrap, async function () {
        if (gearLoaded) return;

        var metaParams = {
            title: { type: "String", default: cState.title, doc: "Card title" }
        };
        if (hasPlay) {
            metaParams.auto_run = {
                type: "Boolean",
                default: !!cState.auto_run,
                doc: "Run automatically on display() edits (default ON except for solver cards)",
            };
        }
        paramsDiv.appendChild(renderParamWidgets({ params: metaParams }, function (n, v) {
            cState[n] = v;
            if (n === "title") {
                var titleEl = container.querySelector(".card-title");
                if (titleEl) titleEl.textContent = v;
            }
        }));

        if (hasDescription) {
            var descWrap = document.createElement("div");
            descWrap.className = "gear-desc-section";
            var descHtml = '<div class="gear-desc-toggle" id="' + targetId + '-desc-toggle">Description &#9662;</div>';
            if (hasClass && cardType === "model") {
                descHtml += '<button class="btn btn-sm" id="' + targetId + '-desc-fetch" style="margin:0.3rem 0">Fetch from model.describe()</button>';
            }
            descHtml += '<div class="gear-desc-editor" id="' + targetId + '-desc-ace" style="display:none"></div>';
            descWrap.innerHTML = descHtml;
            paramsDiv.appendChild(descWrap);

            /* Shared: render description from markdown text. If the card
               had no baked-in description the descEl doesn't exist yet,
               so create it on-demand above .card-controls so fetched
               describe() output has somewhere to land. */
            var _descEditor = null;
            function _renderDescription(mdText) {
                cState.description = mdText;
                var descEl = container.querySelector(".card-description");
                if (!descEl) {
                    descEl = document.createElement("div");
                    descEl.className = "card-description";
                    var body = container.querySelector(".card-body");
                    var firstControls = body ? body.querySelector(".card-controls") : null;
                    if (body) body.insertBefore(descEl, firstControls || body.firstChild);
                }
                descEl.innerHTML = miniMarkdown(mdText);
                if (window.renderMathInElement) renderMathInElement(descEl, {
                    delimiters: [
                        { left: "$$", right: "$$", display: true },
                        { left: "$",  right: "$",  display: false },
                    ],
                    throwOnError: false,
                });
            }

            if (hasClass && document.getElementById(targetId + "-desc-fetch")) {
                document.getElementById(targetId + "-desc-fetch").onclick = async function () {
                    this.textContent = "Loading...";
                    this.disabled = true;
                    var btn = this;
                    logDebug("info", "Fetching describe() for " + card["class"] + "...");
                    try {
                        var _cliRef = await _readyCli();   // active session's worker
                        var desc = await _cliRef.describeModel(card["class"], card.init || {});
                        logDebug("info", "describe() returned " + (desc ? desc.length : 0) + " chars");
                        /* Put into editor (if open) — the editor's on("change") triggers render */
                        if (_descEditor) {
                            _descEditor.setValue(desc, -1);
                        } else {
                            _renderDescription(desc);
                        }
                    } catch (err) {
                        logDebug("error", "describe_model failed: " + err.message);
                    }
                    btn.textContent = "Fetch from model.describe()";
                    btn.disabled = false;
                };
            }

            document.getElementById(targetId + "-desc-toggle").onclick = async function () {
                var editorDiv = document.getElementById(targetId + "-desc-ace");
                if (editorDiv.style.display === "none") {
                    editorDiv.style.display = "";
                    this.innerHTML = "Description &#9652;";
                    if (!descEditorReady) {
                        await ensureAce();
                        _descEditor = makeAceEditor(targetId + "-desc-ace", cState.description || "");
                        _descEditor.session.setMode("ace/mode/markdown");
                        _descEditor.setOptions({ maxLines: 20, minLines: 10 });
                        _descEditor.setTheme("ace/theme/chrome");
                        _descEditor.renderer.setShowGutter(false);
                        _descEditor.session.on("change", function () {
                            _renderDescription(_descEditor.getValue());
                        });
                        descEditorReady = true;
                    }
                } else {
                    editorDiv.style.display = "none";
                    this.innerHTML = "Description &#9662;";
                }
            };
        }

        if (hasLocal) {
            paramsDiv.appendChild(renderParamWidgets({ params: card._localParams }, function (n, v) {
                if (card._onParamChange) card._onParamChange(n, v);
            }));
        } else if (hasClass) {
            try {
                var _cliRef = await _readyCli();    // active session's worker
                var sj = await _cliRef.extractParams(card["class"], card.init || {});
                var parsed = JSON.parse(sj);
                paramsDiv.appendChild(renderParamWidgets(parsed, function (n, v) {
                    cState.params[n] = v;
                }));
            } catch (err) { paramsDiv.innerHTML += '<p style="color:#dc2626;font-size:var(--fs-s)">Class params failed: ' + err.message + '</p>'; }
        }

        gearLoaded = true;
    });

    /* --- Edit button: open the ace editor (lazy). The editor is the only
       place that writes container._editor; executeCard and setupAutoRun
       both read it. --- */
    if (hasEdit) {
        exclusiveToggle(editBtn, editorWrap, gearBtn, paramsDiv, async function () {
            if (editorLoaded) return;
            await ensureAce();
            editorWrap.innerHTML = '<div class="inline-editor" id="' + targetId + '-ace"></div>';
            var code = await resolveCardCode(targetId, card);
            container._editor = makeAceEditor(targetId + "-ace", code);
            container._code = code;
            cState.code = code;
            container._editor.session.on("change", function () { cState.code = container._editor.getValue(); });
            setupAutoRun(targetId, card, cState, cardType, { timelineEl: tlSlider, fieldSelEl: fieldSelEl });
            editorLoaded = true;
        });
        /* Mirror the edit panel's `.open` state onto the card itself so
           CSS can reveal the play button (hidden by default). A
           MutationObserver keeps the two in lock-step even if
           exclusiveToggle's internal logic changes later. */
        new MutationObserver(function () {
            container.classList.toggle("edit-open", editorWrap.classList.contains("open"));
        }).observe(editorWrap, { attributes: true, attributeFilter: ["class"] });
    }

    /* --- Unified play button: single handler for every card type. --- */
    if (hasPlay) {
        var playBtn = document.getElementById(targetId + "-run");
        if (playBtn) {
            playBtn.onclick = function (e) {
                e.stopPropagation();
                executeCard(targetId, card, { timelineEl: tlSlider, fieldSelEl: fieldSelEl });
            };
        }
    }
}

/* === Dashboard selection summary === */

function updateDashboardSummary() {
    var fields = {
        "card-dash-model": { mgr: managers.model, fallback: "No model selected." },
        "card-dash-mesh": { mgr: managers.mesh, fallback: "No mesh loaded." },
        "card-dash-status": { mgr: managers.solver, fallback: "No solver selected." }
    };
    Object.keys(fields).forEach(function (dashId) {
        var descEl = document.querySelector("#" + dashId + " .card-description");
        if (!descEl) return;
        var f = fields[dashId];
        if (f.mgr && f.mgr.selectedId) {
            var selected = f.mgr.cards.find(function (c) { return "card-" + c.id === f.mgr.selectedId; });
            descEl.textContent = selected ? selected.title : f.fallback;
        } else {
            descEl.textContent = f.fallback;
        }
    });
}

/* === Dashboard job tracking === */

var _activeJob = null;
var _simStatus = { state: "idle", lastFinished: null, lastJobId: null, runCount: 0 };
/* Which execution path owns the currently running simulation, so the stop
   button knows where to send the cancel signal. null when no sim is running. */
var _runningMode = null;         // null | "pyodide" | "server"
var _currentPyRunId = null;      // id of the in-flight run_code message

/* Setters that write through to the active session's runtime so session
   switches preserve "what's running". Direct assignments to the globals
   would leave the session runtime stale; use these helpers instead. */
function _setRunningMode(v) {
    _runningMode = v;
    var rt = _sessionRuntime(_activeSession()); if (rt) rt.runningMode = v;
}
function _setActiveJob(v) {
    _activeJob = v;
    var rt = _sessionRuntime(_activeSession()); if (rt) rt.activeJob = v;
}
function _setCurrentPyRunId(v) {
    _currentPyRunId = v;
    var rt = _sessionRuntime(_activeSession()); if (rt) rt.currentPyRunId = v;
}

function setRunBtnState(isRunning) {
    var btn = document.getElementById("btn-run-sim");
    if (!btn) return;
    if (isRunning) {
        btn.innerHTML = "&#9632; Stop simulation";
        btn.classList.add("danger");
        btn.classList.remove("primary");
    } else {
        btn.innerHTML = "&#9654; Run simulation";
        btn.classList.add("primary");
        btn.classList.remove("danger");
    }
}

function stopSimulation() {
    var mode = _runningMode;
    if (!mode) return;
    logDebug("info", "Stopping simulation (" + mode + ")...");
    showToast("Stopping simulation...");

    if (mode === "pyodide") {
        /* Ask the CLI's PyodideAdapter to interrupt. It prefers
           cooperative cancel (SIGINT on the shared buffer) and falls
           back to terminate + re-create when SharedArrayBuffer is
           unavailable. The result tells us which path was taken. */
        getCli().then(function (cli) {
            var res = cli.pyodide.interrupt();
            if (res.mode === "cooperative") {
                logDebug("info", "Interrupt sent (cooperative); worker keeps its state");
            } else if (res.mode === "terminate+recreate") {
                logDebug("info", "Worker terminated (no SAB); a fresh one will boot on the next run");
            }
        });
    } else if (mode === "server") {
        if (_activeJob && _activeJob.jobId && _activeJob.tag) {
            getCli().then(function (cli) {
                return cli.cancel({ tag: _activeJob.tag, jobId: _activeJob.jobId });
            }).then(function (res) {
                logDebug("info", "Server job cancelled: " + JSON.stringify(res));
            }).catch(function (err) {
                logDebug("warn", "Cancel request failed: " + (err.message || err));
            });
        }
        _setActiveJob(null);
    }

    /* On the cooperative-cancel path the worker is still alive and will
       return a KeyboardInterrupt result for the in-flight run_code — the
       existing run handler resets state when it arrives, so we let it do
       that and only clean up here for the terminate / server paths. */
    if (mode === "server" || (mode === "pyodide" && !_pyInterruptView)) {
        _setRunningMode(null);
        _setCurrentPyRunId(null);
        _simStatus.state = "idle";
        _simStatus.progressHtml = "";
        updateDashboardStatus();
        setRunBtnState(false);
    }
    setTimeout(hideToast, 1500);
}

function updateDashboardStatus() {
    var el = document.querySelector("#card-dash-run .card-description");
    if (!el) return;
    var s = _simStatus;
    if (s.state === "idle" && !s.lastFinished) {
        el.innerHTML = '<span class="status-dot status-idle"></span> Idle &mdash; no simulations run yet';
    } else if (s.state === "idle" && s.lastFinished) {
        el.innerHTML = '<span class="status-dot status-idle"></span> Idle' +
            '<br><span style="font-size:var(--fs-s);color:var(--c-muted)">Last finished: ' + s.lastFinished +
            (s.lastJobId ? ' (' + s.lastJobId + ')' : '') +
            ' &middot; ' + s.runCount + ' run' + (s.runCount !== 1 ? 's' : '') + ' total</span>';
    } else if (s.state === "running") {
        el.innerHTML = '<span class="status-dot status-running"></span> Running' +
            (s.currentJobId ? ' <b>' + s.currentJobId + '</b>' : '') +
            (s.progressHtml || '');
    } else if (s.state === "queued") {
        el.innerHTML = '<span class="status-dot status-running"></span> Queued' +
            (s.currentJobId ? ' <b>' + s.currentJobId + '</b>' : '') + '...';
    } else if (s.state === "failed") {
        el.innerHTML = '<span class="status-dot status-failed"></span> Failed' +
            (s.currentJobId ? ' <b>' + s.currentJobId + '</b>' : '') +
            '<br><span style="font-size:var(--fs-s);color:var(--c-muted)">Check Log for details</span>';
    }
}

function updateDashboardJob(status) {
    if (!status) { _simStatus.state = "idle"; updateDashboardStatus(); return; }

    var jobId = status.job_id || "?";
    var s = status.status || "?";
    _simStatus.currentJobId = jobId;

    if (s === "running" && status.progress) {
        _simStatus.state = "running";
        var p = status.progress;
        var t = p.time || 0;
        var tend = p.time_end || 1;
        var pct = tend > 0 ? Math.min(100, (t / tend * 100)).toFixed(0) : 0;
        var eta = "";
        if (_activeJob && _activeJob.startTime && t > 0) {
            var elapsed = (Date.now() - _activeJob.startTime) / 1000;
            var rate = t / elapsed;
            if (rate > 0) eta = " \u2248 " + ((tend - t) / rate).toFixed(0) + "s left";
        }
        _simStatus.progressHtml = ' ' + pct + '%' + eta +
            '<div class="progress-bar"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>';
    } else if (s === "running") {
        _simStatus.state = "running";
        _simStatus.progressHtml = '';
    } else if (s === "complete") {
        _simStatus.state = "idle";
        _simStatus.lastFinished = new Date().toLocaleString();
        _simStatus.lastJobId = jobId;
        _simStatus.runCount++;
        _simStatus.progressHtml = '';
    } else if (s === "failed") {
        _simStatus.state = "failed";
        _simStatus.progressHtml = '';
        /* Auto-reset to idle after 10s */
        setTimeout(function () {
            if (_simStatus.state === "failed") { _simStatus.state = "idle"; updateDashboardStatus(); }
        }, 10000);
    } else if (s === "cancelled") {
        _simStatus.state = "idle";
        _simStatus.lastFinished = new Date().toLocaleString() + " (cancelled)";
        _simStatus.lastJobId = jobId;
        _simStatus.progressHtml = '';
    } else if (s === "queued") {
        _simStatus.state = "queued";
    } else {
        _simStatus.state = s;
    }
    updateDashboardStatus();
}

/* === Dashboard === */

function createDashboard(panel) {
    var gridMgr = new CardManager("dash-grid", { layout: "grid", columns: 2, selectable: false });
    gridMgr.add({ id: "dash-model", title: "Model", text: "No model selected." });
    gridMgr.add({ id: "dash-mesh", title: "Mesh", text: "No mesh loaded." });
    gridMgr.add({ id: "dash-status", title: "Solver", text: "No solver selected." });
    gridMgr.add({ id: "dash-run", title: "Status", text: "Idle" });

    var gridWrap = gridMgr.render(panel);
    gridMgr.cards.forEach(function (c) {
        var div = document.createElement("div");
        div.id = "card-" + c.id;
        gridWrap.appendChild(div);
        createSlotCard("card-" + c.id, {
            title: c.title,
            slots: [{ type: "text", content: c.text }]
        }, gridMgr);
    });

    var backendsDiv = document.createElement("div");
    backendsDiv.id = "card-dash-backends";
    backendsDiv.style.marginTop = "0.8rem";
    panel.appendChild(backendsDiv);
    createSlotCard("card-dash-backends", {
        title: "Backends",
        variant: "backends",
        slots: [{ type: "custom", id: "dashboard-connections" }]
    }, null);

    var sessionDiv = document.createElement("div");
    sessionDiv.id = "dashboard-session-card";
    sessionDiv.style.marginTop = "0.8rem";
    panel.appendChild(sessionDiv);
    renderDashboardSessionCard();

    var logDiv = document.createElement("div");
    logDiv.id = "card-dash-log";
    logDiv.style.marginTop = "0.8rem";
    panel.appendChild(logDiv);
    createSlotCard("card-dash-log", {
        title: "Log",
        variant: "log",
        titleActions: [{
            id: "debug-clear", icon: "&#10005;", title: "Clear",
            onclick: function () {
                /* Clear only the ACTIVE session's log — other sessions
                   keep their history. */
                var rt = _sessionRuntime(_activeSession());
                if (rt) rt.log = [];
                _bootLog = [];
                var el = document.getElementById("debug-log");
                if (el) el.innerHTML = "";
            }
        }],
        slots: [{ type: "log", id: "debug-log" }]
    }, null);

    /* Drag-to-resize for log panel */
    (function () {
        var logEl = document.getElementById("debug-log");
        if (!logEl) return;
        var handle = document.createElement("div");
        handle.className = "log-drag-handle";
        handle.title = "Drag to resize";
        logEl.parentElement.appendChild(handle);
        var startY, startH;
        handle.addEventListener("mousedown", function (e) {
            e.preventDefault();
            startY = e.clientY;
            startH = logEl.offsetHeight;
            function onMove(ev) { logEl.style.height = Math.max(100, startH + ev.clientY - startY) + "px"; }
            function onUp() { document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); }
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    })();

    renderDashboardConnections();
    updateDashboardStatus();
    logDebug("info", "Dashboard initialized");
}

/* === Build tab === */

function buildCardsTab(panel, tab) {
    var isVis = tab.cardType === "vis";
    /* collapseUnselected:true — deselecting a card auto-collapses it and
       selecting one expands it. Combined with the initial .collapsed
       class set in createCard this gives "everything closed on load,
       only the active card is open". */
    var mgr = new CardManager(tab.id, {
        layout: tab.layout || (isVis ? "stack" : "stack"),
        columns: tab.columns || 2,
        /* Viz cards stay expanded so users can compare multiple plots
           side-by-side. Mesh/model/solver tabs keep single-selection behaviour. */
        collapseUnselected: true,
        onSelect: function (selectedId) {
            mgr.updateUI();
            updateDashboardSummary();
            /* Every user click on a card is authoritative for the
               current session's selections dict. Without this sync the
               session-snapshot (triggered when leaving the session)
               sees stale data and the selection is lost. */
            if (_project && _project.selections) {
                if (selectedId) _project.selections.select(tab.id, selectedId);
                else _project.selections.select(tab.id, null);
            }
        }
    });
    managers[tab.id] = mgr;

    var hasSubtabs = tab.subtabs && tab.subtabs.length > 0;
    var cardContainer = panel;

    if (hasSubtabs) {
        var bar = document.createElement("div");
        bar.className = "subtabs";
        var content = document.createElement("div");
        tab.subtabs.forEach(function (st, idx) {
            var btn = document.createElement("button");
            btn.className = "subtab-btn" + (idx === 0 ? " active" : "");
            btn.dataset.subtab = st.id;
            btn.textContent = st.title;
            btn.onclick = function () {
                bar.querySelectorAll(".subtab-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.subtab === st.id); });
                content.querySelectorAll(".subtab-panel").forEach(function (p) { p.classList.toggle("active", p.id === "subtab-" + st.id); });
            };
            bar.appendChild(btn);
            var sp = document.createElement("div");
            sp.id = "subtab-" + st.id;
            sp.className = "subtab-panel" + (idx === 0 ? " active" : "");
            content.appendChild(sp);
        });
        panel.appendChild(bar);
        panel.appendChild(content);
        cardContainer = content;
    }

    /* Use the CardManager's render() to create a layout wrapper (grid or stack) */
    var gridWrapper = null;
    if (!hasSubtabs && tab.layout === "grid") {
        gridWrapper = mgr.render(panel);
    }

    tab.cards.forEach(function (c) {
        mgr.add(c);
        var target;
        if (hasSubtabs && c.subtab) {
            target = cardContainer.querySelector("#subtab-" + c.subtab);
        } else if (gridWrapper) {
            target = gridWrapper;
        } else {
            target = panel;
        }
        if (!target) target = panel;
        var div = document.createElement("div");
        div.id = "card-" + c.id;
        target.appendChild(div);
    });

    tab.cards.forEach(function (c) {
        createCard("card-" + c.id, c, mgr, tab.cardType || "model");
    });

    /* No auto-selection on first render. Cards remain collapsed until the
       user clicks one. Dashboard summary fields show "Not selected" until
       then. Previously we defaulted to the first card which exposed its
       gear / editor as the "initial state" — the user wants a clean,
       collapsed catalog instead. */
}

/* === Init === */

/* === Card loading from cards/ folder structure === */

var CARD_CATEGORIES = [
    { dir: "models",         tabId: "model" },
    { dir: "solvers",        tabId: "solver" },
    { dir: "meshes",         tabId: "mesh" },
    { dir: "visualizations", tabId: "visualization" }
];

async function _loadCategoryCards(dir) {
    /* Load default + generated + user for one category, merge, deduplicate.
       Delegates to ZoomyCLI.listCards, which reads from FetchStorage with
       the same order (default -> generated -> user) and silently skips
       missing files. */
    var cli = await getCli();
    var list = await cli.listCards(dir);
    var seen = {};
    var merged = [];
    list.forEach(function (c) {
        if (!seen[c.id]) { seen[c.id] = true; merged.push(c); }
    });
    return merged;
}

async function _loadAllCards() {
    /* Load tab metadata + all category cards. Returns config object. */
    var cli = await getCli();
    var tabsMeta = (await cli.listTabs().catch(function () { return null; })) || {};

    /* Fallback: if tabs.json doesn't exist, use legacy cards.json */
    if (!tabsMeta || Object.keys(tabsMeta).length === 0) {
        var legacy = await cli.storage.tryReadJson("cards.json");
        if (legacy && legacy.tabs) return legacy;
        tabsMeta = {};
    }

    var tabs = [];

    /* Dashboard always first */
    tabs.push(tabsMeta.dashboard || { id: "dashboard", title: "Dashboard", type: "dashboard" });

    /* Load all card categories in parallel */
    var allCards = await Promise.all(CARD_CATEGORIES.map(function (cat) { return _loadCategoryCards(cat.dir); }));

    for (var i = 0; i < CARD_CATEGORIES.length; i++) {
        var cat = CARD_CATEGORIES[i];
        var cards = allCards[i];
        var meta = tabsMeta[cat.tabId] || { id: cat.tabId, title: cat.dir, type: "cards" };
        meta.cards = cards;

        /* Auto-generate subtabs from card categories (for mesh tab) */
        if (meta.autoSubtabs && cards.length > 0) {
            var seenCats = {};
            var subtabs = [{ id: "create", title: "Create" }];
            cards.forEach(function (c) {
                if (c.source === "builtin" || !c.category) {
                    c.subtab = "create";
                } else {
                    var catId = c.category.toLowerCase().replace(/[^a-z0-9]+/g, "-");
                    if (!seenCats[catId]) {
                        seenCats[catId] = true;
                        subtabs.push({ id: catId, title: c.category });
                    }
                    c.subtab = catId;
                }
            });
            if (subtabs.length > 1) meta.subtabs = subtabs;
        }

        tabs.push(meta);
    }

    return { tabs: tabs };
}

async function initApp() {
    try {
        var config = await _loadAllCards();

        /* Also try server registry for additional auto-discovered cards.
           Route through the CLI when a matching HTTP adapter is connected;
           fall back to a direct fetch against the default discovery URL
           so the existing single-URL probe still works before any
           adapters are registered. */
        try {
            var regUrl = (_cliGetUrlForTag("numpy") || "http://localhost:8000") + "/api/v1/registry";
            var cliReg = await getCli().then(function (cli) { return cli.listRegistry("numpy"); }).catch(function () { return null; });
            var registry = cliReg || await fetch(regUrl, { signal: AbortSignal.timeout(2000) }).then(function (r) { return r.json(); });
            if (registry && registry.tabs) {
                var regTabs = {};
                registry.tabs.forEach(function (t) { regTabs[t.id] = t; });
                config.tabs.forEach(function (tab) {
                    var rt = regTabs[tab.id];
                    if (!rt || !rt.cards) return;
                    var existing = {};
                    (tab.cards || []).forEach(function (c) { existing[c.id] = true; });
                    rt.cards.forEach(function (c) {
                        if (!existing[c.id]) { tab.cards.push(c); }
                    });
                });
            }
        } catch (e) { /* server not available */ }

        initProject(config);
        var tabBar = document.getElementById("tab-bar");
        var tabContent = document.getElementById("tab-content");

        config.tabs.forEach(function (tab, i) {
            var btn = document.createElement("button");
            btn.className = "tab-btn" + (i === 0 ? " active" : "");
            btn.dataset.tab = tab.id;
            btn.textContent = tab.title;
            btn.onclick = function () { switchTab(this.dataset.tab); };
            tabBar.appendChild(btn);

            var panel = document.createElement("div");
            panel.id = "tab-" + tab.id;
            panel.className = "tab-panel" + (i === 0 ? " active" : "");
            tabContent.appendChild(panel);

            if (tab.type === "dashboard") createDashboard(panel);
            else if (tab.type === "cards") buildCardsTab(panel, tab);
        });

        activeTabId = config.tabs[0].id;
        updateDashboardSummary();

        if (window.renderMathInElement) {
            renderMathInElement(tabContent, {
                delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}]
            });
        }

        /* Pyodide loads automatically in Web Worker (background thread, zero UI freeze) */
    } catch (err) { console.error("App init failed:", err); }
}

document.addEventListener("DOMContentLoaded", function () {
    document.getElementById("hamburger").onclick = function () { document.getElementById("sidebar").classList.toggle("open"); };
    document.getElementById("navbar-brand").onclick = function () { switchTab("dashboard"); };
    document.getElementById("btn-new-session").onclick = function () { createSession("Session " + (sessionMgr.cards.length + 1)); };
    document.getElementById("btn-save").onclick = function () { saveProject(); };
    document.getElementById("btn-load").onclick = function () {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = ".zip";
        input.onchange = function () { if (input.files[0]) loadProject(input.files[0]); };
        input.click();
    };
    document.getElementById("btn-connect").onclick = async function () {
        var url = document.getElementById("backend-url").value.replace(/\/+$/, "");
        var cli = await getCli();
        var adapter = await cli.connect(url);
        if (adapter) {
            logDebug("info", "Backend connected: " + adapter.tag + " at " + url);
        } else {
            logDebug("warn", "Backend not reachable: " + url);
        }
    };
    document.getElementById("btn-run-sim").onclick = async function () {
        /* Button is a toggle: while a sim is running it stops instead. */
        if (_runningMode) { stopSimulation(); return; }

        var modelSel = managers.model && managers.model.selectedId;
        var meshSel = managers.mesh && managers.mesh.selectedId;
        var solverSel = managers.solver && managers.solver.selectedId;
        if (!modelSel || !meshSel || !solverSel) { toast.info("Select model, mesh, and solver first", { ttl: 2500 }); return; }

        var modelCard = managers.model.cards.find(function (c) { return "card-" + c.id === modelSel; });
        var meshCard = managers.mesh.cards.find(function (c) { return "card-" + c.id === meshSel; });
        var solverCard = managers.solver.cards.find(function (c) { return "card-" + c.id === solverSel; });

        var tag = solverCard.requires_tag || "numpy";

        /* Pyodide (in-browser numpy): concatenate editor code from all 3 cards */
        if (tag === "numpy" && !_cliGetUrlForTag("numpy")) {
            var modelState = getCardState("card-" + modelCard.id, modelCard, "model", "");
            var meshState = getCardState("card-" + meshCard.id, meshCard, "mesh", "");
            var solverState = getCardState("card-" + solverCard.id, solverCard, "solver", "");

            /* Substitute {key} placeholders with init values */
            function fillTemplate(tmpl, init) {
                if (!tmpl || !init) return tmpl || "";
                return tmpl.replace(/\{(\w+)\}/g, function (_, k) { return init[k] !== undefined ? init[k] : "{" + k + "}"; });
            }

            /* Auto-generate minimal script from class path + init kwargs */
            function autoTemplate(classPath, init) {
                if (!classPath) return "";
                var parts = classPath.split(".");
                var cls = parts[parts.length - 1];
                var mod = parts.slice(0, -1).join(".");
                var kwargs = "";
                if (init && Object.keys(init).length > 0) {
                    kwargs = Object.keys(init).map(function (k) {
                        var v = init[k];
                        return k + "=" + (typeof v === "string" ? "'" + v + "'" : v);
                    }).join(", ");
                }
                return "from " + mod + " import " + cls + "\n\nmodel = " + cls + "(" + kwargs + ")\n";
            }

            /* Resolve code: user-edited > template with substitution > auto-generated from class */
            function resolveCode(state, card) {
                /* If user edited the code (different from default template), use as-is */
                var defCode = card.template || card.snippet || "";
                if (state.code && state.code !== defCode) return state.code;
                /* Template with {placeholder} substitution */
                if (card.template) return fillTemplate(card.template, state.params && Object.keys(state.params).length ? state.params : card.init);
                if (card["class"]) return autoTemplate(card["class"], card.init);
                return state.code || "";
            }

            /* The script is: model.py + mesh.py + solver.py — exactly what the server runs */
            var code = "import sys\nfrom loguru import logger; logger.remove(); logger.add(sys.stdout, level='INFO')\n\n";
            code += "# --- Model ---\n";
            code += resolveCode(modelState, modelCard) + "\n\n";
            code += "# --- Mesh ---\n";
            code += resolveCode(meshState, meshCard) + "\n\n";
            code += "# --- Solver ---\n";
            code += resolveCode(solverState, solverCard) + "\n";

            logDebug("info", "Running locally via Pyodide...");
            logDebug("info", "Code:\n" + code.substring(0, 500));
            showToast("Running via Pyodide...");
            updateDashboardJob({ job_id: "pyodide", status: "running" });
            var runSession = _activeSession();      // capture the owning session
            _setRunningMode("pyodide");
            var runId = "run-" + Date.now();
            _setCurrentPyRunId(runId);
            setRunBtnState(true);

            _readyCli().then(function (cli) {
                return cli.runCode(code);
            }).then(function (resultJson) {
                /* Late returns from a cancelled run get ignored; the stop
                   handler has already reset UI state. */
                if (_runningMode !== "pyodide" || _currentPyRunId !== runId) return;
                var cancelled = false, result = null;
                try {
                    result = JSON.parse(resultJson);
                    cancelled = (result.status === "cancelled");
                    if (result.output) logDebug("info", result.output);
                } catch (e) {
                    logDebug("info", String(resultJson));
                }
                if (cancelled) {
                    logDebug("info", "Simulation cancelled by user");
                    toast.info("Simulation stopped", { ttl: 2000 });
                    updateDashboardJob({ job_id: "pyodide", status: "cancelled" });
                } else {
                    logDebug("info", "Pyodide result received");
                    toast.success("Simulation complete!");
                    updateDashboardJob({ job_id: "pyodide", status: "complete" });
                }
            }).catch(function (err) {
                if (_runningMode !== "pyodide" || _currentPyRunId !== runId) return;
                logDebug("error", "Pyodide error: " + (err.message || err));
                toast.error("Simulation error — see Log");
                updateDashboardJob({ job_id: "pyodide", status: "failed" });
            }).finally(function () {
                if (_runningMode !== "pyodide" || _currentPyRunId !== runId) return;
                /* Re-arm the shared interrupt flag so the next run starts
                   clean (Pyodide clears it internally on each exec start,
                   but the explicit reset keeps intent visible). */
                /* Clear runtime state on the OWNING session — not
                   necessarily the currently-active one (user may have
                   switched sessions while the sim was running). */
                var runRt = runSession && _sessionRuntime(runSession);
                /* resetInterrupt on the ADAPTER that actually ran —
                   per-session workers each own their own interrupt
                   buffer; the shared _pyInterruptView belongs only to
                   the default adapter. */
                var _runAdapter = runRt && runRt.pyodide;
                if (_runAdapter && _runAdapter.resetInterrupt) _runAdapter.resetInterrupt();
                else if (_pyInterruptView) _pyInterruptView[0] = 0;
                if (runRt) { runRt.runningMode = null; runRt.currentPyRunId = null; }
                if (_activeSession() === runSession) {
                    _setRunningMode(null);
                    _setCurrentPyRunId(null);
                    setRunBtnState(false);
                }
            });
            return;
        }

        if (!_cliIsTagConnected(tag)) {
            /* The card is clickable even when its backend is offline so
               the user can still inspect params/code; running it is
               what we refuse — loud and visible, not a silent toast. */
            logDebug("error", "Cannot run: backend '" + tag + "' is not connected. Connect to a server that provides the '" + tag + "' solver first.");
            toast.error("Backend '" + tag + "' not connected");
            return;
        }

        var zoomyCase = {
            version: "1.0",
            model: { class_path: modelCard["class"] || modelCard.id, init: modelCard.init || {}, parameters: {} },
            mesh: meshCard.init ? { type: "create_1d", domain: [meshCard.init.x_min || 0, meshCard.init.x_max || 1], n_cells: meshCard.init.n_cells || 100 } : { type: "create_1d", domain: [0, 1], n_cells: 100 },
            solver: { time_end: 0.1, cfl: 0.45, output_snapshots: 10 }
        };

        logDebug("info", "Submitting job to " + tag + " (" + _cliGetUrlForTag(tag) + ")");
        logDebug("info", "Case: " + JSON.stringify(zoomyCase).substring(0, 200));
        toast.show({ id: "job", text: "Submitting job…", sticky: true });
        _setRunningMode("server");
        setRunBtnState(true);
        try {
            /* submitCase writes the HDF5 into Pyodide's VFS — bind it
               to the active session's worker so the result lands in
               session-scoped storage. */
            var cli = await _readyCli();
            var jobId = null;
            var outcome = await cli.submitCase({
                tag: tag,
                case: zoomyCase,
                onStatus: function (status) {
                    if (!_activeJob && status.job_id) {
                        _setActiveJob({ jobId: status.job_id, tag: tag, startTime: Date.now() });
                        jobId = status.job_id;
                        logDebug("info", "Job submitted: " + jobId);
                        toast.update("job", { text: "Job " + jobId + " running…", sticky: true });
                    }
                    updateDashboardJob(status);
                },
            });
            /* submitCase writes the downloaded HDF5 into Pyodide's VFS
               itself, so viz cards can open_hdf5 the result immediately. */
            if (outcome.mode === "http" && outcome.result.status === "complete") {
                var id = outcome.result.job_id;
                logDebug("info", "Job " + id + " complete (HDF5 "
                         + (outcome.result.hdf5 ? outcome.result.hdf5.byteLength + " bytes" : "missing")
                         + ")");
                toast.update("job", { text: "Ready to visualize!", kind: "success", sticky: false, ttl: 3000 });
                updateDashboardJob({ job_id: id, status: "complete" });
            } else if (outcome.result && outcome.result.status === "cancelled") {
                logDebug("info", "Job " + (jobId || "?") + " cancelled");
                updateDashboardJob({ job_id: jobId || "?", status: "cancelled" });
            }
        } catch (err) {
            logDebug("error", "Job failed: " + (err.message || err));
            toast.update("job", { text: "Job failed — see Log on Dashboard", kind: "error", sticky: true });
            updateDashboardJob({ job_id: "?", status: "failed" });
        } finally {
            _setActiveJob(null); _setRunningMode(null); setRunBtnState(false);
        }
    };

    initApp().then(function () {
        /* Sync initial session from core.js into sidebar */
        if (_project && _project.sessions.sessions.length > 0) {
            sessionMgr.cards = _project.sessions.sessions.map(function (s) {
                return { id: s.id, title: s.title, description: s.description || "" };
            });
            sessionMgr.selectedId = _project.sessions.activeId;
            renderSessionSidebar();
            renderDashboardSessionCard();
        } else {
            createSession("Default session");
        }
        /* Check URL for auto-loading a project */
        checkUrlProject();
    });

    /* Auto-discover a local backend via the CLI. Failure is silent — a
       user without a running zoomy_server will just see "numpy (pyodide)"
       as the only available backend. */
    getCli().then(function (cli) {
        cli.onConnectionsChange(function () {
            if (window.renderDashboardConnections) renderDashboardConnections();
            _updateBackendIndicator();
            _updateSolverCardBadges();
        });
        cli.discover();
    });
});

/* Navbar indicator + card-disabled badges. Previously lived in
   ZoomyBackend._updateAll; now triggered by the CLI's
   onConnectionsChange callback. */
function _updateBackendIndicator() {
    var el = document.getElementById("backend-indicator");
    if (!el || !_cli) return;
    el.textContent = _cli.availableTags().join(" | ");
    el.className = "backend-indicator connected";
}
function _updateSolverCardBadges() {
    document.querySelectorAll(".card[data-requires-tag]").forEach(function (c) {
        var tag = c.dataset.requiresTag;
        var connected = _cliIsTagConnected(tag);
        c.classList.toggle("disabled", !connected);
        var indicator = c.querySelector(".card-connection-status");
        if (indicator) {
            indicator.textContent = connected ? "Connected" : "Disconnected";
            indicator.className = "card-connection-status" + (connected ? " connected" : "");
        }
    });
}
