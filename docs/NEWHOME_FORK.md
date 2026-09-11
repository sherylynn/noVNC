# NewHome noVNC fork differences

This repository is the maintained noVNC fork used by the NewHome Termux/chroot
desktop deployment. The behavior below intentionally differs from upstream
noVNC and must be preserved when rebasing or merging upstream releases.

## Cross-platform clipboard shortcuts

The controlled desktop is Linux, while clients may be macOS, Windows, or Linux.
The fork normalizes browser shortcuts to Linux desktop shortcuts:

- macOS `Command+C` and `Command+V` send remote `Ctrl+C` and `Ctrl+V`.
- Windows/Linux `Ctrl+C` and `Ctrl+V` continue to send remote `Ctrl+C` and
  `Ctrl+V`.
- A browser `copy` event, including one produced by a browser context menu,
  sends remote `Ctrl+C`. x11vnc subsequently returns the changed X11 clipboard
  to noVNC for writing into the local browser clipboard when browser permission
  allows it.
- A browser `paste` event first sends its UTF-8 text through the RFB clipboard
  channel and then automatically sends remote `Ctrl+V`. The user must not need
  to press a second shortcut.
- Firefox sometimes does not emit a `paste` event. After 200 ms, the fork falls
  back to sending remote `Ctrl+V`, preserving copy/paste inside the controlled
  Linux desktop even when local clipboard access is denied or unavailable.
- If a real `paste` event arrives, the fallback is cancelled so text is pasted
  only once.
- noVNC normally maps the left macOS Command key to remote Alt. Before sending a
  synthesized Linux shortcut, the fork releases that remote Alt state to avoid
  accidentally producing `Alt+Ctrl+C` or `Alt+Ctrl+V`.

Clipboard interception applies only to the VNC canvas and noVNC's hidden
keyboard-input element. It must not intercept typing or copy/paste in visible
noVNC settings fields.

## Remote resize and HiDPI

The fork carries the NewHome remote-resize/Retina protocol integration used by
the matching x11vnc receiver and `xfce4-scaling.sh` tooling. Browser viewport
size, device-pixel ratio, and remote DPI information are propagated through the
NewHome extension while retaining the stability guards added for x11vnc resize.

## HTTPS launcher

The bundled launcher supports the NewHome automatic local-CA HTTPS setup used by
the deployment scripts. Fresh installations clone this fork directly; legacy
patch files in the shell-tools repository are compatibility fallbacks for an
explicitly selected official noVNC checkout.

## Maintenance checks

After an upstream update, verify at minimum:

1. Remote Linux copy/paste within the desktop from all three client platforms.
2. macOS Command shortcuts and browser context-menu copy/paste.
3. Local-to-remote and remote-to-local UTF-8 clipboard text.
4. Firefox behavior both with clipboard permission granted and denied.
5. Remote resize in windowed and fullscreen modes without disconnecting x11vnc.
