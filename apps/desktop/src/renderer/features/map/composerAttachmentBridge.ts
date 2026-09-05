import { mapScreenshotContextSchema, type MapScreenshotContext } from '@geo-agent-platform/shared-types'

import {
  desktopFileSelectionHandleSchema,
  type DesktopFileSelectionHandle,
} from '../../../contracts/desktopIpc'

export interface MapScreenshotAttachmentEvent {
  file: DesktopFileSelectionHandle
  context: MapScreenshotContext
}

type MapScreenshotAttachmentListener = (input: MapScreenshotAttachmentEvent) => Promise<void>
const listeners = new Set<MapScreenshotAttachmentListener>()

export async function publishMapScreenshotAttachment(input: MapScreenshotAttachmentEvent): Promise<void> {
  const detail = {
    file: desktopFileSelectionHandleSchema.parse(input.file),
    context: mapScreenshotContextSchema.parse(input.context),
  }
  const activeListeners = [...listeners]
  const listener = activeListeners[0]
  if (activeListeners.length !== 1 || !listener) throw new Error('对话附件接收器尚未就绪。')
  await listener(detail)
}

export function subscribeMapScreenshotAttachment(
  listener: MapScreenshotAttachmentListener,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
