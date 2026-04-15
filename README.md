# Invoice Processing Dashboard

A professional, full-stack invoice extraction dashboard that accepts PDF and image invoices, uses Gemini multimodal AI for data extraction, and provides a review workflow with editable fields, approval actions, and CSV export.

---

## Project Overview

This project is built as a monorepo and focuses on a production-style invoice workflow:

- Upload invoice files (`pdf`, `png`, `jpg`, `jpeg`, `webp`)
- Extract structured invoice data using Gemini
- Review and edit extracted values in a clean dashboard UI
- Retry processing when needed
- Approve finalized invoices
- Download extracted data as CSV

The app is designed to feel fast and interactive, with dark/light theme support and smooth transitions in the frontend.

---

## Tech Stack

### Frontend (`apps/web`)

- React 18 + TypeScript
- Vite
- Tailwind CSS
- LocalStorage caching for invoice list and UI state

### Backend (`apps/api`)

- Node.js + Express + TypeScript
- Zod for request payload validation
- Gemini API (multimodal file extraction)
- In-memory store for invoice metadata and extracted payloads (MVP)

### Worker (`apps/worker`)

- TypeScript worker placeholder process (heartbeat mode)
- Ready to be upgraded to queue-driven processing (Redis/BullMQ) for scale

---

## Architecture

1. User uploads file from the frontend.
2. API stores invoice metadata and queues processing state.
3. Gemini extraction runs with model fallback and retry handling.
4. Invoice status transitions:
   - `queued` -> `processing` -> `processed` / `needs_review` / `failed`
   - optional final status: `approved`
5. Frontend polls invoice status, renders extracted data, and enables:
   - retry
   - edit and save extracted fields
   - approve
   - CSV download

---

## Features Implemented

- PDF + image upload support
- Gemini multimodal extraction
- Model fallback and retry strategy
- Rate-limit handling (`429`) without crashing API
- Review status and meaningful validation messages
- Editable extraction form and line-item table
- Invoice approval flow
- CSV export endpoint and download button
- Document preview:
  - embedded PDF preview
  - image preview for JPEG/PNG/WEBP
- Dark/light theme toggle
- Smooth dashboard UI with Tailwind and lightweight animation

---

## Monorepo Structure

```text
apps/
  api/      # Express API + extraction orchestration
  web/      # React + Tailwind dashboard
  worker/   # Worker placeholder (heartbeat)
```

---

## Environment Configuration

Create and configure:

- `apps/api/.env`

Example:

```env
GEMINI_API_KEY=your_real_key_here
API_PORT=4000
GEMINI_MODEL_PRIMARY=gemini-2.0-flash
GEMINI_MODEL_FALLBACK=gemini-2.0-flash-lite
```

Notes:

- `GEMINI_API_KEY` is required.
- If a model is unavailable, the API attempts fallback/discovered models.

---

## Getting Started

### 1) Install dependencies

```bash
npm install
```

### 2) Add environment variables

Create `apps/api/.env` and set your Gemini API key.

### 3) Run the project

```bash
npm run dev
```

### 4) Open the frontend

- [http://localhost:5173](http://localhost:5173)

---

## Build for Production

```bash
npm run build
```

This builds:

- `apps/api`
- `apps/web`
- `apps/worker`

---

## API Endpoints

### Health

- `GET /health`

### Invoice Lifecycle

- `POST /invoices` -> create and start extraction
- `GET /invoices` -> list invoices
- `GET /invoices/:id` -> fetch single invoice
- `POST /invoices/:id/retry` -> retry processing same source file

### Review & Approval

- `PATCH /invoices/:id/extracted` -> save edited extraction
- `POST /invoices/:id/approve` -> mark invoice as approved

### Preview & Export

- `GET /invoices/:id/source` -> source file base64 + mimeType for preview
- `GET /invoices/:id/csv` -> download extracted invoice as CSV

---

## Current Limitations (MVP)

- Persistence is in-memory on API side (data resets on server restart).
- Frontend caches invoice data in browser `localStorage`.
- No authentication/authorization yet.
- Worker is placeholder (not yet handling distributed queue processing).

---

## Production-Grade Next Steps

- Add Postgres + Prisma for persistent storage
- Move processing to Redis/BullMQ worker queue
- Add OCR fallback pipeline for low-quality scans
- Add auth + role-based reviewer approvals
- Add audit logs/version history for edited fields
- Add vendor template intelligence and duplicate detection
- Add observability (metrics, tracing, alerting)

---

## GitHub Repository Description (Suggested)

Use this as your GitHub repo short description:

> AI-powered invoice processing dashboard with PDF/image upload, Gemini extraction, editable review workflow, approval flow, and CSV export.
