// +-------------------------------------------------------------------------
//
//   地理智能平台 - Electron Vite 构建配置
//
//   文件:       electron.vite.config.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { projectDesktopEnvironment } from './src/main/desktopEnvironment.js'

export default defineConfig((_context) => {
  const env = projectDesktopEnvironment(process.env)
  const rendererServer = resolveDesktopRendererServerOptions(env)

  return {
    main: {
      build: {
        // Electron Forge cannot safely crawl hoisted npm-workspace dependencies.
        // The Main process has no native Node addon, so keep Electron/Node builtins
        // external and bundle the complete JavaScript dependency graph.
        externalizeDeps: false,
        outDir: 'out/main',
        rollupOptions: {
          input: { index: 'src/main/index.ts' },
        },
      },
    },
    preload: {
      build: {
        // A sandboxed preload must be one self-contained bundle; it cannot rely on
        // package-manager layout inside the installed application.
        externalizeDeps: false,
        outDir: 'out/preload',
        rollupOptions: {
          input: { index: 'src/preload/index.ts' },
          output: {
            entryFileNames: 'index.cjs',
            format: 'cjs',
          },
        },
      },
    },
    renderer: {
      root: 'src/renderer',
      plugins: [react(), tailwindcss()],
      optimizeDeps: {
        include: ['react', 'react-dom/client'],
      },
      server: {
        ...rendererServer,
        warmup: {
          clientFiles: ['./main.tsx', './app/AppShell.tsx'],
        },
      },
      build: {
        outDir: 'out/renderer',
        emptyOutDir: true,
      },
    },
  }
})

export function resolveDesktopRendererServerOptions(
  environment: Record<string, string | undefined>,
): { host: '127.0.0.1'; port: number; strictPort: boolean } {
  const configuredPort = parsePort(environment.DESKTOP_RENDERER_PORT)
  return {
    host: '127.0.0.1',
    port: configuredPort ?? 5173,
    // 默认端口只是开发首选值；已有同项目实例时允许 Vite 选择下一可用端口，
    // Electron 的单实例锁随后唤醒现有窗口。显式端口仍保持严格契约。
    strictPort: configuredPort !== undefined,
  }
}

function parsePort(value?: string): number | undefined {
  if (!value?.trim()) return undefined
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : undefined
}
