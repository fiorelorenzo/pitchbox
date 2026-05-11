# Getting started

Pitchbox is a Node monorepo. You need:

- Node ≥ 22
- Docker (for the Postgres dev DB)
- The `claude` CLI logged into a Claude subscription (the default agent runner)

## Install

```bash
git clone https://github.com/fiorelorenzo/pitchbox.git
cd pitchbox
npm install
cp .env.example .env  # then set ENCRYPTION_KEY (32-byte hex) and PITCHBOX_ROOT
```

`ENCRYPTION_KEY` protects account secrets at rest — generate one with `openssl rand -hex 32`.

## Database

```bash
npm run db:up                                 # boots Postgres on port 5434
npm run migrate                               # applies the latest Drizzle migrations
npm run -w @pitchbox/shared seed:core         # seeds platforms, default playbooks, quota defaults
```

## Run

```bash
npm run dev                # web dashboard on http://127.0.0.1:5180
npm run -w daemon dev      # optional: scheduler + reply poller
```

## Optional: turn on authentication

Pitchbox ships unauthenticated by default for single-user self-host. To gate the dashboard:

```bash
echo 'PITCHBOX_AUTH=on' >> .env
npm run dev
```

The first user you create via `/login` becomes the admin.

## Chrome extension

Build and load `extension/dist/` unpacked. See [the extension page](/extension) for the token wiring.
