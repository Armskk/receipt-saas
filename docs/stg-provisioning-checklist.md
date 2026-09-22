# Provisioning stg by hand (Step 3 checklist)

This is the part of Order 126 that has to happen outside an agent session: an Oracle Cloud
account, DNS, LINE/Telegram credentials and GitHub secrets are all things only you can create
or grant access to. Work through this **before** `.github/workflows/deploy-stg.yml` exists —
that workflow (a separate, later step) just automates the `docker compose -p receipt-stg …`
commands this checklist ends with, which you can also run by hand over SSH.

Once every box below is checked, the "Run the end-to-end check against stg" item in Step 3 of
`docs/environments.md` is what's left, and `docs/environments.md`'s runbook ("Deploying an
environment") is the reference for the compose commands themselves.

## 1. Oracle Cloud VM

- [ ] Create an Oracle Cloud **Always Free** account if you don't have one (a credit card is
      required to sign up, but the Ampere shape used here stays in the free tier — see
      `docs/decisions.md` "Receipt SaaS: หา hosting ที่ free จริง" in Notion for why this was
      chosen).
- [ ] Create a VM: **Ampere A1 Compute** (ARM64), the free-tier shape (up to 4 OCPU / 24 GB —
      using less is fine, e.g. 2 OCPU / 12 GB, so a second free VM is possible later for
      production). Image: **Ubuntu 24.04** (Ubuntu 26 is presumably out by now — pin whatever
      the *previous* LTS is, matching the intent of Order 128 "ตรึง runner CI"; a very new,
      undertested release is a bad idea for a box nobody's watching daily).
- [ ] Attach a public IPv4 address (Oracle gives one by default on the free tier).
- [ ] Download the SSH key pair Oracle generates (or supply your own public key) — you'll need
      the **private** key twice: once for your own access, once pasted into a GitHub secret
      later. Do not paste it into this chat or any other chat.
- [ ] In the Oracle Console, edit the VM's **VCN Security List** (or the NSG if you used one):
      ingress TCP 22 (ideally restricted to your current IP — Oracle shows it when you edit the
      rule), TCP 80, TCP 443. Nothing else. This is "layer 1" of the firewall in
      `docs/environments.md`'s runbook; layer 2 (iptables on the VM) is step 4 below.
- [ ] SSH in once to confirm it boots: `ssh -i <key> ubuntu@<vm-ip>` (the default user is
      `ubuntu` on the Oracle Ubuntu image).

## 2. Base OS setup (on the VM)

- [ ] `sudo apt update && sudo apt upgrade -y`
- [ ] Install Docker Engine + the Compose plugin from Docker's own apt repo (Ubuntu's own
      `docker.io`/`docker-compose` packages are older than the `!reset`/`!override` Compose
      features this repo's `docker-compose.prod.yml` uses — confirm `docker compose version`
      reports **≥ 2.24** once installed): follow
      <https://docs.docker.com/engine/install/ubuntu/> (the "apt repository" method, not the
      convenience script).
- [ ] Add your VM user to the `docker` group (`sudo usermod -aG docker $USER`, then reconnect)
      so `docker compose` doesn't need `sudo` — the deploy workflow will need this too.
- [ ] `git clone` this repo onto the VM (a deploy key or a fine-scoped personal access token —
      the repo is private; don't put your personal SSH key on the VM for this).
- [ ] iptables (layer 2 of the firewall — see `docs/environments.md`'s runbook for why this is
      the *second* line, not the first): check `sudo iptables -S INPUT`, allow loopback,
      established/related, 22, 80, 443, drop the rest, then persist it
      (`sudo apt install iptables-persistent`, or `netfilter-persistent save`). Verify from
      **outside** the VM once everything below is up: `nmap -Pn -p- <vm-public-ip>` should show
      only 22, 80, 443 open.
- [ ] `docker network create receipt-edge` (the shared network `docker-compose.edge.yml`
      expects — see the runbook).

## 3. DNS

- [ ] Decide the stg domains, e.g. `app-stg.yourdomain.com` and `api-stg.yourdomain.com`
      (anything works; these are just what you'll put in `.env.edge`).
- [ ] Create **A records** for both, pointing at the VM's public IPv4. (AAAA too if the VM has
      an IPv6 address you want to use — optional.)
- [ ] Wait for propagation (`dig +short app-stg.yourdomain.com` from your own machine) before
      starting Caddy — it requests a Let's Encrypt certificate on first request per domain, and
      Let's Encrypt has rate limits, so don't repeatedly hit a domain that isn't resolving yet.

## 4. LINE channel for stg

A webhook URL belongs to exactly one bot, so stg needs its own — never reuse the one you use
for local testing or (later) production.

- [ ] Create a new **Messaging API channel** at <https://developers.line.biz/console/> (a new
      "Provider" or a new channel under an existing one — either works, but keep it clearly
      named, e.g. "Receipt SaaS (stg)").
- [ ] From the channel's Messaging API tab, note the **Channel secret** and issue a long-lived
      **Channel access token** — these become `LINE_CHANNEL_SECRET` /
      `LINE_CHANNEL_ACCESS_TOKEN` in `backend/.env.stg` (step 6).
- [ ] You can't register the webhook URL until stg is actually serving HTTPS (step 7), so leave
      the webhook field blank for now and come back to it in step 8.
- [ ] Optional: note the bot's "add friend" URL (`https://line.me/R/ti/p/@...`) for
      `NEXT_PUBLIC_LINE_ADD_FRIEND_URL` in `.env.stg` (frontend/lib/api.ts's Connect-chat page
      uses it as a convenience deep link).

## 5. Telegram bot for stg

Same reasoning: a separate bot from local/production.

- [ ] Message **@BotFather** on Telegram, `/newbot`, give it a stg-specific name (e.g.
      "Receipt SaaS stg bot").
- [ ] BotFather gives you a token — this becomes `TELEGRAM_BOT_TOKEN` in `backend/.env.stg`.
- [ ] Note the bot's `@username` for `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` in `.env.stg` (the
      Connect-chat page's `t.me/<bot>?start=<code>` deep link).
- [ ] The webhook itself (`setWebhook`, with `TELEGRAM_WEBHOOK_SECRET`) also has to wait until
      stg is serving HTTPS — that's step 8.

## 6. Generate the stg env files (on the VM)

- [ ] From the repo checkout on the VM: `scripts/init-env.sh stg` — writes `.env.stg` and
      `backend/.env.stg` with fresh random secrets (see `docs/environments.md`'s runbook for
      what each file contains).
- [ ] Also run `scripts/init-env.sh edge` once if `.env.edge` doesn't exist yet — it holds the
      domains for the *shared* Caddy that will eventually serve stg and production both.
- [ ] Fill in the values the script leaves open, in `.env.stg` / `backend/.env.stg` / `.env.edge`:
  - `ANTHROPIC_API_KEY` — a **key of its own** for stg (a separate key or a separate workspace
    in the Anthropic Console, with a spend limit set — never the same key as your local dev or
    production). Consider a cheaper `ANTHROPIC_MODEL` for stg since it's not real traffic.
  - `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` (step 4), `TELEGRAM_BOT_TOKEN` (step 5).
  - `NEXT_PUBLIC_API_URL` in `.env.stg` — `https://api-stg.yourdomain.com` (step 3's domain).
  - `CORS_ORIGINS` in `backend/.env.stg` — `https://app-stg.yourdomain.com` (must match; the
    API refuses to start in production mode without this set correctly).
  - `NEXT_PUBLIC_LINE_ADD_FRIEND_URL` / `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` — optional, from
    steps 4–5.
  - In `.env.edge`: `STG_APP_DOMAIN`, `STG_API_DOMAIN` (step 3's domains), and uncomment
    `EDGE_STG_SITE=./deploy/edge/sites/stg.caddy` to enable stg once you're ready to go live
    (leaving it commented means Caddy won't request a certificate yet, if you want to do steps
    1–6 well ahead of going live).
- [ ] **Never** commit these files or paste their contents anywhere — `.gitignore` already
      excludes every `.env.*` except `*.example`; keep it that way.

## 7. Bring stg up (by hand, for now)

This is exactly what `deploy-stg.yml` will later automate — running it by hand first means you
can see and fix problems interactively instead of debugging through CI logs.

- [ ] Build and start stg (building **on the VM** so the image is natively ARM64 — there's no
      cross-build step in this repo):
  ```bash
  docker compose -p receipt-stg --env-file .env.stg -f docker-compose.yml -f docker-compose.prod.yml up -d --build
  ```
- [ ] Bring up (or reload) the shared edge:
  ```bash
  docker compose -p receipt-edge --env-file .env.edge -f docker-compose.edge.yml up -d
  ```
- [ ] Check `docker compose -p receipt-stg --env-file .env.stg -f docker-compose.yml -f docker-compose.prod.yml ps`
      — `migrate` should show `Exited (0)`, and `backend` should reach `healthy` within
      ~20–30s (`docs/environments.md`'s runbook explains the startup order: Postgres/Redis/MinIO
      → migrate → backend/worker).
- [ ] Smoke test from your own machine: `curl -fsS https://api-stg.yourdomain.com/health` →
      `{"status":"ok","checks":{"database":"up","redis":"up"}}`, and
      `https://app-stg.yourdomain.com/login` loads.

## 8. Register the webhooks

Only do this once step 7's smoke test passes — a webhook pointed at a domain that isn't
serving yet just means LINE/Telegram will retry and eventually mark it unhealthy.

- [ ] LINE: in the channel's Messaging API settings, set the webhook URL to
      `https://api-stg.yourdomain.com/webhooks/line` and enable "Use webhook". LINE has a
      built-in "Verify" button — use it.
- [ ] Telegram:
  ```bash
  curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
    -d "url=https://api-stg.yourdomain.com/webhooks/telegram" \
    -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
  ```
  (both values are in `backend/.env.stg`). Confirm with
  `curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"`.
- [ ] From your own phone: open the dashboard's **Connect chat** page against stg, generate a
      code, send it to each bot, and confirm the chat links (this exercises the whole flow from
      Order 123 against a real chat for the first time — until now it was only ever tested with
      the bot's HTTP token blanked out).

## 9. GitHub Environment + deploy secrets

`.github/workflows/deploy-stg.yml` already exists — it runs on push to `stg` (or manually via
`workflow_dispatch`) and does exactly what step 7 does by hand: SSH in, `git checkout` the
pushed commit, `docker compose -p receipt-stg … up -d --build --wait`, then curl `/health`. It
has nothing to connect to until this step is done.

- [ ] In GitHub → repo **Settings → Environments**, create an environment named `stg`.
- [ ] Add **secrets** scoped to it (never repo-wide, so a `production` environment added later
      can hold different values): `STG_SSH_HOST` (the VM's IP or DNS), `STG_SSH_USER`
      (`ubuntu`), `STG_SSH_KEY` (the **private** key from step 1 — paste it directly into the
      GitHub secret field, never into a file in the repo or into chat).
- [ ] Add **variables** scoped to the same environment (not secrets — these aren't sensitive):
      `STG_DEPLOY_PATH` (the absolute path of the repo checkout on the VM from step 2's
      `git clone`, e.g. `/home/ubuntu/receipt-saas`) and `STG_API_DOMAIN` (step 3's API domain,
      e.g. `api-stg.yourdomain.com`, no `https://` prefix — the workflow builds the URL itself).
- [ ] Optional but recommended: an environment protection rule (even just "restrict to the
      `stg` branch") so a stray workflow run on another branch can't target this environment.
- [ ] Once the secrets/variables are set and steps 1–8 have brought stg up manually at least
      once, push to `stg` (or run the workflow manually) to confirm the automated deploy works
      the same way the manual one in step 7 did.

## When this is done

- [ ] Synthetic data only on stg (per `docs/environments.md`'s environment matrix) — the
      LINE/Telegram accounts and any signups you make while testing this checklist count.
- [ ] Run the manual end-to-end check against stg (the last unchecked box in Step 3 of
      `docs/environments.md`): signup → upload → parse → confirm → summary, plus a cross-tenant
      404/403 check, through the real domains — not `backend/scripts/e2e/`, which only drives
      local processes (see its README's "Not covered").
