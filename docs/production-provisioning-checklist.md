# Provisioning production by hand (Step 4 checklist)

This is the part of Step 4 that has to happen outside an agent session: a second Oracle VM (or
reused capacity on the existing one — see step 1), DNS, LINE/Telegram credentials, an off-VM
backup destination, an uptime monitor, and GitHub secrets are all things only you can create or
grant access to. It closely mirrors `docs/stg-provisioning-checklist.md` — read that first if
you haven't done stg yet, since several steps (Docker install, `receipt-edge` network, DNS
propagation, LINE/Telegram bot creation) are identical in shape and only summarized here.

Once every box below is checked, the "Register production LINE/Telegram webhooks" item in Step 4
of `docs/environments.md` is what's left, and that doc's runbook ("Deploying an environment") and
its **Backups**/**Rollback**/**Monitoring** sections are the reference for the commands used here.

## 1. Oracle Cloud VM

- [ ] Decide: a **second** Ampere A1 VM (Oracle's Always Free tier covers up to 4 OCPU / 24 GB
      total, so two VMs at 2 OCPU / 12 GB each both stay free — `docs/stg-provisioning-checklist.md`
      anticipated this), or reuse the existing stg VM with a third compose project. A second VM is
      recommended: production staying up doesn't depend on anything you do to stg, and a mistake
      on one VM's iptables/Docker config can't affect the other.
- [ ] Same as stg step 1: Ubuntu 24.04 image, public IPv4, download the SSH key pair (**never**
      paste the private key into chat), VCN Security List (22 from your IP, 80, 443 only).
- [ ] SSH in once to confirm it boots.

## 2. Base OS setup (on the VM)

Identical to stg step 2: `apt update && apt upgrade`, Docker Engine + Compose plugin from
Docker's own apt repo (confirm `docker compose version` ≥ 2.24), add your user to the `docker`
group, `git clone` the repo (deploy key or fine-scoped PAT, not your personal SSH key), iptables
(22/80/443 + established/loopback, persisted), `docker network create receipt-edge` — **only if**
this VM doesn't already have it (a second VM needs its own; it is not shared across VMs).

## 3. DNS

- [ ] Decide the production domains, e.g. `app.yourdomain.com` and `api.yourdomain.com` (these
      are the "real domain" row of `docs/environments.md`'s environment matrix — no `-stg`
      suffix). A records → this VM's public IPv4. Wait for propagation before starting Caddy.

## 4. LINE channel for production

Same reasoning as stg step 4, but this is the bot real users will actually message — name it
clearly (e.g. "Receipt SaaS") and **never reuse the stg or local dev bot's webhook URL**.

- [ ] Create the Messaging API channel, note the Channel secret and issue a Channel access token
      → `LINE_CHANNEL_SECRET` / `LINE_CHANNEL_ACCESS_TOKEN` in `backend/.env.production` (step 6).
- [ ] Leave the webhook URL blank until step 7 passes its smoke test.
- [ ] Note the "add friend" URL for `NEXT_PUBLIC_LINE_ADD_FRIEND_URL` in `.env.production`.

## 5. Telegram bot for production

- [ ] `/newbot` via @BotFather, a production-specific name/username, distinct from stg/local.
- [ ] Token → `TELEGRAM_BOT_TOKEN` in `backend/.env.production`; username →
      `NEXT_PUBLIC_TELEGRAM_BOT_USERNAME` in `.env.production`.
- [ ] `setWebhook` waits for step 7's smoke test, same as stg.

## 6. Generate the production env files (on the VM)

- [ ] `scripts/init-env.sh production` — writes `.env.production` and `backend/.env.production`.
- [ ] Run `scripts/init-env.sh edge` too if `.env.edge` doesn't exist on this VM yet (a second VM
      needs its own edge Caddy — `.env.edge` and `docker-compose.edge.yml` aren't shared across
      VMs any more than `receipt-edge` is).
- [ ] Fill in the values the script leaves open, same shape as stg step 6's list:
  `ANTHROPIC_API_KEY` (**a key of its own for production**, with a spend limit — never the stg
  or local key), `LINE_CHANNEL_SECRET`/`LINE_CHANNEL_ACCESS_TOKEN`/`TELEGRAM_BOT_TOKEN` (steps
  4–5), `NEXT_PUBLIC_API_URL` in `.env.production`, `CORS_ORIGINS` in
  `backend/.env.production`, the optional deep-link vars, and in `.env.edge`:
  `PROD_APP_DOMAIN`/`PROD_API_DOMAIN` plus uncommenting `EDGE_PROD_SITE`.
- [ ] **Never** commit these files. This is real user data once live — see
  `docs/environments.md`'s environment matrix: "never copy production data elsewhere".

## 7. Off-VM backups (`rclone` + object storage)

One-time setup for `scripts/backup.sh` (see `docs/environments.md`'s **Backups** section for
what it does).

- [ ] Create an off-VM bucket for backups — OCI Object Storage's free tier (10 GB) fits this
      project's "no paid tiers" hosting goal and keeps the backup destination on a different
      failure domain than either VM. Any S3-compatible provider works the same way.
- [ ] `sudo apt install rclone` (or the install script from rclone.org) on the production VM.
- [ ] `rclone config` — add a remote (any name, e.g. `oci-backup`) pointing at that bucket. This
      is the *only* rclone remote you configure by hand; `scripts/backup.sh` defines the
      MinIO-side remote itself, from env vars, each time it runs.
- [ ] Pick the export string for `OFFSITE_RCLONE_REMOTE` (e.g. `oci-backup:receipt-backups`) and
      add the cron line from `docs/environments.md`'s **Backups** section, adjusted to this VM's
      repo path.
- [ ] Run `scripts/backup.sh production` once by hand to confirm both the Postgres dump and the
      MinIO mirror succeed before relying on cron for it.
- [ ] Test one restore now, before there's real data to lose: dump → restore into a throwaway
      database (`createdb` a scratch DB, `psql` the gunzipped dump into it, spot-check a row) →
      drop the scratch database. Repeat this periodically, not just once.

## 8. Bring production up (by hand, for now)

Same shape as stg step 7 — this is what `deploy-production.yml` (already built) will later
automate.

- [ ] Build and start production (on the VM, for a native ARM64 image):
  ```bash
  docker compose -p receipt-prod --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --build
  ```
- [ ] Bring up (or reload) this VM's edge:
  ```bash
  docker compose -p receipt-edge --env-file .env.edge -f docker-compose.edge.yml up -d
  ```
- [ ] Check `... ps` — `migrate` exits 0, `backend` reaches `healthy`.
- [ ] Smoke test: `curl -fsS https://<api domain>/health`, and `https://<app domain>/login` loads.

## 9. Register the webhooks

Same as stg step 8 — LINE's webhook URL + "Verify" button, Telegram's `setWebhook` with
`TELEGRAM_WEBHOOK_SECRET`, then a real end-to-end check from your own phone through the
**Connect chat** page against production.

## 10. GitHub Environment + deploy secrets

- [ ] GitHub → repo **Settings → Environments** → create `production`.
- [ ] Secrets (scoped to this environment): `PROD_SSH_HOST`, `PROD_SSH_USER` (`ubuntu`),
      `PROD_SSH_KEY` (this VM's private key — paste directly into the GitHub secret field).
- [ ] Variables: `PROD_DEPLOY_PATH`, `PROD_API_DOMAIN` (no `https://` prefix).
- [ ] **Recommended, and free now that the repo is public:** add a required reviewer on this
      environment (yourself) under environment protection rules, so a deploy pauses for approval
      even when triggered by `workflow_dispatch` or a pushed tag. This is on top of, not instead
      of, `deploy-production.yml`'s own tag/manual-only trigger.
- [ ] Once secrets/variables are set and steps 1–9 have brought production up manually at least
      once, push a `v*` tag (or run the workflow manually) to confirm the automated path works
      the same way the manual one did.

## 11. Monitoring

- [ ] Point a free external uptime monitor (UptimeRobot, Better Stack, etc.) at
      `https://<api domain>/health` on a 1–5 minute interval, alerting to somewhere you'll
      actually see (email/push, not just a dashboard nobody opens).
- [ ] Confirm the backup cron job (step 7) and its log path are actually being written to, and
      that a failed run would be visible — either the uptime monitor's own log-check feature, or
      a second monitor on the log file's last-modified time.
- [ ] Skim `docs/environments.md`'s **Monitoring** section for the disk-space and
      container-restart checks; wire whichever of those you want alerted rather than just
      glanced at occasionally.

## 12. Rollback drill

- [ ] Before relying on it under pressure, actually do one: deploy a trivial change, then run
      `deploy-production.yml` again against the *previous* commit/tag and confirm `/health` and
      the dashboard still work. See `docs/environments.md`'s **Rollback** section.

## When this is done

- [ ] Production live at the real domain, serving real (not synthetic) data going forward.
- [ ] Backups scheduled and one restore already tested (step 7).
- [ ] Uptime monitor live (step 11) and a rollback already rehearsed once (step 12).
- [ ] Any secret that was ever pasted into a chat session (this one included) or a log, anywhere,
      is rotated before real user data flows through this environment.
