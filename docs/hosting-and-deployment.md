# Hosting & Deployment Reference

Reference notes for hosting the SIF Kuwait main website (Next.js app).

**Decision:** Self-managed **AWS Lightsail** VM + a stack of free-tier services.
Not using managed Next.js hosting (Vercel/Netlify) — we run our own Node server
with Nginx + PM2, same pattern as prior .NET Core / Express deployments.

Last updated: 2026-07-11

---

## App Requirements

Public-facing website built with Next.js. Cannot use static export (`output: 'export'`)
because it needs a live server:

- A few mostly-static pages
- **Contact form** → needs an API route + email sending
- **One dynamic page** whose content is managed via an **admin panel** → needs a DB + auth

So the stack needs: **Node runtime (SSR + API routes) + database + email + auth.**

---

## Why Not Static / Managed Hosting

- Static export is out — contact form, admin panel, and dynamic content all need a server.
- Managed hosting (Vercel etc.) not needed — we're comfortable self-managing VMs
  (EC2/Azure VM + Nginx + PM2 experience). Self-managing is cheaper and gives full control.

---

## Architecture

```
                 Cloudflare (free)  ──►  caching, SSL, DDoS, WAF, Turnstile
                        │
                 ┌──────▼───────┐
                 │  Lightsail   │   ~$5/mo (first 3 months free)
                 │   VM         │
                 │  Nginx  ──►  Next.js (PM2)         ← SSR + /api routes
                 │              │  ├─ contact form API
                 │              │  ├─ admin panel (auth)
                 │              │  └─ dynamic page (reads DB)
                 │              │
                 │  SQLite (same box)                 ← content + form submissions
                 └──────────────┘
                        │
                 SES / Resend (free tier)             ← sends contact emails
                        │
                 Cloudflare R2                        ← DB backups + media uploads
```

Key cost-saver: the **database lives on the same box** (SQLite), so there's **no
separate DB hosting cost**. A managed Postgres would add cost we don't need at this scale.

---

## Hosting Provider: AWS Lightsail

Chosen for predictable flat pricing + existing AWS familiarity.

### What Lightsail bundles for free (don't pay extra for these)
- **Free trial** — small bundles ($3.50/$5/$7) are free for the **first 3 months** on a
  new account. (Verify the current offer at signup.)
- **Static IP** — free while attached to a running instance.
- **DNS zone hosting** — a few free managed DNS zones per account.
- **Bundled data transfer** — each plan includes a large monthly allowance
  (e.g. the $5 plan bundles ~2 TB out). Our traffic stays free.
- **Snapshots** — a few cents/GB; effectively free for a small app.

### Plan sizing note
- 1 GB instance: `next build` can **OOM**. Mitigate by (best → simplest):
  1. Build in **GitHub Actions**, ship the `.next` artifact to the box.
  2. Add a **2–4 GB swapfile** on the instance.
  3. Use the **2 GB plan** (~$10/mo) and build on the box.

---

## Free-Tier Services Around Lightsail

| Layer | Choice | Cost | Notes |
|---|---|---|---|
| Compute | Lightsail $5 plan | $5/mo (3 mo free) | Flat pricing |
| Database | **SQLite** on box | $0 | Use Prisma/Drizzle ORM to keep Postgres migration easy |
| Email | **AWS SES** or **Resend** | ~$0 | SES: ~$0.10/1k emails. Resend: 3,000/mo free |
| CDN/SSL/WAF/CAPTCHA | **Cloudflare free** | $0 | CDN, SSL, DDoS, WAF, Turnstile bot protection |
| Backups + uploads | **Cloudflare R2** | $0 | 10 GB free, no egress fees |
| CI/CD | **GitHub Actions** | $0 | 2,000 min/mo private; also solves build-RAM problem |
| Monitoring | **UptimeRobot** | $0 | Uptime pings + downtime alerts |
| Error tracking | **Sentry** free | $0 | Runtime error capture |

### Stack decisions in detail

**Database → SQLite**
- Tiny, low-write workload (one dynamic page + admin + form submissions).
- Zero hosting cost, trivial backups (copy the `.db` file — cron to R2/S3).
- Use **Prisma** or **Drizzle** ORM so switching to Postgres later needs no query rewrite.
- Only pick Postgres if concurrent admins or a separate DB service is wanted
  (runs on the same box too, or free managed via **Neon**/**Supabase**).

**Email → transactional API, not self-hosted SMTP**
- Never self-host mail on a VPS (deliverability/IP-reputation nightmare).
- **AWS SES**: native to AWS; requires domain verification (SPF/DKIM) + sandbox-exit request.
- **Resend**: quickest to wire up; 3,000 emails/mo free.

**CDN/SSL/security → Cloudflare free (recommended)**
- Point domain nameservers at Cloudflare, proxy to the Lightsail IP.
- Free SSL, CDN caching, DDoS, WAF, and **Turnstile** (free CAPTCHA for the contact form).
- Origin SSL on the box via **Let's Encrypt (Certbot)** or a Cloudflare origin cert.
- AWS-native alternative: **CloudFront** (always-free 1 TB out + 10M req/mo), but
  Cloudflare gives more (WAF/Turnstile) for less setup.

**Admin auth → keep it simple**
- **Auth.js (NextAuth)** credentials provider, or **Lucia**, backed by SQLite.
- No paid auth service needed.

**Dynamic page → ISR / on-demand revalidation**
- Render with `revalidate`, and call `revalidatePath()` from the admin panel on content edits.
- Public page served from cache (fast + cheap); regenerates only on edits.
- Cloudflare caches it further.

**CI/CD → GitHub + Actions**
- Build on Actions (sidesteps the build-RAM problem), then rsync/SSH artifact to Lightsail.

---

## Regional Consideration (Kuwait / GCC audience)

- Pick a **nearby region** to cut latency:
  - AWS Middle East regions: **Bahrain (me-south-1)**, **UAE (me-central-1)**.
  - (Oracle/others have Jeddah/Dubai — noted for reference.)
- Put **Cloudflare** in front regardless, for global edge caching.

---

## Security Notes for the Public Contact Form

Public forms get bot-spammed fast. Add:
- **Cloudflare Turnstile** (free CAPTCHA).
- **Honeypot** field.
- **Rate limiting** on the API route.

---

## Cost Summary

| Item | Cost |
|---|---|
| Lightsail instance ($5 plan) | ~$5/mo (first 3 months free) |
| Database (SQLite on box) | $0 |
| Email (SES / Resend) | $0 |
| CDN / SSL / WAF / CAPTCHA (Cloudflare) | $0 |
| Backups / uploads (R2) | $0 |
| CI/CD (GitHub Actions) | $0 |
| Monitoring (UptimeRobot / Sentry) | $0 |
| Domain | ~$10/yr |
| **Total** | **~$5/mo + domain** |

---

## Alternatives Considered (for reference)

- **Oracle Cloud "Always Free"** — free *forever*, 4 ARM vCPU / 24 GB. Cheapest possible
  ($0), but onboarding is finicky and idle instances can be reclaimed (upgrade to
  Pay-As-You-Go to make them permanent). Same architecture would apply.
- **Hetzner Cloud** — best paid value (~$4/mo for 2 vCPU / 4 GB), very reliable, EU + US
  regions. Would be the pick if not staying in the AWS ecosystem.
- **Other VPS**: Netcup, OVH/Kimsufi, Contabo (cheap but variable reliability),
  DigitalOcean, Vultr, Linode.

---

## Next Steps (deploy setup — TODO)

- [ ] Nginx reverse-proxy config for Next.js
- [ ] PM2 ecosystem file
- [ ] Let's Encrypt / Cloudflare SSL
- [ ] GitHub Actions deploy workflow (build + ship artifact)
- [ ] SQLite + Prisma/Drizzle schema (dynamic content + form submissions)
- [ ] Contact form API route + SES/Resend + Turnstile
- [ ] Admin panel auth (Auth.js / Lucia)
- [ ] Nightly SQLite backup to R2
