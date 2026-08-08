# Outlook Mail Sidecar

A standalone MCP sidecar for reading and summarizing a personal Outlook/Hotmail mailbox through Microsoft Graph. It is intentionally read-only and is designed to run in a separate hardened container from OpenClaw.

## Microsoft app registration

Create a Microsoft Entra app registration before onboarding:

1. Select **Accounts in any organizational directory and personal Microsoft accounts**.
2. Enable **Allow public client flows** under Authentication.
3. Add Microsoft Graph delegated permission **Mail.Read**. Do not add `Mail.ReadWrite`, `Mail.Send`, or application permissions.
4. Copy the Application (client) ID. No client secret is used or required.

`Mail.Read` is required because summaries need message body/body preview data. `Mail.ReadBasic` excludes body and preview.

## Install and onboard

```bash
cd services/outlook-mail-sidecar
npm install
OUTLOOK_STATE_DIR='../../outlook-state' npm run setup   # one-time, interactive
OUTLOOK_STATE_DIR='../../outlook-state' npm run onboard # device-code sign-in
```

`npm run setup` asks for the Application (client) ID when none is configured, validates it as an Entra UUID, and writes it to `<OUTLOOK_STATE_DIR>/client-id.txt` with mode `0600` inside a `0700` directory. The CLI never stores the client ID in tracked source, docs, or examples. The value is re-used on later `npm run onboard` runs without re-prompting.

`npm run onboard` always prints the MSAL verification URL and device code on stdout (so it stays visible as a fallback), then tries to launch it in the operator's browser via `xdg-open` with `shell:false`. Only the URL MSAL itself returns is opened — no URL from any other input is ever passed to the opener. If the browser launch fails (e.g. `ENOENT` on a headless host), the CLI emits a structured `outlook_browser_open_failed` event and instructs the operator to open the URL manually.

For automation or noninteractive shells, skip `setup` and pass the client ID directly:

```bash
OUTLOOK_CLIENT_ID='<application-client-id>' OUTLOOK_STATE_DIR='../../outlook-state' npm run onboard
```

`OUTLOOK_CLIENT_ID` is read but not persisted when set this way. A client ID is not a secret; it just must not be hard-coded into source.

For Compose, set `OUTLOOK_CLIENT_ID` in the operator environment and keep `./outlook-state` private and mode-restricted. Then build/start the service manually when ready. This repository change does not deploy or authenticate it.

## Attach to OpenClaw

`state/openclaw.json` registers `outlook-mail` for the existing `main` agent and its Telegram allowlist. This is intentionally the simpler operator setup. Use `openclaw-isolated-agent.example.json` only if a dedicated mail-only agent is needed later; do not replace the whole live configuration.

The isolated agent allowlist contains only:

- `outlook-mail__outlook_list_folders`
- `outlook-mail__outlook_list_messages`
- `outlook-mail__outlook_search_messages`
- `outlook-mail__outlook_get_sanitized_message`

The example explicitly denies web/browser/HTTP/shell execution and hypothetical mail mutations. It remains available as the stricter option if future email risk justifies a separate channel account.

## Tool inventory

- `outlook_list_folders`: recursively lists accessible folders, including nested and Junk Email folders, with opaque folder handles.
- `outlook_list_messages`: returns bounded sanitized metadata and opaque message handles for one folder.
- `outlook_search_messages`: performs a bounded Graph search across the mailbox or one folder.
- `outlook_get_sanitized_message`: returns one bounded inert-text message suitable for summarization.
- `outlook_list_pdf_attachments`: returns sanitized PDF-only attachment metadata for one identified message (id, name, contentType, size, isInline). Non-PDF and item attachments are filtered out at the source.
- `outlook_extract_pdf_attachment`: extracts text from one named PDF attachment identified by `attachmentId`. Requires `confirm: true`. Returns bounded sanitized text plus a `trustBoundary` so chat summarization can wrap the result. Never auto-runs based on sender, subject, or content.

There are no send, reply, draft, move, delete, flag, write, or arbitrary URL/shell tools. Graph requests are GET-only for messages, attachment metadata, and attachment `$value`. The PDF extractor is a separate container (`pdf-extractor-sidecar`) on the internal-only `pdf-mcp-internal` network with no Outlook token, no host mounts, no external network, and a read-only root.

PDF reading is strictly **manual-only**: the agent must call `outlook_list_pdf_attachments`, surface the names to the operator, wait for explicit confirmation of a specific attachment, and only then call `outlook_extract_pdf_attachment` with `confirm: true`. There is no sender-based auto-download, no batch reads, and no persistence on the extractor side — bytes leave the extractor exactly once and are discarded.

## Security model

Email is hostile, untrusted data. HTML is converted to inert text; scripts, styles, comments, templates, hidden content, tags, URLs, email addresses, and phone numbers are removed or redacted. Per-message and total payload limits prevent unbounded context growth. Returned messages carry an explicit untrusted-content boundary. External failures are generic, and logs contain only tool names and error class names—never mail content, folder/message IDs, token data, or mailbox paths.

Sanitization does **not** make prompt injection safe. The current deployment exposes Outlook to `main` for simplicity, so mail content must never be treated as instructions and must not trigger unrelated actions. Capability isolation through the included mail-only agent example remains the stronger future option.

The token cache must be writable for MSAL refresh, so the container root filesystem is read-only while only `/var/lib/outlook-mail` is writable. The service has no host port, drops all Linux capabilities, enables `no-new-privileges`, and uses separate internal MCP and outbound networks.

## Recovery and revocation

- Re-run onboarding if consent expires or the cache is removed.
- To disconnect locally, stop the service and remove the sidecar-only token cache.
- Revoke the app from the Microsoft account privacy/security application-consent page, or delete the app registration.
- Rotate the client ID by registering a replacement public client app and onboarding again. A client ID is not a secret, but it must not be hard-coded into source.

## Sources

- Microsoft Graph mail permissions: https://learn.microsoft.com/graph/permissions-reference#mail-permissions
- List messages and body behavior: https://learn.microsoft.com/graph/api/user-list-messages
- Mail folders and the `junkemail` well-known folder: https://learn.microsoft.com/graph/api/resources/mailfolder
- MSAL Node device-code flow: https://learn.microsoft.com/entra/msal/javascript/node/acquire-token-requests#device-code-flow
