/* === Utilities === */

window._aceReady = null;
window._plotlyReady = null;

function loadScript(src) { return new Promise(function (ok, fail) { var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s); }); }
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

/* === Pyodide Web Worker (runs in background thread, never freezes UI) === */

var _pyWorker = new Worker("pyodide-worker.js");
var _pyCallbacks = {};
var _pyMsgId = 0;

_pyWorker.onmessage = function (e) {
    var msg = e.data;
    if (msg.type === "fully_ready") {
        hideToast();
        return;
    }
    if (msg.type === "log") {
        logDebug(msg.level || "info", "[Worker] " + msg.msg);
        if (msg.msg.indexOf("Loading") === 0 || msg.msg.indexOf("Installing") === 0) showToast(msg.msg);
        return;
    }
    var cb = _pyCallbacks[msg.id];
    if (!cb) return;
    delete _pyCallbacks[msg.id];
    if (msg.type === "error") cb.reject(new Error(msg.error));
    else cb.resolve(msg.data);
};

function pyCall(cmd, params) {
    return new Promise(function (resolve, reject) {
        var id = ++_pyMsgId;
        _pyCallbacks[id] = { resolve: resolve, reject: reject };
        var msg = { cmd: cmd, id: id };
        Object.keys(params || {}).forEach(function (k) { msg[k] = params[k]; });
        /* pyCall chatter suppressed — the worker logs user-visible commands itself. */
        _pyWorker.postMessage(msg);
    });
}

function extractParams(classPath, init) {
    return pyCall("extract_params", { class_path: classPath, init: init });
}

function runCode(code) {
    return pyCall("run_code", { code: code });
}

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

function setupOutputPanel(cardId, editorWrap) {
    var panelId = cardId + "-output";
    if (document.getElementById(panelId)) return;

    var toolbar = document.createElement("div");
    toolbar.className = "output-cells-toolbar";
    toolbar.innerHTML = '<span>Output</span><div>' +
        '<button id="' + panelId + '-run">&#9654; Run</button> ' +
        '<button id="' + panelId + '-clear">Clear</button> ' +
        '<label style="font-size:var(--fs-s);cursor:pointer"><input type="checkbox" id="' + panelId + '-auto"> auto</label></div>';

    var cells = document.createElement("div");
    cells.className = "output-cells";
    cells.id = panelId;

    editorWrap.appendChild(toolbar);
    editorWrap.appendChild(cells);

    var _running = false;

    async function executeAndDisplay() {
        if (_running) return;
        var container = document.getElementById(cardId);
        var editor = container && container._editor;
        if (!editor) return;
        _running = true;
        cells.innerHTML = "";
        _activeOutputTarget = panelId;
        var code = editor.getValue();
        try {
            var resultJson = await runCode(code);
            var result = JSON.parse(resultJson);
            /* stdout output goes into a cell only if not empty */
            if (result.output && result.output.trim()) {
                renderOutputCell({ mime: "text/plain", content: result.output }, cells);
            }
            /* Plotly/matplotlib from process_code (non-display path) */
            if (result.plot_type === "plotly" && result.plot_data) {
                await ensurePlotly();
                renderOutputCell({ mime: "application/vnd.plotly+json", content: result.plot_data }, cells);
            } else if (result.plot_type === "matplotlib" && result.plot_data) {
                renderOutputCell({ mime: "image/svg+xml", content: atob(result.plot_data) }, cells);
            }
            if (result.status === "error") {
                renderOutputCell({ mime: "text/plain", content: result.output }, cells);
            }
        } catch (err) {
            renderOutputCell({ mime: "text/plain", content: "Error: " + err.message }, cells);
        }
        _activeOutputTarget = null;
        _running = false;
    }

    /* Manual run button */
    document.getElementById(panelId + "-run").onclick = function (e) { e.stopPropagation(); executeAndDisplay(); };

    /* Clear button */
    document.getElementById(panelId + "-clear").onclick = function (e) { e.stopPropagation(); cells.innerHTML = ""; };

    /* Auto-run: watch editor for completed display() statements */
    var _lastDisplayCount = 0;
    var _autoDebounce = null;
    var autoCheckbox = document.getElementById(panelId + "-auto");

    var container = document.getElementById(cardId);
    if (container && container._editor) {
        container._editor.session.on("change", function () {
            if (!autoCheckbox || !autoCheckbox.checked) return;
            if (_autoDebounce) clearTimeout(_autoDebounce);
            _autoDebounce = setTimeout(function () {
                var code = container._editor.getValue();
                var n = countDisplayCalls(code);
                if (n > _lastDisplayCount) {
                    _lastDisplayCount = n;
                    executeAndDisplay();
                } else {
                    _lastDisplayCount = n;
                }
            }, 800);
        });

        /* Initialize count from current content */
        _lastDisplayCount = countDisplayCalls(container._editor.getValue());
    }
}

/* Handle display() messages from Pyodide worker */
if (_pyWorker) {
    var _origOnMessage = _pyWorker.onmessage;
    _pyWorker.addEventListener("message", function (ev) {
        if (ev.data.type === "display" && ev.data.cell) {
            var cell = JSON.parse(ev.data.cell);
            /* Live stdout streaming from engine._LiveStdout — route to the
               dashboard debug log instead of a notebook cell so users see
               solver iteration progress while a long simulation is running. */
            if (cell.mime === "text/x-log") {
                logDebug("info", "[py] " + cell.content);
                return;
            }
            var target = _activeOutputTarget ? document.getElementById(_activeOutputTarget) : null;
            if (target) renderOutputCell(cell, target);
        }
    });
}

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

    var hasGear     = true;
    var hasEdit     = cardType === "model" || cardType === "solver" || cardType === "vis" || (cardType === "mesh" && !!card.template);
    var hasRefresh  = cardType === "vis";
    var hasSizes    = cardType === "mesh" && card.mesh_sizes && card.mesh_sizes.length > 0;
    var hasTimeline = cardType === "vis" && !!card.has_timeline;
    /* Preview: explicit path or auto-detect by convention previews/{id}.svg */
    if (!card.preview) card._autoPreview = "previews/" + card.id + ".svg";
    var hasPreview  = !!card.preview || !!card._autoPreview;
    var hasMaximize = cardType === "model" || cardType === "solver" || cardType === "vis";
    var hasClass    = !!card["class"];
    var hasLocal    = !!card._localParams;

    container.className = "card";
    if (card.requires_tag) {
        container.dataset.requiresTag = card.requires_tag;
        if (!ZoomyBackend.isTagConnected(card.requires_tag)) container.classList.add("disabled");
    }
    if (mgr) container.dataset.mgr = mgr.id;

    var hasConnectionStatus = !!card.requires_tag;

    /* Header with connection status + maximize */
    var html = '<div class="card-header"><span class="card-title">' + card.title + '</span>';
    html += '<div class="card-header-actions">';
    if (hasConnectionStatus) {
        var tagConnected = ZoomyBackend.isTagConnected(card.requires_tag);
        html += '<span class="card-connection-status' + (tagConnected ? ' connected' : '') + '">' + (tagConnected ? 'Connected' : 'Disconnected') + '</span>';
    }
    if (hasMaximize) html += '<button class="icon-btn sm" id="' + targetId + '-max" title="Maximize">&#9723;</button>';
    html += '</div></div>';

    if (hasPreview || hasRefresh) {
        var previewSrc = card.preview || card._autoPreview;
        html += '<div class="card-preview" id="' + targetId + '-pw">';
        if (previewSrc) html += '<img id="' + targetId + '-preview" loading="lazy" decoding="async" src="' + previewSrc + '" onerror="this.style.display=\'none\'">';
        html += '<div class="card-preview-interactive" id="' + targetId + '-interactive"></div>';
        html += '</div>';
    }

    html += '<div class="card-body">';
    if (card.description) html += '<div class="card-description">' + miniMarkdown(card.description) + '</div>';
    html += '<div class="card-actions">';
    if (hasTimeline) html += '<div class="card-timeline"><input type="range" min="0" max="100" value="0" id="' + targetId + '-tl"><span id="' + targetId + '-ts">0</span></div>';
    /* Field selector: populated from store_meta.fields after first run.
       Sits between the timeline and the refresh/play button. */
    if (cardType === "vis") html += '<select class="card-select" id="' + targetId + '-field-select" disabled title="Field"><option>\u2014</option></select>';
    if (hasRefresh) html += '<button class="icon-btn" id="' + targetId + '-refresh" title="Run">&#9654;</button>';
    if (hasGear) html += '<button class="icon-btn" id="' + targetId + '-gear" title="Parameters">&#9881;</button>';
    if (hasEdit) html += '<button class="icon-btn" id="' + targetId + '-edit" title="Edit code">&#9998;</button>';
    if (hasSizes) {
        html += '<select class="card-select" id="' + targetId + '-size">';
        card.mesh_sizes.forEach(function (s) { html += '<option>' + s + '</option>'; });
        html += '</select>';
    }
    html += '</div></div>';

    if (hasGear) html += '<div class="expandable" id="' + targetId + '-params"></div>';
    if (hasEdit) html += '<div class="expandable" id="' + targetId + '-editor-wrap"></div>';

    container.innerHTML = html;

    /* Selection */
    if (mgr) {
        container.onclick = function (e) {
            if (e.target.closest(".icon-btn,.expandable,select,.card-timeline")) return;
            mgr.select(targetId);
        };
    }

    /* Maximize */
    if (hasMaximize) {
        document.getElementById(targetId + "-max").onclick = function (e) {
            e.stopPropagation();
            container.classList.toggle("maximized");
            this.innerHTML = container.classList.contains("maximized") ? "&#10005;" : "&#9723;";
            var plotEl = document.getElementById(targetId + "-interactive");
            if (plotEl && window.Plotly) {
                setTimeout(function () { Plotly.Plots.resize(plotEl); }, 100);
            }
            /* Resize Ace editor to fit new layout */
            if (container._editor) {
                setTimeout(function () { container._editor.resize(); }, 100);
            }
        };
    }

    /* Timeline */
    if (hasTimeline) {
        var sl = document.getElementById(targetId + "-tl");
        var lb = document.getElementById(targetId + "-ts");
        if (sl) {
            sl.oninput = function () { lb.textContent = sl.value + "/" + sl.max; };
            /* Auto-refresh visualization on slider change (debounced) */
            if (hasRefresh) {
                var _tlDebounce = null;
                sl.addEventListener("change", function () {
                    if (_tlDebounce) clearTimeout(_tlDebounce);
                    _tlDebounce = setTimeout(function () {
                        var refreshBtn = document.getElementById(targetId + "-refresh");
                        if (refreshBtn && !refreshBtn.disabled) refreshBtn.click();
                    }, 300);
                });
            }
        }
    }

    /* Field selector auto-refresh (debounced). Populated by the refresh
       handler from store_meta.fields. */
    if (cardType === "vis") {
        var fs = document.getElementById(targetId + "-field-select");
        if (fs) {
            var _fsDebounce = null;
            fs.addEventListener("change", function () {
                if (_fsDebounce) clearTimeout(_fsDebounce);
                _fsDebounce = setTimeout(function () {
                    var refreshBtn = document.getElementById(targetId + "-refresh");
                    if (refreshBtn && !refreshBtn.disabled) refreshBtn.click();
                }, 200);
            });
        }
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

    exclusiveToggle(gearBtn, paramsDiv, editBtn, editorWrap, async function () {
        if (gearLoaded) return;

        var metaParams = { title: { type: "String", default: cState.title, doc: "Card title" } };
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
                        var desc = await pyCall("describe_model", { class_path: card["class"], init: card.init || {} });
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
                var sj = await extractParams(card["class"], card.init || {});
                var parsed = JSON.parse(sj);
                paramsDiv.appendChild(renderParamWidgets(parsed, function (n, v) {
                    cState.params[n] = v;
                }));
            } catch (err) { paramsDiv.innerHTML += '<p style="color:#dc2626;font-size:var(--fs-s)">Class params failed: ' + err.message + '</p>'; }
        }

        gearLoaded = true;
    });

    if (hasEdit) {
        exclusiveToggle(editBtn, editorWrap, gearBtn, paramsDiv, async function () {
            if (editorLoaded) return;
            await ensureAce();
            editorWrap.innerHTML = '<div class="editor-layout"><div class="editor-pane"><div class="inline-editor" id="' + targetId + '-ace"></div></div><div class="output-pane"></div></div>';
            var defCode = cardDefaults[targetId] ? cardDefaults[targetId].code : "";
            var code = "";
            if (cState.code && cState.code !== defCode) {
                code = cState.code;
            } else if (card.snippet) {
                try { code = await fetch(card.snippet).then(function (r) { return r.text(); }); } catch (e) { code = "# snippet not found"; }
            } else if (card.template) {
                code = card.template;
                if (card.init) Object.keys(card.init).forEach(function (k) { code = code.split("{" + k + "}").join(String(card.init[k])); });
            } else if (card["class"]) {
                /* Auto-generate from class + init */
                var _p = card["class"].split("."), _cls = _p[_p.length-1], _mod = _p.slice(0,-1).join(".");
                var _kw = card.init ? Object.keys(card.init).map(function(k){ var v=card.init[k]; return k+"="+(typeof v==="string"?"'"+v+"'":v); }).join(", ") : "";
                code = "from " + _mod + " import " + _cls + "\n\nmodel = " + _cls + "(" + _kw + ")\n";
            } else {
                code = "# edit here";
            }
            container._editor = makeAceEditor(targetId + "-ace", code);
            container._code = code;
            cState.code = code;
            container._editor.session.on("change", function () { cState.code = container._editor.getValue(); });
            /* Visualization cards use the interactive preview area for output
               (via the refresh button). All other card types get the
               notebook-style output panel next to / below the editor. */
            if (cardType !== "vis") {
                var outputPane = editorWrap.querySelector(".output-pane");
                setupOutputPanel(targetId, outputPane || editorWrap);
            }
            editorLoaded = true;
        });
    }

    /* Refresh (vis) */
    if (hasRefresh) {
        document.getElementById(targetId + "-refresh").onclick = async function (e) {
            e.stopPropagation();
            var btn = this; btn.disabled = true;
            try {
                await ensurePlotly();
                var code = container._editor ? container._editor.getValue() : (cState.code || container._code);
                if (!code) {
                    if (card.snippet) code = await fetch(card.snippet).then(function (r) { return r.text(); });
                    else { code = card.template || ""; if (card.init) Object.keys(card.init).forEach(function (k) { code = code.split("{" + k + "}").join(String(card.init[k])); }); }
                    container._code = code;
                }
                /* Inject timeline slider value as time_step variable */
                var tlSlider = document.getElementById(targetId + "-tl");
                if (tlSlider) {
                    code = "time_step = " + tlSlider.value + "\n" + code;
                }
                /* Inject field_name from the field selector, if one is
                   active. Snippets honour this convention. */
                var fieldSel = document.getElementById(targetId + "-field-select");
                if (fieldSel && !fieldSel.disabled && fieldSel.value && fieldSel.value !== "\u2014") {
                    /* Escape the quotes just in case. */
                    var safe = fieldSel.value.replace(/"/g, '\\"');
                    code = 'field_name = "' + safe + '"\n' + code;
                }
                var resultJson = await runCode(code);
                var result = JSON.parse(resultJson);
                var preview = document.getElementById(targetId + "-preview");
                var inter = document.getElementById(targetId + "-interactive");
                if (!inter) return;
                if (result.status === "success") {
                    if (result.plot_type === "plotly") {
                        inter.style.minHeight = "400px";
                        Plotly.newPlot(inter, JSON.parse(result.plot_data).data, JSON.parse(result.plot_data).layout, {responsive: true});
                    } else if (result.plot_type === "matplotlib") {
                        inter.innerHTML = '<img src="data:image/svg+xml;base64,' + result.plot_data + '" style="max-width:100%;height:auto;display:block;margin:auto;">';
                    }
                } else {
                    inter.innerHTML = '<pre style="color:#dc2626;padding:0.8rem;font-size:var(--fs-s);overflow:auto">' + result.output + '</pre>';
                }
                if (preview) preview.style.display = "none";
                inter.classList.add("active");

                /* Update slider range from store metadata. */
                if (result.store_meta && tlSlider) {
                    var nSnaps = result.store_meta.n_snapshots || 0;
                    if (nSnaps >= 1) {
                        tlSlider.max = Math.max(0, nSnaps - 1);
                        if (parseInt(tlSlider.value, 10) > tlSlider.max) {
                            tlSlider.value = tlSlider.max;
                        }
                        /* Disable the slider when there's only one snapshot
                           — keeps the UI honest about the degenerate case. */
                        tlSlider.disabled = (nSnaps <= 1);
                        var tsLabel = document.getElementById(targetId + "-ts");
                        if (tsLabel) tsLabel.textContent = tlSlider.value + "/" + tlSlider.max;
                    }
                }

                /* Populate the field selector from store_meta.fields. Keep
                   the current selection if it's still valid; otherwise pick
                   the first option. */
                if (result.store_meta && fieldSel) {
                    var fields = result.store_meta.fields || [];
                    if (fields.length) {
                        var prev = fieldSel.value;
                        var html = "";
                        fields.forEach(function (name) {
                            html += '<option value="' + name + '">' + name + '</option>';
                        });
                        fieldSel.innerHTML = html;
                        if (fields.indexOf(prev) !== -1) {
                            fieldSel.value = prev;
                        }
                        fieldSel.disabled = false;
                    }
                }
            } catch (err) { console.error("Runtime error:", err); }
            finally { btn.disabled = false; }
        };
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

async function _fetchJson(url) {
    try {
        var r = await fetch(url);
        if (!r.ok) return [];
        return await r.json();
    } catch (e) { return []; }
}

async function _loadCategoryCards(dir) {
    /* Load default + generated + user for one category, merge, deduplicate. */
    var def  = await _fetchJson("cards/" + dir + "/default.json");
    var gen  = await _fetchJson("cards/" + dir + "/generated.json");
    var usr  = await _fetchJson("cards/" + dir + "/user.json");
    var seen = {};
    var merged = [];
    [def, gen, usr].forEach(function (list) {
        list.forEach(function (c) {
            if (!seen[c.id]) { seen[c.id] = true; merged.push(c); }
        });
    });
    return merged;
}

async function _loadAllCards() {
    /* Load tab metadata + all category cards. Returns config object. */
    var tabsMeta = await _fetchJson("cards/tabs.json");

    /* Fallback: if tabs.json doesn't exist, use legacy cards.json */
    if (!tabsMeta || Object.keys(tabsMeta).length === 0) {
        var legacy = await _fetchJson("cards.json");
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

        /* Also try server registry for additional auto-discovered cards */
        try {
            var regUrl = (ZoomyBackend.getUrlForTag("numpy") || "http://localhost:8000") + "/api/v1/registry";
            var registry = await fetch(regUrl, { signal: AbortSignal.timeout(2000) }).then(function (r) { return r.json(); });
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
            var msgId = "run-" + Date.now();
            var runHandler = function (ev) {
                if (ev.data.id !== msgId) return;
                _pyWorker.removeEventListener("message", runHandler);
                if (ev.data.type === "result") {
                    logDebug("info", "Pyodide result received");
                    showToast("Simulation complete!"); setTimeout(hideToast, 3000);
                    updateDashboardJob({ job_id: "pyodide", status: "complete" });
                    try {
                        var result = JSON.parse(ev.data.data);
                        if (result.output) logDebug("info", result.output);
                    } catch (e) { logDebug("info", String(ev.data.data)); }
                } else if (ev.data.type === "error") {
                    logDebug("error", "Pyodide error: " + ev.data.error);
                    showToast("Error — see Log"); setTimeout(hideToast, 3000);
                    updateDashboardJob({ job_id: "pyodide", status: "failed" });
                }
            };
            _pyWorker.addEventListener("message", runHandler);
            _pyWorker.postMessage({ cmd: "run_code", code: code, id: msgId });
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
            var resp = await ZoomyBackend.submit(tag, zoomyCase);
            _activeJob = { jobId: resp.job_id, tag: tag, startTime: Date.now() };
            logDebug("info", "Job submitted: " + resp.job_id);
            showToast("Job " + resp.job_id + " running...");
            updateDashboardJob({ job_id: resp.job_id, status: "queued" });
            ZoomyBackend.poll(tag, resp.job_id, function (status) {
                updateDashboardJob(status);
                if (status.status === "complete") {
                    logDebug("info", "Job " + resp.job_id + " complete");
                    showToast("Job complete — fetching results...");
                    /* Query results from server and populate the store */
                    ZoomyBackend.getResults(tag, resp.job_id, true).then(function (data) {
                        logDebug("info", "Fetched results: " + data.n_cells + " cells, " +
                            (data.n_snapshots || 1) + " snapshot(s)");
                        return pyCall("load_results", { data: data });
                    }).then(function () {
                        showToast("Ready to visualize!"); setTimeout(hideToast, 3000);
                    }).catch(function (err) {
                        logDebug("error", "Failed to fetch results: " + err);
                        showToast("Results fetch failed — see Log"); setTimeout(hideToast, 3000);
                    });
                    _activeJob = null;
                } else if (status.status === "failed") {
                    logDebug("error", "Job " + resp.job_id + " failed:\n" + (status.error || "unknown"));
                    showToast("Job failed — see Log on Dashboard"); setTimeout(hideToast, 5000);
                    _activeJob = null;
                }
            });
        } catch (err) {
            logDebug("error", "Submit failed: " + err);
            showToast("Submit failed — see Log on Dashboard"); setTimeout(hideToast, 3000);
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
