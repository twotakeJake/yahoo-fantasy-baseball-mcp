# Flatbottom Phil — Backlog & Implementation Notes
**Last updated:** 2026-04-13

---

## In Progress / Active Branch

- `feature/trade-pitch-tool` — selling mode, offer tiers, ADP enrichment, find_free_agents

---

## Notification / Alerting (Not Started)

### SMS via Twilio
**What it'd take:**
1. Create a free Twilio account at twilio.com, get a phone number (~$1/mo)
2. Note your Account SID, Auth Token, and Twilio number
3. Add to `.env`: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `TWILIO_TO`
4. `npm install twilio`
5. Write a standalone `src/digest.ts` script that:
   - Calls Yahoo API directly (or reuses Phil's helpers) for transactions + standings + wire changes
   - Formats a short morning summary (~5 lines)
   - POSTs to Twilio's Messages API
6. Add `"digest": "node build/digest.js"` to package.json scripts
7. Cron it: `0 8 * * * cd /path/to/project && npm run digest`

**Effort:** ~2-3 hours including Twilio account setup. Cost: fractions of a cent per SMS.

---

### Push Notifications via Pushover
**What it'd take:**
1. Buy Pushover app ($5 one-time, iOS/Android) at pushover.net
2. Create an application at pushover.net/apps to get an API token
3. Note your User Key and API Token
4. Add to `.env`: `PUSHOVER_USER_KEY`, `PUSHOVER_API_TOKEN`
5. No npm package needed — Pushover uses a simple HTTPS POST (axios works fine)
6. Write a standalone `src/digest.ts` script (same as above, different delivery):
   - Formats morning summary
   - POSTs to `https://api.pushover.net/1/messages.json` with title + message
7. Cron same as above

**Effort:** ~1-2 hours. Cost: $5 one-time for the app.

---

### Shared Digest Script (feeds both)
Both options above can share the same digest logic. Structure would be:
```
src/
  digest.ts          — fetches data, formats summary, calls notifier
  notifiers/
    twilio.ts        — SMS delivery
    pushover.ts      — push delivery
```
Pick one notifier or support both via env flag (`NOTIFY_VIA=pushover|twilio`).

---

## Tool Backlog (prioritized)

| Priority | Item | Notes |
|---|---|---|
| ✅ Done | `get_pitcher_starts` | Which of your SP/RP are starting on a given day/week, and how many starts remain in the scoring period. Essential for streaming decisions. Pull from Yahoo schedule or MLB stats API. |
| ✅ Done | `get_roster_injury_sweep` | Proactive sweep of all rostered players — returns anyone with a new injury flag since last check. Complements `get_player_news` which is pull-based per player. |
| ✅ Done | `get_category_standings` | Break down standings category-by-category across the league — rank in each stat. Useful for deciding whether to stream for Ks vs ERA vs saves. |
| ✅ Done | `set_lineup` | Push optimal lineup to Yahoo for a given day. Requires Yahoo roster edit API endpoint. Biggest lift but highest daily value. |
| ✅ Done | `get_opponent_scouting` | Deep dive on current matchup opponent: roster health, recent trends, category vulnerabilities to exploit. Extends existing `get_matchup`. |
| Medium | Caching layer | League rosters re-fetch every tool call. One shared fetch/session cuts Yahoo API calls ~60% |
| Medium | `evaluate_advice` outcomes | Tool is built; needs actual use to accumulate data |
| ✅ Done | `get_faab_budget` | Remaining FAAB budget + bid history for leagues using auction waivers. |
| Low | Player blurbs (Rotowire) | JS-rendered. Needs headless Playwright (chromium). Run one persistent browser instance at server start, reuse across calls. `npm install playwright` + `npx playwright install chromium` (~300MB one-time). Keep MLB.com RSS (`get_player_news`) for fast general headlines; Rotowire adds fantasy-specific injury/performance blurbs. |
| Low | Crown jewel pitch integration | Auto-pull trade_scenarios.md counter-offer when Ohtani/Raleigh is the target in pitch tool |
| Low | Pitch persistence | Auto-append generated pitches to docs/trade_scenarios.md |
| Idea | Morning digest + notifications | See above — SMS (Twilio) or push (Pushover) |
| Idea | Claude Code scheduled agent | Use /schedule skill to run Phil tools on cron and summarize in a conversation |

---

## Completed (this branch cycle)

- `get_standings`
- `get_league_transactions`
- `get_matchup`
- `evaluate_advice`
- `get_league_power_rankings`
- `auto_generate_trade_pitch` (buying + selling modes, offer tiers, live ADP)
- `find_free_agents`
- `get_player_news` (MLB.com RSS feed, multi-player, searchable by last name)
- injury status + injuryNote surfaced on all roster/wire calls via `parsePlayerInfo`
- CI fix: typescript → devDependencies, removed @types/bun
