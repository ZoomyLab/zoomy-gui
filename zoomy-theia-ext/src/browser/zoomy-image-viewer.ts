import React from '@theia/core/shared/react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import {
    Navigatable, NavigatableWidgetOpenHandler, WidgetOpenerOptions,
} from '@theia/core/lib/browser';
import { URI, DisposableCollection } from '@theia/core';
import { FileService } from '@theia/filesystem/lib/browser/file-service';

/** Raster/vector image extensions this viewer claims. Required by the GUI spec:
 *  PNG, SVG, GIF (case outputs like outputs/1.png). Extending to other image
 *  types is a one-line change to this map. */
const MIME_BY_EXT: { [ext: string]: string } = {
    png: 'image/png',
    svg: 'image/svg+xml',
    gif: 'image/gif',
};

/** Priority this handler reports to the OpenerService for a matched image
 *  extension. Must beat @theia/editor's EditorManager, whose default
 *  `canHandle` returns 100 (it only returns the very high
 *  `defaultHandlerPriority` (100000) when the user has explicitly forced the
 *  text editor via a `workbench.editorAssociations` preference — we stay
 *  below that so such an explicit override still wins). */
export const IMAGE_OPEN_PRIORITY = 550;

export function imageMimeFor(pathOrName: string): string | undefined {
    const m = /\.([a-z0-9]+)$/i.exec(pathOrName);
    if (!m) { return undefined; }
    return MIME_BY_EXT[m[1].toLowerCase()];
}

function toBase64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) { s += String.fromCharCode(bytes[i]); }
    return btoa(s);
}

/** A small ReactWidget that renders one image file (PNG/SVG/GIF) from the
 *  in-browser virtual FS, scaled to fit. Bytes come from FileService (the
 *  memory FS has no http URL to hand the DOM), so we base64-encode them into
 *  a `data:` URL — works uniformly for raster and SVG alike. */
@injectable()
export class ZoomyImageViewerWidget extends ReactWidget implements Navigatable {
    static readonly ID = 'zoomy-image-viewer';

    @inject(FileService) protected readonly fileService: FileService;

    protected uri: URI | undefined;
    protected dataUrl: string | undefined;
    protected error: string | undefined;
    protected loading = false;
    protected byteLength = 0;
    protected readonly toDisposeOnUri = new DisposableCollection();

    @postConstruct()
    protected init(): void {
        this.addClass('zoomy-image-viewer-widget');
        this.node.style.overflow = 'hidden';
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-file-media';
    }

    override dispose(): void { this.toDisposeOnUri.dispose(); super.dispose(); }

    /** Called by the WidgetFactory right after construction (mirrors how
     *  NavigatableWidgetOpenHandler keys widgets by URI — see
     *  zoomy-frontend-module.ts's WidgetFactory binding for this id). */
    setUri(uri: URI): void {
        this.uri = uri;
        this.id = ZoomyImageViewerWidget.ID + ':' + uri.toString();
        this.title.label = uri.path.base;
        this.title.caption = uri.path.toString();
        this.toDisposeOnUri.dispose();
        this.toDisposeOnUri.push(this.fileService.onDidFilesChange(event => {
            if (this.uri && event.contains(this.uri)) { this.load(); }
        }));
        this.load();
    }

    getResourceUri(): URI | undefined { return this.uri; }
    createMoveToUri(resourceUri: URI): URI | undefined { return resourceUri; }

    protected async load(): Promise<void> {
        if (!this.uri) { return; }
        const uri = this.uri;
        this.loading = true; this.error = undefined; this.update();
        try {
            const mime = imageMimeFor(uri.path.base) || 'application/octet-stream';
            const content = await this.fileService.readFile(uri);
            if (this.uri !== uri) { return; } // superseded by a newer setUri()/reload
            this.byteLength = content.value.byteLength;
            this.dataUrl = 'data:' + mime + ';base64,' + toBase64(content.value.buffer);
        } catch (e: any) {
            if (this.uri !== uri) { return; }
            this.dataUrl = undefined;
            this.error = e?.message || String(e);
        }
        this.loading = false;
        this.update();
    }

    protected render(): React.ReactNode {
        const h = React.createElement;
        const wrap: React.CSSProperties = {
            display: 'flex', flexDirection: 'column', height: '100%', width: '100%',
            background: 'var(--theia-editor-background)',
        };
        const body: React.CSSProperties = {
            flex: '1 1 auto', display: 'flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'auto', minHeight: 0, padding: 12,
        };
        if (this.loading && !this.dataUrl) {
            return h('div', { style: wrap }, h('div', { style: body },
                h('span', { className: 'codicon codicon-loading codicon-modifier-spin', style: { fontSize: 24, color: 'var(--theia-descriptionForeground)' } })));
        }
        if (this.error) {
            return h('div', { style: wrap }, h('div', { style: { ...body, flexDirection: 'column', gap: 10, textAlign: 'center' } },
                h('span', { className: 'codicon codicon-warning', style: { fontSize: 32, color: 'var(--theia-errorForeground, #f66)' } }),
                h('div', { style: { fontSize: 13, fontWeight: 600 } }, 'Could not load image'),
                h('div', { style: { fontSize: 12, color: 'var(--theia-descriptionForeground)', maxWidth: 480, wordBreak: 'break-word' } }, this.error),
                h('div', { style: { fontSize: 11, fontFamily: 'var(--theia-code-font-family, monospace)', color: 'var(--theia-descriptionForeground)', opacity: .7 } }, this.uri?.path.toString() || '')));
        }
        return h('div', { style: wrap },
            h('div', { style: body },
                h('img', {
                    src: this.dataUrl, alt: this.uri?.path.base,
                    style: { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', boxShadow: '0 1px 6px rgba(0,0,0,0.3)' },
                })),
            h('div', {
                style: {
                    flex: '0 0 auto', padding: '3px 10px', fontSize: 11, color: 'var(--theia-descriptionForeground)',
                    borderTop: '1px solid var(--theia-panel-border)', display: 'flex', justifyContent: 'space-between',
                },
            },
                h('span', null, this.uri?.path.toString() || ''),
                h('span', null, this.byteLength ? formatBytes(this.byteLength) : '')));
    }
}

function formatBytes(n: number): string {
    if (n < 1024) { return n + ' B'; }
    if (n < 1024 * 1024) { return (n / 1024).toFixed(1) + ' KB'; }
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

/** Registers the viewer as an OpenHandler for PNG/SVG/GIF, with a priority
 *  high enough to beat the built-in text editor by default (see
 *  IMAGE_OPEN_PRIORITY above). One widget per URI (NavigatableWidgetOpenHandler
 *  dedups on the serialized URI), so re-opening the same file focuses the
 *  existing tab instead of stacking duplicates. */
@injectable()
export class ZoomyImageOpenHandler extends NavigatableWidgetOpenHandler<ZoomyImageViewerWidget> {
    readonly id = ZoomyImageViewerWidget.ID;
    readonly label = 'Image Viewer';

    canHandle(uri: URI, _options?: WidgetOpenerOptions): number {
        return imageMimeFor(uri.path.base) ? IMAGE_OPEN_PRIORITY : 0;
    }
    // createWidgetOptions()/serializeUri() are inherited from
    // NavigatableWidgetOpenHandler as-is: key the cached widget by the
    // normalized file:// URI, one widget per distinct file.
}
