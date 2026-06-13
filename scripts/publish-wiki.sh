#!/usr/bin/env bash
set -euo pipefail

REPO="${1:-KablewyAI/kablewy-cli}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WIKI_SOURCE="$ROOT/wiki"
WORKDIR="$(mktemp -d)"

if [[ ! -d "$WIKI_SOURCE" ]]; then
  echo "wiki source directory not found: $WIKI_SOURCE" >&2
  exit 2
fi

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

if ! git clone "https://github.com/${REPO}.wiki.git" "$WORKDIR/wiki"; then
  mkdir -p "$WORKDIR/wiki"
  cd "$WORKDIR/wiki"
  git init
  git branch -M master
  git remote add origin "https://github.com/${REPO}.wiki.git"
fi
rsync -a --delete --exclude .git "$WIKI_SOURCE"/ "$WORKDIR/wiki"/

cd "$WORKDIR/wiki"
git add .
if git diff --cached --quiet; then
  echo "wiki is already up to date"
  exit 0
fi

git commit -m "docs: update CLI wiki"
git push origin master
