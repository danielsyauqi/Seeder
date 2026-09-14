# Docker Quick Start

## 1. Configure

```sh
cp .env.example .env
```

Edit `.env` — set at minimum:
- `OWNER_EMAIL` — your email (first sign-in creates the owner account)
- `BETTER_AUTH_SECRET` — `openssl rand -base64 32`
- `VCS_ENCRYPTION_KEY` — generate separately with `openssl rand -base64 32`;
  required in production from 2.1, even without a connected Git repository.

## 2. Run (pre-built image from GHCR)

The Compose file pulls the official `ghcr.io/danielsyauqi/seeder:latest` image,
which is published for both amd64 and arm64.

The same image is also mirrored to Docker Hub as
`danielsyauqi/seeder-oss:latest`.

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

## Building locally

Build the image for the current platform:

```sh
docker build --tag seeder:local .
```

Maintainers publish the multi-platform GHCR and Docker Hub images through the
`Publish container image` GitHub Actions workflow. Pushes to `main` publish
`latest` and an immutable `sha-<commit>` tag; version tags such as `v2.1.0`
also publish `2.1.0` and `2.1` tags.

After the package is published for the first time, its visibility must be set
to **Public** in the package settings so users can pull it without signing in.
