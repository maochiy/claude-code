#!/usr/bin/env bash
set -Eeuo pipefail

REGISTRY="${NEXUS_NPM_REGISTRY:-https://test-ai.xiujiadian.com/zhuxiangwei-macmini-nexus/repository/npm-hosted/}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_FILE="${1:-}"
USE_EXISTING_AUTH="${NEXUS_USE_EXISTING_AUTH:-0}"
PACK_CREATED=0
TEMP_NPMRC=""
PACKAGE_JSON_BACKUP=""

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
cd "$PROJECT_ROOT"

if [[ -z "$PACKAGE_FILE" ]]; then
  printf '重新执行 npm pack，使用当前 package.json 生成最新 tarball...\n'
  PACKAGE_JSON_BACKUP="$(mktemp "${TMPDIR:-/tmp}/package.json.XXXXXX")"
  cp -- package.json "$PACKAGE_JSON_BACKUP"
  node -e '
    const fs = require("node:fs")
    const path = "package.json"
    const pkg = JSON.parse(fs.readFileSync(path, "utf8"))
    delete pkg.scripts?.prepare
    fs.writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
  ' || fail '无法临时处理 package.json'
  PACKAGE_FILE="$(HUSKY=0 npm_config_ignore_scripts=true npm pack --ignore-scripts --json | node -e '
    let input = ""
    process.stdin.on("data", chunk => { input += chunk })
    process.stdin.on("end", () => {
      const result = JSON.parse(input)
      if (!Array.isArray(result) || !result[0]?.filename) process.exit(1)
      process.stdout.write(result[0].filename)
    })
  ')" || fail 'npm pack 失败或无法确定生成的 tarball 文件'
  mv -f -- "$PACKAGE_JSON_BACKUP" package.json
  PACKAGE_JSON_BACKUP=""
  PACK_CREATED=1
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

if [[ "$PACK_CREATED" == "1" ]]; then
  rm -f -- "$PACKAGE_FILE"
  printf '已清理自动生成的 tarball。\n'
fi

printf '\n发布完成。\n'
