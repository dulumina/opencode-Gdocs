import { Plugin } from "@opencode/plugin"
import { google } from "googleapis"
import { createServer } from "node:http"
import { randomBytes, createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const execFileAsync = promisify(execFile)
const CONFIG_DIR = path.join(homedir(), ".config", "opencode")
const TOKEN_PATH = path.join(CONFIG_DIR, "google-drive-token.json")
// Desktop-app OAuth client JSON downloaded from Google Cloud Console. Kept out of source
// control because GitHub push protection blocks embedded client credentials.
const CLIENT_PATH = path.join(CONFIG_DIR, "google-drive-client.json")
const SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents",
]

async function oauthClient() {
  let id = process.env.GOOGLE_OAUTH_CLIENT_ID
  let secret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!id || !secret) {
    try {
      const raw = JSON.parse(await readFile(CLIENT_PATH, "utf8"))
      const client = raw.installed ?? raw
      id = client.client_id
      secret = client.client_secret
    } catch {}
  }
  if (!id || !secret) {
    throw new Error(`Google OAuth client is not configured. Save the Desktop app client JSON to ${CLIENT_PATH} or set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.`)
  }
  // Installed-app clients send the shipped secret; PKCE is used on top.
  return new google.auth.OAuth2(id, secret)
}

async function loadAuth() {
  const auth = await oauthClient()
  let saved: Record<string, unknown>
  try {
    saved = JSON.parse(await readFile(TOKEN_PATH, "utf8"))
  } catch {
    throw new Error("Google account is not connected. Run google_auth first.")
  }
  auth.setCredentials(saved)
  // googleapis refreshes in memory only; keep the saved file current so the next
  // call (and the next OpenCode restart) reuses the same session.
  auth.on("tokens", (tokens) => {
    saved = { ...saved, ...tokens }
    void saveTokens(saved).catch(() => {})
  })
  try {
    await auth.getAccessToken()
  } catch {
    throw new Error("Google session expired or was revoked. Run google_auth again.")
  }
  return auth
}

async function saveTokens(tokens: Record<string, unknown>) {
  await mkdir(CONFIG_DIR, { recursive: true, mode: 0o700 })
  await writeFile(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 })
  await chmod(TOKEN_PATH, 0o600)
}

function base64url(input: Buffer) {
  return input.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_")
}

async function openBrowser(url: string) {
  if (process.platform === "darwin") await execFileAsync("open", [url])
  else if (process.platform === "win32") await execFileAsync("cmd", ["/c", "start", "", url])
  else await execFileAsync("xdg-open", [url])
}

const str = (description: string) => ({ type: "string", description })
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
})

export default Plugin.define({
  id: "google-drive",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "google_auth",
        description: "Connect this OpenCode installation to Google Drive and Google Docs through the official Google login and consent page.",
        input: obj({}),
        async execute() {
          const auth = await oauthClient()
          const verifier = base64url(randomBytes(48))
          const challenge = base64url(createHash("sha256").update(verifier).digest())
          const state = base64url(randomBytes(24))
          const server = createServer()
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
          const address = server.address()
          if (!address || typeof address === "string") throw new Error("Could not start local OAuth callback server")
          const redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`
          auth.redirectUri = redirectUri
          const url = auth.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: SCOPES,
            state,
            code_challenge: challenge,
            code_challenge_method: "S256",
          })
          const callback = new Promise<string>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error("Google login timed out; run google_auth again.")), 180_000)
            server.on("request", (req, res) => {
              const parsed = new URL(req.url || "/", redirectUri)
              if (parsed.pathname !== "/oauth2callback") { res.writeHead(404).end(); return }
              if (parsed.searchParams.get("state") !== state) {
                res.writeHead(400, { "content-type": "text/plain" }).end("OAuth state mismatch. You can close this tab.")
                clearTimeout(timeout); reject(new Error("OAuth state mismatch")); return
              }
              const error = parsed.searchParams.get("error")
              const code = parsed.searchParams.get("code")
              res.writeHead(error || !code ? 400 : 200, { "content-type": "text/html; charset=utf-8" })
              res.end(error ? "Google authorization was denied. You may close this tab." : "Google account connected. You may close this tab and return to OpenCode.")
              clearTimeout(timeout)
              if (error) reject(new Error(`Google authorization failed: ${error}`))
              else resolve(code!)
            })
          })
          try {
            await openBrowser(url)
            const code = await callback
            const { tokens } = await auth.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri })
            await saveTokens(tokens as Record<string, unknown>)
            return { content: "Google Drive/Docs connected successfully. Tokens saved locally with owner-only file permissions." }
          } finally {
            server.close()
          }
        },
      })

      editor.add({
        name: "google_auth_status",
        description: "Check whether Google Drive/Docs OAuth credentials are saved locally.",
        input: obj({}),
        async execute() {
          try {
            const auth = await loadAuth()
            await auth.getAccessToken()
            return { content: "Google account is connected and the access token is available." }
          } catch (e) {
            return { content: `Not connected or token refresh failed: ${String(e)}` }
          }
        },
      })

      editor.add({
        name: "google_drive_search",
        description: "Search Google Drive files by name or text query. Returns IDs, names, MIME types, modified times and links.",
        input: obj({
          query: str("Search phrase or Google Drive query fragment"),
          page_size: { type: "integer", minimum: 1, maximum: 100, description: "Maximum results, default 20" },
        }, ["query"]),
        async execute(args) {
          const { query, page_size } = args as { query: string; page_size?: number }
          const auth = await loadAuth()
          const drive = google.drive({ version: "v3", auth })
          const q = query.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
          const result = await drive.files.list({
            q: `trashed = false and (name contains '${q}' or fullText contains '${q}')`,
            pageSize: page_size || 20,
            orderBy: "modifiedTime desc",
            fields: "files(id,name,mimeType,modifiedTime,webViewLink,description)",
          })
          return { content: JSON.stringify(result.data.files || [], null, 2) }
        },
      })

      editor.add({
        name: "google_drive_list",
        description: "List recent files in Google Drive, optionally within a folder ID.",
        input: obj({
          folder_id: str("Google Drive folder ID"),
          page_size: { type: "integer", minimum: 1, maximum: 100, description: "Maximum results, default 20" },
        }),
        async execute(args) {
          const { folder_id, page_size } = args as { folder_id?: string; page_size?: number }
          const auth = await loadAuth()
          const drive = google.drive({ version: "v3", auth })
          const folder = folder_id ? `'${folder_id.replace(/'/g, "\\'")}' in parents and ` : ""
          const result = await drive.files.list({
            q: `${folder}trashed = false`, pageSize: page_size || 20, orderBy: "modifiedTime desc",
            fields: "files(id,name,mimeType,modifiedTime,webViewLink)",
          })
          return { content: JSON.stringify(result.data.files || [], null, 2) }
        },
      })

      editor.add({
        name: "google_drive_read",
        description: "Read a Google Docs document as plain text, or export a supported Drive file as text. Requires a file ID.",
        input: obj({ file_id: str("Google Drive file ID") }, ["file_id"]),
        async execute(args) {
          const { file_id } = args as { file_id: string }
          const auth = await loadAuth()
          const drive = google.drive({ version: "v3", auth })
          const meta = await drive.files.get({ fileId: file_id, fields: "id,name,mimeType,webViewLink" })
          if (meta.data.mimeType === "application/vnd.google-apps.document") {
            const docs = google.docs({ version: "v1", auth })
            const doc = await docs.documents.get({ documentId: file_id })
            const parts: string[] = []
            for (const item of doc.data.body?.content || []) {
              for (const el of item.paragraph?.elements || []) if (el.textRun?.content) parts.push(el.textRun.content)
            }
            return { content: JSON.stringify({ metadata: meta.data, text: parts.join("") }, null, 2) }
          }
          if (meta.data.mimeType === "text/plain") {
            const response = await drive.files.get({ fileId: file_id, alt: "media" }, { responseType: "text" })
            return { content: JSON.stringify({ metadata: meta.data, text: response.data }, null, 2) }
          }
          return { content: `Cannot read ${meta.data.mimeType} as plain text with this tool. Open it at ${meta.data.webViewLink || "Google Drive"}; supported direct reading: Google Docs and text/plain files.` }
        },
      })

      editor.add({
        name: "google_docs_create",
        description: "Create a new Google Docs document with a title and initial plain-text content.",
        input: obj({ title: { type: "string", minLength: 1 }, content: { type: "string" } }, ["title"]),
        async execute(args) {
          const { title, content } = args as { title: string; content?: string }
          const auth = await loadAuth()
          const docs = google.docs({ version: "v1", auth })
          const drive = google.drive({ version: "v3", auth })
          const created = await docs.documents.create({ requestBody: { title } })
          const id = created.data.documentId
          if (!id) throw new Error("Google Docs did not return a document ID")
          if (content) await docs.documents.batchUpdate({ documentId: id, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: content } }] } })
          const meta = await drive.files.get({ fileId: id, fields: "id,name,webViewLink" })
          return { content: JSON.stringify(meta.data, null, 2) }
        },
      })

      editor.add({
        name: "google_docs_append",
        description: "Append text to the end of an existing Google Docs document. Confirm with the user before writing if the request is ambiguous.",
        input: obj({ document_id: { type: "string" }, text: { type: "string", minLength: 1 } }, ["document_id", "text"]),
        async execute(args) {
          const { document_id, text } = args as { document_id: string; text: string }
          const auth = await loadAuth()
          const docs = google.docs({ version: "v1", auth })
          const current = await docs.documents.get({ documentId: document_id })
          const content = current.data.body?.content || []
          const endIndex = content.length ? content[content.length - 1].endIndex : 1
          if (!endIndex) throw new Error("Could not determine document end index")
          await docs.documents.batchUpdate({ documentId: document_id, requestBody: { requests: [{ insertText: { location: { index: endIndex - 1 }, text } }] } })
          return { content: `Appended ${text.length} characters to document ${document_id}.` }
        },
      })

      editor.add({
        name: "google_docs_replace",
        description: "Replace the entire text of an existing Google Docs document. This is destructive; obtain explicit user confirmation before calling this tool.",
        input: obj({ document_id: { type: "string" }, new_content: { type: "string" } }, ["document_id", "new_content"]),
        async execute(args) {
          const { document_id, new_content } = args as { document_id: string; new_content: string }
          const auth = await loadAuth()
          const docs = google.docs({ version: "v1", auth })
          const current = await docs.documents.get({ documentId: document_id })
          const content = current.data.body?.content || []
          const endIndex = content.length ? content[content.length - 1].endIndex : 1
          const requests: any[] = []
          if (endIndex && endIndex > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } })
          if (new_content) requests.push({ insertText: { location: { index: 1 }, text: new_content } })
          if (requests.length) await docs.documents.batchUpdate({ documentId: document_id, requestBody: { requests } })
          return { content: `Replaced document content for ${document_id}.` }
        },
      })
    })
  },
})
