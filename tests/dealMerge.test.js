import test from 'node:test'
import assert from 'node:assert/strict'
import {
  pickPrimaryDeal,
  mergeMeetingFields,
  mergeDealsTransactional
} from '../services/dealMerge.js'

test('pickPrimaryDeal keeps newest updated record as primary', () => {
  const older = {
    id: '00000000-0000-0000-0000-000000000001',
    company: 'Old Co',
    updated_at: '2024-01-01T00:00:00.000Z',
    created_at: '2023-12-01T00:00:00.000Z'
  }
  const newer = {
    id: '00000000-0000-0000-0000-000000000002',
    company: 'New Co',
    updated_at: '2024-02-01T00:00:00.000Z',
    created_at: '2024-01-01T00:00:00.000Z'
  }
  const { primary, secondary } = pickPrimaryDeal([older, newer])
  assert.equal(primary.id, newer.id)
  assert.equal(secondary.id, older.id)
})

test('mergeMeetingFields keeps primary data and fills missing from secondary', () => {
  const primary = {
    meeting_date: '2026-01-10',
    poc: null,
    sector: 'AI',
    status: null,
    exciting_reason: 'Strong team',
    risks: null,
    conviction_score: null,
    pass_reasons: null,
    watch_reasons: null,
    action_required: null
  }
  const secondary = {
    meeting_date: '2026-01-08',
    poc: 'Alice',
    sector: 'Fintech',
    status: 'Watch',
    exciting_reason: 'Secondary reason',
    risks: 'Go-to-market',
    conviction_score: 7.5,
    pass_reasons: null,
    watch_reasons: 'Need references',
    action_required: 'Second call'
  }
  const merged = mergeMeetingFields(primary, secondary)
  assert.equal(merged.meeting_date, primary.meeting_date)
  assert.equal(merged.sector, primary.sector)
  assert.equal(merged.poc, secondary.poc)
  assert.equal(merged.status, secondary.status)
  assert.equal(merged.exciting_reason, primary.exciting_reason)
  assert.equal(merged.risks, secondary.risks)
  assert.equal(merged.conviction_score, 7.5)
  assert.equal(merged.watch_reasons, secondary.watch_reasons)
  assert.equal(merged.action_required, secondary.action_required)
})

test('mergeMeetingFields averages conviction scores when both are present', () => {
  const primary = { conviction_score: 8.0 }
  const secondary = { conviction_score: 6.0 }
  const merged = mergeMeetingFields(primary, secondary)
  assert.equal(merged.conviction_score, 7.0)
})

test('mergeMeetingFields merges both poc values when different', () => {
  const primary = { poc: 'Alice' }
  const secondary = { poc: 'Bob' }
  const merged = mergeMeetingFields(primary, secondary)
  assert.equal(merged.poc, 'Alice, Bob')
})

test('mergeMeetingFields deduplicates poc values across merged lists', () => {
  const primary = { poc: 'Alice, Bob' }
  const secondary = { poc: 'bob, Charlie' }
  const merged = mergeMeetingFields(primary, secondary)
  assert.equal(merged.poc, 'Alice, Bob, Charlie')
})

test('mergeMeetingFields prefers meaningful status over latest New', () => {
  const primary = { status: 'New' } // latest
  const secondary = { status: 'Watch' } // older but meaningful
  const merged = mergeMeetingFields(primary, secondary)
  assert.equal(merged.status, 'Watch')
})

test('mergeMeetingFields keeps latest status when all are New', () => {
  const primary = { status: 'New' } // latest
  const secondary = { status: 'new' }
  const merged = mergeMeetingFields(primary, secondary)
  assert.equal(merged.status, 'New')
})

function createMockPool({ failOnSqlMatch = null } = {}) {
  const log = []
  let released = false
  const primaryDeal = {
    id: '00000000-0000-0000-0000-000000000010',
    company: 'Primary Co',
    updated_at: '2026-03-10T10:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z'
  }
  const secondaryDeal = {
    id: '00000000-0000-0000-0000-000000000020',
    company: 'Secondary Co',
    updated_at: '2026-02-10T10:00:00.000Z',
    created_at: '2026-01-02T00:00:00.000Z'
  }
  const primaryMeeting = {
    id: '11111111-0000-0000-0000-000000000001',
    deal_id: primaryDeal.id,
    meeting_date: '2026-03-01',
    poc: null,
    sector: 'AI',
    status: null,
    exciting_reason: 'Primary reason',
    risks: null,
    conviction_score: null,
    pass_reasons: null,
    watch_reasons: null,
    action_required: null,
    company: primaryDeal.company
  }
  const secondaryMeeting = {
    id: '11111111-0000-0000-0000-000000000002',
    deal_id: secondaryDeal.id,
    meeting_date: '2026-02-25',
    poc: 'Bob',
    sector: 'Cloud',
    status: 'Watch',
    exciting_reason: 'Secondary reason',
    risks: 'Risk note',
    conviction_score: 6.5,
    pass_reasons: null,
    watch_reasons: 'Watch note',
    action_required: 'Follow up',
    company: secondaryDeal.company
  }
  const movedCountByTable = {
    deal_insights: 2,
    deal_files: 1,
    founder_scores: 0,
    founder_signals: 0,
    founder_soft_scores: 1,
    founder_hard_scores: 1,
    founder_final_scores: 1
  }

  const client = {
    async query(sqlText) {
      log.push(sqlText)
      if (failOnSqlMatch && sqlText.includes(failOnSqlMatch)) {
        throw new Error('simulated failure')
      }
      if (sqlText === 'BEGIN' || sqlText === 'COMMIT' || sqlText === 'ROLLBACK') {
        return { rows: [], rowCount: 0 }
      }
      if (sqlText.includes('SELECT * FROM deals')) {
        return { rows: [primaryDeal, secondaryDeal], rowCount: 2 }
      }
      if (sqlText.includes('SELECT * FROM deal_meetings')) {
        return { rows: [primaryMeeting, secondaryMeeting], rowCount: 2 }
      }
      const table = Object.keys(movedCountByTable).find((name) =>
        sqlText.includes(`UPDATE ${name} SET deal_id = $1 WHERE deal_id = $2`)
      )
      if (table) {
        return { rows: [], rowCount: movedCountByTable[table] }
      }
      return { rows: [], rowCount: 1 }
    },
    release() {
      released = true
    }
  }

  return {
    pool: {
      async connect() {
        return client
      }
    },
    log,
    get released() {
      return released
    }
  }
}

test('mergeDealsTransactional returns moved summary and resolves meeting conflict path', async () => {
  const mock = createMockPool()
  const summary = await mergeDealsTransactional(mock.pool, [
    '00000000-0000-0000-0000-000000000010',
    '00000000-0000-0000-0000-000000000020'
  ])

  assert.equal(summary.primaryDealId, '00000000-0000-0000-0000-000000000010')
  assert.equal(summary.mergedDealId, '00000000-0000-0000-0000-000000000020')
  assert.equal(summary.moved.deal_insights, 2)
  assert.equal(summary.moved.deal_files, 1)
  assert.equal(summary.conflictResolved, true)
  assert.equal(mock.released, true)
})

test('mergeDealsTransactional rolls back when any step fails', async () => {
  const mock = createMockPool({ failOnSqlMatch: 'UPDATE deal_files SET deal_id = $1 WHERE deal_id = $2' })
  await assert.rejects(
    mergeDealsTransactional(mock.pool, [
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000020'
    ]),
    /simulated failure/
  )
  assert.ok(mock.log.includes('BEGIN'))
  assert.ok(mock.log.includes('ROLLBACK'))
  assert.ok(mock.released)
})

test('mergeDealsTransactional respects preferredPrimaryId when provided', async () => {
  const mock = createMockPool()
  const summary = await mergeDealsTransactional(
    mock.pool,
    [
      '00000000-0000-0000-0000-000000000010',
      '00000000-0000-0000-0000-000000000020'
    ],
    { preferredPrimaryId: '00000000-0000-0000-0000-000000000020' }
  )
  assert.equal(summary.primaryDealId, '00000000-0000-0000-0000-000000000020')
  assert.equal(summary.mergedDealId, '00000000-0000-0000-0000-000000000010')
})
