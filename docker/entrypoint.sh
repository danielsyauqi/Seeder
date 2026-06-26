#!/bin/sh
set -e

# Fix ownership of the data directory in case the host volume was created as
# root:root (common on Linux when the Docker daemon creates the named volume).
chown seeder:seeder /app/data

echo "Running migrations…"
gosu seeder node /app/migrate.js

echo "Starting server…"
exec gosu seeder node /app/server.js
