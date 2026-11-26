# IM, phone and mobile access

Remote access talks to the team running on the host computer. It does not move that team's files and model runtime onto the phone.

## Phone and browser pairing

1. On the computer open **Settings → Connect → Phone**.
2. Enable phone access. Under **Pair a phone**, choose **Show QR code** (or **Turn on & pair** while offline) and scan it with the phone app.
3. Review paired devices under **Phones**. Use **Remove** to revoke one.

For browser remote, show a pairing code and use **Open in a browser** or **Copy browser link**. The Relay Server must serve the exported mobile web build. Use HTTPS/WSS outside localhost. Browser remote is preview functionality; its relay deployment must support the web page before the link works.

Pairing is a user security action. There is no Bot configuration tool for enabling phone access or silently pairing a device. A Bot can explain the steps and continue work through the user's connected client. Do not copy pairing material into public chats.

The link is end-to-end encrypted. Browser remote still runs a page supplied by its Server: use only a trusted Server. Browser storage is encrypted with a non-extractable key in IndexedDB, but that does not make an untrusted web page safe. Sensitive operations require the phone app or computer. Browser remote has no background notifications.

## IM platforms

Open **Settings → Connect → IM** to configure supported messaging-platform connections. Use the platform choices and setup fields actually shown there; do not assume every chat platform is supported. Account credentials and pairing are user UI work, not Main Bot powers. IM carries messages to the existing team; it is not a new OS sandbox or permission grant.

## Problems

- A paired client needs the host computer and link connection available. Check **Phone** status before pairing repeatedly.
- A browser link that cannot load may mean the Relay Server has no web build. Consult the Relay Server deployment guide rather than changing model settings.
- A sensitive operation unavailable in browser remote should be done on the phone app or computer, not through a workaround.
- Revoke lost devices from **Phones**. Do not merely hide their chat.

Sources: README.md (Browser remote); src/client/phone-page.js, phone-browser.js, im-page.js; docs/plans/2026-10-24-mobile-app.md; docs/plans/2026-11-04-im.md; docs/plans/2026-11-17-web-remote.md.
