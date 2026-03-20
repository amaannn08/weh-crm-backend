import pg from 'pg'
import 'dotenv/config'

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error('DATABASE_URL is required')
}

const pool = new pg.Pool({
  connectionString,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000
})
export function sql(strings, ...values) {
  let text = strings[0] ?? ''
  for (let i = 0; i < values.length; i += 1) {
    text += `$${i + 1}${strings[i + 1] ?? ''}`
  }
  return pool.query(text, values).then((res) => res.rows)
}

export const poolRef = pool

export function formatVector(embedding) {
  return '[' + embedding.join(',') + ']'
}

export async function initSchema() {
  const client = await pool.connect()
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector')

    await client.query(`
      CREATE TABLE IF NOT EXISTS meetings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        drive_file_id TEXT UNIQUE,
        source_file_name TEXT,
        transcript TEXT NOT NULL,
        embedding vector(1536) NOT NULL,
        ingested_at TIMESTAMPTZ DEFAULT now()
      )
    `)
    await client.query('ALTER TABLE meetings ADD COLUMN IF NOT EXISTS drive_file_id TEXT')
    await client.query('ALTER TABLE meetings ADD COLUMN IF NOT EXISTS source_file_name TEXT')
    await client.query('ALTER TABLE meetings ADD COLUMN IF NOT EXISTS company TEXT')

    // CRM meeting metadata per deal (1:1 with deals)
    await client.query(`
      CREATE TABLE IF NOT EXISTS deal_meetings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        company TEXT,
        meeting_date DATE,
        poc TEXT,
        sector TEXT,
        status TEXT,
        exciting_reason TEXT,
        risks TEXT,
        conviction_score NUMERIC(4,1),
        pass_reasons TEXT,
        watch_reasons TEXT,
        action_required TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `)
    await client.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS deal_meetings_deal_id_idx ON deal_meetings(deal_id)'
    )

    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title TEXT DEFAULT 'New session',
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversation_messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS deals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company TEXT NOT NULL,
        company_domain TEXT,
        date DATE,
        poc TEXT,
        sector TEXT,
        founder_name TEXT,
        meeting_date DATE,
        business_model TEXT,
        status TEXT,
        stage TEXT,
        risk_level TEXT,
        source_file_name TEXT,
        exciting_reason TEXT,
        risks TEXT,
        conviction_score NUMERIC(4,1),
        pass_reasons TEXT,
        watch_reasons TEXT,
        action_required TEXT,
        founder_score NUMERIC(4,1),
        founder_soft_score NUMERIC(4,1),
        founder_hard_score NUMERIC(4,1),
        founder_final_score NUMERIC(4,1),
        dd_recommendation TEXT,
        created_at TIMESTAMPTZ DEFAULT now(),
        updated_at TIMESTAMPTZ DEFAULT now()
      )
    `)
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS founder_name TEXT'
    )
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS meeting_date DATE'
    )
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS business_model TEXT'
    )
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS stage TEXT'
    )
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS risk_level TEXT'
    )
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS source_file_name TEXT'
    )
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS company_domain TEXT'
    )
    await client.query(
      'CREATE INDEX IF NOT EXISTS deals_company_domain_idx ON deals(company_domain)'
    )
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS founder_soft_score NUMERIC(4,1)'
    )
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS founder_hard_score NUMERIC(4,1)'
    )
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS founder_final_score NUMERIC(4,1)'
    )
    await client.query(
      'ALTER TABLE deals ADD COLUMN IF NOT EXISTS dd_recommendation TEXT'
    )

    await client.query(`
      CREATE TABLE IF NOT EXISTS founder_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        resilience NUMERIC(3,1) NOT NULL,
        ambition NUMERIC(3,1) NOT NULL,
        self_awareness NUMERIC(3,1) NOT NULL,
        domain_fit NUMERIC(3,1) NOT NULL,
        storytelling NUMERIC(3,1) NOT NULL,
        weighted_score NUMERIC(4,1) NOT NULL,
        archetype TEXT,
        evidence_json JSONB,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS founder_signals (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        education_tier SMALLINT,
        previous_startup_experience SMALLINT,
        technical_background SMALLINT,
        network_strength SMALLINT,
        social_credibility SMALLINT,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS founder_soft_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        resilience NUMERIC(3,1) NOT NULL,
        ambition NUMERIC(3,1) NOT NULL,
        self_awareness NUMERIC(3,1) NOT NULL,
        domain_fit NUMERIC(3,1) NOT NULL,
        storytelling NUMERIC(3,1) NOT NULL,
        soft_weighted_score NUMERIC(4,1) NOT NULL,
        archetype TEXT,
        evidence_json JSONB,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS founder_hard_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        education_tier NUMERIC(3,1),
        domain_work_experience NUMERIC(3,1),
        seniority_of_roles NUMERIC(3,1),
        previous_startup_experience NUMERIC(3,1),
        hard_weighted_score NUMERIC(4,1) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS founder_final_scores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        hard_weighted_score NUMERIC(4,1) NOT NULL,
        soft_weighted_score NUMERIC(4,1) NOT NULL,
        final_score NUMERIC(4,1) NOT NULL,
        dd_recommendation TEXT NOT NULL,
        scored_at TIMESTAMPTZ DEFAULT now(),
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS deal_insights (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        meeting_outcome JSONB,
        founder_pitch JSONB,
        business_model_signals JSONB,
        market_signals JSONB,
        investor_reaction JSONB,
        supporting_quotes JSONB,
        raw_payload JSONB,
        created_at TIMESTAMPTZ DEFAULT now()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS deal_files (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        mime_type TEXT,
        size BIGINT,
        uploaded_at TIMESTAMPTZ DEFAULT now()
      )
    `)
  } catch (err) {
    const isTimeout =
      err.message?.includes('fetch failed') ||
      err.cause?.code === 'ETIMEDOUT' ||
      err.cause?.code === 'ECONNREFUSED'
    if (isTimeout) {
      throw new Error(
        'Could not connect to Neon, Check DATABASE_URL'
      )
    }
    throw err
  } finally {
    client.release()
  }
}
