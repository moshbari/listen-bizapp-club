# listen.bizapp.club

Upload an iPhone voice memo. Get a link. Share it. Anyone plays it in a browser.
No download. No login for listeners.

## How it works

1. Owner logs in with a password.
2. Uploads any audio file — `.m4a`, `.mp3`, `.wav`, `.aac`.
3. Server runs ffmpeg. Makes it a small mono MP3 (64 kbps).
4. If the MP3 is bigger than 24 MB, server splits it into 40-minute parts.
5. Each part uploads to GoHighLevel media library.
6. Owner gets a share link like `https://listen.bizapp.club/p/abc12xyz`.
7. Recipients open the link. Big play button. Part 2 plays on its own after Part 1.

## Stack

- Node.js 20 + Express
- SQLite (via `better-sqlite3`) for metadata
- ffmpeg for transcode + split
- curl for GHL uploads (Node's FormData fails on GHL's multipart parser)
- Docker + Coolify on Hetzner

## Env vars

See `.env.example`. Set these in Coolify, never commit.

## Local dev

```
npm install
export UPLOAD_PASSWORD=dev
export GHL_API_KEY=pit-...
export GHL_LOCATION_ID=MV4qgCBrDVTq6S9QIYNa
export GHL_FOLDER_ID=...
npm start
```

Requires `ffmpeg` and `curl` on your machine.
