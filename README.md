# Seedance Video Studio

Generate 15-second 16:9 videos with sound from a reference image + text prompt using **Seedance 2.0** via [useapi.net](https://useapi.net). Built to deploy on **Railway** straight from GitHub.

## Features
- Upload one reference image + a text prompt
- Backend uploads the asset, kicks off a `seedance-2` task (15s, 16:9, 720p, audio on), and polls until ready
- Frontend grid shows live status, plays each video, and persists history in `localStorage`
- Download each video individually, or **Download all (.zip)** for bulk export

## Stack
- Node.js + Express (single `server.js`)
- `multer` (in-memory upload), `archiver` (bulk zip)
- Vanilla HTML/CSS/JS frontend served from `/public`

## Prerequisites

useapi.net brokers Runway access through one or more **Runway accounts you link inside the useapi.net dashboard**. Before this app can generate anything:

1. Sign in at [useapi.net](https://useapi.net) and grab your bearer token.
2. Link at least one Runway account (`POST /runwayml/accounts/{email}` in the useapi.net dashboard or via API). Confirm via `GET /runwayml/accounts/`.
3. With **one** linked account, useapi.net auto-selects it. With **multiple**, it load-balances unless you pin one via the `RUNWAY_EMAIL` env var.

Once deployed you can hit `GET /api/accounts` on your own server to confirm which Runway accounts useapi.net sees.

## Local development

```bash
npm install
export USEAPI_TOKEN=your_useapi_net_bearer_token   # PowerShell: $env:USEAPI_TOKEN="..."
npm start
```

Open http://localhost:3000.

## Deploy to Railway

1. Push this repo to GitHub.
2. In Railway: **New Project → Deploy from GitHub Repo** and pick the repo.
3. Add environment variables:
   - `USEAPI_TOKEN = <your useapi.net bearer token>` (required)
   - `RUNWAY_EMAIL = <linked Runway account email>` (optional — pin a specific account when multiple are linked)
4. Railway auto-detects Node and runs `npm start` (also pinned in `railway.json`). The app binds to `process.env.PORT`.
5. Generate a public domain in the Railway service settings.

## API surface

| Method | Path                       | Purpose                                            |
| ------ | -------------------------- | -------------------------------------------------- |
| POST   | `/api/generate`            | multipart: `image` + `prompt` → returns `taskId`   |
| GET    | `/api/status/:taskId`      | poll status; returns `videoUrl` when `SUCCEEDED`   |
| GET    | `/api/download/:taskId`    | proxies the MP4 (single-file download / playback)  |
| POST   | `/api/download-bulk`       | body `{ taskIds: [...] }` → streams a `.zip`       |
| GET    | `/api/accounts`            | lists linked Runway accounts useapi.net sees       |
| GET    | `/healthz`                 | health check                                       |

## Notes
- The backend always submits `model=seedance-2`, `duration=15`, `aspect_ratio=16:9`, `resolution=720p`, `audio=true`.
- Videos are streamed through the server so downloads work cross-origin and the API token never reaches the browser.
- History is stored client-side in `localStorage`; clearing the browser store doesn't delete videos on Runway.
