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
export async function query(text, params) {
  return pool.query(text, params)
}

export async function getClient() {
  return pool.connect()
}

export function formatVector(embedding) {
  return '[' + embedding.join(',') + ']'
}

export async function initSchema() {
  const client = await pool.connect()
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS vector')
    await client.query('CREATE SEQUENCE IF NOT EXISTS unknown_company_seq START 1')

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
    await client.query(`
      CREATE TABLE IF NOT EXISTS drive_transcript_ingestion_status (
        drive_file_id TEXT PRIMARY KEY,
        source_file_name TEXT,
        company_name TEXT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'success', 'failed')),
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_attempt_at TIMESTAMPTZ,
        ingested_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_drive_ingestion_status_status ON drive_transcript_ingestion_status(status)'
    )
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_drive_ingestion_status_updated_at ON drive_transcript_ingestion_status(updated_at DESC)'
    )

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

    await client.query(`
      CREATE TABLE IF NOT EXISTS deal_identity_ambiguities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        source_type TEXT NOT NULL CHECK (source_type IN ('upload','drive','docs','csv')),
        source_file_id TEXT,
        source_file_name TEXT,
        extracted_company TEXT,
        normalized_company TEXT,
        extracted_domain TEXT,
        candidate_deal_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
        pending_deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending','resolved','ignored')),
        resolved_deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
        resolution_method TEXT,
        payload JSONB,
        error TEXT,
        resolved_by TEXT,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_deal_identity_ambiguities_status ON deal_identity_ambiguities(status)'
    )
    await client.query(
      'CREATE INDEX IF NOT EXISTS idx_deal_identity_ambiguities_created_at ON deal_identity_ambiguities(created_at DESC)'
    )

    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id            SERIAL PRIMARY KEY,
        slug          TEXT UNIQUE NOT NULL,
        name          TEXT NOT NULL,
        fund          TEXT NOT NULL CHECK (fund IN ('fund1','fund2','fund3')),
        sector        TEXT,
        stage         TEXT,
        status        TEXT DEFAULT 'active'
          CHECK (status IN ('active','exited','written-off')),
        logo_initials TEXT,
        logo_color    TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS rss_sources (
        id          SERIAL PRIMARY KEY,
        company_id  INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        feed_url    TEXT NOT NULL,
        label       TEXT,
        active      BOOLEAN DEFAULT TRUE,
        last_fetched_at TIMESTAMPTZ,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS scrape_targets (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        url          TEXT NOT NULL,
        label        TEXT,
        article_selector    TEXT DEFAULT 'article',
        title_selector      TEXT DEFAULT 'h2 a, h3 a',
        summary_selector    TEXT DEFAULT 'p',
        date_selector       TEXT DEFAULT 'time',
        active       BOOLEAN DEFAULT TRUE,
        last_scraped_at TIMESTAMPTZ,
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS news_items (
        id           SERIAL PRIMARY KEY,
        company_id   INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        source_type  TEXT NOT NULL CHECK (source_type IN ('rss','scrape','manual')),
        source_label TEXT,
        external_url TEXT,
        title        TEXT NOT NULL,
        raw_summary  TEXT,
        ai_summary   TEXT,
        sentiment    TEXT DEFAULT 'neutral'
          CHECK (sentiment IN ('positive','negative','neutral','watch')),
        sentiment_score NUMERIC(5,2),
        category     TEXT,
        tags         TEXT[],
        published_at TIMESTAMPTZ,
        ingested_at  TIMESTAMPTZ DEFAULT NOW(),
        is_published BOOLEAN DEFAULT TRUE,
        dedup_hash   TEXT UNIQUE
      )
    `)

    await client.query('CREATE INDEX IF NOT EXISTS idx_news_company    ON news_items(company_id)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_news_sentiment  ON news_items(sentiment)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_news_published  ON news_items(published_at DESC)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_news_fund       ON news_items(company_id)')

    await client.query(`
      CREATE OR REPLACE FUNCTION update_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql;
    `)

    // Trigger creation can race if multiple processes call initSchema concurrently.
    await client.query('DROP TRIGGER IF EXISTS trg_companies_updated_at ON companies')
    try {
      await client.query(`
        CREATE TRIGGER trg_companies_updated_at
        BEFORE UPDATE ON companies
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
      `)
    } catch (err) {
      if (err?.code !== '42710') throw err // duplicate_object
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS newsletter_issues (
        id            SERIAL PRIMARY KEY,
        title         TEXT NOT NULL,
        period_label  TEXT,
        status        TEXT DEFAULT 'draft'
          CHECK (status IN ('draft', 'in_review', 'published')),
        created_by    TEXT,
        published_at  TIMESTAMPTZ,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS newsletter_picks (
        id            SERIAL PRIMARY KEY,
        issue_id      INTEGER NOT NULL REFERENCES newsletter_issues(id) ON DELETE CASCADE,
        news_item_id  INTEGER NOT NULL REFERENCES news_items(id) ON DELETE CASCADE,
        sort_order    INTEGER DEFAULT 0,
        editor_note   TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (issue_id, news_item_id)
      )
    `)

    await client.query(`
      CREATE TABLE IF NOT EXISTS newsletter_segments (
        id            SERIAL PRIMARY KEY,
        issue_id      INTEGER NOT NULL REFERENCES newsletter_issues(id) ON DELETE CASCADE,
        segment_type  TEXT NOT NULL
          CHECK (segment_type IN (
            'portfolio_highlights',
            'market_context',
            'founder_spotlight',
            'custom'
          )),
        title         TEXT,
        body          TEXT,
        company_id    INTEGER REFERENCES companies(id),
        sort_order    INTEGER DEFAULT 0,
        created_by    TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    await client.query('CREATE INDEX IF NOT EXISTS idx_picks_issue       ON newsletter_picks(issue_id)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_segments_issue    ON newsletter_segments(issue_id)')
    await client.query('CREATE INDEX IF NOT EXISTS idx_issues_status     ON newsletter_issues(status)')
    await client.query('DROP TRIGGER IF EXISTS trg_issues_updated_at ON newsletter_issues')
    try {
      await client.query(`
        CREATE TRIGGER trg_issues_updated_at
        BEFORE UPDATE ON newsletter_issues
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
      `)
    } catch (err) {
      if (err?.code !== '42710') throw err
    }
    await client.query('DROP TRIGGER IF EXISTS trg_segments_updated_at ON newsletter_segments')
    try {
      await client.query(`
        CREATE TRIGGER trg_segments_updated_at
        BEFORE UPDATE ON newsletter_segments
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
      `)
    } catch (err) {
      if (err?.code !== '42710') throw err
    }
    await client.query('DROP TRIGGER IF EXISTS trg_drive_ingestion_status_updated_at ON drive_transcript_ingestion_status')
    try {
      await client.query(`
        CREATE TRIGGER trg_drive_ingestion_status_updated_at
        BEFORE UPDATE ON drive_transcript_ingestion_status
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
      `)
    } catch (err) {
      if (err?.code !== '42710') throw err
    }
    await client.query('DROP TRIGGER IF EXISTS trg_deal_identity_ambiguities_updated_at ON deal_identity_ambiguities')
    try {
      await client.query(`
        CREATE TRIGGER trg_deal_identity_ambiguities_updated_at
        BEFORE UPDATE ON deal_identity_ambiguities
        FOR EACH ROW EXECUTE FUNCTION update_updated_at()
      `)
    } catch (err) {
      if (err?.code !== '42710') throw err
    }
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
