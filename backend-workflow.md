# Backend Core Workflow - CRM MVP

This document provides a comprehensive overview of the backend architecture, core workflows, and file structure for the CRM MVP. 

The backend is built with **Node.js** and **Express.js**, utilizing a serverless **PostgreSQL** database (via **Neon**) extended with `pgvector` for AI embeddings. It heavily integrates with Google's **Gemini AI** (`@google/genai`) for extracting structured deal information from unstructured transcripts, calculating founder scores, and powering a Retrieval-Augmented Generation (RAG) assistant.

---

## 🏗️ Architecture & Tech Stack

*   **Server Frameowork:** Node.js + Express.js
*   **Database:** Serverless PostgreSQL (Neon) with `pgvector` extension.
*   **LLMs / AI Integrations:** `@google/genai` (Gemini 2.0 Flash for structured extraction; Gemini 3.1 Flash Lite for chat streaming).
*   **Auth:** JWT (`jsonwebtoken`) against environment variable credentials.
*   **File Handling:** `multer` (for static deal file uploads) and `mammoth` (for extracting text from `.docx` transcripts).

---



## 🔄 Core Workflows

### 1. Document Ingestion & Deal Extraction
This is the primary automated pipeline that populates the CRM. It runs via the `/deals/ingest-docs` route or local CLI scripts (`npm run ingest`).

1.  **Reading Files (`services/docxReader.js`):** Reads `.docx` meeting transcripts from local directories or Google Drive using `mammoth`.
2.  **AI Extraction (`services/dealExtraction.js`):** Passes the raw transcript text to **Gemini 2.0 Flash**, which is prompted to return structured JSON (deal insights, founder pitch, business model, risks, investor reactions).
3.  **Text Embedding (`services/embeddings.js`):** The transcript is converted into a 1536-dimensional vector using Google GenAI embeddings.
4.  **Founder Scoring (`services/founderScoring.js`):** The extracted "facts" are passed through a scoring algorithm that evaluates **Hard Scores** (education, domain experience) and **Soft Scores** (resilience, ambition, storytelling). The system normalizes these into a weighted final score and assigns a Due Diligence (DD) recommendation.
5.  **Database Storage (`db/neon.js`):** 
    *   The transcript and its vector are saved to the `meetings` table.
    *   The core metadata is saved to the `deals` table.
    *   Detailed insights and scores are spread across normalized tables (`deal_insights`, `founder_signals`, `founder_scores`, etc.).

### 2. CRM Deal Management API (`routes/deals.js`)
The API serves the frontend interface for managing deal flow.

*   **CRUD Operations:** Fetch lists of deals, get individual deal details, scores, and deep-dive insights.
*   **File Uploads:** Uses `multer` to accept multipart/form-data. Supplementary deal files (e.g., pitch decks) are saved locally to `uploads/deal-files/` and their metadata is mapped in the `deal_files` table.

### 3. AI Assistant (RAG Chat) (`routes/assistant.js` & `routes/conversations.js`)
A conversational assistant that can answer questions based on the ingested transcripts.

1.  **Session Management:** `conversations.js` handles creating chat threads and saving message history (`conversation_messages`).
2.  **Semantic Search (`services/retrieval.js`):** When a user asks a question, the query is embedded into a vector. The backend performs a cosine similarity search (`<=>`) against the `meetings.embedding` column in PostgreSQL to find the most relevant transcript segments.
3.  **LLM Generation (`services/llm.js`):** The retrieved context and previous chat history are injected into a prompt for **Gemini 3.1 Flash Lite**, which streams (`streamChat`) a context-aware response back to the client.

### 4. Authentication (`routes/auth.js` & `middleware/auth.js`)
A lightweight, environment-variable-backed authentication system.
*   A `POST /auth/login` checks the username and password against `.env` values.
*   Returns a 24-hour **JWT token**.
*   The `authMiddleware` validates this token via the `Authorization: Bearer <token>` header for all protected routes (`/deals`, `/assistant`, `/conversations`).

---

## 📂 Directory Structure

*   **`/db`**: Contains `neon.js` which manages the PostgreSQL connection pool, helper `sql` execution functions, and the `initSchema()` logic defining all tables and vector extensions.
*   **`/routes`**: Express route definitions mapping HTTP requests to logic.
    *   `auth.js` - Login and JWT issuance.
    *   `deals.js` - Deal retrieval, scoring, file uploads, and ingestion triggers.
    *   `assistant.js` - AI chat generation endpoint.
    *   `conversations.js` - Chat history CRUD.
*   **`/services`**: Reusable business logic, abstracted from HTTP transport.
    *   `dealExtraction.js` - Prompts Gemini to parse transcripts into JSON objects.
    *   `founderScoring.js` - Algorithm for weighting hard and soft founder traits.
    *   `embeddings.js` / `llm.js` / `retrieval.js` - GenAI wrappers for vector embeddings, streaming chat, and RAG retrieval.
    *   `docxReader.js` - Wraps `mammoth` for local parsing.
    *   `ingestDocs.js` - The master orchestrator function for the ingestion pipeline.
*   **`/pipelines` & `/scripts`**: CLI entry points for one-off operations (e.g., local ingestion from folders, pulling from Google Drive, backfilling scores).
*   **`/uploads`**: Local directory for serving static uploaded deal assets.
*   **`server.js`**: The Express application entry point. Handles middleware initialization (CORS, JSON parsing), schema initialization, static file serving, and router mounting.