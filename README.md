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
3. Add an environment variable: `USEAPI_TOKEN = <your token>`.
4. Railway auto-detects Node and runs `npm start` (also pinned in `railway.json`). The app binds to `process.env.PORT`.
5. Generate a public domain in the Railway service settings.

## API surface

| Method | Path                       | Purpose                                            |
| ------ | -------------------------- | -------------------------------------------------- |
| POST   | `/api/generate`            | multipart: `image` + `prompt` → returns `taskId`   |
| GET    | `/api/status/:taskId`      | poll status; returns `videoUrl` when `SUCCEEDED`   |
| GET    | `/api/download/:taskId`    | proxies the MP4 (single-file download / playback)  |
| POST   | `/api/download-bulk`       | body `{ taskIds: [...] }` → streams a `.zip`       |
| GET    | `/healthz`                 | health check                                       |

## Notes
- The backend always submits `model=seedance-2`, `duration=15`, `aspect_ratio=16:9`, `resolution=720p`, `audio=true`.
- Videos are streamed through the server so downloads work cross-origin and the API token never reaches the browser.
- History is stored client-side in `localStorage`; clearing the browser store doesn't delete videos on Runway.
