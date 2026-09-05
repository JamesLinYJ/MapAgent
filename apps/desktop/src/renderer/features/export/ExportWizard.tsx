// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面成果导出向导
//
//   文件:       ExportWizard.tsx
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ArtifactRef } from '@geo-agent-platform/shared-types'
import { useState } from 'react'

import type { DesktopExportRequest } from '../../../contracts/desktopIpc.js'
import {
  GlassDialog,
  GlassDialogActions,
} from '../../shared/components/GlassDialog'

export interface ExportWizardSelection {
  formats: DesktopExportRequest['formats']
  artifactIds: string[]
}

export interface ExportWizardProps {
  open: boolean
  title: string
  artifacts: readonly ArtifactRef[]
  defaultArtifactId?: string
  busy: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (selection: ExportWizardSelection) => Promise<void>
}

const formatOptions = [
  {
    id: 'pdf',
    label: 'A4 PDF 报告',
    description: '对话、结论与当前地图组成的独立报告。',
  },
  {
    id: 'png',
    label: '地图 PNG',
    description: '只导出当前地图画布，不包含工作台界面。',
  },
  {
    id: 'zip',
    label: '可核验 ZIP 数据包',
    description: '包含对话、地图场景、预览图、所选成果与 SHA256 清单。',
  },
] as const satisfies ReadonlyArray<{
  id: DesktopExportRequest['formats'][number]
  label: string
  description: string
}>

export function ExportWizard({
  open,
  title,
  artifacts,
  defaultArtifactId,
  busy,
  onOpenChange,
  onConfirm,
}: ExportWizardProps) {
  const [formats, setFormats] = useState<DesktopExportRequest['formats']>([
    'pdf',
    'png',
    'zip',
  ])
  const [artifactIds, setArtifactIds] = useState<string[]>(
    defaultArtifactId && artifacts.some(artifact => artifact.artifactId === defaultArtifactId)
      ? [defaultArtifactId]
      : artifacts.at(-1)
        ? [artifacts.at(-1)!.artifactId]
        : [],
  )

  const toggleFormat = (format: DesktopExportRequest['formats'][number]) => {
    setFormats(current => (
      current.includes(format)
        ? current.filter(value => value !== format)
        : formatOptions.flatMap(option => (
          option.id === format || current.includes(option.id) ? [option.id] : []
        ))
    ))
  }
  const toggleArtifact = (artifactId: string) => {
    setArtifactIds(current => (
      current.includes(artifactId)
        ? current.filter(value => value !== artifactId)
        : [...current, artifactId]
    ))
  }

  return (
    <GlassDialog
      open={open}
      onOpenChange={nextOpen => {
        if (!busy) onOpenChange(nextOpen)
      }}
      title="导出成果"
      description={`“${title}”将从服务器读取权威对话和地图场景，桌面端不会把界面内容当作业务事实。`}
    >
      <form
        className="dc-export-wizard"
        onSubmit={event => {
          event.preventDefault()
          if (formats.length === 0 || busy) return
          void onConfirm({
            formats,
            artifactIds: formats.includes('zip') ? artifactIds : [],
          })
        }}
      >
        <fieldset disabled={busy}>
          <legend>导出格式</legend>
          <div className="dc-export-options">
            {formatOptions.map(option => (
              <label className="dc-export-option" key={option.id}>
                <input
                  type="checkbox"
                  checked={formats.includes(option.id)}
                  onChange={() => toggleFormat(option.id)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset disabled={busy}>
          <legend>
            数据包成果
            <span>{artifactIds.length}/{artifacts.length}</span>
          </legend>
          {artifacts.length > 0 ? (
            <div className="dc-export-artifacts">
              {artifacts.map(artifact => (
                <label className="dc-export-artifact" key={artifact.artifactId}>
                  <input
                    type="checkbox"
                    checked={artifactIds.includes(artifact.artifactId)}
                    onChange={() => toggleArtifact(artifact.artifactId)}
                    disabled={!formats.includes('zip') || busy}
                  />
                  <span title={artifact.name}>{artifact.name}</span>
                  <small>{artifact.artifactType}</small>
                </label>
              ))}
            </div>
          ) : (
            <p className="dc-export-empty">当前对话没有可附加成果，仍可导出报告、地图与基础数据包。</p>
          )}
        </fieldset>

        {formats.length === 0 && (
          <p className="dc-export-error" role="alert">请至少选择一种导出格式。</p>
        )}

        <GlassDialogActions>
          <button type="button" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </button>
          <button type="submit" className="primary" disabled={formats.length === 0 || busy}>
            {busy ? '正在生成…' : '选择保存位置'}
          </button>
        </GlassDialogActions>
      </form>
    </GlassDialog>
  )
}
