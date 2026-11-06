#!/usr/bin/env bash
# Cuts a release from main: bumps package.json and package-lock.json, pushes
# that commit, then pushes the v<version> tag that release.yml publishes.
set -euo pipefail

bump=${1:-}
case "$bump" in
	major | minor | patch) ;;
	*)
		echo "usage: npm run release -- <major|minor|patch>" >&2
		exit 2
		;;
esac

cd "$(git rev-parse --show-toplevel)"

branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$branch" != main ]; then
	echo "releases are cut from main, not from $branch" >&2
	exit 1
fi

if [ -n "$(git status --porcelain -- package.json package-lock.json)" ]; then
	echo "package.json or package-lock.json has uncommitted changes" >&2
	exit 1
fi

git fetch --quiet origin main
if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]; then
	echo "main is not in sync with origin/main; pull or push first" >&2
	exit 1
fi

tag=$(npm version "$bump" -m 'release: v%s')
git push origin main
git push origin "$tag"
echo "pushed $tag; release.yml stages it on npm"
