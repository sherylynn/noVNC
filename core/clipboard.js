/*
 * noVNC: HTML5 VNC client
 * Copyright (c) 2025 The noVNC authors
 * Licensed under MPL 2.0 or any later version (see LICENSE.txt)
 */

import * as Log from './util/logging.js';
import { browserAsyncClipboardSupport } from './util/browser.js';

// NEWHOME_EXPLICIT_PASTE / NEWHOME_CLIPBOARD_ARBITER
//
// Clipboard model used by the NewHome fork:
//   - controller slot: clipboard last observed on the PC/Mac running noVNC
//   - remote slot: clipboard last received from Linux/Android through RFB
//
// Linux and Android are already kept in sync by NewHome's device-side bridge,
// so they intentionally behave as one "remote" clipboard domain here.
//
// Entering the remote canvas does not immediately overwrite either side. It
// starts a short controller-priority window. During that window a right-click
// can stage the controller slot into X11 before Linux consumes the clipboard.
// Keyboard shortcuts are deliberately left to noVNC's normal keyboard path so
// terminal Ctrl+C and application Ctrl+C/Ctrl+V reach Linux unchanged. Once the user stays inside the
// remote desktop, Linux/Android remain authoritative unless a real browser
// paste event provides fresh controller clipboard data.
//
// Clipboard payload transport is RFB only. Classic ClientCutText is sent as
// UTF-8 bytes by RFB.clipboardPasteFrom(). Classic ServerCutText may arrive as
// those UTF-8 bytes exposed as a legacy 8-bit JS string; _normalizeRemoteText()
// recovers it strictly and falls back to the original Latin-1 text on failure.
const ENTRY_CONTROLLER_PRIORITY_MS = 5000;
const LOCAL_INJECTION_ECHO_MS = 5000;

export default class AsyncClipboard {
    constructor(target) {
        this._target = target || null;
        this._eventTarget = this._target?.ownerDocument || this._target;

        this._isAvailable = null;
        // Controller (PC/Mac) clipboard slot. We only update this from a
        // browser paste event or from a successful permission-safe async read.
        // A failed read never invalidates the previous known controller value.
        this._controllerText = null;
        this._controllerObservedAt = 0;
        this._controllerSource = null;

        // Remote slot represents the shared Linux/Android side.
        this._remoteText = null;
        this._remoteObservedAt = 0;

        // Latest remote clipboard value that could not yet be written to the
        // controller OS clipboard because the browser requires user activation.
        this._pendingRemoteText = null;

        // Pointer context is a weak intent signal. Re-entering from outside
        // opens a short window in which paste/right-click likely means the user
        // wants the controller clipboard in Linux.
        this._insideRemote = false;
        this._enteredAt = 0;
        this._controllerStagedForEntry = false;

        // Prevent a controller value that we just injected into X11 from being
        // mistaken for a new Linux/Android copy when x11vnc echoes it back.
        this._lastInjectedControllerText = null;
        this._lastInjectedControllerAt = 0;

        this._eventHandlers = {
            'focus': this._handleFocus.bind(this),
            'contextmenu': this._handleContextMenu.bind(this),
            'pointerdown': this._handlePointerDown.bind(this),
            'pointerenter': this._handlePointerEnter.bind(this),
            'pointerleave': this._handlePointerLeave.bind(this),
        };

        // ===== EVENT HANDLERS =====

        this.onpaste = () => {};
    }

    // ===== PRIVATE METHODS =====

    async _ensureAvailable() {
        if (this._isAvailable !== null) return this._isAvailable;
        try {
            const status = await browserAsyncClipboardSupport();
            this._isAvailable = (status === 'available');
        } catch {
            this._isAvailable = false;
        }
        return this._isAvailable;
    }

    _rememberControllerClipboard(text, source) {
        if (typeof text !== 'string') return;
        this._controllerText = text;
        this._controllerObservedAt = Date.now();
        this._controllerSource = source;
        Log.Debug(`Controller clipboard slot updated (${source}, ${text.length} chars)`);
    }

    async _refreshControllerClipboard(source) {
        // Do not call readText() on browsers that failed noVNC's permission
        // capability probe. In Firefox this avoids the native "Paste" prompt
        // that used to appear on right-click.
        if (!(await this._ensureAvailable())) return false;
        if (!navigator?.clipboard?.readText) return false;

        try {
            const text = await navigator.clipboard.readText();
            this._rememberControllerClipboard(text, source);
            return true;
        } catch (error) {
            Log.Debug("Controller clipboard refresh unavailable: ", error);
            return false;
        }
    }

    _hasNonAscii(text) {
        if (typeof text !== 'string') return false;
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) > 0x7f) return true;
        }
        return false;
    }

    _normalizeRemoteText(text) {
        // Some clipboard producers expose a single Unicode character (or a
        // sequence of characters) as literal JSON-style escapes, e.g. the X11
        // text "到" arrives as the six ASCII characters "\\u5230". Decode only
        // when the complete payload consists of Unicode escapes. This repairs
        // that transport defect without changing source code or prose which
        // merely contains a \\uXXXX fragment.
        if (typeof text === 'string' &&
            /^(?:\\u[0-9a-fA-F]{4})+$/.test(text)) {
            try {
                return JSON.parse(`"${text}"`);
            } catch {
                // Invalid surrogate sequence or malformed JSON: preserve it.
            }
        }

        if (typeof text !== 'string' || !this._hasNonAscii(text)) return text;

        // Standard RFB ServerCutText is historically an 8-bit string. x11vnc
        // commonly forwards UTF-8 bytes through that field unchanged, which
        // noVNC then exposes as mojibake such as "ä¸­æ–‡". Reinterpret only
        // strings that consist entirely of byte-valued code points and only if
        // those bytes form strictly valid UTF-8. Latin-1 values such as é
        // (single byte 0xe9) fail strict UTF-8 validation and remain untouched.
        const bytes = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            if (code > 0xff) return text; // Extended clipboard is already decoded.
            bytes[i] = code;
        }

        try {
            const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (decoded !== text && this._hasNonAscii(decoded)) {
                Log.Debug("Recovered UTF-8 text from legacy ServerCutText bytes");
                return decoded;
            }
        } catch {
            // Not UTF-8: preserve the exact legacy RFB text.
        }
        return text;
    }

    _entryControllerPriorityActive() {
        return this._insideRemote &&
               this._enteredAt > 0 &&
               (performance.now() - this._enteredAt) <= ENTRY_CONTROLLER_PRIORITY_MS;
    }

    _stageControllerClipboard(reason) {
        if (typeof this._controllerText !== 'string') return false;

        const text = this._controllerText;
        this._lastInjectedControllerText = text;
        this._lastInjectedControllerAt = Date.now();
        this._controllerStagedForEntry = true;

        // Always stage through RFB. RFB.clipboardPasteFrom() encodes classic
        // ClientCutText as UTF-8 bytes, so Unicode no longer needs a NewHome
        // HTTP/4715 side channel.
        this.onpaste(text, false, false);
        Log.Debug(`Staged controller clipboard for remote via RFB (${reason})`);
        return true;
    }

    async _tryWriteRemoteClipboard(text) {
        if (typeof text !== 'string' || !navigator?.clipboard?.writeText) {
            return false;
        }
        try {
            await navigator.clipboard.writeText(text);
            if (this._pendingRemoteText === text) {
                this._pendingRemoteText = null;
            }
            return true;
        } catch (error) {
            // Do not discard a remote clipboard update just because this browser
            // wants a newer user gesture. The next trusted interaction retries it.
            Log.Warn("Remote clipboard write deferred until user activation: ", error);
            return false;
        }
    }

    _flushPendingRemoteClipboard() {
        if (this._pendingRemoteText === null) return;
        this._tryWriteRemoteClipboard(this._pendingRemoteText);
    }

    async _handleFocus() {
        // Focus is only an observation opportunity. Do not flush a pending
        // remote value here: focus often means the user has just returned from
        // the controller OS, so overwriting its clipboard before we can observe
        // it would destroy exactly the value the user may intend to paste.
        await this._refreshControllerClipboard('focus');
    }

    _handlePointerEnter(event) {
        if (!event.isTrusted) return;
        this._insideRemote = true;
        this._enteredAt = performance.now();
        this._controllerStagedForEntry = false;

        // Refresh opportunistically on browsers where clipboard-read permission
        // is already available. This does not overwrite the remote clipboard.
        this._refreshControllerClipboard('pointer-enter');
    }

    _handlePointerLeave(event) {
        if (!event.isTrusted) return;
        this._insideRemote = false;
        this._enteredAt = 0;
        this._controllerStagedForEntry = false;
    }

    _handlePointerDown(event) {
        if (!event.isTrusted) return;

        const entryPriority = this._entryControllerPriorityActive();

        // While the pointer has only just returned from the controller OS, never
        // use that same click to flush an older remote clipboard back to the PC.
        // The controller clipboard is the protected candidate during this short
        // window. Outside the window, any trusted interaction may complete a
        // deferred Linux/Android -> PC write.
        if (!entryPriority) {
            this._flushPendingRemoteClipboard();
        }

        if (event.button !== 2 || !entryPriority) return;

        // Right-click shortly after entering the remote desktop is treated as a
        // likely controller -> Linux paste workflow. Use a previously observed
        // controller slot immediately, and also try a permission-safe refresh in
        // parallel. No navigator.clipboard.readText() call is made on browsers
        // that would show the Firefox/Safari native Paste permission UI.
        if (!this._controllerStagedForEntry) {
            this._stageControllerClipboard('entry-right-click-cached');
        }
        this._refreshControllerClipboard('entry-right-click')
            .then((updated) => {
                if (updated &&
                    this._entryControllerPriorityActive() &&
                    this._controllerText !== this._lastInjectedControllerText) {
                    this._stageControllerClipboard('entry-right-click-refreshed');
                }
            });
    }

    _handleContextMenu(event) {
        if (event.target !== this._target &&
            event.target?.id !== 'noVNC_keyboardinput') return;

        // Keep the browser's own context menu out of the way. The actual mouse
        // button events are still delivered to Linux, so the remote application's
        // context menu is the only one the user sees.
        //
        // Clipboard staging, when appropriate, already happened on pointerdown.
        // We deliberately never call navigator.clipboard.readText() here because
        // Firefox/Safari may display their native "Paste" permission UI.
        event.preventDefault();
    }

    // ===== PUBLIC METHODS =====

    writeClipboard(text) {
        if (typeof text !== 'string') return false;

        // Recover x11vnc's common "UTF-8 bytes carried in legacy ServerCutText"
        // representation at the browser boundary. Extended Clipboard is already
        // Unicode, so _normalizeRemoteText() leaves code points > 0xff unchanged.
        text = this._normalizeRemoteText(text);

        this._remoteText = text;
        this._remoteObservedAt = Date.now();

        // x11vnc can echo a controller clipboard we just staged back as a server
        // clipboard update. That is an acknowledgement, not a fresh Linux copy,
        // so do not churn the controller clipboard or change intent state.
        const injectedEcho =
            this._lastInjectedControllerText === text &&
            (Date.now() - this._lastInjectedControllerAt) <= LOCAL_INJECTION_ECHO_MS;
        if (injectedEcho) {
            Log.Debug("Remote clipboard matches recent controller injection; treating as echo");
            this._pendingRemoteText = null;
            return true;
        }

        // A genuinely new Linux/Android clipboard should flow back to the PC.
        // If the browser blocks the write now, retain it until the next trusted
        // pointer/focus interaction.
        this._pendingRemoteText = text;
        if (navigator?.clipboard?.writeText) {
            this._tryWriteRemoteClipboard(text);
        }

        // Keep RFB's normal clipboard event as a fallback/UI update path.
        return false;
    }

    grab() {
        if (!this._target) return;
        this._eventTarget.addEventListener('contextmenu', this._eventHandlers.contextmenu, true);
        this._eventTarget.addEventListener('pointerdown', this._eventHandlers.pointerdown, true);
        this._target.addEventListener('pointerenter', this._eventHandlers.pointerenter);
        this._target.addEventListener('pointerleave', this._eventHandlers.pointerleave);
        this._target.addEventListener('focus', this._eventHandlers.focus);
        this._ensureAvailable();
    }

    ungrab() {
        if (!this._target) return;
        this._eventTarget.removeEventListener('contextmenu', this._eventHandlers.contextmenu, true);
        this._eventTarget.removeEventListener('pointerdown', this._eventHandlers.pointerdown, true);
        this._target.removeEventListener('pointerenter', this._eventHandlers.pointerenter);
        this._target.removeEventListener('pointerleave', this._eventHandlers.pointerleave);
        this._target.removeEventListener('focus', this._eventHandlers.focus);
        this._pendingRemoteText = null;
        this._insideRemote = false;
        this._enteredAt = 0;
        this._controllerStagedForEntry = false;
    }
}
