# Running Tracker

Personal running tracker: log runs, see weekly mileage and pace trends, track a
weekly mileage goal and an upcoming race.

Node + Express + Postgres, vanilla HTML/SVG frontend. Deployed on Railway.

## Environment variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (Railway reference: `${{Postgres.DATABASE_URL}}`) |
| `APP_PASSWORD` | Login password. If unset, the app runs without a login gate. |
| `PORT` | Listen port (Railway sets this automatically) |

## Run locally

```bash
npm install
DATABASE_URL=postgres://localhost/running_tracker APP_PASSWORD=dev npm start
```

The schema (a `runs` table and a single-row `settings` table for goals) is
created automatically on boot.

## API

- `POST /api/login` / `POST /api/logout` — password gate (cookie session)
- `GET|POST /api/runs`, `PUT|DELETE /api/runs/:id` — run CRUD
- `GET|PUT /api/goals` — weekly mileage target + race goal
- `GET /healthz` — health check
