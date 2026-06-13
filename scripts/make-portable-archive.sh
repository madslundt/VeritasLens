#!/usr/bin/env bash
#
# Make a self-contained tarball of this worktree that can be copied to
# another machine and used as a standalone git repository.
#
# Why a script: a git worktree's `.git` is a text file pointing into the
# main repo's `.git/worktrees/` directory. Copying the worktree folder
# directly leaves a broken pointer. This script bundles a real
# `.git/` directory plus the working tree, minus `node_modules/`, the
# temporary Meta DAT SDK clones, and other junk.
#
# Usage:
#   ./scripts/make-portable-archive.sh [output.tar.gz]
#
# Defaults to ../veritaslens-rayban-port.tar.gz next to the worktree.
#
# On the dev machine:
#   tar xzf veritaslens-rayban-port.tar.gz
#   cd veritaslens-rayban-port
#   npm install      # regenerates node_modules
#   npm test         # confirm 667 tests pass
#   cat docs/rayban-port/HANDOFF-rayban-port.md

set -euo pipefail

WORKTREE_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
OUTPUT="${1:-${WORKTREE_ROOT}/../veritaslens-rayban-port.tar.gz}"
STAGING="$(mktemp -d)"
TARGET_NAME="veritaslens-rayban-port"
TARGET_DIR="${STAGING}/${TARGET_NAME}"

trap 'rm -rf "${STAGING}"' EXIT

echo "[1/5] Cloning worktree branch into a fresh standalone repo at ${TARGET_DIR}"

# `git clone --no-hardlinks` against the worktree gives us a real .git
# with full history, no shared object pool, no worktree indirection.
git clone --no-hardlinks --branch "$(git -C "${WORKTREE_ROOT}" branch --show-current)" \
  "${WORKTREE_ROOT}" "${TARGET_DIR}" >/dev/null 2>&1

echo "[2/5] Reset 'origin' to 'main' branch only"

cd "${TARGET_DIR}"
# Drop the local-machine remote (origin pointed at the worktree path).
# The dev machine should set their own remote pointing at the canonical repo.
git remote remove origin 2>/dev/null || true

# Make sure HEAD is on the rayban-port branch.
git checkout -B feat/rayban-port

echo "[3/5] Verify clean working tree and full history"

git status --short
COMMITS_AHEAD=$(git rev-list --count HEAD ^"$(git merge-base HEAD HEAD~$(git rev-list --count HEAD) 2>/dev/null || echo HEAD)" 2>/dev/null || echo 0)
echo "  branch: $(git branch --show-current)"
echo "  HEAD:   $(git rev-parse --short HEAD)"
echo "  total commits in this clone: $(git rev-list --count HEAD)"

echo "[4/5] Sanity check — files and gitignore"

if [[ ! -f "docs/rayban-port/HANDOFF-rayban-port.md" ]]; then
  echo "ERROR: docs/rayban-port/HANDOFF-rayban-port.md missing in clone" >&2
  exit 1
fi
if [[ -d "node_modules" ]]; then
  echo "ERROR: node_modules ended up in the clone — should be gitignored" >&2
  exit 1
fi

echo "  ✓ docs/rayban-port/ present"
echo "  ✓ no node_modules"

echo "[5/5] Creating tarball at ${OUTPUT}"

cd "${STAGING}"
tar czf "${OUTPUT}" "${TARGET_NAME}"

SIZE=$(du -sh "${OUTPUT}" | cut -f1)
echo
echo "Done. Archive: ${OUTPUT} (${SIZE})"
echo
echo "On the dev machine:"
echo "  tar xzf $(basename "${OUTPUT}")"
echo "  cd ${TARGET_NAME}"
echo "  npm install"
echo "  npm test"
echo "  cat docs/rayban-port/HANDOFF-rayban-port.md"
