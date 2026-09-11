/*
 * NewHome browser-side diagnostics.
 *
 * Disabled by default. When enabled from noVNC settings, metadata-only events
 * are batched to the same-origin /newhome-debug endpoint. Clipboard contents,
 * credentials, and key text are never included.
 */

const MAX_QUEUE = 200;
const FLUSH_DELAY_MS = 400;

class NewHomeDiagnostics {
    constructor() {
        this._enabled = false;
        this._queue = [];
        this._flushTimer = null;
        this._sending = false;
        this._session = globalThis.crypto?.randomUUID?.() ||
            `session-${Date.now().toString(36)}`;
        this._errorHandlersInstalled = false;
    }

    get enabled() {
        return this._enabled;
    }

    setEnabled(enabled) {
        enabled = Boolean(enabled);
        if (enabled === this._enabled) return;
        this._enabled = enabled;
        if (!enabled) {
            clearTimeout(this._flushTimer);
            this._flushTimer = null;
            this._queue = [];
            return;
        }

        this._installErrorHandlers();
        this.capture('diagnostics', 'enabled', {
            secureContext: window.isSecureContext,
            userAgent: navigator.userAgent,
            platform: navigator.platform,
            devicePixelRatio: window.devicePixelRatio,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
            screen: `${screen.width}x${screen.height}`,
            visibility: document.visibilityState,
        });
        this.probeClipboardPermissions();
    }

    _installErrorHandlers() {
        if (this._errorHandlersInstalled) return;
        this._errorHandlersInstalled = true;
        window.addEventListener('error', (event) => {
            this.capture('browser', 'error', {
                name: event.error?.name,
                message: event.message,
                file: event.filename?.split('/').pop(),
                line: event.lineno,
            });
        });
        window.addEventListener('unhandledrejection', (event) => {
            this.capture('browser', 'unhandled-rejection', {
                name: event.reason?.name,
                message: event.reason?.message || String(event.reason),
            });
        });
    }

    async _permission(name, options) {
        if (!navigator.permissions?.query) return 'api-unavailable';
        try {
            const result = await navigator.permissions.query(options);
            return result.state || 'unknown';
        } catch (error) {
            return `unsupported:${error.name || 'Error'}`;
        }
    }

    async probeClipboardPermissions() {
        if (!this._enabled) return;
        const write = await this._permission('clipboard-write', {
            name: 'clipboard-write', allowWithoutGesture: true,
        });
        const read = await this._permission('clipboard-read', {
            name: 'clipboard-read', allowWithoutGesture: false,
        });
        this.capture('clipboard', 'permission-probe', {
            write,
            read,
            hasClipboard: Boolean(navigator.clipboard),
            hasReadText: Boolean(navigator.clipboard?.readText),
            hasWriteText: Boolean(navigator.clipboard?.writeText),
            userActivation: navigator.userActivation?.isActive || false,
        });
    }

    capture(category, event, fields={}) {
        if (!this._enabled) return;
        this._queue.push({
            time: new Date().toISOString(),
            elapsedMs: Math.round(performance.now()),
            category,
            event,
            ...fields,
        });
        if (this._queue.length > MAX_QUEUE) {
            this._queue.splice(0, this._queue.length - MAX_QUEUE);
        }
        if (this._queue.length >= 20) {
            this.flush();
        } else if (this._flushTimer === null) {
            this._flushTimer = setTimeout(() => {
                this._flushTimer = null;
                this.flush();
            }, FLUSH_DELAY_MS);
        }
    }

    async flush() {
        if (!this._enabled || this._sending || this._queue.length === 0) return;
        this._sending = true;
        const events = this._queue.splice(0, 50);
        try {
            const response = await fetch('./newhome-debug', {
                method: 'POST',
                credentials: 'same-origin',
                cache: 'no-store',
                keepalive: true,
                headers: {
                    'Content-Type': 'application/json',
                    'X-NewHome-Debug': '1',
                },
                body: JSON.stringify({ session: this._session, events }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
        } catch {
            this._queue.unshift(...events);
            if (this._queue.length > MAX_QUEUE) this._queue.length = MAX_QUEUE;
        } finally {
            this._sending = false;
            if (this._enabled && this._queue.length > 0 && this._flushTimer === null) {
                this._flushTimer = setTimeout(() => {
                    this._flushTimer = null;
                    this.flush();
                }, 1500);
            }
        }
    }
}

export default new NewHomeDiagnostics();
