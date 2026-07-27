#!/usr/bin/env bash
set -Eeuo pipefail

REGISTRY="${NEXUS_NPM_REGISTRY:-https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus/repository/npm-hosted/}"
PACKAGE_FILE="${1:-}"
USE_EXISTING_AUTH="${NEXUS_USE_EXISTING_AUTH:-0}"
TEMP_NPMRC=""

cleanup() {
  if [[ -n "$TEMP_NPMRC" && -f "$TEMP_NPMRC" ]]; then
    rm -f -- "$TEMP_NPMRC"
  fi
  unset NEXUS_USERNAME NEXUS_PASSWORD NEXUS_NPM_AUTH AUTH
}
trap cleanup EXIT

fail() {
  printf '发布失败: %s\n' "$1" >&2
  exit 1
}

command -v npm >/dev/null 2>&1 || fail "未找到 npm，请先在服务器安装 Node.js/npm"

if [[ -z "$PACKAGE_FILE" ]]; then
  shopt -s nullglob
  packages=(./claude-code-best-*.tgz)
  shopt -u nullglob

  case "${#packages[@]}" in
    0) fail "当前目录没有 claude-code-best-*.tgz，请传入 tarball 路径" ;;
    1) PACKAGE_FILE="${packages[0]}" ;;
    *) fail "当前目录找到多个 tarball，请明确传入文件，例如: $0 ./claude-code-best-2.8.6.tgz" ;;
  esac
fi

[[ -f "$PACKAGE_FILE" ]] || fail "文件不存在: $PACKAGE_FILE"
[[ "$PACKAGE_FILE" == *.tgz ]] || fail "发布文件必须是 .tgz: $PACKAGE_FILE"

PACKAGE_FILE="$(cd "$(dirname "$PACKAGE_FILE")" && pwd)/$(basename "$PACKAGE_FILE")"

printf 'Registry: %s\n' "$REGISTRY"
printf 'Package:  %s\n' "$PACKAGE_FILE"
printf '\n'

if [[ "$USE_EXISTING_AUTH" != "1" ]]; then
  TEMP_NPMRC="$(mktemp "${TMPDIR:-/tmp}/nexus-npmrc.XXXXXX")"
  chmod 600 "$TEMP_NPMRC"

  if [[ -n "${NEXUS_NPM_AUTH:-}" ]]; then
    AUTH="$NEXUS_NPM_AUTH"
  else
    read -r -p 'Nexus username: ' NEXUS_USERNAME
    read -r -s -p 'Nexus password: ' NEXUS_PASSWORD
    printf '\n'
    [[ -n "$NEXUS_USERNAME" ]] || fail '用户名不能为空'
    AUTH="$(printf '%s:%s' "$NEXUS_USERNAME" "$NEXUS_PASSWORD" | base64 | tr -d '\n')"
  fi

  REGISTRY_KEY="${REGISTRY#https:}"
  REGISTRY_KEY="${REGISTRY_KEY#http:}"
  {
    printf '%s:_auth=%s\n' "$REGISTRY_KEY" "$AUTH"
    printf '%s:always-auth=true\n' "$REGISTRY_KEY"
  } > "$TEMP_NPMRC"
  NPM_CONFIG_USERCONFIG="$TEMP_NPMRC"
  export NPM_CONFIG_USERCONFIG
else
  printf '使用服务器已有 npm 认证配置\n'
fi

printf '\n验证 Nexus 认证...\n'
npm whoami --registry="$REGISTRY" >/dev/null \
  || fail '认证失败。请检查账号权限、认证配置或 Nexus npm hosted 路径'

printf '认证成功，开始发布...\n'
npm publish "$PACKAGE_FILE" --registry="$REGISTRY"
printf '\n发布完成。\n'
