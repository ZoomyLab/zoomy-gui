/* === Utilities === */

window._aceReady = null;
window._plotlyReady = null;

function loadScript(src) { return new Promise(function (ok, fail) { var s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = fail; document.head.appendChild(s); }); }
function showToast(msg) { var t = document.getElementById("loading-toast"); if (t) { t.style.display = "block"; t.textContent = msg; } }
function hideToast() { var t = document.getElementById("loading-toast"); if (t) t.style.display = "none"; }

/* Minimal markdown → HTML (headings, bold, italic, newlines, code) */
function miniMarkdown(s) {
    if (!s) return "";
    /* Already contains HTML tags → pass through */
    if (/<[a-z][\s\S]*>/i.test(s)) return s;
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
    Object.keys(managers).forEach(function (tabId) {
        if (managers[tabId].selectedId) _project.selections.select(tabId, managers[tabId].selectedId);
    });
    _project.sessions.sessions = sessionMgr.cards;
    _project.sessions.activeId = sessionMgr.selectedId;

    var data = _project.buildSaveData();
    var zip = new JSZip();
    zip.file("project.json", JSON.stringify(data.projectJson, null, 2));
    data.cards.forEach(function (c) {
        zip.file(c.folder + "/card.json", JSON.stringify(c.meta, null, 2));
        if (c.code) zip.file(c.folder + "/code.py", c.code);
    });
    logDebug("info", "Project: " + data.cards.length + " modified cards saved");
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
            if (project.sessions) {
                sessionMgr.cards = project.sessions;
                sessionMgr.selectedId = project.activeSession || (project.sessions[0] && project.sessions[0].id);
                renderSessionSidebar();
                renderDashboardSessionCard();
            }
        }

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

        var restoredCount = 0;
        for (var folderKey in cardFiles) {
            var cf = cardFiles[folderKey];
            if (!cf.json) continue;
            var metaStr = await cf.json.async("string");
            var meta = JSON.parse(metaStr);

            var targetId = meta.id || null;
            if (targetId && !cardState[targetId]) targetId = null;
            if (!targetId) {
                for (var cid in cardDefaults) {
                    if (cardDefaults[cid].title === meta.title) { targetId = cid; break; }
                }
            }
            if (!targetId) {
                for (var cid in cardState) {
                    if (cardState[cid].title === meta.title) { targetId = cid; break; }
                }
            }
            if (!targetId) {
                logDebug("warn", "Skipped unknown card: " + meta.title);
                continue;
            }

            var cs = cardState[targetId];
            cs.tab = meta.tab || cs.tab || "";
            cs.subtab = meta.subtab || cs.subtab || "";
            cs.title = meta.title;
            cs.description = meta.description || "";
            cs.params = meta.params || {};
            cs.code = cf.code ? await cf.code.async("string") : "";

            var titleEl = document.querySelector("#" + CSS.escape(targetId) + " .card-title");
            if (titleEl) titleEl.textContent = cardState[targetId].title;
            var descEl = document.querySelector("#" + CSS.escape(targetId) + " .card-description");
            if (descEl) {
                descEl.innerHTML = cardState[targetId].description;
                if (window.renderMathInElement) {
                    renderMathInElement(descEl, { delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}] });
                }
            }
            var cEl = document.getElementById(targetId);
            if (cEl && cEl._editor && cardState[targetId].code) {
                cEl._editor.setValue(cardState[targetId].code, -1);
                logDebug("info", "Updated editor for " + meta.title);
            } else if (cardState[targetId].code) {
                logDebug("info", "Code loaded for " + meta.title + " (editor not open, will apply on next open)");
            }

            restoredCount++;
        }

        if (project.selections) {
            Object.keys(project.selections).forEach(function (tabId) {
                if (managers[tabId]) {
                    managers[tabId].select(project.selections[tabId]);
                }
            });
        }

        logDebug("info", "Project loaded: " + restoredCount + " cards restored from " + Object.keys(cardFiles).length + " entries");
    } catch (err) {
        logDebug("error", "Load failed: " + err.message);
    }
}

/* === Session manager (cards in sidebar, full card on dashboard) === */

var sessionMgr = new CardManager("sessions", {
    onSelect: function () { renderSessionSidebar(); renderDashboardSessionCard(); }
});

function createSession(name) {
    var id = "session-" + Date.now();
    sessionMgr.add({ id: id, title: name, description: "Simulation session." });
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
        if (previewSrc) html += '<img id="' + targetId + '-preview" src="' + previewSrc + '" onerror="this.parentElement.style.display=\'none\'">';
        html += '<div class="card-preview-interactive" id="' + targetId + '-interactive"></div>';
        html += '</div>';
    }

    html += '<div class="card-body">';
    if (card.description) html += '<div class="card-description">' + miniMarkdown(card.description) + '</div>';
    html += '<div class="card-actions">';
    if (hasTimeline) html += '<div class="card-timeline"><input type="range" min="0" max="100" value="0" id="' + targetId + '-tl"><span id="' + targetId + '-ts">0</span></div>';
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
        };
    }

    /* Timeline */
    if (hasTimeline) {
        var sl = document.getElementById(targetId + "-tl");
        var lb = document.getElementById(targetId + "-ts");
        if (sl) sl.oninput = function () { lb.textContent = sl.value; };
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

            if (hasClass && document.getElementById(targetId + "-desc-fetch")) {
                document.getElementById(targetId + "-desc-fetch").onclick = async function () {
                    this.textContent = "Loading...";
                    this.disabled = true;
                    var btn = this;
                    logDebug("info", "Fetching describe() for " + card["class"] + "...");
                    try {
                        var desc = await pyCall("describe_model", { class_path: card["class"], init: card.init || {} });
                        logDebug("info", "describe() returned " + (desc ? desc.length : 0) + " chars");
                        cState.description = desc;
                        var descEl = container.querySelector(".card-description");
                        if (descEl) {
                            descEl.innerHTML = miniMarkdown(desc);
                            if (window.renderMathInElement) renderMathInElement(descEl, { delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}] });
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
                        var ed = makeAceEditor(targetId + "-desc-ace", cState.description || "");
                        ed.session.setMode("ace/mode/html");
                        ed.setOptions({ maxLines: 20, minLines: 10 });
                        ed.setTheme("ace/theme/chrome");
                        ed.renderer.setShowGutter(false);
                        ed.session.on("change", function () {
                            cState.description = ed.getValue();
                            var descEl = container.querySelector(".card-description");
                            if (descEl) {
                                descEl.innerHTML = ed.getValue();
                                if (window.renderMathInElement) {
                                    renderMathInElement(descEl, {
                                        delimiters: [{left: "$$", right: "$$", display: true}, {left: "$", right: "$", display: false}]
                                    });
                                }
                            }
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
            editorWrap.innerHTML = '<div class="inline-editor" id="' + targetId + '-ace"></div>';
            var defCode = cardDefaults[targetId] ? cardDefaults[targetId].code : "";
            var code = "";
            if (cState.code && cState.code !== defCode) {
                code = cState.code;
            } else if (card.snippet) {
                try { code = await fetch(card.snippet).then(function (r) { return r.text(); }); } catch (e) { code = "# snippet not found"; }
            } else {
                code = card.template || "# edit here";
                if (card.init) Object.keys(card.init).forEach(function (k) { code = code.split("{" + k + "}").join(String(card.init[k])); });
            }
            container._editor = makeAceEditor(targetId + "-ace", code);
            container._code = code;
            cState.code = code;
            container._editor.session.on("change", function () { cState.code = container._editor.getValue(); });
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

function updateDashboardJob(status) {
    var el = document.querySelector("#card-dash-run .card-description");
    if (!el) return;

    if (!status) {
        el.innerHTML = "\u2014";
        return;
    }

    var jobId = status.job_id || "?";
    var s = status.status || "?";

    if (s === "running" && status.progress) {
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
        el.innerHTML = '<b>' + jobId + '</b> running ' + pct + '%' + eta +
            '<div class="progress-bar"><div class="progress-bar-fill" style="width:' + pct + '%"></div></div>';
    } else if (s === "complete") {
        el.innerHTML = '<b>' + jobId + '</b> \u2714 complete';
    } else if (s === "failed") {
        el.innerHTML = '<b>' + jobId + '</b> \u2718 failed';
    } else if (s === "queued") {
        el.innerHTML = '<b>' + jobId + '</b> queued...';
    } else {
        el.innerHTML = '<b>' + jobId + '</b> ' + s;
    }
}

/* === Dashboard === */

function createDashboard(panel) {
    var gridMgr = new CardManager("dash-grid", { layout: "grid", columns: 2, selectable: false });
    gridMgr.add({ id: "dash-model", title: "Model", text: "No model selected." });
    gridMgr.add({ id: "dash-mesh", title: "Mesh", text: "No mesh loaded." });
    gridMgr.add({ id: "dash-status", title: "Solver", text: "No solver selected." });
    gridMgr.add({ id: "dash-run", title: "Last Run", text: "\u2014" });

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

    renderDashboardConnections();
    logDebug("info", "Dashboard initialized");
}

/* === Build tab === */

function buildCardsTab(panel, tab) {
    var isVis = tab.cardType === "vis";
    var mgr = new CardManager(tab.id, {
        layout: tab.layout || (isVis ? "stack" : "stack"),
        columns: tab.columns || 2,
        collapseUnselected: isVis,
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

    /* Load each card category */
    for (var i = 0; i < CARD_CATEGORIES.length; i++) {
        var cat = CARD_CATEGORIES[i];
        var cards = await _loadCategoryCards(cat.dir);
        var meta = tabsMeta[cat.tabId] || { id: cat.tabId, title: cat.dir, type: "cards" };
        meta.cards = cards;
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

            /* The script is: model.py + mesh.py + solver.py — exactly what the server runs */
            var code = "import sys\nfrom loguru import logger; logger.remove(); logger.add(sys.stdout, level='INFO')\n\n";
            code += "# --- Model ---\n";
            code += fillTemplate(modelState.code || modelCard.template || "", modelCard.init) + "\n\n";
            code += "# --- Mesh ---\n";
            code += fillTemplate(meshState.code || meshCard.template || "", meshCard.init) + "\n\n";
            code += "# --- Solver ---\n";
            code += fillTemplate(solverState.code || solverCard.template || "", solverCard.init) + "\n";

            logDebug("info", "Running locally via Pyodide...");
            logDebug("info", "Code:\n" + code.substring(0, 500));
            showToast("Running via Pyodide...");
            var msgId = "run-" + Date.now();
            var runHandler = function (ev) {
                if (ev.data.id !== msgId) return;
                _pyWorker.removeEventListener("message", runHandler);
                if (ev.data.type === "result") {
                    logDebug("info", "Pyodide result received");
                    showToast("Simulation complete!"); setTimeout(hideToast, 3000);
                    try {
                        var result = JSON.parse(ev.data.data);
                        if (result.plot_data) {
                            updateDashboardJob({ job_id: "pyodide", status: "complete", result: result });
                        }
                        if (result.output) logDebug("info", result.output);
                    } catch (e) { logDebug("info", String(ev.data.data)); }
                } else if (ev.data.type === "error") {
                    logDebug("error", "Pyodide error: " + ev.data.error);
                    showToast("Error — see Log"); setTimeout(hideToast, 3000);
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
                    showToast("Job complete!"); setTimeout(hideToast, 3000);
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

    createSession("Default session");
    initApp();

    /* Auto-discover backend */
    ZoomyBackend.discover();
});
