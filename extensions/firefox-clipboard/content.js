(() => {
    "use strict";

    const POLL_MS = 150;
    const STAGED_ECHO_MS = 3000;
    const USER_EDIT_GRACE_MS = 1200;

    let controllerText = null;
    let lastObservedRemoteRaw = null;
    let lastStagedRaw = null;
    let lastStagedAt = 0;
    let userEditingUntil = 0;
    let active = false;

    function findNoVNC() {
        const container = document.getElementById("noVNC_container");
        const clipboard = document.getElementById("noVNC_clipboard_text");
        if (!container || !clipboard) return null;
        return { container, clipboard };
    }

    async function refreshControllerClipboard(reason) {
        if (!navigator.clipboard?.readText) return false;
        try {
            controllerText = await navigator.clipboard.readText();
            console.debug(`[NewHome Clipboard] controller refreshed: ${reason}`);
            return true;
        } catch (error) {
            console.warn("[NewHome Clipboard] controller read failed", error);
            return false;
        }
    }

    function stageControllerClipboard(clipboard, reason) {
        if (typeof controllerText !== "string") return false;
        clipboard.value = controllerText;
        lastObservedRemoteRaw = controllerText;
        lastStagedRaw = controllerText;
        lastStagedAt = Date.now();
        clipboard.dispatchEvent(new Event("change", { bubbles: true }));
        console.debug(`[NewHome Clipboard] staged controller -> remote: ${reason}`);
        return true;
    }

    function decodeUtf8Mojibake(text) {
        if (typeof text !== "string" || text.length === 0) return text;

        const bytes = new Uint8Array(text.length);
        let sawHighByte = false;
        for (let i = 0; i < text.length; i++) {
            const code = text.charCodeAt(i);
            // Standard RFB ServerCutText is exposed by noVNC as one JS code unit
            // per received byte. If any code unit is above 0xff, this is already
            // a real Unicode string and must not be reinterpreted.
            if (code > 0xff) return text;
            bytes[i] = code;
            if (code >= 0x80) sawHighByte = true;
        }
        if (!sawHighByte) return text;

        try {
            const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            return decoded !== text ? decoded : text;
        } catch {
            return text;
        }
    }

    async function writeControllerClipboard(text) {
        if (!navigator.clipboard?.writeText) return false;
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            console.warn("[NewHome Clipboard] controller write failed", error);
            return false;
        }
    }

    function activate() {
        if (active) return;
        const found = findNoVNC();
        if (!found) return;
        active = true;

        const { container, clipboard } = found;
        lastObservedRemoteRaw = clipboard.value;

        clipboard.addEventListener("input", () => {
            userEditingUntil = Date.now() + USER_EDIT_GRACE_MS;
            lastObservedRemoteRaw = clipboard.value;
        }, true);

        // Extension-level clipboardRead is allowed without Firefox's native
        // Paste prompt, so entering noVNC can safely cache the host clipboard.
        container.addEventListener("pointerenter", () => {
            refreshControllerClipboard("pointer-enter");
        }, true);

        window.addEventListener("focus", () => {
            refreshControllerClipboard("window-focus");
        }, true);

        document.addEventListener("visibilitychange", () => {
            if (!document.hidden) refreshControllerClipboard("visibility");
        }, true);

        // Stage the cached PC/Mac clipboard before Linux sees the right click.
        // Refresh again in parallel in case the host clipboard changed after
        // pointerenter; the user still has time before selecting Paste remotely.
        container.addEventListener("pointerdown", (event) => {
            if (!event.isTrusted || event.button !== 2) return;
            stageControllerClipboard(clipboard, "right-click-cached");
            refreshControllerClipboard("right-click")
                .then((updated) => {
                    if (updated && controllerText !== lastStagedRaw) {
                        stageControllerClipboard(clipboard, "right-click-refreshed");
                    }
                });
        }, true);

        // noVNC assigns remote clipboard values directly to the textarea, so
        // there is no DOM event to observe. Polling this single string is cheap.
        // The normalizer repairs legacy x11vnc UTF-8 transported as byte-valued
        // JavaScript characters via standard RFB ServerCutText.
        setInterval(() => {
            const raw = clipboard.value;
            if (raw === lastObservedRemoteRaw) return;
            lastObservedRemoteRaw = raw;

            if (Date.now() < userEditingUntil) return;
            if (raw === lastStagedRaw && Date.now() - lastStagedAt <= STAGED_ECHO_MS) {
                return;
            }

            const normalized = decodeUtf8Mojibake(raw);
            writeControllerClipboard(normalized);
        }, POLL_MS);

        refreshControllerClipboard("startup");
        console.info("[NewHome Clipboard] Firefox bridge active");
    }

    activate();
    const observer = new MutationObserver(() => activate());
    observer.observe(document.documentElement, { childList: true, subtree: true });
})();
