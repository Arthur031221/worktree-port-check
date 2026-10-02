#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
scratch_root="${TMPDIR:-.}"
scratch_root="$(cd "$scratch_root" && pwd -P)"
demo_root="$(mktemp -d "$scratch_root/worktree-port-check.XXXXXX")"
main_checkout="$demo_root/main"
preview_checkout="$demo_root/preview"
server_pid=""

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  if [ -d "$main_checkout" ]; then
    git -C "$main_checkout" worktree remove --force "$preview_checkout" >/dev/null 2>&1 || true
  fi
  node -e 'require("node:fs").rmSync(process.argv[1], { recursive: true, force: true })' "$demo_root"
}
trap cleanup EXIT INT TERM

mkdir -p "$main_checkout"
git -C "$main_checkout" init -q
git -C "$main_checkout" checkout -q -b main
git -C "$main_checkout" config user.name "Demo User"
git -C "$main_checkout" config user.email "demo@example.invalid"
printf 'console.log("preview")\n' > "$main_checkout/server.js"
git -C "$main_checkout" add server.js
git -C "$main_checkout" commit -qm "Add preview fixture"
git -C "$main_checkout" worktree add -q -b preview "$preview_checkout"

port_file="$demo_root/port"
cd "$preview_checkout"
node -e 'const http = require("node:http"); const server = http.createServer((req, res) => res.end("preview")); server.listen(0, "127.0.0.1", () => console.log(server.address().port));' > "$port_file" 2>&1 &
server_pid="$!"

for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if [ -s "$port_file" ]; then break; fi
  sleep 0.1
done
if [ ! -s "$port_file" ]; then
  printf 'The demo server did not start.\n' >&2
  exit 1
fi
port="$(head -n 1 "$port_file")"
printf ' > worktree-port-check %s\n' "$port"

cd "$main_checkout"
set +e
output="$(node "$project_root/bin-worktree-port-check.js" "$port" 2>&1)"
status="$?"
set -e
printf '%s\n' "$output"
if [ "$status" -eq 1 ] && [[ "$output" == *"result: OTHER_WORKTREE"* ]]; then
  exit 0
fi
printf 'The comparison returned exit code %s.\n' "$status" >&2
exit 1
