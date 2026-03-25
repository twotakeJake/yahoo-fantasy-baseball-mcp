# Flatbottom Phil — Backlog & Implementation Notes
**Last updated:** 2026-03-25

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
| Medium | Caching layer | League rosters re-fetch every tool call. One shared fetch/session cuts Yahoo API calls ~60% |
| Medium | `evaluate_advice` outcomes | Tool is built; needs actual use to accumulate data |
| Low | Player blurbs (Rotowire) | JS-rendered, not accessible via WebFetch. Needs headless browser (Playwright) |
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
- CI fix: typescript → devDependencies, removed @types/bun
