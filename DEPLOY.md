# Deploying AgentMail

AgentMail is a TypeScript Fastify app with a BullMQ worker. It needs:

- **Postgres 16+**
- **Redis 7+**
- An **Anthropic API key** (for classification + drafting)
- **Postmark** server + inbound webhook (for real mail)

Three deployment options below, in descending order of how opinionated this
guide is. All of them run the same Docker image and the same `tsx`-at-runtime
command pattern.

---

## Option A: Fly.io (recommended)

Fly runs both processes (HTTP server + worker) from one image, attaches
managed Postgres in a click, and gives you HTTPS for free.

1. **Launch the app** (don't deploy yet — we need secrets first):

   ```sh
   fly launch --copy-config --no-deploy
   ```

   When prompted, accept (or rename) the app. Fly will detect `Dockerfile`
   and `fly.toml` and create the app.

2. **Provision Postgres** and attach it (sets `DATABASE_URL` automatically):

   ```sh
   fly postgres create --name agentmail-db --region ord
   fly postgres attach agentmail-db --app <your-app>
   ```

3. **Provision Redis** (Fly's Upstash add-on):

   ```sh
   fly redis create --name agentmail-redis --region ord
   # copy the printed connection string, then:
   fly secrets set REDIS_URL="redis://default:...@..."
   ```

4. **Set the rest of the secrets**:

   ```sh
   fly secrets set \
     API_TOKEN="$(openssl rand -hex 32)" \
     OWNER_EMAIL="you@yourdomain.com" \
     OWNER_NAME="Your Name" \
     OWNER_PASSWORD="$(openssl rand -hex 16)" \
     ANTHROPIC_API_KEY="sk-ant-..." \
     POSTMARK_SERVER_TOKEN="..." \
     POSTMARK_WEBHOOK_TOKEN="..." \
     POSTMARK_INBOUND_EMAIL="abc123@inbound.postmarkapp.com"
   ```

5. **Deploy**:

   ```sh
   fly deploy
   ```

   The `[deploy] release_command` in `fly.toml` runs migrations
   (`tsx scripts/migrate.ts`) before the new machines take traffic.

**Final step — wire up Postmark.** In the Postmark dashboard, set the
inbound stream's webhook URL to:

```
https://<your-app>.fly.dev/webhooks/postmark/inbound
```

That's it. Visit `https://<your-app>.fly.dev/` to log in.

---

## Option B: VPS with docker-compose

Any VPS with Docker and ~1GB of RAM works (DigitalOcean, Hetzner, Linode,
EC2 t3.micro). You'll want a reverse proxy (Caddy) in front for HTTPS.

1. **Clone on the VPS**:

   ```sh
   git clone https://github.com/mariagorskikh/agentmail.git
   cd agentmail
   ```

2. **Configure environment**:

   ```sh
   cp .env.example .env
   # edit .env — set API_TOKEN, OWNER_*, ANTHROPIC_API_KEY, POSTMARK_*
   # leave DATABASE_URL and REDIS_URL alone (compose overrides them)
   ```

3. **Run migrations** (one-shot):

   ```sh
   docker compose -f docker-compose.deploy.yml run --rm migrate
   ```

4. **Start the stack** (server + worker + db + redis):

   ```sh
   docker compose -f docker-compose.deploy.yml up -d
   ```

   Check that everything is healthy:

   ```sh
   docker compose -f docker-compose.deploy.yml ps
   docker compose -f docker-compose.deploy.yml logs -f app worker
   ```

5. **Put Caddy in front** of port 3000 for HTTPS. Install Caddy, then drop
   this in `/etc/caddy/Caddyfile`:

   ```caddyfile
   mail.yourdomain.com {
       reverse_proxy localhost:3000
   }
   ```

   Then `sudo systemctl reload caddy`. Point Postmark inbound at
   `https://mail.yourdomain.com/webhooks/postmark/inbound`.

---

## Option C: Railway / Render

Both platforms can deploy this repo from GitHub directly. The shape is:

1. Connect the GitHub repo, let the platform detect `Dockerfile`.
2. Add **two** services from the same repo/image:
   - **web**: start command `tsx src/server.ts`, expose port 3000.
   - **worker**: start command `tsx src/worker.ts`, no port.
3. Add managed Postgres + Redis add-ons; the platform will inject
   `DATABASE_URL` / `REDIS_URL` automatically (or copy them in by hand).
4. Set the rest of the env vars (`API_TOKEN`, `OWNER_*`, `OWNER_PASSWORD`,
   `ANTHROPIC_API_KEY`, `POSTMARK_*`) in the dashboard.
5. After the first successful deploy, run migrations once. Railway: open a
   one-shot shell and `tsx scripts/migrate.ts`. Render: add a pre-deploy job
   with the same command. Then wire Postmark's inbound webhook to the
   public URL.

---

## Environment variables

See `.env.example` for the full list. The required ones are:

| Var | Purpose |
| --- | --- |
| `API_TOKEN` | Bearer token for all API routes |
| `OWNER_EMAIL`, `OWNER_NAME` | Seeded as the `self` contact on boot |
| `OWNER_PASSWORD` | Web UI login password (blank disables login) |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `ANTHROPIC_API_KEY` | Required for classify + draft lanes |
| `POSTMARK_SERVER_TOKEN` | Required to send mail |
| `POSTMARK_WEBHOOK_TOKEN` | Validates inbound webhook signature |
| `POSTMARK_INBOUND_EMAIL` | Your Postmark inbound hash address |
