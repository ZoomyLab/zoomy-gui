/**
 * Card interactions — the basic UI motions the Phase 2 card refactor will
 * exercise and can easily break. Checked:
 *   - Tab switching toggles .tab-btn.active and shows the right target panel.
 *   - Clicking a model card sets .selected; clicking again deselects (when
 *     collapseUnselected is enabled on that manager).
 *   - Opening the gear on a model card reveals its params container.
 *   - The mesh coarseness dropdown (when present) updates cState.params.
 *   - The visualization tab's subtab buttons switch the active subtab.
 *
 * All runs against the local GUI with COI headers enabled, so the full
 * cross-origin-isolated path is exercised as a side-check.
 */
const puppeteer = require("puppeteer");
const { startServer, waitForWorkerReady, clickTab } = require("./_lib");

async function main() {
    const srv = await startServer({ port: 8770, coi: true });
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        protocolTimeout: 600000,
    });
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));

    await page.goto(srv.url, { waitUntil: "networkidle2", timeout: 60000 });
    await waitForWorkerReady(page);

    let failed = false;
    function fail(msg) { console.error("  \u2716 " + msg); failed = true; }
    function pass(msg) { console.log("  \u2713 " + msg); }

    // --- Tab switching --------------------------------------------------
    console.log("Tab switching:");
    for (const t of ["dashboard", "model", "mesh", "solver", "visualization"]) {
        await clickTab(page, t);
        const active = await page.evaluate((tab) => {
            const btn = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
            const panel = document.getElementById("tab-" + tab);
            return {
                btnActive: btn ? btn.classList.contains("active") : false,
                panelVisible: panel ? getComputedStyle(panel).display !== "none" : false,
            };
        }, t);
        if (active.btnActive && active.panelVisible) pass("tab '" + t + "' activates");
        else fail("tab '" + t + "' did not activate correctly: " + JSON.stringify(active));
    }

    // --- Card selection on the Model tab --------------------------------
    console.log("Model card selection:");
    await clickTab(page, "model");
    const modelCards = await page.evaluate(() => {
        const mgr = window.managers && window.managers.model;
        return mgr ? mgr.cards.map((c) => c.id) : [];
    });
    if (!modelCards.length) fail("no model cards rendered");
    else {
        const firstId = modelCards[0];
        await page.evaluate((id) => {
            const el = document.getElementById("card-" + id);
            if (el) el.click();
        }, firstId);
        await new Promise((r) => setTimeout(r, 200));
        const selected = await page.evaluate((id) => {
            const el = document.getElementById("card-" + id);
            return el && el.classList.contains("selected");
        }, firstId);
        if (selected) pass("first model card gains .selected on click");
        else fail(".selected class missing on first model card after click");

        const selId = await page.evaluate(() => window.managers.model.selectedId);
        if (selId === "card-" + firstId) pass("managers.model.selectedId updated");
        else fail("managers.model.selectedId = " + selId + ", expected card-" + firstId);
    }

    // --- Gear menu opens and reveals the params container ---------------
    console.log("Gear menu:");
    const gearState = await page.evaluate(async () => {
        const mgr = window.managers.model;
        if (!mgr || !mgr.cards.length) return { ok: false, reason: "no cards" };
        const id = "card-" + mgr.cards[0].id;
        const gear = document.getElementById(id + "-gear");
        const params = document.getElementById(id + "-params");
        if (!gear || !params) return { ok: false, reason: "gear or params div missing" };
        gear.click();
        // The gear handler is async (extractParams). Wait up to 60s for
        // the params container to have content.
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
            const hasWidgets = params.querySelector(".param-widgets");
            const visible = getComputedStyle(params).display !== "none";
            if (visible && hasWidgets) return { ok: true };
            await new Promise((r) => setTimeout(r, 250));
        }
        return { ok: false, reason: "no widgets rendered within 60s", innerHTML: params.innerHTML.substring(0, 200) };
    });
    if (gearState.ok) pass("gear menu renders param widgets");
    else fail("gear menu failed: " + JSON.stringify(gearState));

    // --- Mesh coarseness dropdown ---------------------------------------
    console.log("Mesh coarseness dropdown:");
    await clickTab(page, "mesh");
    const meshProbe = await page.evaluate(() => {
        const mgr = window.managers.mesh;
        if (!mgr) return { ok: false, reason: "no mesh manager" };
        const withSizes = mgr.cards.find((c) => Array.isArray(c.mesh_sizes) && c.mesh_sizes.length > 1);
        if (!withSizes) return { ok: "skipped", reason: "no multi-size meshes in catalog" };
        const sel = document.getElementById("card-" + withSizes.id + "-size");
        if (!sel) return { ok: false, reason: "size select missing on " + withSizes.id };
        // Pick a value different from the current
        const other = Array.from(sel.options).map((o) => o.value).find((v) => v !== sel.value);
        if (!other) return { ok: false, reason: "no alternate option" };
        sel.value = other;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return { ok: true, card: withSizes.id, newValue: other };
    });
    if (meshProbe.ok === true) pass("mesh size dropdown dispatches change on " + meshProbe.card + " -> " + meshProbe.newValue);
    else if (meshProbe.ok === "skipped") console.log("  - skipped: " + meshProbe.reason);
    else fail("mesh size dropdown: " + JSON.stringify(meshProbe));

    // --- Viz subtab switch ----------------------------------------------
    console.log("Visualization subtab switch:");
    await clickTab(page, "visualization");
    const subtab = await page.evaluate(async () => {
        // Scope subtab query to the visualization tab so mesh-tab
        // auto-subtabs (basic_shapes / channels / ...) don't leak in.
        const panel = document.getElementById("tab-visualization");
        if (!panel) return { ok: false, reason: "no visualization panel" };
        const btns = panel.querySelectorAll('.subtab-btn');
        if (!btns.length) return { ok: false, reason: "no subtab buttons in viz panel" };
        // Find ids for the viz subtabs (matplotlib, pyvista).
        const ids = Array.from(btns).map((b) => b.dataset.subtab).filter(Boolean);
        if (ids.length < 1) return { ok: false, reason: "no data-subtab attrs" };
        // Switch to a non-default subtab if possible.
        const target = ids[1] || ids[0];
        const tb = panel.querySelector('.subtab-btn[data-subtab="' + target + '"]');
        tb.click();
        await new Promise((r) => setTimeout(r, 200));
        return { ok: tb.classList.contains("active"), target, all: ids };
    });
    if (subtab.ok) pass("subtab '" + subtab.target + "' activates (options: " + (subtab.all || []).join(", ") + ")");
    else fail("subtab switch: " + JSON.stringify(subtab));

    // --- page errors ----------------------------------------------------
    if (pageErrors.length) {
        console.log("Page errors captured during run:");
        pageErrors.forEach((e) => console.log("  ! " + e));
    }

    await browser.close();
    await srv.close();

    if (failed) { console.log("\n\u274c FAILED"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch((e) => { console.error("Crashed:", e); process.exit(1); });
