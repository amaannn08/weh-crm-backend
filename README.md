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
- `npm run ingest:drive` - ingest transcripts from Google Drive (needs Drive env vars)

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

