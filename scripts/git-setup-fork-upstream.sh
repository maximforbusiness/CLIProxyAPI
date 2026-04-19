#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/git-setup-fork-upstream.sh --origin <fork-url> --upstream <upstream-url> [options]

Options:
  --main <branch>      Main branch name (default: main)
  --feature <branch>   Custom branch name (default: my-custom)
  -h, --help           Show help

Example:
  scripts/git-setup-fork-upstream.sh \
    --origin git@github.com:YOUR_USER/CLIProxyAPI.git \
    --upstream git@github.com:router-for-me/CLIProxyAPI.git \
    --main main \
    --feature my-custom
EOF
}

origin_url=""
upstream_url=""
main_branch="main"
feature_branch="my-custom"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --origin)
      origin_url="${2:-}"
      shift 2
      ;;
    --upstream)
      upstream_url="${2:-}"
      shift 2
      ;;
    --main)
      main_branch="${2:-}"
      shift 2
      ;;
    --feature)
      feature_branch="${2:-}"
      shift 2
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

if [[ -z "$origin_url" || -z "$upstream_url" ]]; then
  echo "Both --origin and --upstream are required." >&2
  usage
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "This directory is not a git repository. Run this script from your cloned repository root." >&2
  exit 1
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$origin_url"
else
  git remote add origin "$origin_url"
fi

if git remote get-url upstream >/dev/null 2>&1; then
  git remote set-url upstream "$upstream_url"
else
  git remote add upstream "$upstream_url"
fi

git fetch origin --prune
git fetch upstream --prune

if ! git show-ref --verify --quiet "refs/heads/$main_branch"; then
  if git show-ref --verify --quiet "refs/remotes/origin/$main_branch"; then
    git branch "$main_branch" "origin/$main_branch"
  elif git show-ref --verify --quiet "refs/remotes/upstream/$main_branch"; then
    git branch "$main_branch" "upstream/$main_branch"
  else
    echo "Main branch '$main_branch' not found in origin or upstream." >&2
    exit 1
  fi
fi

if ! git show-ref --verify --quiet "refs/heads/$feature_branch"; then
  git branch "$feature_branch" "$main_branch"
fi

git config pull.rebase true
git config rebase.autoStash true
git config fetch.prune true
git config "branch.$main_branch.remote" origin
git config "branch.$main_branch.merge" "refs/heads/$main_branch"

echo "Setup completed."
echo "Remotes:"
git remote -v
echo
echo "Branches:"
git branch --list "$main_branch" "$feature_branch"
echo
echo "Next steps:"
echo "  git switch $main_branch && git pull --rebase upstream $main_branch"
echo "  git switch $feature_branch && git rebase $main_branch"
