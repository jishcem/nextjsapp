# CI/CD: GitHub Actions → AWS Lightsail (Design)

**Date:** 2026-07-11
**Status:** Approved (design)
**Repo:** `git@github.com:jishcem/nextjsapp.git` (branch `main`)

## Goal

Automate deployment of the Next.js app to a self-managed AWS Lightsail VM
(Ubuntu, x86_64) on every push to `main`, using GitHub Actions. Build happens
in CI; the server only runs the app.

## Context / Constraints

- **App:** Next.js 16 app (currently a fresh scaffold; contact form, admin panel,
  and one dynamic page + SQLite are planned but not yet built).
- **Server:** AWS Lightsail, Ubuntu (OS-only), **x86_64**, Nginx + PM2, Node 22.
  Small instance (1 GB) — must NOT build on the box (OOM risk).
- **Deploy model (chosen):** Build in CI, ship the compiled artifact.
  Rejected alternative: pull-and-build-on-server (slower, leans on swap, RAM-tight).
- **Arch:** server is x86_64 → build on GitHub's `ubuntu-latest` (x64) runner so
  future native modules (`better-sqlite3`) match.

## Deploy Flow

On push to `main` (and manual `workflow_dispatch`):

1. Checkout code
2. Setup Node 22 + pnpm (with caching)
3. `pnpm install --frozen-lockfile`
4. **Quality gate:** `pnpm lint` + `tsc --noEmit` typecheck
5. `pnpm build` → produces `.next/standalone/` (standalone output)
6. Assemble deploy bundle (standalone + static + public)
7. `rsync` bundle to Lightsail over SSH (excludes `.env.production`, DB data)
8. SSH in → `pm2 reload` the app (near-zero-downtime restart)

The server runs `node server.js` (standalone entry) under PM2 on `PORT=3000`.
Nginx reverse-proxies `:443` → `127.0.0.1:3000`.

```
GitHub Actions runner (x64)
  ├─ checkout
  ├─ pnpm install --frozen-lockfile
  ├─ lint + typecheck
  ├─ next build      (output: standalone)
  ├─ assemble bundle (.next/standalone + .next/static + public)
  └─ rsync → Lightsail:/home/ubuntu/Code/app
        └─ ssh: pm2 reload app

Lightsail box: only RUNS the app (never builds)
  Nginx :443 ──► 127.0.0.1:3000 (node server.js via PM2)
```

## Repo Changes

### 1. `next.config.ts` — enable standalone output
```ts
const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: { root: __dirname },   // existing
};
```
Standalone emits `.next/standalone/` with a minimal `server.js` + only the
traced `node_modules`. The workflow copies `.next/static` and `public/` into the
bundle (Next does not copy these automatically).

### 2. `.github/workflows/deploy.yml` — the pipeline
- Triggers: `push` to `main`, `workflow_dispatch`
- Runner: `ubuntu-latest`, Node 22, pnpm + cache (pnpm store + `.next/cache`)
- Steps as in Deploy Flow above
- SSH with **known-hosts verification** (NOT `StrictHostKeyChecking=no`)

### 3. `ecosystem.config.js` — PM2 process definition (committed)
Defines the app: name, `script: server.js`, `cwd: /home/ubuntu/Code/app`,
`env: { PORT: 3000, NODE_ENV: production }`.

## Secrets (GitHub repo → Settings → Secrets and variables → Actions)

A **dedicated runner→server SSH key** (generated for this purpose only):

| Secret | Value |
|---|---|
| `SSH_PRIVATE_KEY` | private key the runner uses to reach Lightsail |
| `SSH_HOST` | Lightsail static IP |
| `SSH_USER` | `ubuntu` |
| `SSH_KNOWN_HOSTS` | server host key (`ssh-keyscan <ip>`) for verification |

Note: because the server never pulls from GitHub in this model, the git deploy
key discussed earlier is NOT needed. This runner→server key replaces it.

## One-Time Server Prep (manual, over SSH)

- App directory: **`/home/ubuntu/Code/app`**
- Add the runner's **public** key to `~/.ssh/authorized_keys`
- Place `ecosystem.config.js` reference / start app via PM2: `pm2 start ecosystem.config.js`
- `pm2 startup` + `pm2 save` (survive reboots)
- Nginx server block: proxy `127.0.0.1:3000`; SSL via Let's Encrypt or Cloudflare
- **`.env.production` on the server** (Resend key, auth secret, DB path, etc.)
  — **rsync excludes it** so deploys never overwrite secrets

## Future-Proofing (SQLite — not built yet)

- DB file lives **outside** the deploy dir, e.g. `/var/lib/main-website/data.db`,
  referenced by env — so `rsync --delete` never wipes data.
- `better-sqlite3` compiles on the x64 runner → matches x64 server.

## Deploy Style Decision

**Simple** (chosen): rsync into the app dir + `pm2 reload`.
Rejected: releases-folder + symlink (instant rollback) — more machinery than a
small site needs. Rollback path if needed: revert the commit and re-push, or
re-run a previous successful workflow.

## Out of Scope (for this pipeline setup)

- Building the contact form, admin panel, dynamic page, or DB schema.
- SSL cert issuance and Nginx config (documented in
  `docs/hosting-and-deployment.md`; done during server setup).
- Staging environment / multi-branch deploys (single `main` → prod only).

## Success Criteria

- Push to `main` triggers the workflow.
- Workflow fails fast on lint/type errors (nothing broken gets deployed).
- On success, the new build is live on the server via `pm2 reload` with no
  manual steps and no downtime.
- Server never runs `next build`.
- Secrets on the server are never overwritten by a deploy.
