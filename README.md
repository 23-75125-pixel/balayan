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

