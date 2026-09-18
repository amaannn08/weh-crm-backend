# WEH CRM Backend — Developer & Agent Instructions

## Overview
Node.js + Express backend (ES modules) for WEH Ventures CRM.
- **Database**: Neon PostgreSQL with `pgvector` extension. Single schema owner is `db/neon.js` (`initSchema()` using idempotent `IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).
- **Deployment**: Render Web Service + Render Cron Job (defined in `render.yaml`).
- **External Services**: Google Drive API (transcripts), Gemini API (embeddings), DeepSeek API (chat & deal extraction).

## Key Commands
- `npm start` - Start Express API server (`node server.js`)
- `npm run ingest:drive` - Run Google Drive transcript ingestion pipeline
- `npm run status:drive` - Read-only status & diagnosis of Google Drive folder and DB tracking
- `npm run ingest` - Ingest local transcripts from `TRANSCRIPTS_DIR`
- `npm test` - Run automated test suite (`node --test tests`)

## Deployment Architecture & Rules
1. **Render Scheduling**:
   - Primary: Render Cron Job `weh-crm-drive-ingest` running `npm run ingest:drive` on `0 */6 * * *`.
   - Fallback: In-process `node-cron` in `server.js` when `DRIVE_INGEST_CRON_ENABLED="true"`.
   - Concurrency: Managed by atomic DB lease in `system_locks` table (`lock_key = 'drive_ingest'`) and in-process mutex.
2. **Drive Ingestion**:
   - Supports Google Docs (`application/vnd.google-apps.document`), Word documents (`.docx`), and Google Drive shortcuts (`application/vnd.google-apps.shortcut` by resolving target).
   - Never fails on shortcut downloads; resolves target doc ID and exports plain text.
3. **Document Cleanup**:
   - Transient files in `uploads/transcripts-tmp/` and ingested local files in `TRANSCRIPTS_DIR` / `./docs` are deleted via `services/cleanup.js` after database records are persisted.
   - Files are NEVER deleted if ingestion fails.
   - `uploads/deal-files/` contains active CRM deal attachments and must NEVER be deleted by automated cleanup.
   - Database rows are NEVER deleted during cleanup.
4. **Database & Schema**:
   - `db/neon.js` is the ONLY place schema changes belong.
   - Never create migration files. Use idempotent `IF NOT EXISTS` inside `initSchema()`.
5. **Security**:
   - Never commit secrets (`.env`, `google-token.json`, `*.pem`).
   - Always verify `git diff --cached` before committing.
