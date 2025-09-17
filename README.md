# EthOS Launchpad Telegram Bot

A Telegram bot that watches an EthOS/EOS20 launchpad contract, detects new token launches and lock events, enriches them (socials, LP/FDV, specs), and posts formatted messages to a Telegram chat.

---

## Table of Contents
- [Features](#features)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Configuration](#configuration)
- [Finding `TARGET_CHAT_ID`](#finding-target_chat_id)
- [Run in Production (PM2)](#run-in-production-pm2)
- [Run with Docker](#run-with-docker)
- [GitHub Actions (CI & Image Publish)](#github-actions-ci--image-publish)
- [Troubleshooting](#troubleshooting)
- [Security](#security)
- [Appendix: File Templates](#appendix-file-templates)

---

## Features
- Live monitoring via **WebSocket** RPC
- Auto-parsing socials (website, X/Twitter, Telegram, Discord)
- Smart **“Specs Mechanisms”** breakdown with: Auto LP / ETH Reward / Gamble / Dev Fee
- **LP** shown as **USD + ETH** side
- **FDV** shown in **USD only**
- Optional ABI loading (from Etherscan or inline)

---

## Requirements
- Node.js 20+ (works great on Node 22)
- A WebSocket Ethereum RPC endpoint (Mainnet or Sepolia)
- A Telegram bot token from **@BotFather**
- The EthOS/EOS20 **launchpad contract address**

---

## Quick Start

```bash
git clone <YOUR_REPO_URL> ethos-bot
cd ethos-bot
npm ci
# Create your .env from the template (below) and fill it
cp .env.example .env
# Start the bot
node index.mjs
```

You should see the bot subscribe to your launchpad address.  
Add the bot to your Telegram group/channel and **make it an admin**.

---

## Configuration

Create a `.env` in the project root (see full template in the Appendix):

```ini
# Telegram
BOT_TOKEN=123456:ABC_your_bot_token
TARGET_CHAT_ID=-1001234567890

# Ethereum / Chain
CHAIN_ID=1
RPC_WSS=wss://mainnet.your-provider/ws

# Launchpad
LAUNCHPAD_ADDRESS=0xYourLaunchpadAddress

# Optional
ETHERSCAN_API_KEY=your_key
ETHOS_URL_TEMPLATE=https://ethos.vision/?t={CA}
CREATE_EVENT_NAMES=TokenCreated,Created,Launched,TokenLaunched
LOCK_EVENT_NAMES=SettingsLocked,LiquidityLocked,MechanismLocked
FROM_BLOCK=latest-100
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
LAUNCHPAD_ABI=
```

**Key notes**
- `CHAIN_ID`: use `1` for **Mainnet** (or `11155111` for Sepolia).
- `RPC_WSS`: must be **WebSocket** (supports `eth_subscribe`).
- `ETHERSCAN_API_KEY` enables ABI fetch (or paste ABI JSON into `LAUNCHPAD_ABI`).

---

## Finding `TARGET_CHAT_ID`

- For **private chats** with your bot: open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` and send any message to the bot; look for `message.chat.id`.
- For **channels/groups**: add the bot as **admin**, then post a message; the `chat.id` will usually be a **negative** integer (e.g., `-100...`).
- Or use a helper bot like `@getidsbot`.

---

## Run in Production (PM2)

```bash
npm i -g pm2
pm2 start index.mjs --name ethos-bot --time
pm2 save
pm2 startup   # follow the printed command to enable auto-start on reboot
```

Handy commands:

```bash
pm2 logs ethos-bot
pm2 restart ethos-bot
pm2 status
```

---

## Run with Docker

Build & run locally:

```bash
docker build -t ethos-bot:latest .
docker run -d --name ethos-bot --restart unless-stopped --env-file .env ethos-bot:latest
```

---

## GitHub Actions (CI & Image Publish)

> **Note:** Actions are for **CI** and **image publishing** only. They do **not** host a 24/7 bot. Use PM2 or Docker on a server/VPS for uptime.

This README includes two workflows in the Appendix:
- `ci.yml` — installs deps and does a quick file sanity check.
- `publish.yml` — builds and pushes a Docker image to **GHCR** on tag or main push.

To publish to GHCR, add repository **Secrets**:
- `GHCR_USERNAME` (your GitHub username)
- `GHCR_TOKEN` (a classic PAT with `write:packages`, `read:packages`)

Resulting image: `ghcr.io/<owner>/<repo>:<tag>`.

---

## Troubleshooting

- **No Telegram messages**
  - Bot isn’t an **admin** in the target chat.
  - `TARGET_CHAT_ID` is wrong (check sign / value).
- **No on-chain events**
  - `LAUNCHPAD_ADDRESS` or `CHAIN_ID` incorrect.
  - Your RPC is not WebSocket or provider blocks subscriptions.
- **FDV/LP show 0**
  - Some launches split actions across multiple txs; pair may not be seeded in the same receipt.
- **ABI fetch fails**
  - Provide `ETHERSCAN_API_KEY` or paste ABI JSON into `LAUNCHPAD_ABI`.

---

## Security

- **Never commit** your `.env`.
- Use dedicated bot tokens and rotate regularly.
- Prefer reputable, stable **WebSocket** RPC providers in production.

---

## Appendix: File Templates

> Copy blocks below into the corresponding files in your repo.

### `.env.example`

```ini
# Telegram
BOT_TOKEN=
TARGET_CHAT_ID=

# Ethereum / Chain
CHAIN_ID=1
RPC_WSS=

# Launchpad
LAUNCHPAD_ADDRESS=

# Optional
ETHERSCAN_API_KEY=
ETHOS_URL_TEMPLATE=https://ethos.vision/?t={CA}
CREATE_EVENT_NAMES=TokenCreated,Created,Launched,TokenLaunched
LOCK_EVENT_NAMES=SettingsLocked,LiquidityLocked,MechanismLocked
FROM_BLOCK=latest-50
WETH_ADDRESS=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
LAUNCHPAD_ABI=
```

### `.gitignore`

```gitignore
# Node
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*

# Env
.env
.env.*
!.env.example

# OS / Editor
.DS_Store
Thumbs.db
.idea/
.vscode/
```

### `Dockerfile`

```dockerfile
FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production

COPY . .

ENV NODE_ENV=production
CMD ["node", "index.mjs"]
```

### `.github/workflows/ci.yml`

```yaml
name: CI

on:
  push:
    branches: [ main ]
  pull_request:

jobs:
  node:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      # quick sanity: just make sure index.mjs exists
      - run: node -e "require('fs').accessSync('index.mjs')"
```

### `.github/workflows/publish.yml` (optional GHCR)

```yaml
name: Publish Docker (GHCR)

on:
  push:
    branches: [ main ]
    tags: [ 'v*.*.*' ]

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ secrets.GHCR_USERNAME }}
          password: ${{ secrets.GHCR_TOKEN }}

      - name: Extract metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository }}
          tags: |
            type=ref,event=branch
            type=ref,event=tag
            type=sha

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
```
