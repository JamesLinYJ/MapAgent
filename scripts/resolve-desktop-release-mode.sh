#!/usr/bin/env bash
set -euo pipefail

version="$(node scripts/validate-release-version.mjs)"
production=false
create_tag=false
release_tag=''

if [[ "${GITHUB_REF_TYPE:-}" == 'tag' ]]; then
  node scripts/validate-release-version.mjs "${GITHUB_REF_NAME}"
  production=true
  release_tag="${GITHUB_REF_NAME}"
elif [[ "${REQUESTED_PUBLISH:-false}" == 'true' ]]; then
  if [[ "${GITHUB_REF}" != 'refs/heads/main' ]]; then
    echo '手动生产发布只能从 main 分支运行。' >&2
    exit 1
  fi
  if [[ -z "${REQUESTED_VERSION:-}" ]]; then
    echo 'publish=true 时必须提供 version。' >&2
    exit 1
  fi
  release_tag="v${REQUESTED_VERSION}"
  node scripts/validate-release-version.mjs "${release_tag}"
  # 手动发布：本次运行完成 打标签 + 生产打包 + 发布 全流程。
  # GITHUB_TOKEN 推送的标签不会触发新的 workflow 运行，因此不再依赖标签事件。
  production=true
  create_tag=true
fi

source_revision="$(git rev-parse "${GITHUB_SHA}^{commit}")"
source_date_epoch="$(git show -s --format=%ct "${source_revision}")"
{
  echo "production=${production}"
  echo "create_tag=${create_tag}"
  echo "release_tag=${release_tag}"
  echo "source_date_epoch=${source_date_epoch}"
  echo "source_revision=${source_revision}"
  echo "version=${version}"
} >> "${GITHUB_OUTPUT}"
