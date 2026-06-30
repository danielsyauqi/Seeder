# Docker Quick Start

## 1. Configure

```sh
cp .env.example .env
```

Edit `.env` — set at minimum:
- `OWNER_EMAIL` — your email (first sign-in creates the owner account)
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`

## 2. Run (pre-built image from Docker Hub)

```sh
docker compose pull
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

---

## Building & publishing (maintainer)

Requires Docker Desktop with buildx. One-time builder setup:

```sh
docker buildx create --use --name multiarch --driver docker-container --bootstrap
```

Build and push multi-arch image (amd64 + arm64):

```sh
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --tag mrtimothyduong/seeder:latest \
  --push \
  .
```

The builder stage runs natively on the host arch (arm64 on Apple Silicon) for
both targets — only the lightweight prod-deps stage emulates amd64.
