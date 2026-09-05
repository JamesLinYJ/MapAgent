// +-------------------------------------------------------------------------
//
//   地理智能平台 - 工作台检查区面板
//
//   文件:       WorkspaceInspectorPanel.tsx
//
//   日期:       2026年07月08日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.5
// --------------------------------------------------------------------------

import { lazy, Suspense } from 'react'
import { m } from 'framer-motion'
import type { DetailPanelProps } from '../../features/artifacts/DetailPanel'
import { motionSpring } from '../../shared/motion'
import { WorkbenchProgressCard, type WorkbenchProgressCardProps } from './WorkbenchProgressCard'

const DetailPanel = lazy(() => import('../../features/artifacts/DetailPanel').then((module) => ({ default: module.DetailPanel })))
export type WorkspaceInspectorDetail = DetailPanelProps

export interface WorkspaceInspectorProgress {
  runStatus: WorkbenchProgressCardProps['runStatus']
  progressItems: WorkbenchProgressCardProps['progressItems']
  tasks: WorkbenchProgressCardProps['tasks']
  events: WorkbenchProgressCardProps['events']
  artifactCount: WorkbenchProgressCardProps['artifactCount']
  onOpenHistory: WorkbenchProgressCardProps['onOpenHistory']
}

export interface WorkspaceInspectorPanelProps {
  detail: WorkspaceInspectorDetail
  progress?: WorkspaceInspectorProgress
}

function DetailPanelFallback() {
  return (
    <div className="dc-detail-column" aria-label="正在准备结果摘要">
      <section className="dc-card dc-card--summary">
        <div className="dc-card__header">
          <div><div className="dc-card__eyebrow">结果摘要</div><h3>等待分析</h3></div>
        </div>
        <p className="dc-empty-copy">摘要面板正在就绪。</p>
      </section>
    </div>
  )
}

export function WorkspaceInspectorPanel({
  detail,
  progress,
}: WorkspaceInspectorPanelProps) {
  return (
    <>
      {progress ? (
        <m.div layout transition={motionSpring.gentle}>
          <WorkbenchProgressCard
            runStatus={progress.runStatus}
            progressItems={progress.progressItems}
            tasks={progress.tasks}
            events={progress.events}
            artifactCount={progress.artifactCount}
            onOpenHistory={progress.onOpenHistory}
          />
        </m.div>
      ) : null}
      <m.div className="workbench-inspector-detail" layout transition={motionSpring.gentle}>
        <Suspense fallback={<DetailPanelFallback />}>
          <m.div layout transition={motionSpring.gentle}>
            <DetailPanel {...detail} />
          </m.div>
        </Suspense>
      </m.div>
    </>
  )
}
