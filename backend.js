var ZoomyBackend = {
    connections: {},
    _heartbeats: {},
    _pollTimers: {},

    availableTags: function () {
        var tags = ["numpy (pyodide)"];
        Object.keys(this.connections).forEach(function (tag) { tags.push(tag); });
        return tags;
    },

    isTagConnected: function (tag) {
        if (tag === "numpy") return true;
        return !!this.connections[tag];
    },

    getUrlForTag: function (tag) {
        var c = this.connections[tag];
        return c ? c.url : null;
    },

    connect: function (url) {
        var self = this;
        fetch(url + "/api/v1/health", { signal: AbortSignal.timeout(2000) })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                if (data.status === "ok") {
                    var tag = data.tag || "unknown";
                    self.connections[tag] = { url: url, tag: tag, backends: data.backends || [] };
                    self._startHeartbeat(tag, url);
                    self._updateAll();
                    if (window.logDebug) logDebug("info", "Backend connected: " + tag + " at " + url);
                }
            })
            .catch(function (err) {
                if (window.logDebug) logDebug("warn", "Backend not reachable: " + url + " (" + (err.message || err) + ")");
            });
    },

    disconnect: function (tag) {
        if (this._heartbeats[tag]) { clearInterval(this._heartbeats[tag]); delete this._heartbeats[tag]; }
        delete this.connections[tag];
        this._updateAll();
        if (window.logDebug) logDebug("info", "Disconnected from " + tag);
    },

    discover: function () {
        this.connect("http://localhost:8080");
    },

    _startHeartbeat: function (tag, url) {
        var self = this;
        if (self._heartbeats[tag]) clearInterval(self._heartbeats[tag]);
        self._heartbeats[tag] = setInterval(function () {
            fetch(url + "/api/v1/health", { signal: AbortSignal.timeout(2000) })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    if (data.status !== "ok") throw new Error("bad status");
                })
                .catch(function (err) {
                    if (self.connections[tag]) {
                        if (window.logDebug) logDebug("warn", "Backend lost: " + tag + " (" + (err.message || err) + ")");
                        delete self.connections[tag];
                        clearInterval(self._heartbeats[tag]);
                        delete self._heartbeats[tag];
                        self._updateAll();
                    }
                });
        }, 5000);
    },

    submit: function (tag, zoomyCase) {
        var url = this.getUrlForTag(tag);
        if (!url) return Promise.reject("No backend for tag: " + tag);
        return fetch(url + "/api/v1/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(zoomyCase)
        }).then(function (r) { return r.json(); });
    },

    cancel: function (tag, jobId) {
        var url = this.getUrlForTag(tag);
        if (!url) return Promise.reject("No backend for tag: " + tag);
        /* Stop polling immediately — the server's DELETE response is the
           final word, we don't need one more status fetch after that. */
        var key = tag + ":" + jobId;
        if (this._pollTimers[key]) {
            clearInterval(this._pollTimers[key]);
            delete this._pollTimers[key];
        }
        return fetch(url + "/api/v1/jobs/" + jobId, { method: "DELETE" })
            .then(function (r) {
                if (!r.ok && r.status !== 404) throw new Error("HTTP " + r.status);
                return r.status === 404 ? { status: "not_found" } : r.json();
            });
    },

    getResults: function (tag, jobId, timeline) {
        var url = this.getUrlForTag(tag);
        if (!url) return Promise.reject("No backend for tag: " + tag);
        var qs = timeline ? "?timeline=true" : "";
        return fetch(url + "/api/v1/jobs/" + jobId + "/results" + qs)
            .then(function (r) {
                if (!r.ok) throw new Error("HTTP " + r.status);
                return r.json();
            });
    },

    poll: function (tag, jobId, onUpdate, intervalMs) {
        var self = this;
        var url = this.getUrlForTag(tag);
        if (!url) return;
        intervalMs = intervalMs || 2000;
        var key = tag + ":" + jobId;
        if (this._pollTimers[key]) clearInterval(this._pollTimers[key]);
        this._pollTimers[key] = setInterval(function () {
            fetch(url + "/api/v1/jobs/" + jobId)
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    onUpdate(data);
                    if (data.status === "complete" || data.status === "failed") {
                        clearInterval(self._pollTimers[key]);
                        delete self._pollTimers[key];
                    }
                })
                .catch(function () {});
        }, intervalMs);
    },

    _updateAll: function () {
        this._updateNavbar();
        this._updateSolverCards();
        if (window.renderDashboardConnections) renderDashboardConnections();
    },

    _updateNavbar: function () {
        var el = document.getElementById("backend-indicator");
        if (!el) return;
        el.textContent = this.availableTags().join(" | ");
        el.className = "backend-indicator connected";
    },

    _updateSolverCards: function () {
        var self = this;
        document.querySelectorAll(".card[data-requires-tag]").forEach(function (c) {
            var tag = c.dataset.requiresTag;
            var connected = self.isTagConnected(tag);
            c.classList.toggle("disabled", !connected);
            var indicator = c.querySelector(".card-connection-status");
            if (indicator) {
                indicator.textContent = connected ? "Connected" : "Disconnected";
                indicator.className = "card-connection-status" + (connected ? " connected" : "");
            }
        });
    }
};
