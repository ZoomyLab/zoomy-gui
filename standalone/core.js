/**
 * Zoomy Core — pure business logic, no DOM.
 * Works in browser (via <script>) and Node.js (via require/import).
 */

(function (exports) {

/* === Card State === */

function CardState() {
    this.cards = {};
    this.defaults = {};
}

CardState.prototype.init = function (cardId, defaults, tabId, subtab) {
    var defCode = defaults.template || defaults.snippet || "";
    if (!this.defaults[cardId]) {
        this.defaults[cardId] = {
            tab: tabId || "", subtab: subtab || "",
            title: defaults.title || "", description: defaults.description || "",
            code: defCode, params: {},
            requires_tag: defaults.requires_tag || "",
            class_path: defaults["class"] || "",
            init: defaults.init || {}
        };
    }
    if (!this.cards[cardId]) {
        this.cards[cardId] = {
            tab: tabId || "", subtab: subtab || "",
            title: defaults.title || "", description: defaults.description || "",
            code: defCode, params: {},
            requires_tag: defaults.requires_tag || "",
            class_path: defaults["class"] || "",
            init: defaults.init || {}
        };
    }
    return this.cards[cardId];
};

CardState.prototype.isModified = function (cardId) {
    var cs = this.cards[cardId];
    var cd = this.defaults[cardId];
    if (!cs || !cd) return !!cs;
    return cs.title !== cd.title || cs.description !== cd.description
        || cs.code !== cd.code || JSON.stringify(cs.params) !== JSON.stringify(cd.params);
};

CardState.prototype.get = function (cardId) {
    return this.cards[cardId] || null;
};

CardState.prototype.update = function (cardId, fields) {
    var cs = this.cards[cardId];
    if (!cs) return;
    Object.keys(fields).forEach(function (k) { cs[k] = fields[k]; });
};

/* === Selection Manager === */

function SelectionManager() {
    this.selections = {};
}

SelectionManager.prototype.select = function (tab, cardId) {
    this.selections[tab] = cardId;
};

SelectionManager.prototype.selected = function (tab) {
    return this.selections[tab] || null;
};

SelectionManager.prototype.toDict = function () {
    return JSON.parse(JSON.stringify(this.selections));
};

/* === Session Manager === */

function SessionManager() {
    this.sessions = [];
    this.activeId = null;
}

SessionManager.prototype.create = function (title) {
    var id = "s-" + Date.now();
    var session = { id: id, title: title, description: "Simulation session." };
    this.sessions.push(session);
    this.activeId = id;
    return session;
};

SessionManager.prototype.active = function () {
    for (var i = 0; i < this.sessions.length; i++) {
        if (this.sessions[i].id === this.activeId) return this.sessions[i];
    }
    return null;
};

SessionManager.prototype.switchTo = function (id) {
    this.activeId = id;
};

/* === Project (orchestrates everything) === */

function Project() {
    this.cardState = new CardState();
    this.selections = new SelectionManager();
    this.sessions = new SessionManager();
}

Project.prototype.status = function () {
    var result = {};
    var tabs = ["model", "mesh", "solver"];
    for (var i = 0; i < tabs.length; i++) {
        var cardId = this.selections.selected(tabs[i]);
        var card = cardId ? this.cardState.get(cardId) : null;
        result[tabs[i]] = card ? card.title : "Not selected";
    }
    var session = this.sessions.active();
    result.session = session ? session.title : "No session";
    return result;
};

Project.prototype.buildCase = function () {
    var model = this.selections.selected("model");
    var mesh = this.selections.selected("mesh");
    var solver = this.selections.selected("solver");

    if (!model || !mesh || !solver) {
        var missing = [];
        if (!model) missing.push("model");
        if (!mesh) missing.push("mesh");
        if (!solver) missing.push("solver");
        throw new Error("Missing selections: " + missing.join(", "));
    }

    var mc = this.cardState.get(model);
    var meshC = this.cardState.get(mesh);

    var meshInit = meshC.params || {};
    var meshSpec;
    if (meshInit.n_cells) {
        meshSpec = { type: "create_1d", domain: [meshInit.x_min || 0, meshInit.x_max || 1], n_cells: meshInit.n_cells };
    } else if (meshInit.nx) {
        meshSpec = { type: "create_2d", x_min: meshInit.x_min || 0, x_max: meshInit.x_max || 1,
                     y_min: meshInit.y_min || 0, y_max: meshInit.y_max || 1, nx: meshInit.nx, ny: meshInit.ny };
    } else {
        meshSpec = { type: "create_1d", domain: [0, 1], n_cells: 100 };
    }

    return {
        version: "1.0",
        model: { class_path: mc.class_path || mc.title, init: mc.init || {}, parameters: mc.params || {} },
        mesh: meshSpec,
        solver: { time_end: 0.1, cfl: 0.45, output_snapshots: 10 }
    };
};

Project.prototype.listCards = function (tab) {
    var result = [];
    var cards = this.cardState.cards;
    Object.keys(cards).forEach(function (id) {
        if (!tab || cards[id].tab === tab) result.push({ id: id, title: cards[id].title, tab: cards[id].tab });
    });
    return result;
};

/* === Safe folder name === */

function safeFolderName(str) {
    return (str || "unnamed").replace(/[^a-zA-Z0-9_-]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "").toLowerCase();
}

/* === Project serialization (ZIP-compatible data) === */

Project.prototype.buildSaveData = function () {
    var proj = this;
    var meta = {
        version: "1.0",
        sessions: proj.sessions.sessions,
        activeSession: proj.sessions.activeId,
        selections: proj.selections.toDict()
    };

    var cards = [];
    var sessionTitle = (proj.sessions.active() || {}).title || "default";

    Object.keys(proj.cardState.cards).forEach(function (cardId) {
        if (!proj.cardState.isModified(cardId)) return;
        var cs = proj.cardState.cards[cardId];
        if (!cs.tab) return;

        var folder = safeFolderName(sessionTitle) + "/" + cs.tab;
        if (cs.subtab) folder += "/" + cs.subtab;
        folder += "/" + safeFolderName(cs.title);

        cards.push({
            folder: folder,
            meta: { id: cardId, title: cs.title, description: cs.description, params: cs.params, tab: cs.tab, subtab: cs.subtab },
            code: cs.code || null
        });
    });

    return { projectJson: meta, cards: cards };
};

Project.prototype.applySaveData = function (projectJson, cardEntries) {
    if (projectJson.sessions) {
        this.sessions.sessions = projectJson.sessions;
        this.sessions.activeId = projectJson.activeSession || "";
    }
    if (projectJson.selections) {
        var sel = projectJson.selections;
        for (var tab in sel) this.selections.select(tab, sel[tab]);
    }

    var restored = 0;
    for (var i = 0; i < cardEntries.length; i++) {
        var entry = cardEntries[i];
        var meta = entry.meta;
        var targetId = meta.id || null;

        if (targetId && !this.cardState.cards[targetId]) targetId = null;
        if (!targetId) {
            var self = this;
            Object.keys(this.cardState.defaults).forEach(function (cid) {
                if (!targetId && self.cardState.defaults[cid].title === meta.title) targetId = cid;
            });
        }
        if (!targetId) {
            Object.keys(this.cardState.cards).forEach(function (cid) {
                if (!targetId && self.cardState.cards[cid].title === meta.title) targetId = cid;
            });
        }
        if (!targetId) continue;

        var cs = this.cardState.cards[targetId];
        cs.tab = meta.tab || cs.tab || "";
        cs.subtab = meta.subtab || cs.subtab || "";
        cs.title = meta.title;
        cs.description = meta.description || "";
        cs.params = meta.params || {};
        if (entry.code) cs.code = entry.code;
        restored++;
    }
    return restored;
};

/* === Initialize from cards.json config === */

Project.fromConfig = function (config) {
    var proj = new Project();
    proj.sessions.create("Default session");

    var tabs = config.tabs || [];
    for (var i = 0; i < tabs.length; i++) {
        var tab = tabs[i];
        if (tab.type !== "cards") continue;
        var tabId = tab.id;
        var cards = tab.cards || [];
        var firstId = null;

        for (var j = 0; j < cards.length; j++) {
            var entry = cards[j];
            var cardId = "card-" + entry.id;
            var subtab = entry.subtab || "";
            proj.cardState.init(cardId, entry, tabId, subtab);
            if (!firstId) firstId = cardId;
        }
        if (firstId) proj.selections.select(tabId, firstId);
    }
    return proj;
};

/* === Exports === */

exports.CardState = CardState;
exports.SelectionManager = SelectionManager;
exports.SessionManager = SessionManager;
exports.Project = Project;
exports.safeFolderName = safeFolderName;

})(typeof module !== "undefined" && module.exports ? module.exports : (window.ZoomyCore = {}));
