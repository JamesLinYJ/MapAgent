// +-------------------------------------------------------------------------
//
//   地理智能平台 - 公共数据库连接工厂
//
//   数据库连接和 Drizzle schema 属于公共基础包；业务应用只负责注入
//   连接参数及本应用的连接错误观测，不在各自进程复制连接类型。
// --------------------------------------------------------------------------

import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'

type DrizzleDatabase = ReturnType<typeof drizzle<typeof schema>>

export type Database = DrizzleDatabase & {
  pool: Pool
  close: () => Promise<void>
}

export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export interface DatabaseConnectionOptions {
  onPoolError?: (error: Error) => void
}

export function createDb(
  databaseUrl: string,
  options: DatabaseConnectionOptions = {},
): Database {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 120_000,
    query_timeout: 120_000,
  })
  if (options.onPoolError) {
    pool.on('error', options.onPoolError)
  }
  const db = drizzle(pool, { schema }) as DrizzleDatabase
  return Object.assign(db, {
    pool,
    close: () => pool.end(),
  }) satisfies Database
}
