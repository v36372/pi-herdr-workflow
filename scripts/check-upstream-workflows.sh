#!/usr/bin/env bash
set -euo pipefail

readonly upstream_url="https://github.com/osolmaz/pi-workflows.git"
readonly upstream_ref="b44db48ea789300fbc791289bb5a46b61f96177a"
readonly project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
checkout="${1:-}"
temporary_checkout=""

if [[ -z "$checkout" ]]; then
  temporary_checkout="$(mktemp -d "${TMPDIR:-/tmp}/pi-workflows-upstream.XXXXXX")"
  trap 'rm -rf "$temporary_checkout"' EXIT
  git clone --quiet "$upstream_url" "$temporary_checkout"
  git -C "$temporary_checkout" checkout --quiet "$upstream_ref"
  checkout="$temporary_checkout"
fi

actual_ref="$(git -C "$checkout" rev-parse HEAD)"
if [[ "$actual_ref" != "$upstream_ref" ]]; then
  printf 'expected upstream %s, found %s\n' "$upstream_ref" "$actual_ref" >&2
  exit 1
fi

exact_files=(
  artifacts.ts
  decision.ts
  definition.ts
  errors.ts
  graph.ts
  json.ts
  shell.ts
  text.ts
)

for file in "${exact_files[@]}"; do
  cmp "$project_root/src/workflows/$file" "$checkout/src/workflows/$file"
  printf 'exact %s\n' "$file"
done

printf '%s\n' 'Herdr graft files: engine.ts index.ts loader.ts schema.ts store.ts types.ts'
