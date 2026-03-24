# Yahoo Fantasy Baseball MCP Server

[![CI](https://github.com/jimbrig/yahoo-fantasy-baseball-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/jimbrig/yahoo-fantasy-baseball-mcp/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

An MCP (Model Context Protocol) server that connects Claude to the Yahoo Fantasy Sports API. Ask Claude natural-language questions about your fantasy baseball team — roster, waiver wire targets, trade candidates, and age/rebuild analysis — and get real data back.

## What This Does

This server exposes four tools to Claude:

| Tool | Description |
|---|---|
| `get_team_roster` | Your current roster with position, slot, and MLB team |
| `get_waiver_wire_targets` | Available free agents filtered by age, sorted by ADP, tagged as *lotto ticket* (≤24) or *target* (25–29) |
| `get_trade_targets` | Players on other league rosters filtered by age, sorted youngest-first, with owning team |
| `get_team_age_profile` | Full roster sorted by age with median age, rebuild score, and gap to a ~25 target median |

Age data is pulled live from the **MLB Stats API** and cross-referenced by name + jersey number to handle players who share a name.

---

## What Was Built

The original repo scaffolded an MCP server with a single `get_team_roster` tool and an OAuth 1.0a authentication flow. Yahoo has since deprecated those endpoints, so this project:

- **Rewrote the auth flow** from broken OAuth 1.0a to working OAuth 2.0 (authorization code + bearer token)
- **Replaced the `get-token` script** with a browser-based flow: opens Yahoo login, catches the redirect, exchanges the code, and writes tokens to `.env` automatically
- **Added three new tools**: `get_waiver_wire_targets`, `get_trade_targets`, `get_team_age_profile`
- **Integrated the MLB Stats API** for real player age lookups with fuzzy name matching and jersey-number disambiguation
- **Made league/team configurable** via `YAHOO_LEAGUE_ID` and `YAHOO_TEAM_NUMBER` environment variables instead of hardcoded values
- **Dynamically resolves the Yahoo game key** so the server doesn't break when Yahoo increments their season key each year

---

## Prerequisites

- Node.js v18+
- A Yahoo Fantasy Baseball league
- A Yahoo Developer account with an app registered at [developer.yahoo.com](https://developer.yahoo.com/apps/create)

---

## Setup

### 1. Register a Yahoo App

1. Go to [developer.yahoo.com/apps/create](https://developer.yahoo.com/apps/create)
2. Fill in:
   - **App Name:** anything, e.g. `Fantasy Baseball Claude`
   - **Redirect URI:** `https://localhost:8080`
   - **API Permissions:** `Fantasy Sports → Read`
3. Copy your **Client ID** and **Client Secret**

### 2. Clone and Install

```bash
git clone <repository-url>
cd yahoo-fantasy-baseball-mcp
npm install
```

### 3. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` and fill in your credentials:

```
YAHOO_CLIENT_ID=your_client_id
YAHOO_CLIENT_SECRET=your_client_secret
YAHOO_LEAGUE_ID=your_league_id
YAHOO_TEAM_NUMBER=your_team_number
```

> Your league ID is in the URL when you visit your Yahoo Fantasy league page. Your team number is your team's position in the league (visible in the team URL).

### 4. Get an Access Token

```bash
npm run get-token
```

This opens your browser to Yahoo's authorization page. After you approve the app, Yahoo redirects to `https://localhost:8080?code=...` — the page will show a connection error, which is expected. Copy the full URL from your browser's address bar and paste it back into the terminal. The script exchanges the code for tokens and writes them to `.env` automatically.

### 5. Build

```bash
npm run build
```

### 6. Add to Claude Code

Add the following to your Claude MCP settings file (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "yahoo-fantasy-baseball": {
      "command": "node",
      "args": ["/absolute/path/to/yahoo-fantasy-baseball-mcp/build/index.js"],
      "env": {
        "YAHOO_CLIENT_ID": "your_client_id",
        "YAHOO_CLIENT_SECRET": "your_client_secret",
        "YAHOO_ACCESS_TOKEN": "your_access_token",
        "YAHOO_LEAGUE_ID": "your_league_id",
        "YAHOO_TEAM_NUMBER": "your_team_number"
      },
      "transportType": "stdio"
    }
  }
}
```

> Use the full absolute path. Relative paths are a common failure point.

### 7. Restart Claude Code

Start a new Claude Code session and test it:

> "Use the `get_team_roster` tool to show my current lineup"

---

## Available Tools

### `get_team_roster`

Returns your current roster with name, position, MLB team, and active slot.

```
Show me my current roster.
```

### `get_waiver_wire_targets`

Scans available free agents under a given age, sorted by ADP. Tags each player as a **lotto ticket** (age ≤24) or **target** (age 25–29).

```
Find me waiver wire targets under 27 years old.
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `max_age` | number | 29 | Maximum player age to include |
| `count` | number | 75 | Number of wire players to scan |

### `get_trade_targets`

Lists players on other league rosters filtered by age, sorted youngest-first, with the owning fantasy team.

```
Who are the best trade targets under 26?
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `max_age` | number | 29 | Maximum player age to include |

### `get_team_age_profile`

Returns your full roster sorted by age with:
- Median age
- Gap to a target median of 25
- Rebuild score breakdown (≤24 / 25–27 / 28–29 / 30+)

```
Give me my team's age profile.
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `YAHOO_CLIENT_ID` | Yes | OAuth app Client ID |
| `YAHOO_CLIENT_SECRET` | Yes | OAuth app Client Secret |
| `YAHOO_ACCESS_TOKEN` | Yes | OAuth 2.0 Bearer access token (populated by `npm run get-token`) |
| `YAHOO_REFRESH_TOKEN` | No | OAuth refresh token (populated by `npm run get-token`) |
| `YAHOO_LEAGUE_ID` | Yes | Your Yahoo Fantasy league ID |
| `YAHOO_TEAM_NUMBER` | Yes | Your team number within the league |

---

## Testing

Run the test suite:

```bash
npm test
```

The tests cover the pure data-transformation layer — the functions responsible for parsing Yahoo's API response format, normalizing player names, and resolving player ages. These are the functions most likely to corrupt output silently (wrong age, wrong player matched, missing field) without ever throwing an error.

```
transforms.js | line: 100% | branch: 96.55% | funcs: 100%
```

**What is tested:**
- `normalizeName` — accent stripping, parenthetical removal (e.g. `Shohei Ohtani (Batter)`), unicode normalization
- `lookupAge` — unique lookups, same-name disambiguation by jersey number, missing player handling
- `extractField` — Yahoo's array-of-single-key-objects response format, null/array guards
- `parsePlayerInfo` — full player record extraction, missing field fallbacks
- `extractPlayersMap` — Yahoo roster object structure variants

**What is not tested:**

The API I/O layer (`getTeamRoster`, `getWaiverWireTargets`, etc.) is not covered by unit tests. These functions require live Yahoo and MLB API credentials to execute, and mocking them would add significant complexity with limited confidence — API contract changes (the actual failure mode) aren't caught by mocks anyway. The OAuth flow is similarly I/O-only with no meaningful logic to isolate.

---

## License

MIT
