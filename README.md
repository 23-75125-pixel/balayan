# Balayan Smashers Hub

Multi-page storefront with a small Node API layer in front of a local SQLite database.

## Clean structure

```text
.
├── public/
│   ├── *.html
│   └── photos/
├── assets/
│   ├── css/
│   └── js/
├── data/
│   └── bsh.sqlite
├── server.js
├── package.json
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

## Setup

1. Copy `.env.example` to `.env`.
2. Start the app. The SQLite database is created automatically on first run.
3. Uploaded product photos are stored in `public/uploads/` and the database file lives in `data/bsh.sqlite`.

## Run with Docker

```bash
sudo docker compose up -d --build
```

Open http://localhost:8000.

## Architecture

The browser loads `public/*.html`, shared styles from `assets/css`, and the app modules from `assets/js`.

The Node server in `server.js` exposes:

- `/api/auth/*` for login, signup, logout, and password updates
- `/api/db/*` for table reads and writes
- `/api/storage/*` for product image uploads and removals
- `/config/runtime-config.js` for the public runtime config

## Admin setup

Create a user through the app, then set that user's `role` to `admin` in the local SQLite database.

```sql
update profiles
set role = 'admin'
where id = 'PASTE_USER_ID_HERE';
```

If you want to inspect the local database, open `data/bsh.sqlite` with any SQLite browser.

## Notes

- `docker-compose.yml` mounts `data/` and `public/uploads/` so the SQLite database and uploaded images persist.
- The old root-level HTML/CSS/JS entry points were moved under `public/` and `assets/`.
- Image assets stay under `public/photos/` and are baked into the Docker image.

## Deploy to Render

This repository includes a `render.yaml` that configures a Render.com web service using the included `Dockerfile` and attaches a Persistent Disk for SQLite and uploaded files.

Quick steps:

- Push this repository to GitHub (or GitLab).
- On Render, create a new service and connect the repository. Render will read `render.yaml` and create the web service automatically.

Manual setup (if you prefer the UI):

- Create a new **Web Service** and choose **Docker** as the environment.
- Set the **Dockerfile path** to `Dockerfile`.
- Add these environment variables:
	- `PORT` = `8000`
	- `SQLITE_DB_PATH` = `/disk/data/bsh.sqlite`
	- `UPLOAD_DIR` = `/disk/uploads`
	- `UPLOAD_BUCKET_NAME` = `product-images`
	- `MAX_UPLOAD_BYTES` = `5242880`
- Add a **Persistent Disk** and mount it at `/disk` (1 GB is usually sufficient).

Why this is required:

- Render instances are ephemeral; attaching a Persistent Disk ensures the SQLite database and uploaded images persist across deploys and restarts.
- The `Dockerfile` creates the `/disk/data` and `/disk/uploads` directories so the mounted volume is ready at runtime.

After deployment, your app will be available at the service URL Render provides. The server listens on the `PORT` environment variable and uses the mounted `/disk` for persistent storage.


