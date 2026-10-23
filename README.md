# OpenCode Google Drive / Docs — global plugin

A global [OpenCode V2](https://opencode.ai/v2/docs/build/plugins) plugin for Google Drive and Google Docs.

**Site:** https://dulumina.github.io/opencode-Gdocs/

> Requires OpenCode V2. V1 plugins do not run in V2; this plugin uses the V2 `Plugin.define` API.

## Google Cloud setup

1. Create a **Desktop app** OAuth client in a Google Cloud project and download its client JSON.
2. Enable the Google Drive API and Google Docs API for that project.
3. While the app is in **Testing**, only listed test users can authorize it, and Google expires refresh tokens after **7 days** — you will be asked to log in again every week.
4. To authorize only once, set the OAuth consent screen to **In production** (Google Auth Platform → Audience → Publish app). Unverified apps still show a warning and are capped at 100 users, which is fine for personal use.

The plugin reads the client from `~/.config/opencode/google-drive-client.json`, or from `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`. It uses browser-based OAuth with a local loopback callback and PKCE.

## Install globally (Linux)

```bash
chmod +x install.sh
./install.sh /path/to/client_secret_*.json
```

Without an argument the script looks for `client_secret_*.json` in `~/Downloads` or `~/Documents`. It copies the plugin to `~/.config/opencode/plugins/google-drive.ts` and the client JSON to `~/.config/opencode/google-drive-client.json` (mode 600). If `~/.config/opencode/package.json` already exists it is left untouched — make sure it includes `@opencode/plugin` and `googleapis`. Then install dependencies:

```bash
cd ~/.config/opencode
bun install   # or: npm install
```

Restart OpenCode and run `google_auth`. Your browser opens Google's login/consent page. Tokens are saved to `~/.config/opencode/google-drive-token.json` with owner-only permissions, and refreshed access tokens are written back automatically.

## Tools

- `google_auth`: connect through Google OAuth
- `google_auth_status`: check the saved connection
- `google_drive_search`: search Drive by name or text
- `google_drive_list`: list recent files
- `google_drive_read`: read Google Docs and plain text files
- `google_docs_create`: create a Google Doc
- `google_docs_append`: append text to a Google Doc
- `google_docs_replace`: replace the full text of a Google Doc; use only after explicit confirmation

## Notes and limitations

- The current scopes are `drive.readonly` and `documents`: Drive search/read plus Google Docs editing, but no general Drive write access.
- Direct text reading supports Google Docs and `text/plain`; PDFs, Word files, Sheets and Slides are not parsed.
- Tokens are stored in a local JSON file with mode 600, not an OS keychain. Protect your account and disk.
- Never commit token or client JSON files. For installed-app OAuth clients Google does not treat the shipped client secret as confidential, but this repository keeps it out of source control anyway.
