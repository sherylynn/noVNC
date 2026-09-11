import AsyncClipboard from '../core/clipboard.js';

describe('Async Clipboard', function () {
    "use strict";

    let targetMock;
    let clipboard;

    beforeEach(function () {
        sinon.stub(navigator, "clipboard").value({
            writeText: sinon.stub().resolves(),
            readText: sinon.stub().resolves(),
        });

        sinon.stub(navigator, "permissions").value({
            query: sinon.stub(),
        });

        targetMock = document.createElement("canvas");
        clipboard = new AsyncClipboard(targetMock);
    });

    afterEach(function () {
        sinon.restore();
        targetMock = null;
        clipboard = null;
    });

    function stubClipboardPermissions(state) {
        navigator.permissions.query
            .withArgs({ name: 'clipboard-write', allowWithoutGesture: true })
            .resolves({ state: state });
        navigator.permissions.query
            .withArgs({ name: 'clipboard-read', allowWithoutGesture: false })
            .resolves({ state: state });
    }

    function nextTick() {
        return new Promise(resolve => setTimeout(resolve, 0));
    }

    it('grab() installs focus and pointer intent listeners', function () {
        const addListenerSpy = sinon.spy(targetMock, 'addEventListener');
        clipboard.grab();

        expect(addListenerSpy.calledWith('focus')).to.be.true;
        expect(addListenerSpy.calledWith('pointerenter')).to.be.true;
        expect(addListenerSpy.calledWith('pointerleave')).to.be.true;
    });

    it('focus observes the controller clipboard without overwriting remote', async function () {
        stubClipboardPermissions('granted');
        const text = 'hello clipboard world';
        navigator.clipboard.readText.resolves(text);
        clipboard.onpaste = sinon.spy();

        await clipboard._handleFocus();

        expect(navigator.clipboard.readText.calledOnce).to.be.true;
        expect(clipboard._controllerText).to.equal(text);
        expect(clipboard.onpaste.called).to.be.false;
    });

    it('focus does not read when async clipboard permission is unavailable', async function () {
        stubClipboardPermissions('denied');
        clipboard.onpaste = sinon.spy();

        await clipboard._handleFocus();

        expect(navigator.clipboard.readText.called).to.be.false;
        expect(clipboard.onpaste.called).to.be.false;
    });

    it('writeClipboard() attempts Linux/Android -> controller sync and keeps fallback', function () {
        const text = 'writing to clipboard';
        const result = clipboard.writeClipboard(text);

        expect(navigator.clipboard.writeText.calledWith(text)).to.be.true;
        expect(result).to.be.false;
        expect(clipboard._remoteText).to.equal(text);
    });

    it('treats an echoed controller injection as acknowledgement', function () {
        clipboard._lastInjectedControllerText = 'same text';
        clipboard._lastInjectedControllerAt = Date.now();

        const result = clipboard.writeClipboard('same text');

        expect(result).to.be.true;
        expect(navigator.clipboard.writeText.called).to.be.false;
    });

    it('maps Command+C to a remote copy shortcut', function () {
        clipboard.onshortcut = sinon.spy();
        clipboard._handlePasteKeyDown({
            target: targetMock, key: 'c', metaKey: true, ctrlKey: false,
            altKey: false, preventDefault: sinon.spy(),
            stopImmediatePropagation: sinon.spy(),
        });

        expect(clipboard.onshortcut.calledOnceWith('copy', true)).to.be.true;
    });

    it('maps a browser copy event to a remote copy shortcut', function () {
        clipboard.onshortcut = sinon.spy();
        const event = {
            target: targetMock,
            preventDefault: sinon.spy(),
            stopImmediatePropagation: sinon.spy(),
        };

        clipboard._handleCopy(event);

        expect(event.preventDefault.calledOnce).to.be.true;
        expect(clipboard.onshortcut.calledOnceWith('copy', false)).to.be.true;
    });

    it('uses cached controller clipboard for paste fallback just after entry', function () {
        const clock = sinon.useFakeTimers();
        clipboard.onpaste = sinon.spy();
        clipboard.onshortcut = sinon.spy();
        clipboard._controllerText = 'from mac';
        clipboard._insideRemote = true;
        clipboard._enteredAt = 1;

        clipboard._handlePasteKeyDown({
            target: targetMock, key: 'v', metaKey: false, ctrlKey: true,
            altKey: false, stopImmediatePropagation: sinon.spy(),
        });
        clock.tick(200);

        expect(clipboard.onpaste.calledOnceWith('from mac', false, false)).to.be.true;
        expect(clipboard.onshortcut.calledOnceWith('paste')).to.be.true;
    });

    it('keeps Linux clipboard authoritative after the entry window', function () {
        const clock = sinon.useFakeTimers();
        clipboard.onpaste = sinon.spy();
        clipboard.onshortcut = sinon.spy();
        clipboard._controllerText = 'stale controller text';
        clipboard._insideRemote = true;
        clipboard._enteredAt = 1;
        clock.tick(6000);

        clipboard._handlePasteKeyDown({
            target: targetMock, key: 'v', metaKey: false, ctrlKey: true,
            altKey: false, stopImmediatePropagation: sinon.spy(),
        });
        clock.tick(200);

        expect(clipboard.onpaste.called).to.be.false;
        expect(clipboard.onshortcut.calledOnceWith('paste')).to.be.true;
    });

    it('uses a browser paste event as authoritative controller clipboard', function () {
        const clock = sinon.useFakeTimers();
        clipboard.onpaste = sinon.spy();
        clipboard.onshortcut = sinon.spy();
        clipboard._handlePasteKeyDown({
            target: targetMock, key: 'v', metaKey: true, ctrlKey: false,
            altKey: false, stopImmediatePropagation: sinon.spy(),
        });
        clipboard._handlePaste({
            target: targetMock,
            clipboardData: { getData: () => 'clipboard text' },
            preventDefault: sinon.spy(),
            stopImmediatePropagation: sinon.spy(),
        });
        clock.tick(200);

        expect(clipboard._controllerText).to.equal('clipboard text');
        expect(clipboard.onpaste.calledOnceWith('clipboard text', true, true)).to.be.true;
        expect(clipboard.onshortcut.called).to.be.false;
    });

    it('stages cached controller clipboard on right click just after entry', function () {
        clipboard.onpaste = sinon.spy();
        clipboard._controllerText = 'right-click from pc';
        clipboard._insideRemote = true;
        clipboard._enteredAt = Math.max(1, performance.now());
        clipboard._isAvailable = false; // avoid an async read in this unit test

        clipboard._handlePointerDown({ isTrusted: true, button: 2 });

        expect(clipboard.onpaste.calledOnceWith('right-click from pc', false, false)).to.be.true;
    });

    it('does not stage controller clipboard on right click after entry window', function () {
        clipboard.onpaste = sinon.spy();
        clipboard._controllerText = 'old pc value';
        clipboard._insideRemote = true;
        clipboard._enteredAt = performance.now() - 6000;

        clipboard._handlePointerDown({ isTrusted: true, button: 2 });

        expect(clipboard.onpaste.called).to.be.false;
    });

    it('suppresses browser context menu without reading controller clipboard', function () {
        const event = {
            target: targetMock,
            preventDefault: sinon.spy(),
        };

        clipboard._handleContextMenu(event);

        expect(event.preventDefault.calledOnce).to.be.true;
        expect(navigator.clipboard.readText.called).to.be.false;
    });
});
