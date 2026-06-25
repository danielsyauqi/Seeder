# Docker Quick Start

## 1. Configure

```sh
cp .env.example .env
```

Edit `.env` — set at minimum:
- `OWNER_EMAIL` — your email (first sign-in creates the owner account)
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`

## 2. Build & run

```sh
docker compose build
docker compose up -d
```

Migrations run automatically. Open `http://localhost:3000/sign-in`.

## 3. Day-to-day

```sh
docker compose down       # stop (data survives)
docker compose up -d      # start
docker compose logs -f    # tail logs
docker compose down -v    # wipe data (irreversible)
```
