// 兼容 Server 内部既有相对导入；连接实现归属 @geo-agent-platform/db。
import {
  createDb as createSharedDb,
  type Database,
} from '@geo-agent-platform/db'
import { errorLogPayload, logger } from '../observability/logger.js'

export type { Database, DatabaseTransaction } from '@geo-agent-platform/db'

export function createDb(databaseUrl: string): Database {
  return createSharedDb(databaseUrl, {
    onPoolError: error => {
      logger.warn({ error: errorLogPayload(error) }, 'db idle client error')
    },
  })
}
