#!/usr/bin/env bash
# +-------------------------------------------------------------------------
#
#   地理智能平台 - Linux Desktop 生产运行时清单安装器
#
#   文件:       install-desktop-runtime-manifest.sh
#
#   日期:       2026年07月29日
#   作者:       JamesLinYJ
#   协助:       OpenAI Codex:GPT-5.6 Sol
# --------------------------------------------------------------------------

set -euo pipefail

project_root=''
service_user='geo_platform'
operators_group='geo-agent-platform-ops'
runtime_root='/var/lib/geo-agent-platform/runtime'
api_base_url='http://127.0.0.1:8000'
supervisor_token_file=''
service_environment_file='/etc/geo-agent-platform/geo-agent-platform.env'
preserve_token='false'
declare -a allowed_overrides=()

while (($# > 0)); do
  case "$1" in
    --project-root) project_root="${2:-}"; shift 2 ;;
    --service-user) service_user="${2:-}"; shift 2 ;;
    --operators-group) operators_group="${2:-}"; shift 2 ;;
    --runtime-root) runtime_root="${2:-}"; shift 2 ;;
    --api-base-url) api_base_url="${2:-}"; shift 2 ;;
    --supervisor-token-file) supervisor_token_file="${2:-}"; shift 2 ;;
    --service-environment-file) service_environment_file="${2:-}"; shift 2 ;;
    --allow-environment-override) allowed_overrides+=("${2:-}"); shift 2 ;;
    --preserve-existing-supervisor-token) preserve_token='true'; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if ((EUID != 0)); then
  echo '安装受保护的 Desktop runtime manifest 需要 root 权限。' >&2
  exit 1
fi
for command_name in node realpath install stat id getent; do
  command -v "$command_name" >/dev/null || {
    echo "缺少安装依赖命令：$command_name" >&2
    exit 1
  }
done
[[ -n "$project_root" ]] || { echo '缺少 --project-root。' >&2; exit 2; }
id "$service_user" >/dev/null 2>&1 || { echo "服务账户不存在：$service_user" >&2; exit 1; }
getent group "$operators_group" >/dev/null || { echo "运维组不存在：$operators_group" >&2; exit 1; }

require_absolute_path() {
  local value="$1"
  local name="$2"
  [[ "$value" == /* ]] || { echo "$name 必须是绝对路径。" >&2; exit 1; }
}

assert_no_links() {
  local candidate="$1"
  local current="$candidate"
  while [[ "$current" != '/' ]]; do
    [[ ! -L "$current" ]] || {
      echo "路径不能经过符号链接：$current" >&2
      exit 1
    }
    current="$(dirname -- "$current")"
  done
}

require_absolute_path "$project_root" 'projectRoot'
require_absolute_path "$runtime_root" 'runtimeRoot'
require_absolute_path "$service_environment_file" 'serviceEnvironmentFile'
project_root="$(realpath -e -- "$project_root")"
runtime_root="$(realpath -m -- "$runtime_root")"
service_environment_file="$(realpath -m -- "$service_environment_file")"
[[ "$project_root" != '/' && -d "$project_root" ]] || {
  echo 'projectRoot 必须是非根普通目录。' >&2
  exit 1
}
assert_no_links "$project_root"

config_root='/etc/geo-agent-platform'
manifest_path="$config_root/runtime-manifest.v1.json"
[[ "$service_environment_file" == "$config_root/"* ]] || {
  echo 'serviceEnvironmentFile 必须位于 /etc/geo-agent-platform 内。' >&2
  exit 1
}
[[ -f "$service_environment_file" && ! -L "$service_environment_file" ]] || {
  echo 'serviceEnvironmentFile 必须是已存在的普通文件。' >&2
  exit 1
}
[[ "$(stat -c '%h' -- "$service_environment_file")" == '1' ]] || {
  echo 'serviceEnvironmentFile 不能是 hard link。' >&2
  exit 1
}

if [[ -z "$supervisor_token_file" ]]; then
  supervisor_token_file="$runtime_root/secrets/supervisor.token"
fi
require_absolute_path "$supervisor_token_file" 'supervisorTokenFile'
supervisor_token_file="$(realpath -m -- "$supervisor_token_file")"
[[ "$supervisor_token_file" == "$runtime_root/"* ]] || {
  echo 'supervisorTokenFile 必须位于 runtimeRoot 内部。' >&2
  exit 1
}
token_directory="$(dirname -- "$supervisor_token_file")"
[[ "$token_directory" != "$runtime_root" ]] || {
  echo 'supervisorTokenFile 必须位于 runtimeRoot 下的独立受保护目录中。' >&2
  exit 1
}
assert_no_links "$runtime_root"
assert_no_links "$token_directory"

declare -A seen_overrides=()
for override in "${allowed_overrides[@]}"; do
  case "$override" in
    GEO_AGENT_PLATFORM_ROOT|RUNTIME_ROOT|APP_BASE_URL|GEO_AGENT_PLATFORM_SUPERVISOR_TOKEN_FILE) ;;
    *) echo "未知受控环境变量覆盖：$override" >&2; exit 1 ;;
  esac
  [[ -z "${seen_overrides[$override]+present}" ]] || {
    echo "重复受控环境变量覆盖：$override" >&2
    exit 1
  }
  seen_overrides["$override"]=1
done

api_base_url="$(
  API_BASE_URL="$api_base_url" node -e '
    const url = new URL(process.env.API_BASE_URL);
    if (!["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== "/" && url.pathname !== "")) {
      throw new Error("apiBaseUrl 必须是 HTTP/HTTPS 源站根地址");
    }
    process.stdout.write(url.origin);
  '
)"

validator="$(dirname -- "${BASH_SOURCE[0]}")/validate-production-environment.mjs"
[[ -f "$validator" && ! -L "$validator" ]] || {
  echo '缺少生产监督器环境校验器。' >&2
  exit 1
}
node "$validator" \
  --file "$service_environment_file" \
  --project-root "$project_root" \
  --runtime-root "$runtime_root" \
  --supervisor-token-file "$supervisor_token_file" \
  --api-base-url "$api_base_url"

install -d -o root -g "$operators_group" -m 0750 "$config_root"
install -d -o "$service_user" -g "$operators_group" -m 0750 "$runtime_root"
install -d -o root -g "$operators_group" -m 0750 "$token_directory"
assert_no_links "$config_root"
assert_no_links "$runtime_root"
assert_no_links "$token_directory"
chown root:root "$service_environment_file"
chmod 0600 "$service_environment_file"

temporary_token=''
temporary_manifest=''
trap 'rm -f -- "${temporary_token:-}" "${temporary_manifest:-}"' EXIT
if [[ "$preserve_token" == 'true' && -e "$supervisor_token_file" ]]; then
  [[ -f "$supervisor_token_file" && ! -L "$supervisor_token_file" ]] || {
    echo '显式保留的 Supervisor token 必须是普通文件。' >&2
    exit 1
  }
  [[ "$(stat -c '%h' -- "$supervisor_token_file")" == '1' ]] || {
    echo '显式保留的 Supervisor token 不能是 hard link。' >&2
    exit 1
  }
  existing_token="$(tr -d '\r\n' <"$supervisor_token_file")"
  [[ "$existing_token" =~ ^[A-Za-z0-9_-]{43}$ ]] || {
    echo '显式保留的 Supervisor token 必须是 256 位 base64url 值。' >&2
    exit 1
  }
else
  temporary_token="$(mktemp "$token_directory/.supervisor-token.XXXXXX")"
  node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url") + "\n")' \
    >"$temporary_token"
  chown root:"$operators_group" "$temporary_token"
  chmod 0640 "$temporary_token"
  mv -fT -- "$temporary_token" "$supervisor_token_file"
  temporary_token=''
fi
chown root:"$operators_group" "$supervisor_token_file"
chmod 0640 "$supervisor_token_file"

overrides_json="$(
  printf '%s\n' "${allowed_overrides[@]}" \
    | node -e '
      let source = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => { source += chunk; });
      process.stdin.on("end", () => {
        process.stdout.write(JSON.stringify(source.split(/\r?\n/u).filter(Boolean)));
      });
    '
)"
temporary_manifest="$(mktemp "$config_root/.runtime-manifest.XXXXXX")"
PROJECT_ROOT="$project_root" \
RUNTIME_ROOT="$runtime_root" \
API_BASE_URL="$api_base_url" \
SUPERVISOR_TOKEN_FILE="$supervisor_token_file" \
ALLOWED_OVERRIDES_JSON="$overrides_json" \
MANIFEST_PATH="$temporary_manifest" \
node -e '
  const fs = require("node:fs");
  const manifest = {
    kind: "geo-agent-platform.desktop-runtime",
    schemaVersion: 1,
    projectRoot: process.env.PROJECT_ROOT,
    runtimeRoot: process.env.RUNTIME_ROOT,
    apiBaseUrl: process.env.API_BASE_URL,
    supervisorTokenFile: process.env.SUPERVISOR_TOKEN_FILE,
    allowedEnvironmentOverrides: JSON.parse(process.env.ALLOWED_OVERRIDES_JSON),
  };
  fs.writeFileSync(process.env.MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
'
chown root:"$operators_group" "$temporary_manifest"
chmod 0640 "$temporary_manifest"
mv -fT -- "$temporary_manifest" "$manifest_path"
temporary_manifest=''

echo "Desktop runtime manifest：$manifest_path"
echo "Supervisor token：$supervisor_token_file"
echo "Service environment：$service_environment_file"
