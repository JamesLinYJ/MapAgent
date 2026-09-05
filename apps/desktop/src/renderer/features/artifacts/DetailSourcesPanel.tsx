// +-------------------------------------------------------------------------
//
//   地理智能平台 - 详情文件管理面板
//
//   文件:       DetailSourcesPanel.tsx
//
//   日期:       2026年07月06日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

// 模块职责
//
// 渲染右侧详情栏的数据源文件列表、上传入口和删除按钮。
// 文件真实上传/删除仍由父级资源控制器处理，本组件只消费回调。

import { useState } from 'react'
import { CloudUpload, Trash2 } from 'lucide-react'

import type { DesktopFileSelectionHandle } from '../../../contracts/desktopIpc'
import type { FileEntry } from '../../api/client'
import { selectDesktopUploadFile } from '../../api/desktopFiles'
import { AppIcon } from '../../shared/components/AppIcon'

interface DetailSourcesPanelProps {
  allFiles?: FileEntry[]
  onDeleteFile?: (fileId: string) => void
  onUploadFile?: (file: DesktopFileSelectionHandle) => void
}

export function DetailSourcesPanel({
  allFiles,
  onDeleteFile,
  onUploadFile,
}: DetailSourcesPanelProps) {
  const [selectionError, setSelectionError] = useState<string | null>(null)
  // 文件管理渲染边界
  //
  // 面板只展示文件列表，不直接推断文件用途；上传分类和数据集绑定由上层控制器完成。
  return (
    <section className="dc-card">
      <div className="dc-card__header">
        <div>
          <div className="dc-card__eyebrow">文件管理</div>
          <h3>所有文件</h3>
        </div>
        <div className="dc-card__icon">
          <AppIcon name="database" size={18} />
        </div>
      </div>

      <div className="dc-panel-section" style={{ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 0 }}>
        {onUploadFile ? (
          <button
            type="button"
            className="dc-link-button dc-link-button--primary"
            onClick={() => {
              void selectDesktopUploadFile()
                .then((file) => {
                  setSelectionError(null)
                  if (file) onUploadFile(file)
                })
                .catch((error: unknown) => {
                  setSelectionError(error instanceof Error ? error.message : '文件选择失败，请重试。')
                })
            }}
          >
            <CloudUpload size={14} aria-hidden="true" />
            上传文件
          </button>
        ) : null}
        <span className="text-[12px] text-slate-400">
          {(allFiles?.length ?? 0) > 0
            ? `${allFiles!.length} 个文件`
            : '点击上传并使用系统文件选择器'}
        </span>
      </div>
      {selectionError ? <p className="dc-panel-error" role="alert">{selectionError}</p> : null}

      <div className="dc-panel-section">
        {allFiles && allFiles.length > 0 ? (
          <div className="file-browser">
            <div className="file-browser__head">
              <span className="file-browser__col file-browser__col--name">名称</span>
              <span className="file-browser__col file-browser__col--size">大小</span>
              <span className="file-browser__col file-browser__col--date">上传时间</span>
              <span className="file-browser__col file-browser__col--actions" />
            </div>
            {allFiles.map((file) => (
              <div key={file.id} className="file-browser__row">
                <span className="file-browser__col file-browser__col--name" title={file.name}>
                  <FileIcon name={file.name} />
                  {file.name}
                </span>
                <span className="file-browser__col file-browser__col--size">{file.size}</span>
                <span className="file-browser__col file-browser__col--date">
                  {file.uploadedAt
                    ? new Date(file.uploadedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
                    : '—'}
                </span>
                <span className="file-browser__col file-browser__col--actions">
                  {onDeleteFile ? (
                    <button
                      type="button"
                      className="dc-icon-button dc-icon-button--danger"
                      title="删除"
                      onClick={() => onDeleteFile(file.id)}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="dc-empty-copy">暂无文件。点击上方「上传文件」按钮，从系统文件选择器添加。</p>
        )}
      </div>
    </section>
  )
}

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || ''
  const emoji: Record<string, string> = {
    geojson: '🗺', json: '📋', gpkg: '🗄', zip: '📦',
    tif: '🖼', tiff: '🖼', png: '🖼', jpg: '🖼', jpeg: '🖼', svg: '🖼',
    nc: '🌤', nc4: '🌤', grib: '🌤', grb: '🌤', grb2: '🌤', h5: '🌤', hdf5: '🌤', bz2: '🌤',
    pdf: '📄', txt: '📝', md: '📝', doc: '📄', docx: '📄', xls: '📊', xlsx: '📊', csv: '📊',
  }
  return <span style={{ fontSize: 16, marginRight: 6 }}>{emoji[ext] || '📎'}</span>
}
