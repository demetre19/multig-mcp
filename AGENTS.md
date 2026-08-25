# multig-mcp project DOX

## Purpose

`multig-mcp` is a local, source-distributed, read-only MCP server and setup CLI for one person to access multiple personal Gmail accounts from macOS. Gmail requests go directly from the local process to Google; the project operates no hosted service.

## Version-one scope

Version one includes:

- TypeScript and Node.js stdio MCP server.
- CLI account setup and management through `auth configure`, `auth add`, `auth list`, `auth remove`, and `auth reauthorize`.
- Direct Gmail API access with the Gmail read-only scope.
- macOS Keychain storage for OAuth client material and per-account refresh tokens.
- User-restricted local JSON metadata containing only non-secret account information.
- Read-only MCP tools for account listing, Gmail search, and message retrieval.
- Safety guidance that treats email content as untrusted data.

Version one does not include sending or modifying mail, drafts, attachment downloads, synchronization, polling, webhooks, hosted infrastructure, a web or desktop UI, multi-user support, a database, non-macOS credential stores, npm publishing, packaged binaries, telemetry, or services other than Gmail.

## Security and data boundaries

- Every Gmail data operation requires an explicit account alias. There is no default account or cross-account fallback.
- OAuth client material and refresh tokens stay in macOS Keychain. They must never appear in source, metadata, arguments, logs, tests, transcripts, MCP responses, or Git history.
- Local metadata stores no secrets, message bodies, or Gmail payloads.
- MCP protocol messages go to stdout only. Human-readable diagnostics go to stderr only; neither channel may expose credentials. Message content is returned only when explicitly requested through the message tool.
- Email headers and bodies are untrusted data. The server parses and returns requested data but never executes HTML, scripts, links, or instructions embedded in mail.
- Account isolation is enforced by exact alias resolution and credential selection in code, not only by tool descriptions.
- Real-account verification is owner-controlled. Do not place real credentials, personal Gmail addresses, message content, tokens, authorization codes, or retained personal-data evidence in prompts, fixtures, source, logs, or this public repository.

## Owned local paths

The foundation lane owns these paths:

- `PRD-Multig-MCP-2026-08-26.md` (approved PRD, included unchanged)
- `AGENTS.md`
- `package.json`
- `pnpm-lock.yaml`
- `tsconfig.json`
- `LICENSE`
- `.gitignore`
- `.github/workflows/ci.yml`
- `src/contracts.ts`

Other lanes own their declared source, tests, proofs, documentation, and release paths. Do not create files outside an assigned path without an updated orchestration contract.

## Dependency and package-manager safety

Use the pinned `pnpm` version declared in `package.json`. On the originating workstation, use `/Volumes/TheHoneyBadger/pnpm-store`; public instructions must remain portable. Install and update dependencies deterministically with lifecycle scripts disabled, review lockfile changes, inspect dependency sources and lifecycle scripts, and reject Git, tarball, exotic, or unexplained sources. Keep dependencies minimal and do not add a dependency when a Node-native facility is sufficient.

## Proof before integration

Novel external boundaries must be proven before dependent production work is integrated: macOS Keychain invocation, installed-app OAuth, MCP stdio stdout discipline, atomic metadata writes, and MIME normalization. Proof artifacts must be sanitized and contain no real account data or secrets.

## Focused verification

The foundation baseline is verified with:

```text
pnpm install --frozen-lockfile --ignore-scripts --store-dir /Volumes/TheHoneyBadger/pnpm-store
pnpm exec tsc --noEmit
pnpm test
pnpm build
```

Focused future checks are exposed as `test:auth`, `test:mcp`, `test:integration`, `proof:keychain`, `proof:mcp`, `proof:oauth`, `proof:metadata`, and `proof:mime`. Real-account checks are owner-controlled and are not run in CI.

## Durable contract updates

Update this file whenever the project purpose, version-one scope, security boundary, ownership, workflow, or durable cross-lane contract changes. Keep it public-safe and remove stale or contradictory rules immediately.
