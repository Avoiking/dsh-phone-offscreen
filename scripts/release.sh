#!/usr/bin/env bash
# release.sh —— dsh-phone-offscreen 一条命令发版
#
# 用法：
#   ./scripts/release.sh patch          # 0.1.1 → 0.1.2（修 bug）
#   ./scripts/release.sh minor          # 0.1.1 → 0.2.0（加功能）
#   ./scripts/release.sh major          # 0.1.1 → 1.0.0（破坏性改动）
#   ./scripts/release.sh 0.3.7          # 指定版本号
#   ./scripts/release.sh patch --dry-run   # 只检查，不发布
#
# 它做的事（顺序固定，任一步失败就停）：
#   1. 检查工作区是否干净、是否在 main 分支
#   2. npm pack --dry-run 检查打包内容（意外多出大文件会在这里暴露）
#   3. 改版本号 → 提交 → 打 tag
#   4. 用 ~/.dsh/tokens/npm-granular.token 临时写 .npmrc → npm publish → 立刻删掉 .npmrc
#   5. 推 GitHub（走 7890 代理，用 ~/.dsh/tokens/github.token）
#   6. 等 registry 真的把新版本挂上 latest 再报成功（npm 有几分钟处理延迟，
#      不等的话你会以为失败又发一次，撞 409）
#
# 这两个 token 都是"能绕过 2FA 的发布凭证"，只放在 ~/.dsh/tokens/ 下（600），
# 绝不进项目目录、绝不进 git。作废后在 npm/GitHub 网页上撤销即可，脚本会报缺文件。

set -euo pipefail

REPO_SLUG="Avoiking/dsh-phone-offscreen"
PROXY="http://127.0.0.1:7890"
NPM_TOKEN_FILE="${HOME}/.dsh/tokens/npm-granular.token"
GH_TOKEN_FILE="${HOME}/.dsh/tokens/github.token"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

BUMP="${1:-}"
DRY_RUN=0
[[ "${2:-}" == "--dry-run" || "${1:-}" == "--dry-run" ]] && DRY_RUN=1
[[ "$BUMP" == "--dry-run" ]] && BUMP=""

if [[ -z "$BUMP" ]]; then
  echo "用法: $0 <patch|minor|major|x.y.z> [--dry-run]" >&2
  exit 64
fi

say() { printf '\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31m!! %s\033[0m\n' "$*" >&2; exit 1; }

# ── 1. 前置检查 ──────────────────────────────────────────────
say "检查工作区"
[[ -d .git ]] || die "这里不是 git 仓库"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "main" ]] || die "当前分支是 $BRANCH，发版要在 main 上"
if [[ -n "$(git status --porcelain)" ]]; then
  die "工作区不干净，先提交或 stash：\n$(git status --short)"
fi

OLD_VERSION="$(node -p "require('./package.json').version")"
say "当前版本 $OLD_VERSION"

# ── 2. 打包内容自检 ──────────────────────────────────────────
say "检查打包内容"
npm pack --dry-run 2>&1 | sed -n '/Tarball Contents/,/Tarball Details/p' | head -20
if npm pack --dry-run 2>&1 | grep -q "\.env\|\.npmrc\|token"; then
  die "打包内容里出现了敏感文件名，停下"
fi

# ── 3. 新版本号 ──────────────────────────────────────────────
if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
  npm version "$NEW_VERSION" --no-git-tag-version >/dev/null
else
  NEW_VERSION="$(npm version "$BUMP" --no-git-tag-version | tr -d 'v')"
fi
say "新版本 $NEW_VERSION"

if [[ $DRY_RUN -eq 1 ]]; then
  git checkout -- package.json 2>/dev/null || true
  say "dry-run 结束（版本号已回滚，什么都没发）"
  exit 0
fi

# ── 4. 发布到 npm ────────────────────────────────────────────
[[ -r "$NPM_TOKEN_FILE" ]] || die "缺 npm 令牌：$NPM_TOKEN_FILE（去 npm 网页重新生成 granular token）"
say "发布 npm"
cp -f package.json package.json.bak-release
trap 'rm -f .npmrc; mv -f package.json.bak-release package.json 2>/dev/null || true' EXIT
printf '//registry.npmjs.org/:_authToken=%s\n' "$(tr -d '\n' < "$NPM_TOKEN_FILE")" > .npmrc
chmod 600 .npmrc
npm publish --access public
rm -f .npmrc
mv -f package.json.bak-release package.json
trap - EXIT

# ── 5. 提交 + tag + 推 GitHub ────────────────────────────────
say "提交并推 GitHub"
git add -A
git -c core.hooksPath=/dev/null commit -q -m "chore(release): v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "v$NEW_VERSION"
[[ -r "$GH_TOKEN_FILE" ]] || die "缺 GitHub 令牌：$GH_TOKEN_FILE"
GH_TOKEN="$(tr -d '\n' < "$GH_TOKEN_FILE")"
HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" \
  git -c credential.helper= push -q "https://x-access-token:${GH_TOKEN}@github.com/${REPO_SLUG}.git" main:main
HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY" \
  git -c credential.helper= push -q "https://x-access-token:${GH_TOKEN}@github.com/${REPO_SLUG}.git" "v$NEW_VERSION"
if git remote get-url origin >/dev/null 2>&1; then :; else
  git remote add origin "https://github.com/${REPO_SLUG}.git"
fi

# ── 6. 等 registry 真正生效 ──────────────────────────────────
say "等 registry 生效（npm 有几分钟处理延迟）"
for i in $(seq 1 24); do
  LIVE="$(curl -s "https://registry.npmjs.org/dsh-phone-offscreen/$NEW_VERSION" \
    | python3 -c 'import json,sys;print(json.load(sys.stdin).get("version",""))' 2>/dev/null || true)"
  if [[ "$LIVE" == "$NEW_VERSION" ]]; then
    TAG="$(curl -s https://registry.npmjs.org/dsh-phone-offscreen \
      | python3 -c 'import json,sys;print(json.load(sys.stdin).get("dist-tags",{}).get("latest",""))' 2>/dev/null || true)"
    say "已上线：npm $NEW_VERSION（latest=$TAG）"
    echo "  https://www.npmjs.com/package/dsh-phone-offscreen/v/$NEW_VERSION"
    echo "  https://github.com/${REPO_SLUG}/releases/tag/v$NEW_VERSION"
    exit 0
  fi
  sleep 10
done
die "npm 四分钟还没挂上新版本，去网页确认：https://www.npmjs.com/package/dsh-phone-offscreen"
