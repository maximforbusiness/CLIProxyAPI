#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/git-sync-upstream.sh [options]

Options:
  --main <branch>      Main branch name (default: main)
  --feature <branch>   Custom branch name (default: my-custom)
  --push-main          Push updated main branch to origin
  --push-feature       Push rebased feature branch to origin (uses --force-with-lease if branch exists remotely)
  --allow-dirty        Allow running with uncommitted changes (not recommended)
  -h, --help           Show help

Example:
  scripts/git-sync-upstream.sh --main main --feature my-custom --push-main --push-feature
EOF
}

main_branch="main"
feature_branch="my-custom"
push_main="false"
push_feature="false"
allow_dirty="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --main)
      main_branch="${2:-}"
      shift 2
      ;;
    --feature)
      feature_branch="${2:-}"
      shift 2
      ;;
    --push-main)
      push_main="true"
      shift
      ;;
    --push-feature)
      push_feature="true"
      shift
      ;;
    --allow-dirty)
      allow_dirty="true"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This directory is not a git repository." >&2
  exit 1
fi

if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "Remote 'upstream' is missing. Run setup first." >&2
  exit 1
fi

if [[ "$allow_dirty" != "true" ]]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Working tree has uncommitted changes. Commit/stash or rerun with --allow-dirty." >&2
    exit 1
  fi
fi

original_branch="$(git symbolic-ref --quiet --short HEAD || true)"

restore_branch() {
  if [[ -n "$original_branch" ]]; then
    git switch "$original_branch" >/dev/null 2>&1 || true
  fi
}

trap restore_branch EXIT

git fetch upstream --prune
git fetch origin --prune

if ! git show-ref --verify --quiet "refs/heads/$main_branch"; then
  echo "Local branch '$main_branch' not found." >&2
  exit 1
fi

if ! git show-ref --verify --quiet "refs/remotes/upstream/$main_branch"; then
  echo "Remote branch 'upstream/$main_branch' not found." >&2
  exit 1
fi

git switch "$main_branch"
git rebase "upstream/$main_branch"

if [[ "$push_main" == "true" ]]; then
  git push origin "$main_branch"
fi

if git show-ref --verify --quiet "refs/heads/$feature_branch"; then
  git switch "$feature_branch"
  git rebase "$main_branch"

  if [[ "$push_feature" == "true" ]]; then
    if git show-ref --verify --quiet "refs/remotes/origin/$feature_branch"; then
      git push --force-with-lease origin "$feature_branch"
    else
      git push -u origin "$feature_branch"
    fi
  fi
else
  echo "Feature branch '$feature_branch' does not exist locally, skipping."
fi

echo "Sync completed: upstream/$main_branch -> $main_branch -> $feature_branch"
