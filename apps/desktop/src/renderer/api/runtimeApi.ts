// +-------------------------------------------------------------------------
//
//   Desktop runtime capability API
//
//   The capability document is the release handshake between the Electron
//   shell and the Node runtime service. It is intentionally fetched through
//   the same typed HTTP gateway as every other renderer API.
// --------------------------------------------------------------------------

import {
  runtimeCapabilitiesSchema,
  type RuntimeCapabilities,
} from '@geo-agent-platform/shared-types/release'
import { requestJson } from './transport'

export function getRuntimeCapabilities(): Promise<RuntimeCapabilities> {
  return requestJson(
    '/health/capabilities',
    undefined,
    5_000,
    runtimeCapabilitiesSchema,
  )
}
