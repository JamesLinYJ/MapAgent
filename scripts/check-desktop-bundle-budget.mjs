// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面 Renderer 首屏体积预算
//
//   文件:       check-desktop-bundle-budget.mjs
//
//   日期:       2026年06月18日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'apps/desktop/out/renderer')
const html = await readFile(path.join(dist, 'index.html'), 'utf8')
const initialJs = [...html.matchAll(/(?:src|href)="(?:\.\/|\/)?(assets\/[^"?]+\.js)"/gu)].map(match => match[1])
const initialCss = [...html.matchAll(/rel="stylesheet"[^>]+href="(?:\.\/|\/)?(assets\/[^"?]+\.css)"/gu)].map(match => match[1])

const initialJsGzip = await totalGzip(initialJs)
const initialCssGzip = await totalGzip(initialCss)
const initialCssAssets = await referencedCssAssets(initialCss)
const initialCssAssetBytes = await totalBytes(initialCssAssets)
assertBudget('首屏 JavaScript', initialJsGzip, 120 * 1024)
assertBudget('首屏 CSS', initialCssGzip, 22 * 1024)
assertBudget('首屏 CSS 静态资源', initialCssAssetBytes, 128 * 1024)

for (const forbidden of ['maplibre', 'MapCanvas', 'DebugPage', 'ToolManagementPage', 'motion']) {
  if (html.includes(forbidden)) throw new Error(`首屏 HTML 不应预加载 ${forbidden}`)
}

const assets = await readdir(path.join(dist, 'assets'))
const workspaceApplication = assets.find(name => /^DesktopWorkspaceApplication-.*\.js$/u.test(name))
const mapShell = assets.find(name => /^MapCanvas-.*\.js$/u.test(name))
// MapLibre 6 移除了旧 CSP 子路径的产物名；同时接受升级前后的命名，
// 预算检查只关心运行时与 Worker 是否仍然拆包，而不绑定依赖的内部入口名。
const mapRuntime = assets.find(name => /^maplibre-gl(?:-csp)?-(?!worker-).*\.js$/u.test(name))
const mapWorker = assets.find(name => /^maplibre-gl(?:-csp)?-worker-.*\.js$/u.test(name))
if (!workspaceApplication || !mapShell || !mapRuntime || !mapWorker) {
  throw new Error('没有找到桌面工作区、地图壳、MapLibre 运行时或地图 Worker 异步构建产物')
}
assertBudget('桌面工作区异步包', await gzipSize(`assets/${workspaceApplication}`), 240 * 1024)
// 地图壳和 MapLibre 运行时必须保持独立；若工具模块重新静态导入 MapLibre，
// 地图壳会立即突破这个基于当前 12 KiB 实测值留有余量的预算。
assertBudget('地图壳异步包', await gzipSize(`assets/${mapShell}`), 24 * 1024)
assertBudget('MapLibre 运行时异步包', await gzipSize(`assets/${mapRuntime}`), 310 * 1024)
// MapLibre 6 Worker 当前 gzip 约 141 KiB；保留约 6% 回归余量，仍以独立预算
// 阻止它被并回首屏或在后续升级中无界增长。
assertBudget('MapLibre Worker 异步包', await gzipSize(`assets/${mapWorker}`), 150 * 1024)

console.log(JSON.stringify({
  initialJsGzip,
  initialCssGzip,
  initialJs,
  initialCss,
  initialCssAssets,
  initialCssAssetBytes,
  workspaceApplication,
  mapShell,
  mapRuntime,
  mapWorker,
}, null, 2))

async function totalGzip(files) {
  const sizes = await Promise.all([...new Set(files)].map(gzipSize))
  return sizes.reduce((sum, size) => sum + size, 0)
}

async function gzipSize(relativePath) {
  const content = await readFile(path.join(dist, relativePath))
  return gzipSync(content, { level: 9 }).length
}

async function referencedCssAssets(cssFiles) {
  const referenced = new Set()
  for (const cssFile of new Set(cssFiles)) {
    const content = await readFile(path.join(dist, cssFile), 'utf8')
    for (const match of content.matchAll(/url\((['"]?)([^)'"]+)\1\)/gu)) {
      const raw = match[2]?.trim()
      if (!raw || /^(?:data:|https?:|#)/u.test(raw)) continue
      const withoutQuery = raw.split(/[?#]/u, 1)[0]
      if (!withoutQuery) continue
      const relativePath = withoutQuery.startsWith('/')
        ? path.posix.normalize(withoutQuery.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(cssFile), withoutQuery))
      if (relativePath === '..' || relativePath.startsWith('../')) {
        throw new Error(`首屏 CSS 资源越出 renderer 构建目录：${raw}`)
      }
      referenced.add(relativePath)
    }
  }
  return [...referenced].sort()
}

async function totalBytes(files) {
  const sizes = await Promise.all(files.map(async file => (await stat(path.join(dist, file))).size))
  return sizes.reduce((sum, size) => sum + size, 0)
}

function assertBudget(label, actual, limit) {
  if (actual > limit) throw new Error(`${label} 超出预算：${actual} > ${limit} bytes`)
}
