/**
 * User cards are scoped by session. A card created in session A must
 * not leak into session B. Switching back to A restores A's cards;
 * switching to B shows only B's cards (plus builtins).
 */
const puppeteer = require("puppeteer");
const { startServer, waitForWorkerReady, clickTab } = require("./_lib");

async function main() {
    const srv = await startServer({ port: 8774, coi: true });
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

    async function setPrompt(text) {
        await page.evaluate((t) => { window.prompt = () => t; window.confirm = () => true; }, text);
    }

    async function sessionIds() {
        return await page.evaluate(() => {
            return (window._cli && window._project) ? {
                active: window.sessionMgr.selectedId,
                all: window.sessionMgr.cards.map((s) => s.id),
            } : null;
        });
    }

    // Create a second session alongside the default.
    console.log("Set up two sessions:");
    const initial = await sessionIds();
    const defaultId = initial.active;
    pass("default session active: " + defaultId);

    await page.evaluate(() => window.createSession("Second session"));
    await new Promise((r) => setTimeout(r, 600));
    const twoSessions = await sessionIds();
    const secondId = twoSessions.active;
    if (secondId === defaultId) fail("second session did not mint a fresh id");
    else pass("second session created: " + secondId);

    // Second session should have NO user cards by default.
    const secondInitial = await page.evaluate(() => {
        return window.managers.model.cards.filter((c) => c.source === "user").map((c) => c.title);
    });
    // Legacy cards/models/user.json ships with one demo card — it's a
    // cross-session builtin, so it shows up in every session.
    const legacyAllowed = "Tutorial: SWE Dam Break";
    const secondInitialCustom = secondInitial.filter((t) => t !== legacyAllowed);
    if (secondInitialCustom.length === 0) pass("second session has no user cards of its own yet");
    else fail("second session started with unexpected user cards: " + JSON.stringify(secondInitialCustom));

    // Create a user card in the second session.
    console.log("Create card in second session:");
    await clickTab(page, "model");
    await setPrompt("SecondOnly");
    await page.evaluate(() => document.getElementById("btn-new-card-model").click());
    await page.waitForFunction(
        () => window.managers.model.cards.find((c) => c.title === "SecondOnly"),
        { timeout: 10000 },
    );
    pass("created 'SecondOnly' in second session");

    // Switch back to the default session — 'SecondOnly' should vanish.
    console.log("Switch back to default:");
    await page.evaluate((id) => window.sessionMgr.select(id), defaultId);
    await new Promise((r) => setTimeout(r, 1200));  // reloadCards is async
    const inDefault = await page.evaluate(() => {
        return window.managers.model.cards.find((c) => c.title === "SecondOnly") ? true : false;
    });
    if (inDefault) fail("'SecondOnly' leaked into default session");
    else pass("'SecondOnly' is NOT visible in default session");

    // Switch to default session, create another card.
    console.log("Create card in default session:");
    await setPrompt("DefaultOnly");
    await page.evaluate(() => document.getElementById("btn-new-card-model").click());
    await page.waitForFunction(
        () => window.managers.model.cards.find((c) => c.title === "DefaultOnly"),
        { timeout: 10000 },
    );
    pass("created 'DefaultOnly' in default session");

    // Flip back to second session. 'DefaultOnly' must vanish, 'SecondOnly' returns.
    console.log("Switch back to second session:");
    await page.evaluate((id) => window.sessionMgr.select(id), secondId);
    await new Promise((r) => setTimeout(r, 1200));
    const crossCheck = await page.evaluate(() => {
        const titles = window.managers.model.cards.map((c) => c.title);
        return {
            hasSecondOnly:  titles.indexOf("SecondOnly") >= 0,
            hasDefaultOnly: titles.indexOf("DefaultOnly") >= 0,
        };
    });
    if (crossCheck.hasSecondOnly)  pass("'SecondOnly' visible again in second session");
    else                           fail("'SecondOnly' missing from second session");
    if (!crossCheck.hasDefaultOnly) pass("'DefaultOnly' NOT visible in second session");
    else                            fail("'DefaultOnly' leaked into second session");

    // Clean up so re-runs start fresh.
    console.log("Clean up:");
    await page.evaluate((id) => window.sessionMgr.select(id), secondId);
    await new Promise((r) => setTimeout(r, 600));
    await page.evaluate(() => {
        const id = window.managers.model.cards.find((c) => c.title === "SecondOnly").id;
        document.getElementById("card-" + id + "-trash").click();
    });
    await page.evaluate((id) => window.sessionMgr.select(id), defaultId);
    await new Promise((r) => setTimeout(r, 600));
    await page.evaluate(() => {
        const c = window.managers.model.cards.find((c) => c.title === "DefaultOnly");
        if (c) document.getElementById("card-" + c.id + "-trash").click();
    });
    pass("test data cleaned up");

    if (pageErrors.length) {
        for (const e of pageErrors) fail("page error: " + e);
    }

    await browser.close();
    await srv.close();

    if (failed) { console.log("\n\u274c FAILED — " + failed + " assertion(s)"); process.exit(1); }
    console.log("\n\u2705 PASSED");
}

main().catch((e) => { console.error("Crashed:", e); process.exit(1); });
