# Security policy

## Supported version

The supported release line is `multig-mcp` 0.1.x running on macOS with Node.js 24.x LTS (`>=24 <25`) and the dependency versions pinned by `pnpm-lock.yaml`. Report security issues against the latest source on the supported release line.

## Reporting a vulnerability

Please use the repository's private GitHub Security Advisory flow (**Security** → **Report a vulnerability**) rather than opening a public issue. Include the affected version or commit, the smallest safe reproduction, impact, and any suggested mitigation. Do not include passwords, OAuth client secrets, refresh tokens, authorization codes, real Gmail message content, or personal account addresses in a report.

Maintainers will acknowledge a private report within seven calendar days, keep the reporter informed while the issue is assessed, and agree on a coordinated disclosure date after a fix or mitigation is available. Do not publicly disclose exploitable details before that coordination is complete.

## Scope

In scope is the code and release material in this repository, including the CLI, MCP stdio boundary, Gmail integration, local metadata handling, macOS Keychain integration, tests, and documentation when it creates a security-relevant behavior.

Out of scope:

- Google's or Gmail's own services, APIs, OAuth policy, account security, or availability
- Vulnerabilities caused solely by a user's Google Cloud, OAuth consent-screen, MCP-client, operating-system, or Keychain misconfiguration
- A user's chosen MCP client or model provider's handling, retention, or processing of Gmail content after the server returns it
- Feature requests, unsupported operating systems, and expected Google consent-screen warnings

## Credential handling

OAuth client material and Gmail refresh tokens are stored in namespaced macOS Keychain records. The local JSON metadata stores only non-secret account metadata and Keychain record references. The CLI does not put secrets in argv, and the Keychain helper receives secret bytes through standard input rather than command-line arguments. MCP stdout is reserved for protocol messages; diagnostics are written to stderr and must not contain credentials or personal Gmail data.

Gmail access is restricted to the read-only scope in version one. Account aliases are resolved explicitly and are never allowed to fall back to another account. Email content is untrusted data and is not executed as instructions.
