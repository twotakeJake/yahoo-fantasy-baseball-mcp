# Yahoo Fantasy Baseball MCP Server

[![CI](https://github.com/twotakeJake/yahoo-fantasy-baseball-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/twotakeJake/yahoo-fantasy-baseball-mcp/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)

An MCP (Model Context Protocol) server named **Flatbottom Phil** that connects Claude to the Yahoo Fantasy Sports API. Ask Claude natural-language questions about your fantasy baseball team — roster, waiver wire, trades, age/rebuild analysis, matchups, standings, and more — and get real data back.

Age data is pulled live from the **MLB Stats API** and cross-referenced by name + jersey number to handle players who share a name (e.g. two Max Muncys).

---

## Available Tools (34)

### Roster & Wire

| Tool | Description |
|---|---|
| `get_team_roster` | Current roster with position, slot, and MLB team |
| `get_waiver_wire_targets` | Available free agents filtered by age, sorted by ADP. Tagged *lotto ticket* (≤24) or *target* (25–29) |
| `find_free_agents` | Roster-aware wire finder. Detects your positional thin spots and surfaces available players that fill those gaps, sorted by ADP. Filter to a specific position or scan all thin spots at once |
| `get_waiver_wire_delta` | What changed on the wire since the last scan — newly available and newly claimed players |
| `get_prospect_overlap` | Cross-references your roster and wire against recently debuted young players (age ≤25, debuted 2024+) |
| `get_pitcher_starts` | Which of your rostered pitchers are scheduled to start over the next N days (default 7), with opponent, home/away, and date — for streaming and counting starts left in the scoring week |
| `get_roster_injury_sweep` | Sweeps your roster for injuries — currently injured, newly flagged, and recently cleared; saves a snapshot each run so the delta stays fresh |

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
| `get_schedule` | Full league schedule for one or more weeks — all matchups with competitive_tier labels (top_vs_top, etc.) and results for completed weeks. Defaults to remaining regular-season weeks |
| `get_category_standings` | Ranks all teams category-by-category on season-to-date stats — your rank per category, strengths/weaknesses, and the full per-stat table. Essential for streaming decisions |
| `get_opponent_scouting` | Deep dive on this week's opponent — full roster with injury flags, season category ranks vs the league, and which categories to attack (they're weak) vs defend (they're strong) |
| `get_faab_budget` | Your remaining FAAB budget vs the rest of the league (or waiver priority if the league is priority-based) |

### Lineup

| Tool | Description |
|---|---|
| `get_current_lineup` | Your active/BN/IL assignments for a given date, flags issues (injured players in active slots, IL-eligible players on BN, empty slots), and compares against the optimal lineup |
| `set_lineup` | Optimize and push your lineup to Yahoo for a date — auto-assigns IL-eligible injured players to IL, fills active slots most-constrained-first, benches the rest. `dry_run=true` to preview |

### Player Research & Data

| Tool | Description |
|---|---|
| `get_player_performance` | Statcast-powered profile for one or more players — fantasy stats plus advanced metrics (xERA, Barrel%, wOBA, Hard Hit%, fWAR, SwStr%) and opinionated signals: BABIP luck, ERA–xERA delta, contact-quality tier, and ADP over/underperformance |
| `get_player_news` | Recent MLB.com RSS headlines for one or more players (editorial headlines, not fantasy blurbs) |
| `get_rotowire_data` | RotoWire scraper — five data types: `player_news`, `probable_starters`, `pitcher_usage`, `player_outlook`, `injury_report`. 30-minute cache (`force_refresh` to bust) |
| `get_baseball_reference_stats` | Baseball-Reference scraper — five stat types: `splits`, `park_factors`, `plate_discipline`, `career_trajectory`, `minor_league`. 24-hour cache |

### Logs & Accountability

| Tool | Description |
|---|---|
| `regret_list` | Log dropped/traded-away players and check if they're back on the wire |
| `trade_history_log` | Record and view trade history — pending, accepted, rejected — with crown jewel scenario lookup |
| `evaluate_advice` | Phil's accountability log. Record calls Phil makes, update with outcomes, score his hit rate by category |

---

## Setup

### 1. Get your Yahoo session cookies

This server authenticates with your **Yahoo session cookies**, not OAuth — Yahoo's OAuth 2.0 tokens are rejected by the Fantasy Sports API with a 403 (see [Authentication](#authentication)).

1. Log in to [baseball.fantasysports.yahoo.com](https://baseball.fantasysports.yahoo.com) in your browser.
2. Open DevTools → **Network** tab, reload the page, and click any request to `fantasysports.yahoo.com`.
3. Under **Request Headers**, copy the full **`Cookie`** header value — that string is your `YAHOO_COOKIES`.

Cookies last weeks to months. When they expire (calls start returning 401), repeat this step and update the value. `YAHOO_CRUMB` is optional — the server fetches and refreshes it automatically.

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

Edit `.env` and fill in your values:

```
YAHOO_COOKIES=your_full_cookie_header_string
YAHOO_LEAGUE_ID=your_league_id
YAHOO_TEAM_NUMBER=your_team_number
YAHOO_TEAM_NAME=your_team_name
```

> Your league ID is in the URL when you visit your Yahoo Fantasy league page. Your team number is your team's position in the league (visible in the team URL). `YAHOO_CRUMB` is optional — the server fetches one automatically.

### 4. Build

```bash
npm run build
```

### 5. Add to Claude Code

Add the following to your Claude MCP settings file (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "yahoo-fantasy-baseball": {
      "command": "node",
      "args": ["/absolute/path/to/yahoo-fantasy-baseball-mcp/build/index.js"],
      "env": {
        "YAHOO_COOKIES": "your_full_cookie_header_string",
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

### 6. Restart Claude Code

Start a new Claude Code session and test it:

> "Use `get_team_roster` to show my current lineup"

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `YAHOO_COOKIES` | Yes | Full `Cookie` header from an authenticated Yahoo Fantasy browser session |
| `YAHOO_LEAGUE_ID` | Yes | Your Yahoo Fantasy league ID |
| `YAHOO_TEAM_NUMBER` | Yes | Your team number within the league |
| `YAHOO_CRUMB` | No | Yahoo crumb token; fetched and refreshed automatically if omitted |
| `YAHOO_TEAM_NAME` | No | Display name for your team (cosmetic only) |

> **Deprecated:** `YAHOO_CLIENT_ID`, `YAHOO_CLIENT_SECRET`, `YAHOO_ACCESS_TOKEN`, and `YAHOO_REFRESH_TOKEN` are only used by the legacy OAuth helper scripts (`npm run get-token` / `refresh-token`). The live server ignores them — see [Authentication](#authentication).

---

## Authentication

The server authenticates with **Yahoo session cookies + a crumb token**, sent as a `Cookie` header on each request (no `Authorization` header). On a 401 it fetches a fresh crumb from the Yahoo Fantasy page and retries automatically.

**Why not OAuth?** Yahoo's OAuth 2.0 flow still issues tokens, but the Fantasy Sports API rejects them with `403 "This application is not authorized"`. The `get-token` / `refresh-token` scripts and their `CLIENT_ID`/`CLIENT_SECRET`/`ACCESS_TOKEN`/`REFRESH_TOKEN` variables remain in the repo for reference only and are not used at runtime.

---

## Persistent Data Files

These files are created and maintained automatically in the `data/` directory:

| File | Purpose |
|---|---|
**Authored data** (version-controlled — your records live here):

| File | Purpose |
|---|---|
| `data/rubric_config.json` | Phil Rebuild Rubric config — milestones, age weights, top-30 bonus players, young core baseline |
| `data/rebuild_progress.json` | Age profile snapshots over time (written by `rebuild_progress_tracker`) |
| `data/regret_list.json` | Dropped/traded-away player log (written by `regret_list`) |
| `data/trade_history.json` | Trade log (written by `trade_history_log`) |
| `data/advice_log.json` | Phil's advice accountability log (written by `evaluate_advice`) |

**Regenerable caches** (git-ignored — rewritten by tools each run, safe to delete):

| File | Purpose |
|---|---|
| `data/wire_snapshot.json` | Last waiver wire scan (used by `get_waiver_wire_delta`) |
| `data/injury_snapshot.json` | Last roster injury scan (used by `get_roster_injury_sweep`) |

The file `docs/trade_scenarios.md` is a manually maintained counter-offer reference for crown jewel players, parsed programmatically by `get_trade_scenarios` and `trade_history_log`.

---

## Testing

```bash
npm test            # build + run the suite (98 tests)
npm run test:coverage   # same, with coverage report (Node 22+)
```

> `npm test` runs coverage-free so it passes on all supported Node versions — Node 20/22 crash the experimental coverage reporter. Use `test:coverage` for the report.

Tests cover the pure data-transformation layer — the functions responsible for parsing Yahoo's API response format, normalizing names and ages, building lineups, and computing standings/matchup/signal logic. Current coverage: **line 98.8% · branch 94.1% · funcs 100%**.

**What is tested (14 functions):** `normalizeName`, `lookupAge`, `extractField`, `parsePlayerInfo`, `extractPlayersMap`, `buildOptimalLineup`, `computeCategoryRankings`, `adpTier`, `generateBatterSignals`, `generatePitcherSignals`, `rankBand`, `competitiveTier`, `mapMatchupStatus`, `defaultScheduleWeeks`

**What is not tested:** The API I/O layer requires live Yahoo and MLB credentials (and, for the scraper tools, live RotoWire / Baseball-Reference HTML). Mocking them would add complexity without catching the actual failure mode — API contract and page-structure changes.

---

## License

MIT
