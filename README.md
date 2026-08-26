# multig-mcp

`multig-mcp` is a local, read-only Model Context Protocol (MCP) server for one person who uses more than one Gmail account. Each account is connected once and assigned an alias such as `personal` or `side-project`. An MCP client can then list accounts, search one selected account, and retrieve one selected message.

The process runs on macOS, sends Gmail requests directly to Google, and does not provide a hosted connector or multi-user service. Gmail content returned to an MCP client is still available to that client and its configured model provider; local credential storage does not guarantee local-only model inference.

## Requirements

- macOS with access to the user Keychain
- Node.js 24.x LTS (`>=24 <25`)
- pnpm 11.8.0, the version pinned by this repository
- A Google account that can create or use a Google Cloud project and an MCP-compatible client that can launch a local stdio process

This project is source-distributed and macOS-only in version one. It does not support Windows or Linux credential stores.

## Install and build

From a clean clone:

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm run build
pnpm run build:keychain
```

`--ignore-scripts` prevents dependency lifecycle scripts from running during installation. The native Keychain helper is compiled separately by `build:keychain` and is placed in `dist/native/`.

The command above uses pnpm's normal user-owned store. Development on the originating workstation uses `/Volumes/TheHoneyBadger/pnpm-store`; other users should substitute an equivalent local store path rather than depending on that path:

```bash
pnpm install --frozen-lockfile --ignore-scripts --store-dir /path/to/pnpm-store
```

The build creates `dist/cli.js`. Use `node dist/cli.js` below if your shell does not expose the package binary through pnpm.

## Google Cloud setup

Create credentials in a Google Cloud project owned or controlled by you:

1. Create or select a Google Cloud project.
2. Enable **Gmail API** for that project.
3. Configure **OAuth consent screen** as an **External** app. Fill in the app name, support email, and developer contact information required by Google.
4. Add the Gmail read-only scope, `https://www.googleapis.com/auth/gmail.readonly`.
5. While the app is in **Testing**, add every Gmail account you will connect as a test user.
6. Create an OAuth client under **Credentials**, choose **Desktop app**, and download the JSON file.

The downloaded JSON is input to the local import command only. `multig-mcp` stores the minimum client material in macOS Keychain and does not copy the source JSON into its configuration. After a successful import, the downloaded source file is no longer required by `multig-mcp`; delete it securely when you no longer need it.

### Google publication and testing limits

Google currently classifies `gmail.readonly` as a **restricted** scope. An External app in **Testing** is limited to allowlisted test users (maximum 100) and Gmail-scope refresh tokens expire after seven days. Personal-use exemptions may avoid mandatory verification in applicable cases, but unverified-app warnings and applicable limits still apply. Moving to **In production** removes the Testing-only seven-day rule, but unverified restricted-scope warnings and limits still apply; public use beyond an applicable exemption requires the relevant Google verification.

Do not promise indefinite refresh-token lifetime. Reauthorization may also be needed after user revocation, six months of non-use, a password change affecting Gmail scopes, token-count eviction, time-limited access, or administrator policy changes. Check Google's current OAuth and Gmail-scope guidance before publishing or changing the app's status.

## Connect and manage accounts

Import the desktop client once:

```bash
pnpm multig-mcp auth configure --credentials ~/Downloads/client_secret.json
```

To intentionally replace an already imported client, add `--replace`:

```bash
pnpm multig-mcp auth configure --credentials ~/Downloads/client_secret.json --replace
```

Connect accounts with unique aliases. The command opens the system browser for Google's authorization flow:

```bash
pnpm multig-mcp auth add --alias personal
pnpm multig-mcp auth add --alias side-project
```

List aliases, Gmail addresses, granted scopes, and connection status without displaying credentials:

```bash
pnpm multig-mcp auth list
```

Remove one account's local metadata and refresh token:

```bash
pnpm multig-mcp auth remove --alias personal
```

Local removal does **not** revoke the Google authorization. Version one has no implicit Google revocation operation.

Reauthorize one alias without changing another:

```bash
pnpm multig-mcp auth reauthorize --alias personal
```

Every Gmail search or retrieval operation must name an explicit alias. There is no default-account or cross-account fallback.

## Configure an MCP client

The following is a **generic illustrative client-configuration example**, not a universal MCP configuration file format. MCP does not define one universal host configuration file. Replace both absolute paths with paths on your machine, and consult the current documentation for your MCP client before using this configuration:

```json
{
  "mcpServers": {
    "multig-mcp": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/multig-mcp/dist/cli.js",
        "serve"
      ]
    }
  }
}
```

Some clients can launch an executable built entry point directly; use that form only when the client supports it and the entry point is executable. The `serve` process uses stdin/stdout for newline-delimited MCP JSON-RPC only. Diagnostics are sent to stderr.

## How it works

```text
MCP client
   │ newline-delimited JSON-RPC over stdio
   ▼
dist/cli.js serve
   │ explicit alias → local metadata + macOS Keychain refresh token
   ▼
Google OAuth client + Gmail API
   │ direct request for the selected account
   ▼
Gmail
```

`gmail_accounts` reads local account metadata. `gmail_search` makes one bounded list request and fetches compact metadata for the selected message IDs. `gmail_get_message` retrieves and safely normalizes one full message; attachment bodies are never downloaded. Email headers, bodies, and metadata are untrusted data and are returned as data, never executed as instructions.

## Privacy and safety boundaries

- OAuth client material and refresh tokens remain in macOS Keychain; they are not command-line arguments, environment variables, repository files, metadata, MCP responses, or logs.
- Local metadata contains aliases, authorized addresses, scopes, status inputs, and Keychain record references—not tokens or message content.
- Gmail operations require an explicit alias and never fall back to another account.
- Gmail access is read-only. Version one does not send mail, download attachments, create drafts, or modify Gmail.
- The MCP client and its configured model provider may receive returned Gmail content. Treat email as untrusted input and do not follow instructions found in it.

## Troubleshooting and cleanup

- `oauth_client_not_configured`: run `auth configure` with a valid Google Desktop OAuth JSON file.
- `reauthorization_required`: run `auth reauthorize --alias <alias>` and complete Google's flow. Testing refresh-token expiry and the other Google causes listed above can require this.
- `invalid_local_configuration`: check that the application configuration and Keychain records have not been manually altered, then reconfigure or reconnect the affected alias.
- A consent-screen warning or `access_denied` response usually means the account is not an allowed test user, the app's Google status has changed, or the requested restricted scope needs the applicable Google review.
- If an MCP client reports a launch failure, verify that Node and `dist/cli.js` are absolute paths, that both build steps completed, and that the client is configured to start `serve`.

To remove an account, use `auth remove`; this removes the local alias and its refresh token but does not revoke Google authorization. To fully clean up this installation, remove any remaining local configuration under the documented macOS Application Support location and remove the `multig-mcp.v1` records from macOS Keychain using Keychain Access. Remove the Google Cloud OAuth client separately if it is no longer needed. These cleanup actions are local or project-level actions and do not by themselves revoke every Google grant.

## Development checks

```bash
pnpm exec tsc --noEmit
pnpm test
pnpm test:integration
pnpm run build
pnpm run build:keychain
```

Do not put real Gmail addresses, message content, authorization codes, client secrets, or refresh tokens in source, fixtures, logs, transcripts, or bug reports.
