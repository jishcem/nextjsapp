# Deploy Runbook — GitHub Actions → AWS Lightsail

Step-by-step manual setup for the CI/CD pipeline. Execute the phases in order —
do the **server + secrets setup before the first push**, because the first push
is what triggers a deploy.

Design reference: `docs/superpowers/specs/2026-07-11-cicd-github-actions-lightsail-design.md`
Hosting reference: `docs/hosting-and-deployment.md`

> Substitute `<LIGHTSAIL_IP>` with your instance's static IP throughout.

**Model:** build in CI, ship the compiled standalone artifact via rsync, `pm2 reload`.
The server only runs `node server.js` — it never builds.

---

## Phase 1 — Repo files (on your Mac)

**1.1** `next.config.ts` — enable standalone output (already applied):
```ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: { root: __dirname },
  output: "standalone",
};

export default nextConfig;
```

**1.2** Pin pnpm so CI uses your exact version. In `package.json` (top level):
```json
"packageManager": "pnpm@11.5.2",
```

**1.3** Create `ecosystem.config.js` at the repo root:
```js
module.exports = {
  apps: [
    {
      name: "main-website",
      script: "server.js",
      cwd: "/home/ubuntu/Code/app",
      instances: 1,
      exec_mode: "fork",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
        HOSTNAME: "127.0.0.1"  // bind to localhost; Nginx proxies to it
      }
    }
  ]
};
```

**1.4** Create `.github/workflows/deploy.yml`:
```yaml
name: Deploy to Lightsail

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        # --ignore-scripts: sharp & unrs-resolver ship prebuilt native binaries,
        # so build scripts aren't needed; avoids pnpm's ERR_PNPM_IGNORED_BUILDS.
        run: pnpm install --frozen-lockfile --ignore-scripts

      - name: Lint
        run: pnpm lint

      - name: Typecheck
        run: pnpm exec tsc --noEmit

      - name: Build
        run: pnpm build

      - name: Assemble deploy bundle
        run: |
          rm -rf deploy && mkdir -p deploy
          cp -r .next/standalone/. deploy/
          mkdir -p deploy/.next
          cp -r .next/static deploy/.next/static
          [ -d public ] && cp -r public deploy/public || true
          cp ecosystem.config.js deploy/

      - name: Setup SSH
        run: |
          mkdir -p ~/.ssh
          echo "${{ secrets.SSH_PRIVATE_KEY }}" > ~/.ssh/id_deploy
          chmod 600 ~/.ssh/id_deploy
          echo "${{ secrets.SSH_KNOWN_HOSTS }}" > ~/.ssh/known_hosts

      - name: Rsync to server
        run: |
          rsync -az --delete \
            --exclude '.env.production' \
            -e "ssh -i ~/.ssh/id_deploy" \
            deploy/ ${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }}:/home/ubuntu/Code/app/

      - name: Reload app
        run: |
          ssh -i ~/.ssh/id_deploy ${{ secrets.SSH_USER }}@${{ secrets.SSH_HOST }} \
            "cd /home/ubuntu/Code/app && (pm2 reload main-website || pm2 start ecosystem.config.js) && pm2 save"
```

> **Do not push yet** — finish Phases 2–4 first.

### What the "Assemble deploy bundle" step does

Next.js standalone output is a *minimal* server that deliberately omits the
client static assets and `public/`. This step rebuilds a complete, runnable
`deploy/` directory:

| Line | Purpose |
|---|---|
| `rm -rf deploy && mkdir -p deploy` | Start from a clean, empty bundle dir (idempotent). |
| `cp -r .next/standalone/. deploy/` | Copy the standalone server: `server.js`, trimmed `node_modules/`, `package.json`, `.next/server/`. Trailing `/.` includes dot-entries like `.next`. |
| `mkdir -p deploy/.next` | Ensure `.next` exists before adding `static` (defensive no-op). |
| `cp -r .next/static deploy/.next/static` | Add client JS/CSS chunks — **not** in standalone; without them the browser 404s all assets. |
| `[ -d public ] && cp -r public deploy/public \|\| true` | Add `public/` (favicon, images) if present; `\|\| true` keeps the step green when there is none. |
| `cp ecosystem.config.js deploy/` | Ship the PM2 config so first-deploy `pm2 start ecosystem.config.js` works. |

Resulting layout rsynced to the server:
```
deploy/
├── server.js            ← standalone entry (run by PM2)
├── package.json
├── node_modules/        ← traced, minimal
├── ecosystem.config.js  ← PM2 config (added)
├── .next/
│   ├── server/          ← from standalone
│   └── static/          ← client JS/CSS (added)
└── public/              ← static assets (added, if present)
```

---

## Phase 2 — Generate the runner→server SSH key (on your Mac)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/lightsail_deploy -N "" -C "gha-deploy"
```
Creates `~/.ssh/lightsail_deploy` (private → GitHub secret) and
`~/.ssh/lightsail_deploy.pub` (public → server).

---

## Phase 3 — One-time server prep (SSH into Lightsail)

Run these **on the server** (connect with your normal Lightsail key first):

**3.1** App directory:
```bash
mkdir -p /home/ubuntu/Code/app
```

**3.2** Authorize the deploy key — paste the contents of
`~/.ssh/lightsail_deploy.pub` (from your Mac):
```bash
echo "PASTE_THE_PUBLIC_KEY_LINE_HERE" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

**3.3** Env file for future secrets (empty now; rsync never overwrites it):
```bash
touch /home/ubuntu/Code/app/.env.production
```

**3.4** PM2 on boot (run the `sudo ... pm2 startup ...` line it prints):
```bash
pm2 startup
```

**3.5** Nginx reverse proxy:
```bash
sudo tee /etc/nginx/sites-available/main-website >/dev/null <<'EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/main-website /etc/nginx/sites-enabled/main-website
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

**3.6** In **Lightsail console → Networking**, allow **HTTP (80)** and **HTTPS (443)**.
(SSL via Cloudflare/Certbot later — see `docs/hosting-and-deployment.md`.)

---

## Phase 4 — GitHub secrets (on your Mac)

**4.1** Get the server host key:
```bash
ssh-keyscan -H <LIGHTSAIL_IP>
```

**4.2** Add four repo secrets (web UI or `gh` CLI):
```bash
gh secret set SSH_PRIVATE_KEY < ~/.ssh/lightsail_deploy
gh secret set SSH_HOST --body "<LIGHTSAIL_IP>"
gh secret set SSH_USER --body "ubuntu"
ssh-keyscan -H <LIGHTSAIL_IP> | gh secret set SSH_KNOWN_HOSTS
```

| Secret | Value |
|---|---|
| `SSH_PRIVATE_KEY` | private key the runner uses to reach Lightsail |
| `SSH_HOST` | Lightsail static IP |
| `SSH_USER` | `ubuntu` |
| `SSH_KNOWN_HOSTS` | server host key (from `ssh-keyscan`) |

---

## Phase 5 — First deploy

```bash
git add next.config.ts package.json ecosystem.config.js .github/workflows/deploy.yml
git commit -m "Add GitHub Actions deploy pipeline for Lightsail"
git push origin main
```
Watch it:
```bash
gh run watch
```
On the first run, `pm2 reload` finds nothing so the `|| pm2 start` fallback starts
the app, then `pm2 save` persists it.

---

## Phase 6 — Verify

```bash
curl -I http://<LIGHTSAIL_IP>        # expect HTTP/1.1 200 OK
```
On the server:
```bash
pm2 list                              # main-website => online
pm2 logs main-website --lines 30
```
Then test the loop: make a trivial change, `git push`, confirm it auto-updates.

---

## Failure map

| Symptom | Likely cause |
|---|---|
| Workflow fails at **Reload app** with host-key error | `SSH_KNOWN_HOSTS` wrong/missing → re-run 4.1 |
| Reload step: `Permission denied (publickey)` | public key not in server `authorized_keys` (3.2), or wrong `SSH_PRIVATE_KEY` |
| `curl` connection refused | Nginx not proxying (3.5) or app not on :3000 (`pm2 logs`) |
| 502 Bad Gateway | app crashed — check `pm2 logs main-website` |
| Lint/typecheck fails the build | fix locally, or temporarily drop those two steps while scaffolding |

---

## Notes

- **Env vars:** server-only runtime secrets (Resend key, auth secret, DB path) go in
  `/home/ubuntu/Code/app/.env.production` on the server (rsync-excluded). Build-time
  `NEXT_PUBLIC_*` values must exist during the CI build instead.
- **SQLite (future):** keep the DB file **outside** the deploy dir (e.g.
  `/var/lib/main-website/data.db`) so `rsync --delete` never wipes it.
- **Rollback:** revert the commit and re-push, or re-run a previous successful workflow.
- **pnpm build scripts (`ERR_PNPM_IGNORED_BUILDS`):** newer pnpm hard-fails CI installs
  when a dependency has an unapproved build script. `sharp` and `unrs-resolver` only
  need their prebuilt native binaries, so the install uses `--ignore-scripts`. The
  `onlyBuiltDependencies` allowlist in `pnpm-workspace.yaml` was NOT honored by the
  pnpm build in use, so do not rely on it. If a future dependency genuinely needs to
  compile from source (no prebuilt binary), drop `--ignore-scripts` and instead run a
  `pnpm rebuild <pkg>` step after install, or pin/approve builds once pnpm's workspace
  allowlist works in your version.
