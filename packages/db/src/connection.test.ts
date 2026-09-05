import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDb, platformRuns } from './index.js'

describe('shared database package', () => {
  const databases: Array<{ close: () => Promise<void> }> = []

  afterEach(async () => {
    await Promise.all(databases.splice(0).map(database => database.close()))
  })

  it('exports the schema and creates a lazy connection without opening the network', () => {
    expect(platformRuns).toBeDefined()
    const db = createDb('postgresql://127.0.0.1:1/unused')
    databases.push(db)

    expect(db.pool).toBeDefined()
    expect(typeof db.close).toBe('function')
  })

  it('forwards idle pool errors to the application observer', () => {
    const onPoolError = vi.fn()
    const db = createDb('postgresql://127.0.0.1:1/unused', { onPoolError })
    databases.push(db)

    const error = new Error('idle client failed')
    db.pool.emit('error', error)

    expect(onPoolError).toHaveBeenCalledOnce()
    expect(onPoolError).toHaveBeenCalledWith(error)
  })
})
