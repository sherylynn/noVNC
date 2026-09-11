/*
 * noVNC: HTML5 VNC client
 * Copyright (c) 2025 The noVNC authors
 * Licensed under MPL 2.0 or any later version (see LICENSE.txt)
 */

import * as Log from './util/logging.js';
import { browserAsyncClipboardSupport } from './util/browser.js';

export default class AsyncClipboard {
    constructor(target) {
        this._target = target || null;
        this._eventTarget = this._target?.ownerDocument || this._target;

        this._isAvailable = null;
        // NEWHOME_EXPLICIT_PASTE: Firefox keyboard/right-click clipboard bridge.
        this._explicitPasteShortcut = false;

        this._eventHandlers = {
            'focus': this._handleFocus.bind(this),
            'paste': this._handlePaste.bind(this),
            'keydown': this._handlePasteKeyDown.bind(this),
            'keyup': this._handlePasteKeyUp.bind(this),
            'contextmenu': this._handleContextMenu.bind(this),
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

    async _handleFocus(event) {
        if (!(await this._ensureAvailable())) return;
        try {
            const text = await navigator.clipboard.readText();
            this.onpaste(text);
        } catch (error) {
            Log.Error("Clipboard read failed: ", error);
        }
    }

    _handlePasteKeyDown(event) {
        if (this._isEditableTarget(event.target)) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey &&
            event.key.toLowerCase() === 'v') {
            this._explicitPasteShortcut = true;
            // Keyboard's normal handler would send Ctrl/Meta+V before the RFB
            // clipboard update. Keep the browser's paste action, but stop that
            // premature remote key event.
            event.stopImmediatePropagation();
        }
    }

    _handlePasteKeyUp(event) {
        if (this._explicitPasteShortcut && event.key.toLowerCase() === 'v') {
            event.stopImmediatePropagation();
            this._explicitPasteShortcut = false;
        }
    }

    _handlePaste(event) {
        if (this._isEditableTarget(event.target)) return;
        const text = event.clipboardData?.getData('text/plain');
        if (typeof text !== 'string') return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.onpaste(text, true);
    }

    async _handleContextMenu(event) {
        if (event.target !== this._target &&
            event.target?.id !== 'noVNC_keyboardinput') return;
        // Firefox does not expose clipboard-read through the Permissions API,
        // but permits an explicit read attempt from a user-triggered action.
        if (!navigator?.clipboard?.readText) return;
        try {
            const text = await navigator.clipboard.readText();
            this.onpaste(text, false);
        } catch (error) {
            Log.Warn("Clipboard read on right click failed: ", error);
        }
    }

    _isEditableTarget(target) {
        if (!target) return false;
        // noVNC deliberately focuses this hidden textarea for keyboard input.
        // Firefox dispatches Cmd+V and context-menu Paste to it, so it belongs
        // to the remote canvas rather than to noVNC's local settings forms.
        if (target.id === 'noVNC_keyboardinput') return false;
        const tag = target.tagName?.toLowerCase();
        return tag === 'input' || tag === 'textarea' || target.isContentEditable;
    }

    // ===== PUBLIC METHODS =====

    writeClipboard(text) {
        // Can lazily check cached availability
        if (!this._isAvailable) return false;
        navigator.clipboard.writeText(text)
            .catch(error => Log.Error("Clipboard write failed: ", error));
        return true;
    }

    grab() {
        if (!this._target) return;
        this._eventTarget.addEventListener('paste', this._eventHandlers.paste, true);
        this._eventTarget.addEventListener('keydown', this._eventHandlers.keydown, true);
        this._eventTarget.addEventListener('keyup', this._eventHandlers.keyup, true);
        this._eventTarget.addEventListener('contextmenu', this._eventHandlers.contextmenu, true);
        this._ensureAvailable()
            .then((isAvailable) => {
                if (isAvailable) {
                    this._target.addEventListener('focus', this._eventHandlers.focus);
                }
            });
    }

    ungrab() {
        if (!this._target) return;
        this._eventTarget.removeEventListener('paste', this._eventHandlers.paste, true);
        this._eventTarget.removeEventListener('keydown', this._eventHandlers.keydown, true);
        this._eventTarget.removeEventListener('keyup', this._eventHandlers.keyup, true);
        this._eventTarget.removeEventListener('contextmenu', this._eventHandlers.contextmenu, true);
        this._target.removeEventListener('focus', this._eventHandlers.focus);
        this._explicitPasteShortcut = false;
    }
}
