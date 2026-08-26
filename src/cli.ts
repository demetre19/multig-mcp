import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { google } from "googleapis";
import { AccountManager, type AccountManagerOptions } from "./accounts/index.js";
import { normalizeAlias } from "./storage/config.js";
import { main as authMain } from "./cli/auth.js";
import type { AccountProvider } from "./mcp/session.js";
import { AccountProviderError } from "./mcp/session.js";
import { serve as serveMcp } from "./mcp/server.js";

const USAGE = `Usage:
  multig-mcp serve
  multig-mcp auth configure --credentials <path> [--replace]
  multig-mcp auth add --alias <alias>
  multig-mcp auth list
  multig-mcp auth remove --alias <alias>
  multig-mcp auth reauthorize --alias <alias>
`;

const HELP_OPTIONS: Record<string, true> = { help: true, h: true };

function writeUsage(): void {
  process.stdout.write(USAGE);
}

function writeUsageError(message: string): number {
  process.stderr.write(`multig-mcp: ${message}\n${USAGE}`);
  return 1;
}

function hasOnlyAllowedOptions(tokens: Array<{ kind: string; name?: string }> | undefined, allowed: Readonly<Record<string, true>>): boolean {
  return (tokens ?? []).every((token) => token.kind !== "option" || (token.name !== undefined && allowed[token.name] === true));
}

export function createAccountProvider(options: AccountManagerOptions = {}): AccountProvider {
  const manager = new AccountManager(options);
  return {
    listAccounts: () => manager.listAccounts(),
    async openSession(aliasInput: string) {
      let alias: string;
      try {
        alias = normalizeAlias(aliasInput);
      } catch {
        throw new AccountProviderError("unknown_account", "The selected account alias is not configured.", aliasInput);
      }
      if (alias !== aliasInput) {
        throw new AccountProviderError("unknown_account", "The selected account alias is not configured.", aliasInput);
      }
      const auth = await manager.getAccountSession(alias);
      return {
        alias,
        scopes: await manager.getAccountScopes(alias),
        gmailClient: google.gmail({ version: "v1", auth }),
      };
    },
  };
}

function authOptionsFor(command: string | undefined): Readonly<Record<string, true>> | undefined {
  switch (command) {
    case "configure":
      return { credentials: true, replace: true, ...HELP_OPTIONS };
    case "add":
    case "remove":
    case "reauthorize":
      return { alias: true, ...HELP_OPTIONS };
    case "list":
      return HELP_OPTIONS;
    default:
      return undefined;
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      options: {
        help: { type: "boolean", short: "h" },
        credentials: { type: "string" },
        alias: { type: "string" },
        replace: { type: "boolean" },
      },
      allowPositionals: true,
      strict: false,
      tokens: true,
    });
  } catch {
    return writeUsageError("invalid arguments");
  }

  const [command, subcommand] = parsed.positionals;
  if (command === undefined) {
    if (!hasOnlyAllowedOptions(parsed.tokens, HELP_OPTIONS)) {
      return writeUsageError("unknown command or arguments");
    }
    if (parsed.values.help === true) {
      writeUsage();
      return 0;
    }
    return writeUsageError("a command is required");
  }

  if (command === "serve") {
    if (parsed.positionals.length !== 1 || !hasOnlyAllowedOptions(parsed.tokens, HELP_OPTIONS)) {
      return writeUsageError("unknown command or arguments");
    }
    if (parsed.values.help === true) {
      writeUsage();
      return 0;
    }
    try {
      await serveMcp(createAccountProvider());
      return 0;
    } catch {
      process.stderr.write("multig-mcp: serve failed\n");
      return 1;
    }
  }

  if (command === "auth") {
    const allowed = authOptionsFor(subcommand);
    if (allowed === undefined || parsed.positionals.length !== 2 || !hasOnlyAllowedOptions(parsed.tokens, allowed)) {
      return writeUsageError("unknown command or arguments");
    }
    if (parsed.values.help === true) {
      writeUsage();
      return 0;
    }
    return authMain(args);
  }

  return writeUsageError("unknown command or arguments");
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const exitCode = await main();
  if (exitCode !== 0) process.exitCode = exitCode;
}


