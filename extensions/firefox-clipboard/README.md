# NewHome noVNC Clipboard Bridge for Firefox

This extension gives the NewHome noVNC fork trusted access to the Firefox host
clipboard. It is intentionally small and has only two privileged permissions:
`clipboardRead` and `clipboardWrite`.

Behavior:

- when the pointer enters the noVNC desktop, cache the current PC/Mac clipboard;
- on right-click, stage that cached text into noVNC before the Linux context menu
  consumes it;
- mirror clipboard text received from Linux back to the controller OS clipboard;
- repair UTF-8 text that legacy x11vnc transports through standard RFB
  `ServerCutText` as byte-valued JavaScript characters;
- do nothing on ordinary pages that do not contain the noVNC container and
  clipboard elements.

## Download

The repository root contains `newhome-clipboard-firefox.xpi`. When noVNC is
served from this checkout it is available directly at:

`https://<noVNC-host>:<port>/newhome-clipboard-firefox.xpi`

## Temporary install on stock Firefox

Download the XPI, open `about:debugging`, choose **This Firefox** ->
**Load Temporary Add-on**, and select the XPI/ZIP. Firefox removes temporary
extensions when the browser restarts.

## Permanent install

Stock Firefox requires Mozilla signing for permanently installed extensions.
Use AMO self-distribution / unlisted signing for this XPI. The extension has a
stable ID: `newhome-novnc-clipboard@sherylynn.local`.
