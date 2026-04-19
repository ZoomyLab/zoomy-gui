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
function showToast(msg) { var t = document.getElementById("loading-toast"); if (t) { t.style.display = "block"; t.textContent = msg; } }
function hideToast() { var t = document.getElementById("loading-toast"); if (t) t.style.display = "none"; }

/* Minimal markdown → HTML (headings, bold, italic, newlines, code, math blocks) */
function miniMarkdown(s) {
    if (!s) return "";
    /* Already contains HTML tags → pass through */
    if (/<[a-z][\s\S]*>/i.test(s)) return s;
    /* Protect $$ math blocks: wrap in div so KaTeX renders them as display math */
    s = s.replace(/\$\$([\s\S]*?)\$\$/g, function (_, math) {
        return '\n<div class="math-block">$$' + math + '$$</div>\n';
    });
    return s
        .replace(/^### (.+)$/gm, '<h4>$1</h4>')
        .replace(/^## (.+)$/gm, '<h3>$1</h3>')
        .replace(/^# (.+)$/gm, '<h2>$1</h2>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\n/g, '<br>');
}

/* === Debug log === */
var _debugLines = [];
function logDebug(level, msg) {
    var ts = new Date().toLocaleTimeString();
    _debugLines.push({ ts: ts, level: level, msg: msg });
    if (_debugLines.length > 200) _debugLines.shift();
    var el = document.getElementById("debug-log");
    if (el) {
        var color = level === "error" ? "#dc2626" : level === "warn" ? "#d97706" : "var(--c-muted)";
        el.innerHTML += '<div style="color:' + color + '">[' + ts + '] ' + level.toUpperCase() + ': ' + msg.replace(/</g, "&lt;") + '</div>';
        el.scrollTop = el.scrollHeight;
    }
    if (level === "error") console.error("[zoomy]", msg);
    else console.log("[zoomy]", msg);
}

/* === Isomorphic CLI façade (Phase 3) =====================================
 * app.js routes every backend call through a single ZoomyCLI instance.
 * The CLI owns the Pyodide worker (via PyodideAdapter) and any HTTP
 * backends (HttpAdapter, registered at connect time). No more direct
 * _pyWorker.postMessage or ZoomyBackend.* calls from app.js.
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

function _onAdapterLog(msg) {
    logDebug(msg.level || "info", "[Worker] " + msg.msg);
    if (msg.msg.indexOf("Loading") === 0 || msg.msg.indexOf("Installing") === 0) showToast(msg.msg);
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

/* No more pyCall / runCode / extractParams wrappers in app.js — every
   backend interaction goes through the CLI façade (cli.runCode,
   cli.extractParams, cli.describeModel, cli.writeHdf5Bytes,
   cli.submitCase, cli.cancel). The old wrappers used to live here. */

/* === Ace + Plotly (still main thread, they need DOM access) === */

function ensureAce() { if (!window._aceReady) window._aceReady = (async function () { logDebug("info","Loading Ace editor..."); showToast("Loading editor..."); await loadScript("https://cdnjs.cloudflare.com/ajax/libs/ace/1.32.7/ace.js"); logDebug("info","Ace editor ready"); hideToast(); })(); return window._aceReady; }
function ensurePlotly() { if (!window._plotlyReady) window._plotlyReady = (async function () { logDebug("info","Loading Plotly..."); showToast("Loading plotting..."); await loadScript("https://cdn.plot.ly/plotly-2.27.0.min.js"); logDebug("info","Plotly ready"); hideToast(); })(); return window._plotlyReady; }

function makeAceEditor(id, code) {
    var e = ace.edit(id);
    e.setTheme("ace/theme/monokai");
    e.session.setMode("ace/mode/python");
    e.setOptions({ fontSize: "14px", showPrintMargin: false, useSoftTabs: true, tabSize: 4 });
    e.setValue(code, -1);
    return e;
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

/* Append (or re-use) a plot cell in a card's shared output-cells list.
   Plots want to grow to a decent size, so we look for the LAST
   .output-cell-plotly / .output-cell-svg and update that rather than
   appending a fresh one — this is what makes timeline-slider scrubbing
   feel like one live plot instead of a growing gallery. */
function _upsertPlotCell(cells, mime, content) {
    if (mime === "application/vnd.plotly+json") {
        var plotData = JSON.parse(content);
        var existing = cells.querySelector(".output-cell-plotly:last-of-type");
        if (existing && window.Plotly) {
            try {
                Plotly.react(existing, plotData.data || [], plotData.layout || {}, { responsive: true });
                return;
            } catch (e) { /* fall through to append */ }
        }
    } else if (mime === "image/svg+xml") {
        var existingSvg = cells.querySelector(".output-cell-svg:last-of-type");
        if (existingSvg) { existingSvg.innerHTML = content; return; }
    }
    renderOutputCell({ mime: mime, content: content }, cells);
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
           loaded before we get a result to render. For simple stdout-only
           runs this is a no-op cache hit. */
        if (/\bplotly\b/.test(code)) await ensurePlotly();

        var cli = await getCli();
        var resultJson = await cli.runCode(code);
        var result = JSON.parse(resultJson);

        /* Clear the cells on a fresh run but preserve the last plot cell
           if the incoming result is going to re-use it (Plotly.react). */
        var willReusePlot = (result.plot_type === "plotly" || result.plot_type === "matplotlib") &&
                            result.plot_data &&
                            !!cells.querySelector(".output-cell-plotly, .output-cell-svg");
        if (!willReusePlot) cells.innerHTML = "";

        if (result.output && result.output.trim()) {
            renderOutputCell({ mime: "text/plain", content: result.output }, cells);
        }
        if (result.plot_type === "plotly" && result.plot_data) {
            _upsertPlotCell(cells, "application/vnd.plotly+json", result.plot_data);
        } else if (result.plot_type === "matplotlib" && result.plot_data) {
            _upsertPlotCell(cells, "image/svg+xml", atob(result.plot_data));
        }
        if (result.status === "error") {
            renderOutputCell({ mime: "text/plain", content: result.output }, cells);
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
            /* Snapshot departing session, restore arriving session in core.js */
            var arriving = sessionMgr.selectedId;
            _project.sessions.switchTo(arriving, _project);
            /* Sync UI managers with restored selections */
            var sel = _project.selections.toDict();
            Object.keys(sel).forEach(function (tab) {
                if (managers[tab]) managers[tab].select(sel[tab]);
            });
            /* Refresh open editors with restored card state */
            Object.keys(_project.cardState.cards).forEach(function (cardId) {
                var cEl = document.getElementById(cardId);
                var cs = _project.cardState.cards[cardId];
                if (cEl && cEl._editor && cs) cEl._editor.setValue(cs.code || "", -1);
            });
        }
        renderSessionSidebar();
        renderDashboardSessionCard();
    }
});

function createSession(name) {
    var id = "session-" + Date.now();
    /* Snapshot current session before creating new one */
    if (_project) _project.sessions.snapshotSession(_project);
    sessionMgr.add({ id: id, title: name, description: "Simulation session." });
    /* Register in core.js SessionManager */
    if (_project) {
        var session = { id: id, title: name, description: "Simulation session.", selections: _project.selections.toDict(), cardOverrides: {} };
        _project.sessions.sessions.push(session);
        _project.sessions.activeId = id;
    }
    sessionMgr.select(id);
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
    if (!el) return;
    var html = '<span class="session-conn-tag">numpy (pyodide)</span>';
    Object.keys(ZoomyBackend.connections).forEach(function (tag) {
        html += '<span class="session-conn-tag">' + tag + ' <button class="session-conn-x" data-tag="' + tag + '">&times;</button></span>';
    });
    el.innerHTML = html;
    el.querySelectorAll(".session-conn-x").forEach(function (btn) {
        btn.onclick = function (e) {
            e.stopPropagation();
            ZoomyBackend.disconnect(this.dataset.tag);
        };
    });
}

/* === Tabs === */

var activeTabId = null;
function switchTab(tabId) {
    activeTabId = tabId;
    document.querySelectorAll(".tab-btn").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === tabId); });
    document.querySelectorAll(".tab-panel").forEach(function (p) { p.classList.toggle("active", p.id === "tab-" + tabId); });
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
        if (!ZoomyBackend.isTagConnected(card.requires_tag)) container.classList.add("disabled");
    }
    if (mgr) container.dataset.mgr = mgr.id;

    var hasConnectionStatus = !!card.requires_tag;

    /* --- Header: title + connection badge + maximize --- */
    var html = '<div class="card-header"><span class="card-title">' + card.title + '</span>';
    html += '<div class="card-header-actions">';
    if (hasConnectionStatus) {
        var tagConnected = ZoomyBackend.isTagConnected(card.requires_tag);
        html += '<span class="card-connection-status' + (tagConnected ? ' connected' : '') + '">' +
                (tagConnected ? 'Connected' : 'Disconnected') + '</span>';
    }
    if (hasMaximize) html += '<button class="icon-btn sm" id="' + targetId + '-max" title="Maximize">&#9723;</button>';
    html += '</div></div>';

    html += '<div class="card-body">';
    if (card.description) html += '<div class="card-description">' + miniMarkdown(card.description) + '</div>';

    /* --- Controls bar: per-frame controls + gear/edit/size --- */
    html += '<div class="card-controls">';
    if (hasTimeline) html += '<div class="card-timeline"><input type="range" min="0" max="100" value="0" id="' + targetId + '-tl"><span id="' + targetId + '-ts">0</span></div>';
    if (cardType === "vis") html += '<select class="card-select" id="' + targetId + '-field-select" disabled title="Field"><option>\u2014</option></select>';
    if (hasGear) html += '<button class="icon-btn" id="' + targetId + '-gear" title="Parameters">&#9881;</button>';
    if (hasEdit) html += '<button class="icon-btn" id="' + targetId + '-edit" title="Edit code">&#9998;</button>';
    if (hasSizes) {
        html += '<select class="card-select" id="' + targetId + '-size">';
        card.mesh_sizes.forEach(function (s) { html += '<option>' + s + '</option>'; });
        html += '</select>';
    }
    html += '</div>';

    /* --- Output list (always present for code-bearing cards) --- */
    if (hasPlay) {
        html += '<div class="card-output"><div class="output-cells" id="' + targetId + '-output">';
        /* Preview image appears initially when no output exists. Cleared on first run. */
        if (previewSrc) {
            html += '<img class="card-output-preview" id="' + targetId + '-preview" loading="lazy" decoding="async" src="' + previewSrc + '" onerror="this.style.display=\'none\'">';
        }
        html += '</div></div>';
    }

    if (hasGear) html += '<div class="expandable" id="' + targetId + '-params"></div>';
    if (hasEdit) html += '<div class="expandable card-code" id="' + targetId + '-editor-wrap"></div>';

    /* --- Play button under the code, not inside the output toolbar --- */
    if (hasPlay) {
        html += '<div class="card-play"><button class="play-btn" id="' + targetId + '-run" title="Run">&#9654;</button></div>';
    }

    html += '</div>';   /* .card-body */

    container.innerHTML = html;

    /* Selection: clicking anywhere on the card body selects it, except
       when the click lands on an interactive control (buttons, selects,
       expandables, timeline slider, play button, output cells). */
    if (mgr) {
        container.onclick = function (e) {
            if (e.target.closest(".icon-btn,.expandable,select,.card-timeline,.card-play,.card-output,.play-btn")) return;
            mgr.select(targetId);
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

            /* Shared: render description from markdown text */
            var _descEditor = null;
            function _renderDescription(mdText) {
                cState.description = mdText;
                var descEl = container.querySelector(".card-description");
                if (descEl) {
                    descEl.innerHTML = miniMarkdown(mdText);
                    if (window.renderMathInElement) renderMathInElement(descEl, { delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}] });
                }
            }

            if (hasClass && document.getElementById(targetId + "-desc-fetch")) {
                document.getElementById(targetId + "-desc-fetch").onclick = async function () {
                    this.textContent = "Loading...";
                    this.disabled = true;
                    var btn = this;
                    logDebug("info", "Fetching describe() for " + card["class"] + "...");
                    try {
                        var _cliRef = await getCli();
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
                var _cliRef = await getCli();
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
        _activeJob = null;
    }

    /* On the cooperative-cancel path the worker is still alive and will
       return a KeyboardInterrupt result for the in-flight run_code — the
       existing run handler resets state when it arrives, so we let it do
       that and only clean up here for the terminate / server paths. */
    if (mode === "server" || (mode === "pyodide" && !_pyInterruptView)) {
        _runningMode = null;
        _currentPyRunId = null;
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
            onclick: function () { _debugLines = []; var el = document.getElementById("debug-log"); if (el) el.innerHTML = ""; }
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
    var mgr = new CardManager(tab.id, {
        layout: tab.layout || (isVis ? "stack" : "stack"),
        columns: tab.columns || 2,
        /* Viz cards stay expanded so users can compare multiple plots
           side-by-side. Mesh/model/solver tabs keep single-selection behaviour. */
        collapseUnselected: false,
        onSelect: function () { mgr.updateUI(); updateDashboardSummary(); }
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

    if (tab.cards.length > 0) mgr.select("card-" + tab.cards[0].id);
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
            var regUrl = (ZoomyBackend.getUrlForTag("numpy") || "http://localhost:8000") + "/api/v1/registry";
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
    document.getElementById("btn-connect").onclick = function () {
        var url = document.getElementById("backend-url").value.replace(/\/+$/, "");
        ZoomyBackend.connect(url);
    };
    document.getElementById("btn-run-sim").onclick = async function () {
        /* Button is a toggle: while a sim is running it stops instead. */
        if (_runningMode) { stopSimulation(); return; }

        var modelSel = managers.model && managers.model.selectedId;
        var meshSel = managers.mesh && managers.mesh.selectedId;
        var solverSel = managers.solver && managers.solver.selectedId;
        if (!modelSel || !meshSel || !solverSel) { showToast("Select model, mesh, and solver first"); setTimeout(hideToast, 2000); return; }

        var modelCard = managers.model.cards.find(function (c) { return "card-" + c.id === modelSel; });
        var meshCard = managers.mesh.cards.find(function (c) { return "card-" + c.id === meshSel; });
        var solverCard = managers.solver.cards.find(function (c) { return "card-" + c.id === solverSel; });

        var tag = solverCard.requires_tag || "numpy";

        /* Pyodide (in-browser numpy): concatenate editor code from all 3 cards */
        if (tag === "numpy" && !ZoomyBackend.getUrlForTag("numpy")) {
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
            _runningMode = "pyodide";
            var runId = "run-" + Date.now();
            _currentPyRunId = runId;
            setRunBtnState(true);

            getCli().then(function (cli) {
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
                    showToast("Simulation stopped"); setTimeout(hideToast, 2000);
                    updateDashboardJob({ job_id: "pyodide", status: "cancelled" });
                } else {
                    logDebug("info", "Pyodide result received");
                    showToast("Simulation complete!"); setTimeout(hideToast, 3000);
                    updateDashboardJob({ job_id: "pyodide", status: "complete" });
                }
            }).catch(function (err) {
                if (_runningMode !== "pyodide" || _currentPyRunId !== runId) return;
                logDebug("error", "Pyodide error: " + (err.message || err));
                showToast("Error — see Log"); setTimeout(hideToast, 3000);
                updateDashboardJob({ job_id: "pyodide", status: "failed" });
            }).finally(function () {
                if (_runningMode !== "pyodide" || _currentPyRunId !== runId) return;
                /* Re-arm the shared interrupt flag so the next run starts
                   clean (Pyodide clears it internally on each exec start,
                   but the explicit reset keeps intent visible). */
                if (_pyInterruptView) _pyInterruptView[0] = 0;
                _runningMode = null;
                _currentPyRunId = null;
                setRunBtnState(false);
            });
            return;
        }

        if (!ZoomyBackend.isTagConnected(tag)) { showToast("Backend '" + tag + "' not connected"); setTimeout(hideToast, 2000); return; }

        var zoomyCase = {
            version: "1.0",
            model: { class_path: modelCard["class"] || modelCard.id, init: modelCard.init || {}, parameters: {} },
            mesh: meshCard.init ? { type: "create_1d", domain: [meshCard.init.x_min || 0, meshCard.init.x_max || 1], n_cells: meshCard.init.n_cells || 100 } : { type: "create_1d", domain: [0, 1], n_cells: 100 },
            solver: { time_end: 0.1, cfl: 0.45, output_snapshots: 10 }
        };

        logDebug("info", "Submitting job to " + tag + " (" + ZoomyBackend.getUrlForTag(tag) + ")");
        logDebug("info", "Case: " + JSON.stringify(zoomyCase).substring(0, 200));
        showToast("Submitting job...");
        try {
            /* Make sure the CLI has an HttpAdapter registered for this tag
               (ZoomyBackend already knew the URL; we bridge it to the CLI
               on demand, which keeps backward compat with existing
               discover()/connect() flows that only touched ZoomyBackend). */
            var cli = await getCli();
            if (!cli.isHttpConnected(tag)) {
                var backendUrl = ZoomyBackend.getUrlForTag(tag);
                if (backendUrl) {
                    try { await cli.connectHttp(backendUrl, cli.constructor.HttpAdapter || (await import("./zoomy_cli/browser.mjs")).HttpAdapter); }
                    catch (e) { logDebug("warn", "CLI HttpAdapter connect failed, falling back to ZoomyBackend.submit: " + (e.message || e)); }
                }
            }

            /* Prefer the CLI path (submit → poll → download HDF5 → write
               to Pyodide VFS, all in one call). Falls back to the legacy
               ZoomyBackend pathway if no HttpAdapter is available. */
            _runningMode = "server";
            setRunBtnState(true);

            if (cli.isHttpConnected(tag)) {
                var jobId = null;
                var _onStatus = function (status) {
                    if (!_activeJob && status.job_id) {
                        _activeJob = { jobId: status.job_id, tag: tag, startTime: Date.now() };
                        jobId = status.job_id;
                        logDebug("info", "Job submitted: " + jobId);
                        showToast("Job " + jobId + " running...");
                    }
                    updateDashboardJob(status);
                };
                try {
                    var outcome = await cli.submitCase({
                        tag: tag,
                        case: zoomyCase,
                        onStatus: _onStatus,
                    });
                    /* submitCase already piped the HDF5 into Pyodide's VFS
                       via the CLI — viz cards can open_hdf5 it directly. */
                    if (outcome.mode === "http" && outcome.result.status === "complete") {
                        var id = outcome.result.job_id;
                        logDebug("info", "Job " + id + " complete (HDF5 "
                                 + (outcome.result.hdf5 ? outcome.result.hdf5.byteLength + " bytes" : "missing")
                                 + ")");
                        showToast("Ready to visualize!"); setTimeout(hideToast, 3000);
                        updateDashboardJob({ job_id: id, status: "complete" });
                    } else if (outcome.result && outcome.result.status === "cancelled") {
                        logDebug("info", "Job " + (jobId || "?") + " cancelled");
                        updateDashboardJob({ job_id: jobId || "?", status: "cancelled" });
                    }
                } catch (err) {
                    logDebug("error", "Job failed: " + (err.message || err));
                    showToast("Job failed — see Log on Dashboard"); setTimeout(hideToast, 5000);
                    updateDashboardJob({ job_id: jobId || "?", status: "failed" });
                } finally {
                    _activeJob = null; _runningMode = null; setRunBtnState(false);
                }
            } else {
                /* Legacy ZoomyBackend pathway — kept until the final
                   cleanup commit of Phase 3 deletes backend.js. */
                var resp = await ZoomyBackend.submit(tag, zoomyCase);
                _activeJob = { jobId: resp.job_id, tag: tag, startTime: Date.now() };
                logDebug("info", "Job submitted: " + resp.job_id);
                showToast("Job " + resp.job_id + " running...");
                updateDashboardJob({ job_id: resp.job_id, status: "queued" });
                ZoomyBackend.poll(tag, resp.job_id, function (status) {
                    updateDashboardJob(status);
                    if (status.status === "complete") {
                        logDebug("info", "Job " + resp.job_id + " complete");
                        showToast("Job complete — downloading HDF5…");
                        var url = ZoomyBackend.getUrlForTag(tag) +
                                  "/api/v1/jobs/" + resp.job_id + "/results/hdf5";
                        fetch(url).then(function (r) {
                            if (!r.ok) throw new Error("HTTP " + r.status);
                            return r.arrayBuffer();
                        }).then(function (buf) {
                            logDebug("info", "HDF5 downloaded: " + buf.byteLength + " bytes");
                            return cli.writeHdf5Bytes("/tmp/zoomy_sim/" + resp.job_id + ".h5", new Uint8Array(buf));
                        }).then(function () {
                            showToast("Ready to visualize!"); setTimeout(hideToast, 3000);
                        }).catch(function (err) {
                            logDebug("error", "Failed to fetch HDF5: " + err);
                            showToast("HDF5 download failed — see Log"); setTimeout(hideToast, 3000);
                        });
                        _activeJob = null; _runningMode = null; setRunBtnState(false);
                    } else if (status.status === "failed") {
                        logDebug("error", "Job " + resp.job_id + " failed:\n" + (status.error || "unknown"));
                        showToast("Job failed — see Log on Dashboard"); setTimeout(hideToast, 5000);
                        _activeJob = null; _runningMode = null; setRunBtnState(false);
                    } else if (status.status === "cancelled") {
                        logDebug("info", "Job " + resp.job_id + " cancelled");
                        _activeJob = null; _runningMode = null; setRunBtnState(false);
                    }
                });
            }
        } catch (err) {
            logDebug("error", "Submit failed: " + err);
            showToast("Submit failed — see Log on Dashboard"); setTimeout(hideToast, 3000);
            _runningMode = null;
            setRunBtnState(false);
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

    /* Auto-discover backend */
    ZoomyBackend.discover();
});
