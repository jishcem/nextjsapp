Here's the full runbook. It's ordered so nothing fails for lack of a prerequisite — do the server + secrets setup before the final push, because the first push is what triggers the deploy. Substitute <LIGHTSAIL_IP> with your instance's static IP throughout.

I've kept it as commands + file contents you create by hand (matching how you did next.config.ts yourself). Your next.config.ts already has output: 'standalone' ✅ — so Phase 1 step 1 is done.

---
Phase 1 — Repo files (on your Mac)

1.1 next.config.ts → already has output: 'standalone'. Done.

1.2 Pin pnpm so the CI runner uses your exact version. Add this line to package.json (top level, e.g. after "private": true,):
"packageManager": "pnpm@11.5.2",

1.3 Create ecosystem.config.js at the repo root:
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

1.4 Create .github/workflows/deploy.yml:
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
        run: pnpm install --frozen-lockfile

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

Don't push yet — finish the server + secrets first.

---
Phase 2 — Generate the runner→server SSH key (on your Mac)

2.1 Create a dedicated keypair (no passphrase, so CI can use it):
ssh-keygen -t ed25519 -f ~/.ssh/lightsail_deploy -N "" -C "gha-deploy"
This makes ~/.ssh/lightsail_deploy (private) and ~/.ssh/lightsail_deploy.pub (public).

---
Phase 3 — One-time server prep (SSH into Lightsail)

SSH in using your normal Lightsail key, then run these on the server:

3.1 Create the app directory:
mkdir -p /home/ubuntu/Code/app

3.2 Authorize the deploy key. Paste the contents of ~/.ssh/lightsail_deploy.pub (from your Mac — cat ~/.ssh/lightsail_deploy.pub) into the server's authorized_keys:
echo "PASTE_THE_PUBLIC_KEY_LINE_HERE" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys

3.3 Create an env file for future secrets (empty for now; rsync will never overwrite it):
touch /home/ubuntu/Code/app/.env.production

3.4 Set PM2 to start on boot (run the command it prints, it'll include sudo):
pm2 startup
# copy-paste and run the "sudo env PATH=... pm2 startup systemd ..." line it outputs

3.5 Configure Nginx to proxy to the app. Create the site config:
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

3.6 In the Lightsail console → Networking tab, make sure the firewall allows HTTP (80) and HTTPS (443). (SSL via Cloudflare/Certbot comes later — see docs/hosting-and-deployment.md.)

---
Phase 4 — GitHub secrets (on your Mac)

4.1 Get the server's host key for verification:
ssh-keyscan -H <LIGHTSAIL_IP>
Copy the entire output (all lines).

4.2 Add four repo secrets — either via the web UI (repo → Settings → Secrets and variables → Actions → New repository secret) or with the gh CLI:
gh secret set SSH_PRIVATE_KEY < ~/.ssh/lightsail_deploy
gh secret set SSH_HOST --body "<LIGHTSAIL_IP>"
gh secret set SSH_USER --body "ubuntu"
ssh-keyscan -H <LIGHTSAIL_IP> | gh secret set SSH_KNOWN_HOSTS

---
Phase 5 — First deploy

5.1 Commit and push the repo files — this triggers the workflow:
git add next.config.ts package.json ecosystem.config.js .github/workflows/deploy.yml
git commit -m "Add GitHub Actions deploy pipeline for Lightsail"
git push origin main

5.2 Watch it run:
gh run watch
The Reload app step runs pm2 reload || pm2 start, so on this first run it will start the app (reload finds nothing), then pm2 save persists it.

---
Phase 6 — Verify

6.1 From your Mac, hit the server:
curl -I http://<LIGHTSAIL_IP>
Expect HTTP/1.1 200 OK. Or open http://<LIGHTSAIL_IP> in a browser.

6.2 On the server, confirm the process:
pm2 list          # main-website should be "online"
pm2 logs main-website --lines 30

6.3 Test the full loop: make a trivial change, git push, and confirm the site updates automatically.

---
Quick failure map

┌──────────────────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────┐
│                     Symptom                      │                               Likely cause                                │
├──────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Workflow fails at Reload app with host-key error │ SSH_KNOWN_HOSTS secret wrong/missing → re-run 4.1                         │
├──────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Reload step: Permission denied (publickey)       │ public key not in server's authorized_keys (3.2) or wrong SSH_PRIVATE_KEY │
├──────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ curl connection refused                          │ Nginx not proxying (3.5) or app not on :3000 (pm2 logs)                   │
├──────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ 502 Bad Gateway                                  │ app crashed — check pm2 logs main-website                                 │
├──────────────────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
│ Lint/typecheck fails the build                   │ fix locally, or temporarily remove those two steps while scaffolding      │
└──────────────────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────┘

---
Want me to save this runbook into docs/hosting-and-deployment.md (or a dedicated docs/deploy-runbook.md) so it's alongside the rest of your reference material? I can also create the two repo files (ecosystem.config.js, deploy.yml) for you instead of you pasting them — your call.

✻ Cogitated for 2m 0s

※ recap: You're setting up GitHub Actions CI/CD to auto-deploy your Next.js app to Lightsail. The full step-by-step runbook is ready. Next: create the two repo files (ecosystem.config.js, deploy.yml), then do the server and secrets setup before your first push.

❯ IN the Assemble deploy bundle step in deploy.yml file - can you explain each step in it

Sure. This step exists because of a quirk of Next.js standalone output: next build with output: 'standalone' produces a minimal server, but deliberately leaves out two things you must add back yourself — the client-side static assets and your public/ folder. Next's own docs call this out. The step rebuilds a complete, runnable directory called deploy/ that then gets rsynced to the server.

Here's the step with each line explained:

- name: Assemble deploy bundle
  run: |
    rm -rf deploy && mkdir -p deploy
    cp -r .next/standalone/. deploy/
    mkdir -p deploy/.next
    cp -r .next/static deploy/.next/static
    [ -d public ] && cp -r public deploy/public || true
    cp ecosystem.config.js deploy/

rm -rf deploy && mkdir -p deploy
Start from a clean, empty deploy/ directory. Removes any leftover from a previous attempt, then recreates it empty. It's defensive/idempotent — guarantees no stale files sneak into the bundle.

cp -r .next/standalone/. deploy/
Copy the standalone server into deploy/. This is the core artifact — it contains server.js (the entry point), a trimmed node_modules/ with only the deps the app actually traced, package.json, and .next/server/ (the compiled server chunks).
- The trailing /. is important: it copies the contents of standalone, including hidden/dot entries like the .next directory. If you wrote .next/standalone/* instead, the shell glob would skip dot-entries and you'd miss .next/server. /. is the safe form.

mkdir -p deploy/.next
Ensure a .next directory exists inside deploy/ before we drop static into it. It usually already exists (from the previous copy, which brought .next/server), but -p makes this a harmless no-op if so — purely defensive so the next line can't fail.

cp -r .next/static deploy/.next/static
Copy the client-side static assets — the hashed JS/CSS bundles the browser downloads. Standalone does NOT include these, and server.js serves them from .next/static. Skip this line and the site loads but every JS/CSS request 404s → unstyled, broken page.

[ -d public ] && cp -r public deploy/public || true
Copy your public/ folder (favicon, images, static files served at the site root) — also not included by standalone.
- [ -d public ] tests whether the folder exists.
- && cp ... copies it only if it does.
- || true forces the command to exit successfully even when public/ doesn't exist, so the step doesn't fail the workflow on a project without one.

cp ecosystem.config.js deploy/
Include the PM2 config in the bundle. Standalone knows nothing about it (it's a repo-root file), but the server needs it at /home/ubuntu/Code/app/ecosystem.config.js so the workflow's fallback pm2 start ecosystem.config.js works on the first deploy.

Resulting deploy/ layout that gets rsynced

deploy/
├── server.js                ← standalone entry (run by PM2)
├── package.json
├── node_modules/            ← traced, minimal
├── ecosystem.config.js      ← PM2 config (added)
├── .next/
│   ├── server/              ← from standalone
│   └── static/              ← client JS/CSS (added)
└── public/                  ← static assets (added, if present)

That's a fully self-contained, runnable app directory — node server.js in it just works, with no pnpm install or build needed on the server. That's the whole point of the build-in-CI model: the box receives a ready-to-run folder.