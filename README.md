# Backend (CRM)

Node.js + Express backend for the CRM MVP. It provides:

- Auth (JWT)
- Deal management (CRUD, file attachments)
- Transcript ingestion (extract -> embed -> persist -> score)
- Assistant chat (RAG over ingested transcripts)

## Prerequisites

- Node.js (LTS recommended)
- A Postgres database (Neon recommended) with `pgvector` enabled

## Setup

From the repo root:

```bash
cd backend
```

Create/edit `backend/.env` with at least:

- `DATABASE_URL` - Neon Postgres connection string (must have `vector`/`pgvector` available)
- `GEMINI_API_KEY` - Google AI Studio API key
- `DEEPSEEK_API_KEY` - DeepSeek API key (used by the assistant chat model)
- `LOGIN_USERNAME`, `LOGIN_PASSWORD`, `JWT_SECRET` - used for JWT auth
- `CORS_ORIGIN` - frontend origin (e.g. `http://localhost:5173`)
- `TRANSCRIPTS_DIR` - folder for local transcript docs (`.docx`, `.txt`, `.md` depending on your ingestion setup)
- `DEEPSEEK_BASE_URL` and `DEAL_EXTRACTION_MODEL` - model config for extraction/chat
- `PORT` - (optional) defaults to `3000`

Important: this project expects a local `backend/.env` file. Do not commit it.

## Run

```bash
npm install
npm start
```

Server:
- `http://localhost:3000`

## Key commands

- `npm start` - run API server (`node server.js`)
- `npm run ingest` - ingest docx/transcript files from `TRANSCRIPTS_DIR` (local)
- `npm run ingest:drive` - ingest transcripts from Google Drive (needs Drive credentials)
- `npm run status:drive` - read-only audit of Drive folder and Neon DB ingestion status
- `npm test` - run automated test suite (`node --test tests`)

## Drive Ingestion & Render Deployment Contract

### Architecture on Render
The backend repository includes [`render.yaml`](./render.yaml) defining two services:
1. **Web Service (`weh-crm-backend`)**:
   - Handles REST API traffic, authentication, deal management, and webhooks.
   - Recommended: Set `DRIVE_INGEST_CRON_ENABLED=false` so the web container does not run ingestion workloads.
2. **Cron Job (`weh-crm-drive-ingest`)**:
   - Runs `npm run ingest:drive` on schedule `0 */6 * * *` (every 6 hours).
   - Runs in an isolated, non-sleeping container and terminates cleanly upon completion.

### Environment Variables
| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon Postgres connection string with `pgvector` enabled |
| `GOOGLE_DRIVE_FOLDER_ID` | Yes | Google Drive folder ID containing call transcripts |
| `CLIENT_ID`, `CLIENT_SECRET` | Yes | Google OAuth2 client credentials |
| `GOOGLE_TOKEN_JSON` | Yes* | OAuth2 token JSON content (*or mount secret file at `/etc/secrets/google-token.json` or local `google-token.json`)* |
| `CRON_SECRET` | Optional | Shared bearer secret for triggering `POST /admin/ingest/drive` externally |
| `DRIVE_INGEST_CRON_ENABLED` | Optional | `"true"` to enable in-process `node-cron` fallback on web service (default: `"false"`) |
| `DRIVE_INGEST_CRON` | Optional | Cron expression for in-process fallback (default: `"0 */6 * * *"`) |
| `DRIVE_TRASH_PROCESSED_FILES` | Optional | `"true"` to move processed Drive files to Trash (default: `"false"`, requires `drive` or `drive.file` scope) |

### Concurrency & Overlap Guard
- Ingestion runs are coordinated through an atomic lease table in Neon Postgres: `system_locks` (`lock_key = 'drive_ingest'`).
- The lease lasts 30 minutes and is released immediately on completion.
- If a Render Cron Job, an in-process web cron, or a manual HTTP call triggers while a run is active, the second runner detects the active lease and exits safely (`status: 'skipped'`).
- In addition, an in-process mutex prevents concurrent calls within the same Node process.

### Post-Ingest Document Cleanup Contract
- **Temporary Uploads (`uploads/transcripts-tmp`)**: Transcript `.docx` files uploaded via the web API are deleted immediately upon successful ingestion into `meetings`/`deals`. A background sweep also purges orphaned files older than 1 hour every 6 hours and at server startup.
- **Local Transcripts (`TRANSCRIPTS_DIR` / `./docs`)**: When ingested via `npm run ingest` or `/deals/ingest-docs`, source `.docx` files are safely deleted only after database records are persisted.
- **Safety Guarantee**: Files are **never deleted** if ingestion fails or throws. Automated routines **never touch `uploads/deal-files/`** (permanent attachments).
- **Google Drive Files**: Left in Google Drive unless `DRIVE_TRASH_PROCESSED_FILES=true` is explicitly set. Trashing uses Google Drive Trash (never permanent delete).

### Manual Trigger
You can trigger Drive ingestion manually via HTTP:
```bash
curl -X POST https://<your-render-app>.onrender.com/admin/ingest/drive \
  -H "x-cron-secret: <CRON_SECRET>"
```
Or authenticate from the CRM frontend as an admin user using standard JWT Bearer token.

### Drive Status Diagnostic
Check Drive folder counts, MIME types, and database tracking without performing any ingestion:
```bash
npm run status:drive
```

## API overview

Auth:

- Routes under `/deals`, `/assistant`, `/conversations` are protected by JWT middleware.
- `/auth/*` is used for login.

### Transcript ingestion (runs the full pipeline)

Endpoint:

- `POST /deals/ingest-transcript`

Upload:

- `multipart/form-data`
- field name: `transcript`
- supported format: `.docx`

Behavior:

- extracts raw text from the uploaded docx
- extracts deal info + embeddings
- inserts/updates `deals` and `meetings`
- writes `deal_insights`
- re-scores the founder(s)
- cleans up the temporary uploaded file

### Deal file attachments

Endpoint:

- `POST /deals/:id/files`

Upload:

- `multipart/form-data`
- field name: `files` (can be multiple files)

Behavior:

- saves metadata into `deal_files`
- currently stores files locally under `backend/uploads/deal-files`
- server serves them via `GET /uploads/deal-files/*` (configured in `server.js`)

### File cleanup

- `DELETE /deals/:dealId/files/:fileId` removes both:
  - the database row (`deal_files`)
  - the corresponding local file in `uploads/deal-files/`

## Internal docs

- `backend-workflow.md` - architecture + ingestion flow overview

