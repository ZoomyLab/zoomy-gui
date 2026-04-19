/**
 * Phase 3 / Card v2 tests:
 *   - Title click toggles .collapsed on a model card.
 *   - Play button is hidden on a model card by default.
 *   - Play button becomes visible when the edit panel opens.
 *   - Play button is visible on a vis card by default (.has-vis).
 */
const puppeteer = require("puppeteer");
const { startServer, waitForWorkerReady, clickTab } = require("./_lib");

function computedDisplay(page, selector) {
    return page.evaluate(sel => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).display : null;
    }, selector);
}

async function main() {
    const srv = await startServer({ port: 8773, coi: true });
    const browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
        protocolTimeout: 600000,
    });
    const page = await browser.newPage();
    await page.goto(srv.url, { waitUntil: "networkidle2", timeout: 60000 });
    await waitForWorkerReady(page);

    let failed = false;
    function fail(msg) { console.error("  \u2716 " + msg); failed = true; }
    function pass(msg) { console.log("  \u2713 " + msg); }

    // --- Title click collapses the card ---------------------------------
    console.log("Title-click collapse:");
    await clickTab(page, "model");
    const first = await page.evaluate(() => {
        const mgr = window.managers && window.managers.model;
        return mgr && mgr.cards.length ? mgr.cards[0].id : null;
    });
    if (!first) { fail("no model cards"); }
    else {
        const sel = "#card-" + first;
        const before = await page.evaluate(s => document.querySelector(s).classList.contains("collapsed"), sel);
        await page.evaluate(s => document.querySelector(s + " .card-title").click(), sel);
        await new Promise(r => setTimeout(r, 120));
        const after = await page.evaluate(s => document.querySelector(s).classList.contains("collapsed"), sel);
        if (after === !before) pass("title click toggled .collapsed on " + first + " (" + before + " \u2192 " + after + ")");
        else fail("title click did not toggle .collapsed (was " + before + ", still " + after + ")");
        // Reset state for downstream tests
        if (after) await page.evaluate(s => document.querySelector(s + " .card-title").click(), sel);
    }

    // --- Play button hidden on model card by default --------------------
    console.log("Play button visibility on model card:");
    const modelPlay = "#card-" + first + "-run";
    const modelBody = await page.evaluate(s => !!document.querySelector(s), modelPlay);
    if (!modelBody) fail("play button element missing for " + first);
    else {
        const modelDisplay = await computedDisplay(page, modelPlay);
        if (modelDisplay === "none") pass("play button hidden (display=none) on model card");
        else fail("expected display=none on model card play; got display='" + modelDisplay + "'");
    }

    // --- Opening the edit panel reveals the play button -----------------
    console.log("Play button visibility after edit open:");
    await page.evaluate(s => document.querySelector(s).click(), "#card-" + first + "-edit");
    // Wait for Ace to load; the panel first acquires .open and then the
    // body gets .edit-open via the MutationObserver in createCard.
    await page.waitForFunction(id => {
        const c = document.getElementById("card-" + id);
        return c && c.classList.contains("edit-open");
    }, { timeout: 60000 }, first);
    const afterEditDisplay = await computedDisplay(page, modelPlay);
    if (afterEditDisplay && afterEditDisplay !== "none") pass("play button visible after edit opens (display=" + afterEditDisplay + ")");
    else fail("play button still hidden after edit opened (display=" + afterEditDisplay + ")");

    // --- Play visible on a vis card by default --------------------------
    console.log("Play button on vis card:");
    await clickTab(page, "visualization");
    const visId = await page.evaluate(() => {
        const mgr = window.managers && window.managers.visualization;
        return mgr && mgr.cards.length ? mgr.cards[0].id : null;
    });
    if (!visId) fail("no vis cards");
    else {
        const visPlay = "#card-" + visId + "-run";
        const vd = await computedDisplay(page, visPlay);
        if (vd && vd !== "none") pass("vis card play visible (display=" + vd + ")");
        else fail("vis card play hidden (display=" + vd + ")");
    }

    await browser.close();
    await srv.close();

    if (failed) { console.log("\n\u274c FAILED"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch(e => { console.error("Crashed:", e); process.exit(1); });
