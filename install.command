#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h}"
ARCHIVE="$ROOT/multig-mcp-0.1.0.tgz"
APP="$HOME/Library/Application Support/multig-mcp/app"
BIN="$HOME/.local/bin/multig-mcp"
SKILLS="$HOME/.omp/agent/custom-skills"

[[ "$(uname -s)" == "Darwin" ]] || { echo "Multi G currently requires macOS."; exit 1; }
[[ "$(uname -m)" == "arm64" ]] || { echo "This release contains an Apple Silicon native helper."; exit 1; }
command -v node >/dev/null || { echo "Install Node.js 24 first: https://nodejs.org/en/download"; exit 1; }
command -v pnpm >/dev/null || { echo "Install pnpm first: https://pnpm.io/installation"; exit 1; }
[[ -f "$ARCHIVE" ]] || { echo "Missing $ARCHIVE"; exit 1; }

mkdir -p "$APP" "$HOME/.local/bin" "$SKILLS"
cd "$APP"
[[ -f package.json ]] || printf '{"private":true}\n' > package.json
pnpm add "$ARCHIVE" --save-exact --ignore-scripts

cat > "$BIN" <<EOF
#!/bin/zsh
exec node "$APP/node_modules/multig-mcp/dist/cli.js" "\$@"
EOF
chmod 700 "$BIN"
rm -rf "$SKILLS/multig-mcp"
cp -R "$APP/node_modules/multig-mcp/skill/multig-mcp" "$SKILLS/multig-mcp"

"$BIN" --help >/dev/null
cat <<EOF

Multi G installed.

Command:
  $BIN

Next:
  1. Follow the Google Cloud steps in README.md.
  2. Import the downloaded OAuth JSON:
     "$BIN" auth configure --credentials ~/Downloads/client_secret.json
  3. Add accounts:
     "$BIN" auth add --alias personal
     "$BIN" auth add --alias work
  4. Configure your MCP client to run:
     command: $BIN
     args:    serve

Start a new OMP session to load the installed multig-mcp skill.
EOF
