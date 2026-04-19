/**
 * User-authored card CRUD end-to-end in the browser.
 *
 * Drives the `+ New card` button on each card-bearing tab, verifies the
 * new card appears in the tab, then clicks its trash icon to delete.
 * Between cycles the page is reloaded so we're also testing that the
 * IndexedDB overlay actually persists the card across page loads.
 *
 * window.prompt / window.confirm are stubbed to deterministic values so
 * the test is non-interactive.
 */
const puppeteer = require("puppeteer");
const { startServer, waitForWorkerReady, clickTab } = require("./_lib");

const TABS_TO_TEST = [
    { tabId: "model",         title: "My Custom Model"  },
    { tabId: "solver",        title: "My Custom Solver" },
    { tabId: "visualization", title: "My Custom Vis"    },
    { tabId: "mesh",          title: "My Custom Mesh"   },
];

async function installPrompts(page, answers) {
    // answers.prompt is a string or null (cancel); answers.confirm is a bool.
    await page.evaluate((a) => {
        window.prompt  = () => a.prompt;
        window.confirm = () => !!a.confirm;
    }, answers);
}

async function main() {
    const srv = await startServer({ port: 8773, coi: true });
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

    let failed = 0;
    const fail = (m) => { console.error("  \u2716 " + m); failed++; };
    const pass = (m) => console.log("  \u2713 " + m);

    // --------------------------------------------------------------
    // 1. Create a new card on each tab, verify it appears.
    // --------------------------------------------------------------
    console.log("Create new user card on each tab:");
    const createdIds = {};
    for (const { tabId, title } of TABS_TO_TEST) {
        await clickTab(page, tabId);
        await installPrompts(page, { prompt: title });

        // Count existing cards pre-creation.
        const beforeCount = await page.evaluate((t) => {
            const mgr = window.managers && window.managers[t];
            return mgr ? mgr.cards.length : 0;
        }, tabId);

        // Click + New card.
        const clicked = await page.evaluate((t) => {
            const btn = document.getElementById("btn-new-card-" + t);
            if (!btn) return false;
            btn.click();
            return true;
        }, tabId);
        if (!clicked) { fail(tabId + ": + New card button missing"); continue; }

        // Wait for the card to land.
        try {
            await page.waitForFunction((t, before) => {
                const mgr = window.managers && window.managers[t];
                return mgr && mgr.cards.length > before;
            }, { timeout: 10000 }, tabId, beforeCount);
        } catch (e) { fail(tabId + ": new card never materialised"); continue; }

        const newCard = await page.evaluate((t, wantTitle) => {
            const mgr = window.managers[t];
            // Match by title too — the model tab ships a demo user card
            // (cards/models/user.json → "Tutorial: SWE Dam Break") that
            // also has source="user", so match-by-title pins this assertion
            // to the card the test just created.
            const c = mgr.cards.find((c) => c.source === "user" && c.title === wantTitle);
            return c ? { id: c.id, title: c.title, source: c.source } : null;
        }, tabId, title);
        if (!newCard) { fail(tabId + ": no source=user card in manager"); continue; }
        if (newCard.title !== title) fail(tabId + ": title mismatch, got '" + newCard.title + "'");
        else pass(tabId + ": created '" + title + "' (id=" + newCard.id + ")");

        // Trash icon present?
        const hasTrash = await page.evaluate((id) => {
            return !!document.getElementById("card-" + id + "-trash");
        }, newCard.id);
        if (hasTrash) pass(tabId + ": trash icon present on new card");
        else fail(tabId + ": trash icon missing");

        createdIds[tabId] = newCard.id;
    }

    // --------------------------------------------------------------
    // 2. Reload page — the user cards should still be there
    //    (IndexedDB overlay persists across page loads).
    // --------------------------------------------------------------
    console.log("Persistence across reload:");
    await page.reload({ waitUntil: "networkidle2", timeout: 60000 });
    await waitForWorkerReady(page);
    // Give reloadCards time to run after sessionMgr syncs.
    await new Promise((r) => setTimeout(r, 2000));

    for (const { tabId } of TABS_TO_TEST) {
        const id = createdIds[tabId];
        if (!id) continue;
        const stillThere = await page.evaluate((t, wantId) => {
            const mgr = window.managers[t];
            if (!mgr) return null;
            return mgr.cards.find((c) => c.id === wantId) ? true : false;
        }, tabId, id);
        if (stillThere) pass(tabId + ": user card survived page reload");
        else fail(tabId + ": user card missing after reload");
    }

    // --------------------------------------------------------------
    // 3. Delete each card and verify it's gone.
    // --------------------------------------------------------------
    console.log("Delete user cards:");
    for (const { tabId } of TABS_TO_TEST) {
        const id = createdIds[tabId];
        if (!id) continue;
        await clickTab(page, tabId);
        await installPrompts(page, { prompt: null, confirm: true });

        const clicked = await page.evaluate((cid) => {
            const btn = document.getElementById("card-" + cid + "-trash");
            if (!btn) return false;
            btn.click();
            return true;
        }, id);
        if (!clicked) { fail(tabId + ": trash button missing for " + id); continue; }

        try {
            await page.waitForFunction((t, cid) => {
                const mgr = window.managers && window.managers[t];
                return !!mgr && !mgr.cards.find((c) => c.id === cid);
            }, { timeout: 10000 }, tabId, id);
            pass(tabId + ": card removed from manager after trash click");
        } catch (e) {
            fail(tabId + ": card did not disappear within 10s");
        }

        const domGone = await page.evaluate((cid) => !document.getElementById("card-" + cid), id);
        if (domGone) pass(tabId + ": DOM element removed");
        else fail(tabId + ": DOM element lingers");
    }

    // --------------------------------------------------------------
    // 4. Cancel path — prompt returns null, nothing should happen.
    // --------------------------------------------------------------
    console.log("Cancel path:");
    await clickTab(page, "model");
    await installPrompts(page, { prompt: null });
    const beforeCancel = await page.evaluate(() => window.managers.model.cards.length);
    await page.evaluate(() => document.getElementById("btn-new-card-model").click());
    await new Promise((r) => setTimeout(r, 500));
    const afterCancel = await page.evaluate(() => window.managers.model.cards.length);
    if (afterCancel === beforeCancel) pass("prompt cancel creates no card");
    else fail("prompt cancel still created a card (" + beforeCancel + " -> " + afterCancel + ")");

    if (pageErrors.length) {
        for (const e of pageErrors) fail("page error: " + e);
    }

    await browser.close();
    await srv.close();

    if (failed) {
        console.log("\n\u274c FAILED — " + failed + " assertion(s)");
        process.exit(1);
    }
    console.log("\n\u2705 PASSED");
}

main().catch((e) => { console.error("Crashed:", e); process.exit(1); });
