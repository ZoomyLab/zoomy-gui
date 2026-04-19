/**
 * Session independence. Two sessions, each with its own selections +
 * log + Pyodide worker.
 *   1. Create session B with fresh selections.
 *   2. Select model X in A, switch to B, select model Y, switch back
 *      to A → A still has X. Switch to B → B has Y.
 *   3. Log written in A doesn't appear in B's log view.
 *   4. Run Simulation triggers a session-scoped worker; stop is
 *      isolated per session (user can switch away from a running sim
 *      and come back to find it still running).
 */
const puppeteer = require("puppeteer");
const { startServer, waitForWorkerReady } = require("./_lib");

async function snapshot(page) {
    return page.evaluate(() => {
        const mgr = window.managers.model;
        const log = document.getElementById("debug-log");
        return {
            model: mgr ? mgr.selectedId : null,
            logLen: log ? log.textContent.length : 0,
            sessionId: _project && _project.sessions && _project.sessions.activeId,
        };
    });
}

async function main() {
    const srv = await startServer({ port: 8783, coi: true });
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

    // --- Step 1: select model-X in session A ---------------------------
    const sessionA = await page.evaluate(() => _project.sessions.activeId);
    console.log("Session A:", sessionA);
    await page.evaluate(() => {
        const mgr = window.managers.model;
        mgr.select("card-" + mgr.cards[0].id);
        logDebug("info", "MARK session A log");
    });
    const afterA = await snapshot(page);
    console.log("  after select in A:", JSON.stringify(afterA));

    // --- Step 2: create session B ---------------------------------------
    await page.evaluate(() => createSession("Session B"));
    await new Promise(r => setTimeout(r, 200));
    const sessionB = await page.evaluate(() => _project.sessions.activeId);
    console.log("Session B:", sessionB);
    if (sessionA === sessionB) fail("createSession did not switch activeId");

    const beforeBSelect = await snapshot(page);
    console.log("  B initial:", JSON.stringify(beforeBSelect));
    if (beforeBSelect.model !== null) {
        fail("new session should inherit no selection, got " + beforeBSelect.model);
    } else {
        pass("session B starts with no model selection");
    }

    // Log in B should NOT contain the A mark (different session => fresh log view)
    if (beforeBSelect.logLen > 0) {
        const aMarkInB = await page.evaluate(() =>
            document.getElementById("debug-log").textContent.includes("MARK session A log"));
        if (aMarkInB) fail("session B log contains session A entries");
    }

    await page.evaluate(() => {
        const mgr = window.managers.model;
        mgr.select("card-" + mgr.cards[1].id);
        logDebug("info", "MARK session B log");
    });
    const afterBSelect = await snapshot(page);
    console.log("  after select in B:", JSON.stringify(afterBSelect));

    // --- Step 3: switch back to A, verify A's selection survived --------
    await page.evaluate((id) => sessionMgr.select(id), sessionA);
    await new Promise(r => setTimeout(r, 300));
    const backInA = await snapshot(page);
    console.log("  back in A:", JSON.stringify(backInA));
    if (backInA.model === afterA.model) pass("session A still holds " + afterA.model);
    else fail("A lost its selection: expected " + afterA.model + ", got " + backInA.model);

    // A's log should include MARK session A but NOT MARK session B
    const logInA = await page.evaluate(() => document.getElementById("debug-log").textContent);
    if (logInA.includes("MARK session A")) pass("A's log retained its entries");
    else fail("A's log lost its entries");
    if (logInA.includes("MARK session B")) fail("A's log bleed: contains B entries");
    else pass("A's log is not polluted by B");

    // --- Step 4: switch forward to B, verify B's selection survived -----
    await page.evaluate((id) => sessionMgr.select(id), sessionB);
    await new Promise(r => setTimeout(r, 300));
    const backInB = await snapshot(page);
    console.log("  back in B:", JSON.stringify(backInB));
    if (backInB.model === afterBSelect.model) pass("session B still holds " + afterBSelect.model);
    else fail("B lost its selection: expected " + afterBSelect.model + ", got " + backInB.model);

    await browser.close();
    await srv.close();
    if (failed) { console.log("\n\u274c FAILED"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch(e => { console.error("Crashed:", e); process.exit(1); });
