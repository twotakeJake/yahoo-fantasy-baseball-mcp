# Claude.ai MCP Server Setup

## Step 1 — Get Yahoo Developer Credentials

1. Go to [developer.yahoo.com/apps/create](https://developer.yahoo.com/apps/create)
2. Sign in with your Yahoo account (same one as your fantasy league)
3. Fill in the following fields:
   - **App Name:** anything, e.g. `Fantasy Baseball Claude`
   - **Redirect URI:** `https://localhost:8080`
   - **API Permissions:** check `Fantasy Sports → Read`
4. Hit **Create**, then copy your **Client ID** and **Client Secret**

---

## Step 2 — Clone the Server

```bash
git clone https://github.com/jimbrig/yahoo-fantasy-baseball-mcp.git
cd yahoo-fantasy-baseball-mcp
npm install
```

---

## Step 3 — Auth + Environment

```bash
cp .env.example .env
```

Open `.env` and fill in your Client ID and Client Secret. Then run the token helper script to complete OAuth and populate your access token:

```bash
npm run get-token
```

This will open a browser window for Yahoo login. Approve it, and your `.env` gets populated automatically.

---

## Step 4 — Build

```bash
npm run build
```

---

## Step 5 — Add to Claude Code

In your IDE, find your MCP config file (usually `~/.cursor/mcp.json` or equivalent) and add:

```json
{
  "mcpServers": {
    "yahoo-fantasy-baseball": {
      "command": "node",
      "args": ["/full/path/to/yahoo-fantasy-baseball-mcp/build/index.js"],
      "env": {
        "YAHOO_CLIENT_ID": "your_client_id",
        "YAHOO_CLIENT_SECRET": "your_client_secret",
        "YAHOO_ACCESS_TOKEN": "your_access_token"
      },
      "transportType": "stdio"
    }
  }
}
```

> **Note:** Use the full absolute path — relative paths are a common gotcha here.

---

## Step 6 — Restart Your IDE

Once restarted, try asking Claude:

> "Use the `get_team_roster` tool to show my current lineup"

If it returns your roster, you're live.
5%