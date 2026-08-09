import React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { CommandRegistry, URI } from '@theia/core';

/**
 * Deep-link route: `<gui>/#/open?path=<path relative to the /zoomy workspace root>[&project=<url-or-asset-id>]`
 *
 * `path` alone (once cases/sme_friction_mms_level1/outputs/1.png already
 * exists in the visiting browser's local library):
 *   https://zoomylab.github.io/Zoomy/gui/#/open?path=cases/sme_friction_mms_level1/outputs/1.png
 *
 * `path` + `project` (works for a visitor who has NEVER opened the GUI
 * before — an empty virtual FS — by fetching/unpacking the case bundle
 * through the SAME loader the existing `?project=` query param uses, before
 * resolving `path`; see handleDeepLink() in zoomy-frontend-module.ts):
 *   https://zoomylab.github.io/Zoomy/gui/#/open?project=https://example.org/sme_friction.zip&path=cases/sme_friction_mms_level1/outputs/1.png
 *
 * `project` accepts anything ZoomyModelConfigWidget.loadProjectFromUrl()
 * already accepts: a direct .zip URL, or `zenodo:<id>[/file]`.
 *
 * `path` may also be a full `file:///...` URI, or (in principle) any scheme
 * an OpenHandler is registered for.
 */
export const DEEP_LINK_ROUTE = 'open';
const SESSION_KEY = 'zoomy-pending-deep-link';
/** Set (and cleared) alongside SESSION_KEY, but never consumed by
 *  consumeDeepLink() — see hasPendingProjectDeepLink() below for why this
 *  needs to survive independently of the main fragment's one-time read. */
const PROJECT_HINT_KEY = 'zoomy-pending-deep-link-has-project';

/**
 * MUST be invoked at module-evaluation time — i.e. before any Theia service
 * is constructed — because `@theia/workspace`'s WorkspaceService treats
 * `window.location.hash` as a *workspace directory path* the instant it is
 * instantiated (an inversify `@postConstruct`, which the frontend bootstrap
 * fires well before our own FrontendApplicationContribution.onStart()). A
 * hash like "#/open?path=…" would be misparsed as a (nonexistent) workspace
 * folder named literally "open?path=…", and WorkspaceService would clear or
 * overwrite the fragment while failing to resolve it — racing us for the one
 * value we need.
 *
 * So we steal the raw fragment for ourselves first: stash it in
 * sessionStorage (it must survive the same-tab reload that first-ever-visit
 * workspace setup triggers — see ensureWorkspaceThenOpen in
 * zoomy-frontend-module.ts, which uses the same sessionStorage pattern for
 * its own "already tried" guard) and blank the URL fragment via
 * history.replaceState (no navigation, no hashchange) so WorkspaceService
 * sees a clean slate and falls back to its normal most-recently-used-
 * workspace resolution, completely unaffected by our route.
 *
 * This module is imported at the top of zoomy-frontend-module.ts specifically
 * so this call happens as early as possible; see the self-invocation at the
 * bottom of this file.
 */
export function captureDeepLinkHash(): void {
    try {
        if (typeof location === 'undefined' || typeof sessionStorage === 'undefined') { return; }
        const h = location.hash || '';
        if (/^#\/open(?:$|[/?])/.test(h)) {
            const rest = h.slice(1); // drop the leading '#'
            sessionStorage.setItem(SESSION_KEY, rest);
            // Recomputed fresh from THIS load's hash every time (see
            // hasPendingProjectDeepLink() below) — never left stale from an
            // earlier page load, whether it matches or not.
            const qIdx = rest.indexOf('?');
            const hasProject = qIdx >= 0 && new URLSearchParams(rest.slice(qIdx + 1)).has('project');
            if (hasProject) { sessionStorage.setItem(PROJECT_HINT_KEY, '1'); }
            else { sessionStorage.removeItem(PROJECT_HINT_KEY); }
            if (typeof history !== 'undefined' && history.replaceState) {
                history.replaceState(null, '', location.pathname + location.search);
            } else {
                location.hash = '';
            }
        } else {
            sessionStorage.removeItem(PROJECT_HINT_KEY);
        }
    } catch { /* storage blocked (private mode, non-browser eval, …) — deep link silently no-ops */ }
}

/**
 * True exactly when THIS page load's hash was a `#/open?…project=…` deep
 * link — checked (not consumed) by ZoomyModelConfigWidget.load(), so it can
 * skip its own `location.search`-driven auto-open (restore last case / open
 * first / create a fresh "test" case) and leave case-selection entirely to
 * handleDeepLink()'s explicit loadProjectFromUrl() call. Without this, a
 * first-ever visitor scanning a project-carrying QR code would race: the
 * widget's own init() would see zero cases (nothing loaded yet), fall
 * through to "create a fresh test case", concurrently with our own fetch —
 * a spurious case the visitor never asked for.
 *
 * Independent of consumeDeepLink()'s one-time read (a separate key) because
 * the two are read by different consumers at different times: handleDeepLink
 * consumes SESSION_KEY once, from ensureWorkspaceThenOpen(); this widget
 * checks PROJECT_HINT_KEY from its own init(), which normally runs
 * concurrently with (not after) that same call.
 */
export function hasPendingProjectDeepLink(): boolean {
    try { return sessionStorage.getItem(PROJECT_HINT_KEY) === '1'; } catch { return false; }
}

/** Reads back (and clears) a hash stashed by captureDeepLinkHash(). Returns
 *  the fragment WITHOUT its leading '#', e.g. "/open?path=cases/foo/1.png". */
export function consumeDeepLink(): string | undefined {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (raw == null) { return undefined; }
        sessionStorage.removeItem(SESSION_KEY);
        return raw;
    } catch { return undefined; }
}

export interface ParsedDeepLink { route: string; path?: string; project?: string; }

/** Parses "/open?path=cases/foo/outputs/1.png&project=https://…/x.zip" (no
 *  leading '#') into { route: 'open', path: '…', project: '…' }. `project` is
 *  optional — its presence is what tells handleDeepLink() to fetch/unpack the
 *  case bundle (via the existing loader) before resolving `path`. Returns
 *  undefined for anything that doesn't look like one of our routes at all. */
export function parseDeepLink(fragment: string): ParsedDeepLink | undefined {
    const s = (fragment || '').trim();
    if (!s.startsWith('/')) { return undefined; }
    const qIdx = s.indexOf('?');
    const routePart = qIdx >= 0 ? s.slice(0, qIdx) : s;
    const route = routePart.replace(/^\/+/, '').replace(/\/+$/, '');
    const query = new URLSearchParams(qIdx >= 0 ? s.slice(qIdx + 1) : '');
    const path = query.get('path');
    const project = query.get('project');
    return { route, path: path != null ? path : undefined, project: project != null ? project : undefined };
}

/** Resolves a deep-link `path` value to an openable URI. A bare relative path
 *  (the common case, e.g. "cases/foo/outputs/1.png") resolves against
 *  `workspaceRoot` (pass ZoomyContribution.WORKSPACE_ROOT, i.e. "file:///zoomy").
 *  A value that already names a scheme (e.g. "file:///zoomy/cases/…") is used
 *  as-is. Throws on an empty path or one that tries to climb out with "..". */
export function resolveDeepLinkPath(workspaceRoot: string, raw: string): URI {
    const p = (raw || '').trim();
    if (!p) { throw new Error('empty path'); }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(p)) { return new URI(p); }
    const clean = p.replace(/^\/+/, '');
    if (clean.split('/').some(seg => seg === '..')) { throw new Error('path must not contain ".."'); }
    return new URI(workspaceRoot.replace(/\/+$/, '') + '/').resolve(clean);
}

/** A single-instance panel that shows a clear, visible message in the main
 *  workbench area — used when a deep link can't be resolved, instead of
 *  leaving the user looking at a blank screen. Re-showable with new content
 *  (setNotice()), so one widget/tab serves every deep-link failure. */
@injectable()
export class ZoomyNoticeWidget extends ReactWidget {
    static readonly ID = 'zoomy-notice';

    @inject(CommandRegistry) protected readonly commands: CommandRegistry;

    protected heading = 'Zoomy';
    protected message = '';
    protected detail = '';

    @postConstruct()
    protected init(): void {
        this.id = ZoomyNoticeWidget.ID;
        this.title.label = 'Zoomy';
        this.title.caption = 'Zoomy';
        this.title.iconClass = 'codicon codicon-warning';
        this.title.closable = true;
        this.addClass('zoomy-notice-widget');
        this.node.style.overflow = 'auto';
    }

    /** Named setNotice (not show()) — Widget.show() is a Lumino lifecycle
     *  method with a different signature; colliding with it is a type error. */
    setNotice(opts: { heading: string; message: string; detail?: string }): void {
        this.heading = opts.heading;
        this.message = opts.message;
        this.detail = opts.detail || '';
        this.update();
    }

    protected render(): React.ReactNode {
        const h = React.createElement;
        return h('div', {
            style: {
                display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                height: '100%', textAlign: 'center', padding: 32, gap: 12, fontFamily: 'var(--theia-font-family)',
            },
        },
            h('span', { className: 'codicon codicon-warning', style: { fontSize: 40, color: 'var(--theia-errorForeground, #f66)' } }),
            h('div', { style: { fontSize: 16, fontWeight: 600 } }, this.heading),
            h('div', { style: { fontSize: 13, color: 'var(--theia-descriptionForeground)', maxWidth: 520 } }, this.message),
            this.detail ? h('div', {
                style: {
                    fontSize: 11, fontFamily: 'var(--theia-code-font-family, monospace)',
                    color: 'var(--theia-descriptionForeground)', opacity: .75, wordBreak: 'break-all', maxWidth: 560,
                },
            }, this.detail) : null,
            h('button', {
                style: {
                    marginTop: 8, cursor: 'pointer', border: 'none', borderRadius: 6, padding: '8px 16px',
                    fontSize: 13, fontWeight: 600, background: 'var(--theia-button-background)', color: 'var(--theia-button-foreground)',
                },
                onClick: () => this.commands.executeCommand('zoomy.openModelConfig'),
            }, 'Open model configuration'));
    }
}

// Run as early as this module is first imported — see the doc comment on
// captureDeepLinkHash() above for why this must win the race against
// WorkspaceService.
captureDeepLinkHash();
