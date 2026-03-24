# Yahoo Fantasy Baseball MCP Server

[![CI](https://github.com/twotakeJake/yahoo-fantasy-baseball-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/twotakeJake/yahoo-fantasy-baseball-mcp/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

An MCP (Model Context Protocol) server named **Flatbottom Phil** that connects Claude to the Yahoo Fantasy Sports API. Ask Claude natural-language questions about your fantasy baseball team — roster, waiver wire, trades, age/rebuild analysis, matchups, standings, and more — and get real data back.

Age data is pulled live from the **MLB Stats API** and cross-referenced by name + jersey number to handle players who share a name (e.g. two Max Muncys).

---

## Available Tools (21)

### Roster & Wire

| Tool | Description |
|---|---|
| `get_team_roster` | Current roster with position, slot, and MLB team |
| `get_waiver_wire_targets` | Available free agents filtered by age, sorted by ADP. Tagged *lotto ticket* (≤24) or *target* (25–29) |
| `get_waiver_wire_delta` | What changed on the wire since the last scan — newly available and newly claimed players |
| `get_prospect_overlap` | Cross-references your roster and wire against recently debuted young players (age ≤25, debuted 2024+) |

### Rebuild & Age Analysis

| Tool | Description |
|---|---|
| `get_team_age_profile` | Roster sorted by age with median age, rebuild score, and gap to target median |
| `rebuild_progress_tracker` | Snapshots median age and roster composition over time; shows trend |
| `get_rebuild_scorecard` | Full 5-dimension Phil Rebuild Rubric: age progress, core stability, asset quality, competitive viability, transaction quality |
| `get_league_power_rankings` | Composite rank for all teams: 35% age score + 40% asset quality + 25% win rate |

### Trades

| Tool | Description |
|---|---|
| `get_trade_targets` | Players on other league rosters filtered by age, sorted youngest-first |
| `simulate_trade` | Preview age/roster impact of a proposed trade before sending it |
| `evaluate_trade` | Scores a trade across ADP value, age multiplier, and positional scarcity — returns ADVANTAGEOUS / EQUITABLE / UNFAVORABLE |
| `team_needs_analysis` | Positional thin spots and young assets for every team in the league |
| `trade_partner_finder` | Given a player you want to move, finds which teams need that position and ranks by young talent they can offer back |
| `get_trade_scenarios` | Reads `docs/trade_scenarios.md` — counter-offer reference for crown jewels (Ohtani, Raleigh) |
| `auto_generate_trade_pitch` | Two modes: **buying** (acquire a player) or **selling** (move one). Scores all assets with live ADP, generates floor/target/ceiling offer tiers, and writes a structured pitch with rationale |

### League & Matchup

| Tool | Description |
|---|---|
| `get_standings` | W/L/T record, win pct, streak, and rank for all teams |
| `get_league_transactions` | Recent league-wide adds, drops, and trades. Filterable by type |
| `get_matchup` | Current week H2H matchup — your roster vs opponent's, with category stat breakdown |

### Logs & Accountability

| Tool | Description |
|---|---|
| `regret_list` | Log dropped/traded-away players and check if they're back on the wire |
| `trade_history_log` | Record and view trade history — pending, accepted, rejected — with crown jewel scenario lookup |
| `evaluate_advice` | Phil's accountability log. Record calls Phil makes, update with outcomes, score his hit rate by category |

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
git clone https://github.com/twotakeJake/yahoo-fantasy-baseball-mcp.git
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
YAHOO_TEAM_NAME=your_team_name
```

> Your league ID is in the URL when you visit your Yahoo Fantasy league page. Your team number is your team's position in the league (visible in the team URL).

### 4. Get an Access Token

```bash
npm run get-token
```

This opens your browser to Yahoo's authorization page. After you approve the app, Yahoo redirects to `https://localhost:8080?code=...` — the page will show a connection error, which is expected. Copy the full URL from your browser's address bar and paste it back into the terminal. The script exchanges the code for tokens and writes them to `.env` automatically.

To silently refresh an expired token without a browser:

```bash
npm run refresh-token
```

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
        "YAHOO_REFRESH_TOKEN": "your_refresh_token",
        "YAHOO_LEAGUE_ID": "your_league_id",
        "YAHOO_TEAM_NUMBER": "your_team_number",
        "YAHOO_TEAM_NAME": "your_team_name"
      },
      "transportType": "stdio"
    }
  }
}
```

> Use the full absolute path. Relative paths are a common failure point.

### 7. Restart Claude Code

Start a new Claude Code session and test it:

> "Use `get_team_roster` to show my current lineup"

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `YAHOO_CLIENT_ID` | Yes | OAuth app Client ID |
| `YAHOO_CLIENT_SECRET` | Yes | OAuth app Client Secret |
| `YAHOO_ACCESS_TOKEN` | Yes | OAuth 2.0 Bearer access token (populated by `npm run get-token`) |
| `YAHOO_REFRESH_TOKEN` | Yes | OAuth refresh token — used for silent auto-refresh on 401s |
| `YAHOO_LEAGUE_ID` | Yes | Your Yahoo Fantasy league ID |
| `YAHOO_TEAM_NUMBER` | Yes | Your team number within the league |
| `YAHOO_TEAM_NAME` | No | Display name for your team (cosmetic only) |

---

## Persistent Data Files

These files are created and maintained automatically in the `data/` directory:

| File | Purpose |
|---|---|
| `data/rubric_config.json` | Phil Rebuild Rubric config — milestones, age weights, top-30 bonus players, young core baseline |
| `data/rebuild_progress.json` | Age profile snapshots over time (written by `rebuild_progress_tracker`) |
| `data/wire_snapshot.json` | Last waiver wire scan (used by `get_waiver_wire_delta`) |
| `data/regret_list.json` | Dropped/traded-away player log |
| `data/trade_history.json` | Trade log |
| `data/advice_log.json` | Phil's advice accountability log |

The file `docs/trade_scenarios.md` is a manually maintained counter-offer reference for crown jewel players, parsed programmatically by `get_trade_scenarios` and `trade_history_log`.

---

## Testing

```bash
npm test
```

Tests cover the pure data-transformation layer — the functions responsible for parsing Yahoo's API response format, normalizing player names, and resolving player ages.

```
transforms.js | line: 100% | branch: 96.55% | funcs: 100%
```

**What is tested:** `normalizeName`, `lookupAge`, `extractField`, `parsePlayerInfo`, `extractPlayersMap`

**What is not tested:** The API I/O layer requires live Yahoo and MLB API credentials. Mocking them would add complexity without catching the actual failure mode (API contract changes).

---

## License

MIT
