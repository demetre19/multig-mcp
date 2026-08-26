import {
  addAccount,
  configureOAuthClient,
  listAuthAccounts,
  reauthorizeAccount,
  removeAccount,
  AuthLifecycleError,
  type ImportedOAuthClient,
} from "../auth/lifecycle.js";
import type { AccountSummary } from "../contracts.js";

export type AuthCommandIO = {
  writeLine: (line: string) => void;
  writeError: (line: string) => void;
};

export type AuthCommandOptions = {
  io?: AuthCommandIO;
  lifecycle?: Parameters<typeof configureOAuthClient>[1];
};

function defaultIO(): AuthCommandIO {
  return {
    writeLine: (line) => process.stdout.write(`${line}\n`),
    writeError: (line) => process.stderr.write(`${line}\n`),
  };
}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) throw new AuthLifecycleError(`missing_${name.slice(2).replaceAll("-", "_")}`);
  return value;
}

function hasOption(args: string[], name: string): boolean {
  return args.includes(name);
}

function printAccounts(accounts: AccountSummary[], io: AuthCommandIO): void {
  io.writeLine("alias\temail\tscopes\tstatus");
  for (const account of accounts) {
    io.writeLine(`${account.alias}\t${account.email}\t${account.scopes.join(",")}\t${account.status}`);
  }
}

export async function runAuthCommand(inputArgs: string[], options: AuthCommandOptions = {}): Promise<void> {
  const io = options.io ?? defaultIO();
  const args = inputArgs[0] === "auth" ? inputArgs.slice(1) : inputArgs;
  const command = args[0];
  if (command === undefined) throw new AuthLifecycleError("auth_command_required");
  const lifecycle = options.lifecycle;
  switch (command) {
    case "configure": {
      const credentialsPath = requiredOption(args, "--credentials");
      await configureOAuthClient(credentialsPath, { ...lifecycle, replace: hasOption(args, "--replace") });
      io.writeLine("OAuth client imported. The source credential file is no longer required and may be deleted securely.");
      return;
    }
    case "add": {
      const alias = requiredOption(args, "--alias");
      const result = await addAccount(alias, lifecycle);
      io.writeLine(`Account connected: ${alias} (${result.email}).`);
      return;
    }
    case "list": {
      printAccounts(await listAuthAccounts(lifecycle), io);
      return;
    }
    case "remove": {
      const alias = requiredOption(args, "--alias");
      await removeAccount(alias, lifecycle);
      io.writeLine(`Account removed locally: ${alias}. Google authorization was not revoked.`);
      return;
    }
    case "reauthorize": {
      const alias = requiredOption(args, "--alias");
      const before = await listAuthAccounts(lifecycle);
      const result = await reauthorizeAccount(alias, lifecycle);
      io.writeLine(`Account reauthorized: ${alias} (${result.email}).`);
      const normalizedAlias = alias.trim().toLowerCase();
      const prior = before.find((account) => account.alias === normalizedAlias);
      const addedScopes = result.scopes.filter((scope) => !(prior?.scopes.includes(scope) ?? false));
      if (addedScopes.length > 0) io.writeLine(`New scopes granted: ${addedScopes.join(", ")}.`);
      return;
    }
    default:
      throw new AuthLifecycleError("unknown_auth_command");
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  try {
    await runAuthCommand(args);
    return 0;
  } catch (error) {
    const io = defaultIO();
    if (error instanceof AuthLifecycleError) io.writeError(`auth error: ${error.code}`);
    else io.writeError("auth error: operation failed");
    return 1;
  }
}

export type { ImportedOAuthClient };
