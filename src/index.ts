#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import { config } from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizeName, lookupAge, extractField, parsePlayerInfo, extractPlayersMap } from './utils/transforms.js';

config();

const YAHOO_CLIENT_ID = process.env.YAHOO_CLIENT_ID || '';
const YAHOO_CLIENT_SECRET = process.env.YAHOO_CLIENT_SECRET || '';
let accessToken = process.env.YAHOO_ACCESS_TOKEN || '';
let refreshToken = process.env.YAHOO_REFRESH_TOKEN || '';

const LEAGUE_ID = process.env.YAHOO_LEAGUE_ID || '';
const TEAM_NUMBER = process.env.YAHOO_TEAM_NUMBER || '';
const TEAM_NAME = process.env.YAHOO_TEAM_NAME || 'My Team';

if (!YAHOO_CLIENT_ID || !YAHOO_CLIENT_SECRET || !LEAGUE_ID || !TEAM_NUMBER) {
  throw new Error('YAHOO_CLIENT_ID, YAHOO_CLIENT_SECRET, YAHOO_LEAGUE_ID, and YAHOO_TEAM_NUMBER are required in environment variables');
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');

class FlatbottomPhil {
  private server: Server;
  private yahooApi;
  private mlbApi;
  private cachedGameKey: string | null = null;
  private cachedAgeMap: Map<string, { age: number; jersey: string }[]> | null = null;

  constructor() {
    this.server = new Server(
      { name: 'flatbottom-phil', version: '0.2.0' },
      { capabilities: { tools: {} } }
    );

    this.yahooApi = axios.create({
      baseURL: 'https://fantasysports.yahooapis.com/fantasy/v2',
    });

    this.mlbApi = axios.create({
      baseURL: 'https://statsapi.mlb.com/api/v1',
    });

    this.setupToolHandlers();
    this.setupTokenRefresh();

    this.server.onerror = (error) => console.error('[Phil Error]', error);
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  // --- Utilities ---

  private authHeaders() {
    return { Authorization: `Bearer ${accessToken}` };
  }

  // On 401, attempt a token refresh and retry the original request once.
  private setupTokenRefresh() {
    this.yahooApi.interceptors.response.use(
      (res) => res,
      async (error) => {
        if (error.response?.status !== 401 || error.config?._retried || !refreshToken) {
          return Promise.reject(error);
        }
        try {
          const credentials = Buffer.from(`${YAHOO_CLIENT_ID}:${YAHOO_CLIENT_SECRET}`).toString('base64');
          const params = new URLSearchParams();
          params.append('grant_type', 'refresh_token');
          params.append('refresh_token', refreshToken);
          const { data } = await axios.post('https://api.login.yahoo.com/oauth2/get_token', params.toString(), {
            headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/x-www-form-urlencoded' },
          });
          accessToken = data.access_token;
          if (data.refresh_token) refreshToken = data.refresh_token;
          console.error('[Auth] Token refreshed automatically.');
          error.config._retried = true;
          error.config.headers['Authorization'] = `Bearer ${accessToken}`;
          return this.yahooApi.request(error.config);
        } catch (refreshError) {
          console.error('[Auth] Token refresh failed. Run: npm run refresh-token');
          return Promise.reject(error);
        }
      }
    );
  }

  private async getGameKey(): Promise<string> {
    if (this.cachedGameKey) return this.cachedGameKey;
    const res = await this.yahooApi.get('/game/mlb', {
      headers: this.authHeaders(),
      params: { format: 'json' },
    });
    this.cachedGameKey = res.data.fantasy_content.game[0].game_key as string;
    return this.cachedGameKey;
  }

  private async buildTeamKey(teamNumber = TEAM_NUMBER): Promise<string> {
    const gameKey = await this.getGameKey();
    return `${gameKey}.l.${LEAGUE_ID}.t.${teamNumber}`;
  }

  private async buildLeagueKey(): Promise<string> {
    const gameKey = await this.getGameKey();
    return `${gameKey}.l.${LEAGUE_ID}`;
  }

  // Fetch all active MLB players with ages from the MLB Stats API (cached per session).
  // Stores an array per name to handle same-name players (e.g. two Max Muncys).
  private async getAgeMap(): Promise<Map<string, { age: number; jersey: string }[]>> {
    if (this.cachedAgeMap) return this.cachedAgeMap;
    const res = await this.mlbApi.get('/sports/1/players', {
      params: { season: 2026, fields: 'people,fullName,currentAge,primaryNumber' },
    });
    const map = new Map<string, { age: number; jersey: string }[]>();
    for (const p of res.data.people as { fullName: string; currentAge: number; primaryNumber?: string }[]) {
      const key = normalizeName(p.fullName);
      const entry = { age: p.currentAge, jersey: p.primaryNumber ?? '' };
      const existing = map.get(key);
      if (existing) {
        existing.push(entry);
      } else {
        map.set(key, [entry]);
      }
    }
    this.cachedAgeMap = map;
    return map;
  }

  // --- Tool Handlers ---

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_team_roster',
          description: 'Get the current roster with position and slot info',
          inputSchema: {
            type: 'object',
            properties: {
              team_key: { type: 'string', description: 'Yahoo team key (optional)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_waiver_wire_targets',
          description:
            'Top available free agents under a given age, sorted by ADP. ' +
            'Flags lotto-ticket youth (age <=24) vs solid rebuilding targets (25-29).',
          inputSchema: {
            type: 'object',
            properties: {
              max_age: { type: 'number', description: 'Max player age to include (default: 29)' },
              count: { type: 'number', description: 'Number of wire players to scan (default: 75)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_trade_targets',
          description:
            'Players rostered on other league teams filtered by age. ' +
            'Sorted by age to surface the youngest tradeable assets.',
          inputSchema: {
            type: 'object',
            properties: {
              max_age: { type: 'number', description: 'Max player age to include (default: 29)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_team_age_profile',
          description:
            'Your roster sorted by age with median age, rebuild score, and gap to your ~25 target median.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'simulate_trade',
          description:
            'Preview the age/roster impact of a proposed trade before sending it. ' +
            'Shows before/after median age, rebuild score delta, and flags what you gain or lose.',
          inputSchema: {
            type: 'object',
            properties: {
              send: {
                type: 'array',
                items: { type: 'string' },
                description: 'Player names you are sending away',
              },
              receive: {
                type: 'array',
                items: { type: 'string' },
                description: 'Player names you are receiving',
              },
            },
            required: ['send', 'receive'],
            additionalProperties: false,
          },
        },
        {
          name: 'get_waiver_wire_delta',
          description:
            'What changed on the waiver wire since the last scan. ' +
            'Shows newly available players and players that disappeared (claimed/dropped). Saves a snapshot each run.',
          inputSchema: {
            type: 'object',
            properties: {
              max_age: { type: 'number', description: 'Max player age to track (default: 29)' },
              count: { type: 'number', description: 'Number of wire players to scan (default: 75)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_prospect_overlap',
          description:
            'Cross-references your roster and the waiver wire against recently debuted young players ' +
            '(age <=25, debuted 2024+). Surfaces prospect-pedigree players you own or can grab.',
          inputSchema: {
            type: 'object',
            properties: {
              max_age: { type: 'number', description: 'Max age to consider a prospect (default: 25)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'rebuild_progress_tracker',
          description:
            'Snapshots current median age and roster composition, appends to history, and shows the trend over time. ' +
            'Call regularly to track rebuild progress.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'regret_list',
          description:
            'Log dropped or traded-away players and check if they\'re available again on the wire. ' +
            'Actions: add (log a player you dropped), check (scan wire for their availability), remove (clear from list).',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['add', 'check', 'remove'],
                description: 'add = log players you dropped, check = see who\'s back on wire, remove = clear from list (default: check)',
              },
              players: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    position: { type: 'string' },
                    mlbTeam: { type: 'string' },
                    dropped_for: { type: 'string', description: 'Player added in their place' },
                    notes: { type: 'string' },
                  },
                  required: ['name'],
                },
                description: 'Required for add/remove actions',
              },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'trade_history_log',
          description:
            'Record and view trade history. Log pending/accepted/rejected trades and track what went out vs what came in.',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['log', 'view', 'update_status'],
                description: 'log = record a trade, view = see history, update_status = mark accepted/rejected (default: view)',
              },
              sent: { type: 'array', items: { type: 'string' }, description: 'Player names sent away (for log)' },
              received: { type: 'array', items: { type: 'string' }, description: 'Player names received (for log)' },
              counterpart_team: { type: 'string', description: 'Name of the other fantasy team' },
              notes: { type: 'string', description: 'Any notes about the trade' },
              status: {
                type: 'string',
                enum: ['pending', 'accepted', 'rejected'],
                description: 'Trade status for log or update_status',
              },
              trade_id: { type: 'number', description: 'Trade ID to update (for update_status)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'team_needs_analysis',
          description:
            'For each team in the league, identifies positional thin spots and surfaces their young tradeable assets. ' +
            'Optionally filter to a single team by name.',
          inputSchema: {
            type: 'object',
            properties: {
              team: { type: 'string', description: 'Filter to a specific team name (partial match, optional)' },
              max_age_assets: { type: 'number', description: 'Max age to consider a player a young asset (default: 27)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'trade_partner_finder',
          description:
            'Given a player you want to move, finds which league teams are thin at that position and ranks them ' +
            'by how much young talent they can offer in return.',
          inputSchema: {
            type: 'object',
            properties: {
              player_name: { type: 'string', description: 'Name of the player you want to trade away' },
              max_age_return: { type: 'number', description: 'Max age of players you want back (default: 27)' },
            },
            required: ['player_name'],
            additionalProperties: false,
          },
        },
        {
          name: 'get_trade_scenarios',
          description:
            'Read the trade scenarios reference doc (docs/trade_scenarios.md). ' +
            'Optionally filter by player ("ohtani" or "raleigh") and/or trading partner team name. ' +
            'Auto-surfaces when a crown jewel is logged in trade_history_log.',
          inputSchema: {
            type: 'object',
            properties: {
              player: { type: 'string', description: 'Filter by crown jewel: "ohtani" or "raleigh"' },
              team: { type: 'string', description: 'Filter by trading partner team name (partial match)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'evaluate_trade',
          description:
            'Scores a proposed trade across three lenses — ADP-based market value, age multiplier (rebuild), ' +
            'and positional scarcity — and returns a verdict: ADVANTAGEOUS / EQUITABLE / UNFAVORABLE. ' +
            'Shows per-player score breakdown and value differential.',
          inputSchema: {
            type: 'object',
            properties: {
              send: {
                type: 'array',
                items: { type: 'string' },
                description: 'Player names you are sending away',
              },
              receive: {
                type: 'array',
                items: { type: 'string' },
                description: 'Player names you are receiving',
              },
            },
            required: ['send', 'receive'],
            additionalProperties: false,
          },
        },
        {
          name: 'get_rebuild_scorecard',
          description:
            'Computes the full 5-dimension Phil Rebuild Rubric scorecard: age progress, core stability, ' +
            'asset quality score, competitive viability, and transaction quality. ' +
            'Seeds the young-core baseline on first run. Call at each checkpoint (All-Star, end of season).',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'get_standings',
          description: 'Current league standings — W/L/T record, win pct, and rank for all teams.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'get_league_transactions',
          description:
            'Recent league-wide transactions: adds, drops, and trades. ' +
            'Optionally filter by type (add, drop, trade) and limit count.',
          inputSchema: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['add', 'drop', 'trade', 'all'],
                description: 'Transaction type to filter by (default: all)',
              },
              count: { type: 'number', description: 'Number of transactions to return (default: 25)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_matchup',
          description:
            'Current week H2H matchup — your roster vs your opponent\'s roster, ' +
            'with category-level stat breakdown where available.',
          inputSchema: {
            type: 'object',
            properties: {
              week: { type: 'number', description: 'Scoring week (default: current week)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'evaluate_advice',
          description:
            'Phil\'s accountability log. ' +
            'Log advice Phil gave, record what actually happened, and score Phil\'s hit rate over time. ' +
            'Actions: log (record a call), outcome (update with what happened), score (see Phil\'s batting average).',
          inputSchema: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['log', 'outcome', 'score'],
                description: 'log = record a call Phil made, outcome = update with result, score = see hit rate (default: score)',
              },
              call: { type: 'string', description: 'The advice or recommendation Phil made (for log)' },
              category: {
                type: 'string',
                enum: ['drop', 'add', 'trade', 'hold', 'other'],
                description: 'Type of advice (for log)',
              },
              players: {
                type: 'array',
                items: { type: 'string' },
                description: 'Players involved in the call (for log)',
              },
              advice_id: { type: 'number', description: 'ID of the advice entry to update (for outcome)' },
              result: {
                type: 'string',
                enum: ['correct', 'incorrect', 'partial', 'tbd'],
                description: 'How it turned out (for outcome)',
              },
              outcome_notes: { type: 'string', description: 'What actually happened (for outcome)' },
            },
            additionalProperties: false,
          },
        },
        {
          name: 'get_league_power_rankings',
          description:
            'Composite power ranking for all 10 teams: age score + asset quality + win rate. ' +
            'Shows each team\'s component scores and overall rank. Best signal on who\'s ascending vs declining.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        {
          name: 'auto_generate_trade_pitch',
          description:
            'Draft a trade pitch with floor/target/ceiling offer tiers and live ADP scoring. ' +
            'Two modes: buying (you want someone) or selling (you want to move someone). ' +
            'Analyzes positional needs, scores assets with real ADP, and writes a structured pitch.',
          inputSchema: {
            type: 'object',
            properties: {
              mode: {
                type: 'string',
                enum: ['buying', 'selling'],
                description: 'buying = you want to acquire a player; selling = you want to move one (default: buying)',
              },
              target_player: { type: 'string', description: 'Player you want to acquire (buying mode)' },
              offer_player: { type: 'string', description: 'Player you want to move (selling mode)' },
              target_team: { type: 'string', description: 'Team that owns the target (buying) or best landing spot (selling) — partial name match' },
              max_offer_age: { type: 'number', description: 'Max age of players you\'re willing to offer in buying mode (default: 32)' },
            },
            additionalProperties: false,
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'get_team_roster':
            return await this.getTeamRoster(request.params.arguments);
          case 'get_waiver_wire_targets':
            return await this.getWaiverWireTargets(request.params.arguments);
          case 'get_trade_targets':
            return await this.getTradeTargets(request.params.arguments);
          case 'get_team_age_profile':
            return await this.getTeamAgeProfile();
          case 'simulate_trade':
            return await this.simulateTrade(request.params.arguments);
          case 'get_waiver_wire_delta':
            return await this.getWaiverWireDelta(request.params.arguments);
          case 'get_prospect_overlap':
            return await this.getProspectOverlap(request.params.arguments);
          case 'rebuild_progress_tracker':
            return await this.rebuildProgressTracker();
          case 'regret_list':
            return await this.regretList(request.params.arguments);
          case 'trade_history_log':
            return await this.tradeHistoryLog(request.params.arguments);
          case 'team_needs_analysis':
            return await this.teamNeedsAnalysis(request.params.arguments);
          case 'trade_partner_finder':
            return await this.tradePartnerFinder(request.params.arguments);
          case 'get_trade_scenarios':
            return await this.getTradeScenarios(request.params.arguments);
          case 'evaluate_trade':
            return await this.evaluateTrade(request.params.arguments);
          case 'get_rebuild_scorecard':
            return await this.getRebuildScorecard();
          case 'get_standings':
            return await this.getStandings();
          case 'get_league_transactions':
            return await this.getLeagueTransactions(request.params.arguments);
          case 'get_matchup':
            return await this.getMatchup(request.params.arguments);
          case 'evaluate_advice':
            return await this.evaluateAdvice(request.params.arguments);
          case 'get_league_power_rankings':
            return await this.getLeaguePowerRankings();
          case 'auto_generate_trade_pitch':
            return await this.autoGenerateTradePitch(request.params.arguments);
          default:
            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        if (axios.isAxiosError(error)) {
          return {
            content: [
              {
                type: 'text',
                text: `API error: ${error.response?.data ? JSON.stringify(error.response.data) : error.message}`,
              },
            ],
            isError: true,
          };
        }
        throw error;
      }
    });
  }

  // --- Tool Implementations ---

  private async getTeamRoster(args: any) {
    const teamKey = args?.team_key ?? (await this.buildTeamKey());
    const res = await this.yahooApi.get(`/team/${teamKey}/roster/players`, {
      headers: this.authHeaders(),
      params: { format: 'json' },
    });

    const rosterObj = res.data.fantasy_content.team[1].roster;
    const players = extractPlayersMap(rosterObj);

    const parsed = Object.entries(players)
      .filter(([k]) => k !== 'count')
      .map(([, v]: [string, any]) => {
        const info = parsePlayerInfo(v.player[0]);
        const selectedPos: any[] = v.player[1]?.selected_position ?? [];
        const slot = selectedPos.find((x) => x.position !== undefined)?.position ?? '?';
        return { ...info, slot };
      });

    return {
      content: [{ type: 'text', text: JSON.stringify({ team: '${TEAM_NAME}', players: parsed }, null, 2) }],
    };
  }

  private async getWaiverWireTargets(args: any) {
    const maxAge: number = args?.max_age ?? 29;
    const count: number = args?.count ?? 75;

    const [leagueKey, ageMap] = await Promise.all([this.buildLeagueKey(), this.getAgeMap()]);

    const res = await this.yahooApi.get(
      `/league/${leagueKey}/players;status=A;count=${count};sort=AR;out=draft_analysis`,
      { headers: this.authHeaders(), params: { format: 'json' } }
    );

    const playersData = res.data.fantasy_content.league[1].players;
    const targets: any[] = [];

    for (const [k, v] of Object.entries(playersData) as [string, any][]) {
      if (k === 'count') continue;
      const playerArr = v.player;
      const info = parsePlayerInfo(playerArr[0]);
      const adpRaw = playerArr[1]?.draft_analysis?.average_pick;
      const adp = adpRaw ? parseFloat(adpRaw) : null;

      const age = lookupAge(ageMap, info.name, info.jerseyNumber);
      if (age === undefined || age > maxAge) continue;

      targets.push({
        name: info.name,
        position: info.position,
        mlbTeam: info.mlbTeam,
        age,
        adp: adp && !isNaN(adp) ? adp : null,
        tag: age <= 24 ? 'lotto ticket' : 'target',
      });
    }

    // Sort by ADP ascending (best value first); null ADPs go to the end
    targets.sort((a, b) => (a.adp ?? 9999) - (b.adp ?? 9999));

    const lottos = targets.filter((p) => p.tag === 'lotto ticket');
    const solidTargets = targets.filter((p) => p.tag === 'target');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              summary: `${targets.length} available players age <=${maxAge} found`,
              lotto_tickets: lottos,
              solid_targets: solidTargets,
              note: 'Sorted by ADP (lower = drafted earlier = more valuable). lotto ticket = age <=24.',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async getTradeTargets(args: any) {
    const maxAge: number = args?.max_age ?? 29;

    const [leagueKey, ageMap] = await Promise.all([this.buildLeagueKey(), this.getAgeMap()]);
    const myTeamKey = await this.buildTeamKey();

    const res = await this.yahooApi.get(`/league/${leagueKey}/teams/roster/players`, {
      headers: this.authHeaders(),
      params: { format: 'json' },
    });

    const teamsData = res.data.fantasy_content.league[1].teams;
    const targets: any[] = [];

    for (const [tk, tv] of Object.entries(teamsData) as [string, any][]) {
      if (tk === 'count') continue;
      const teamArr = tv.team;
      const teamInfoArr: any[] = teamArr[0];
      const teamKey = extractField(teamInfoArr, 'team_key');
      const teamName = extractField(teamInfoArr, 'name');

      if (teamKey === myTeamKey) continue;

      const rosterObj = teamArr[1]?.roster;
      if (!rosterObj) continue;
      const players = extractPlayersMap(rosterObj);

      for (const [pk, pv] of Object.entries(players) as [string, any][]) {
        if (pk === 'count') continue;
        const info = parsePlayerInfo(pv.player[0]);
        const age = lookupAge(ageMap, info.name, info.jerseyNumber);
        if (age === undefined || age > maxAge) continue;

        targets.push({
          name: info.name,
          position: info.position,
          mlbTeam: info.mlbTeam,
          age,
          fantasyTeam: teamName,
          tag: age <= 24 ? 'lotto ticket' : 'target',
        });
      }
    }

    targets.sort((a, b) => a.age - b.age);

    const lottos = targets.filter((p) => p.tag === 'lotto ticket');
    const solidTargets = targets.filter((p) => p.tag === 'target');

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              summary: `${targets.length} trade targets age <=${maxAge} across other league teams`,
              lotto_tickets: lottos,
              solid_targets: solidTargets,
              note: 'Sorted by age ascending. fantasyTeam = who owns them.',
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async getTeamAgeProfile() {
    const [teamKey, ageMap] = await Promise.all([this.buildTeamKey(), this.getAgeMap()]);

    const res = await this.yahooApi.get(`/team/${teamKey}/roster/players`, {
      headers: this.authHeaders(),
      params: { format: 'json' },
    });

    const rosterObj = res.data.fantasy_content.team[1].roster;
    const players = extractPlayersMap(rosterObj);

    const roster = Object.entries(players)
      .filter(([k]) => k !== 'count')
      .map(([, v]: [string, any]) => {
        const info = parsePlayerInfo(v.player[0]);
        const selectedPos: any[] = v.player[1]?.selected_position ?? [];
        const slot = selectedPos.find((x) => x.position !== undefined)?.position ?? '?';
        const age = lookupAge(ageMap, info.name, info.jerseyNumber) ?? null;
        return { name: info.name, position: info.position, mlbTeam: info.mlbTeam, slot, age };
      });

    roster.sort((a, b) => (a.age ?? 99) - (b.age ?? 99));

    const ages = roster.filter((p) => p.age !== null).map((p) => p.age as number);
    ages.sort((a, b) => a - b);

    let median: number | null = null;
    if (ages.length > 0) {
      median =
        ages.length % 2 === 0
          ? ((ages[ages.length / 2 - 1] ?? 0) + (ages[ages.length / 2] ?? 0)) / 2
          : ages[Math.floor(ages.length / 2)] ?? null;
    }

    const targetMedian = 25;
    const gapStr =
      median !== null
        ? median > targetMedian
          ? `${(median - targetMedian).toFixed(1)} years above target`
          : `${(targetMedian - median).toFixed(1)} years below target (nice)`
        : 'N/A';

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              team: '${TEAM_NAME}',
              median_age: median,
              target_median: targetMedian,
              gap: gapStr,
              rebuild_score: {
                age_24_and_under: ages.filter((a) => a <= 24).length,
                age_25_to_27: ages.filter((a) => a >= 25 && a <= 27).length,
                age_28_to_29: ages.filter((a) => a >= 28 && a <= 29).length,
                age_30_plus: ages.filter((a) => a >= 30).length,
                total_with_age: ages.length,
              },
              roster,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  // Search Yahoo's player pool by name, return first match's parsed info
  private async searchYahooPlayer(name: string, leagueKey: string): Promise<{ name: string; position: string; mlbTeam: string; jerseyNumber: string } | null> {
    const encoded = encodeURIComponent(name);
    const res = await this.yahooApi.get(
      `/league/${leagueKey}/players;search=${encoded};count=1`,
      { headers: this.authHeaders(), params: { format: 'json' } }
    );
    const players = res.data.fantasy_content.league[1].players;
    if (!players || players.count === 0) return null;
    const first = players['0'];
    if (!first) return null;
    return parsePlayerInfo(first.player[0]);
  }

  private calcMedian(ages: number[]): number | null {
    if (ages.length === 0) return null;
    const sorted = [...ages].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
      : sorted[mid] ?? null;
  }

  private async simulateTrade(args: any) {
    const sendNames: string[] = args?.send ?? [];
    const receiveNames: string[] = args?.receive ?? [];

    const [teamKey, leagueKey, ageMap] = await Promise.all([
      this.buildTeamKey(),
      this.buildLeagueKey(),
      this.getAgeMap(),
    ]);

    const res = await this.yahooApi.get(`/team/${teamKey}/roster/players`, {
      headers: this.authHeaders(),
      params: { format: 'json' },
    });

    const rosterObj = res.data.fantasy_content.team[1].roster;
    const players = extractPlayersMap(rosterObj);

    // Build current roster list
    const roster = Object.entries(players)
      .filter(([k]) => k !== 'count')
      .map(([, v]: [string, any]) => {
        const info = parsePlayerInfo(v.player[0]);
        const age = lookupAge(ageMap, info.name, info.jerseyNumber) ?? null;
        return { ...info, age };
      });

    // Match sent players against roster (fuzzy by normalized name)
    const sentPlayers = roster.filter((p) =>
      sendNames.some((s) => normalizeName(p.name).includes(normalizeName(s)))
    );
    const notFound = sendNames.filter(
      (s) => !roster.some((p) => normalizeName(p.name).includes(normalizeName(s)))
    );

    // Look up received players from Yahoo + age map
    const receivedPlayers = await Promise.all(
      receiveNames.map(async (name) => {
        const info = await this.searchYahooPlayer(name, leagueKey);
        if (!info) return { name, position: '?', mlbTeam: '?', age: null };
        const age = lookupAge(ageMap, info.name, info.jerseyNumber) ?? null;
        return { ...info, age };
      })
    );

    // Before: current ages
    const beforeAges = roster.filter((p) => p.age !== null).map((p) => p.age as number);
    const beforeMedian = this.calcMedian(beforeAges);

    // After: remove sent, add received
    const afterRoster = [
      ...roster.filter((p) => !sentPlayers.some((s) => s.name === p.name)),
      ...receivedPlayers,
    ];
    const afterAges = afterRoster.filter((p) => p.age !== null).map((p) => p.age as number);
    const afterMedian = this.calcMedian(afterAges);

    const ageDelta = afterMedian !== null && beforeMedian !== null
      ? parseFloat((afterMedian - beforeMedian).toFixed(1))
      : null;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          trade_summary: {
            you_send: sentPlayers.map((p) => ({ name: p.name, age: p.age, position: p.position })),
            you_receive: receivedPlayers.map((p) => ({ name: p.name, age: p.age, position: p.position })),
            not_found_on_roster: notFound,
          },
          age_impact: {
            median_before: beforeMedian,
            median_after: afterMedian,
            delta: ageDelta !== null ? `${ageDelta > 0 ? '+' : ''}${ageDelta} years` : 'N/A',
            verdict: ageDelta === null ? 'N/A' : ageDelta < 0 ? 'gets younger' : ageDelta > 0 ? 'gets older' : 'no change',
          },
          rebuild_score_after: {
            age_24_and_under: afterAges.filter((a) => a <= 24).length,
            age_25_to_27: afterAges.filter((a) => a >= 25 && a <= 27).length,
            age_28_to_29: afterAges.filter((a) => a >= 28 && a <= 29).length,
            age_30_plus: afterAges.filter((a) => a >= 30).length,
          },
        }, null, 2),
      }],
    };
  }

  private async getWaiverWireDelta(args: any) {
    const maxAge: number = args?.max_age ?? 29;
    const count: number = args?.count ?? 75;

    const leagueKey = await this.buildLeagueKey();
    const ageMap = await this.getAgeMap();

    const res = await this.yahooApi.get(
      `/league/${leagueKey}/players;status=A;count=${count};sort=AR;out=draft_analysis`,
      { headers: this.authHeaders(), params: { format: 'json' } }
    );

    const playersData = res.data.fantasy_content.league[1].players;
    const currentScan: Record<string, { name: string; position: string; mlbTeam: string; age: number; adp: number | null; tag: string }> = {};

    for (const [k, v] of Object.entries(playersData) as [string, any][]) {
      if (k === 'count') continue;
      const info = parsePlayerInfo(v.player[0]);
      const age = lookupAge(ageMap, info.name, info.jerseyNumber);
      if (age === undefined || age > maxAge) continue;
      const adpRaw = v.player[1]?.draft_analysis?.average_pick;
      const adp = adpRaw ? parseFloat(adpRaw) : null;
      currentScan[info.playerKey] = {
        name: info.name,
        position: info.position,
        mlbTeam: info.mlbTeam,
        age,
        adp: adp && !isNaN(adp) ? adp : null,
        tag: age <= 24 ? 'lotto ticket' : 'target',
      };
    }

    // Load previous snapshot
    const snapshotPath = path.join(DATA_DIR, 'wire_snapshot.json');
    let previousScan: Record<string, any> = {};
    let lastScanned = 'never';
    if (fs.existsSync(snapshotPath)) {
      const saved = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      previousScan = saved.players ?? {};
      lastScanned = saved.scanned_at ?? 'unknown';
    }

    // Compute delta
    const currentKeys = new Set(Object.keys(currentScan));
    const previousKeys = new Set(Object.keys(previousScan));

    const newlyAvailable = Object.values(currentScan).filter((p) => !previousKeys.has(
      Object.keys(currentScan).find((k) => currentScan[k] === p) ?? ''
    ));
    // More precise: players in current but not previous
    const newKeys = [...currentKeys].filter((k) => !previousKeys.has(k));
    const goneKeys = [...previousKeys].filter((k) => !currentKeys.has(k));

    const newPlayers = newKeys.map((k) => currentScan[k]).filter(Boolean);
    const gonePlayers = goneKeys.map((k) => previousScan[k]).filter(Boolean);

    // Save current snapshot
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(snapshotPath, JSON.stringify({
      scanned_at: new Date().toISOString(),
      players: currentScan,
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          last_scanned: lastScanned,
          newly_available: newPlayers.sort((a, b) => (a?.age ?? 99) - (b?.age ?? 99)),
          newly_gone: gonePlayers.sort((a, b) => (a?.age ?? 99) - (b?.age ?? 99)),
          still_available: Object.values(currentScan).sort((a, b) => a.age - b.age),
          note: 'newly_gone = claimed or dropped off wire. newly_available = just dropped by someone.',
        }, null, 2),
      }],
    };
  }

  private async getProspectOverlap(args: any) {
    const maxAge: number = args?.max_age ?? 25;
    const currentYear = new Date().getFullYear();
    const prospectDebutCutoff = currentYear - 2; // debuted 2024 or later = still prospect-adjacent

    // Fetch MLB players with debut date
    const mlbRes = await this.mlbApi.get('/sports/1/players', {
      params: { season: 2026, fields: 'people,fullName,currentAge,primaryNumber,mlbDebutDate' },
    });

    const prospectMap = new Map<string, { age: number; debutYear: number | null; jersey: string }>();
    for (const p of mlbRes.data.people as { fullName: string; currentAge: number; primaryNumber?: string; mlbDebutDate?: string }[]) {
      if (p.currentAge > maxAge) continue;
      const debutYear = p.mlbDebutDate ? parseInt(p.mlbDebutDate.slice(0, 4)) : null;
      if (debutYear !== null && debutYear < prospectDebutCutoff) continue; // established veteran
      prospectMap.set(normalizeName(p.fullName), {
        age: p.currentAge,
        debutYear,
        jersey: p.primaryNumber ?? '',
      });
    }

    // Fetch my roster
    const [teamKey, leagueKey] = await Promise.all([this.buildTeamKey(), this.buildLeagueKey()]);
    const [rosterRes, wireRes] = await Promise.all([
      this.yahooApi.get(`/team/${teamKey}/roster/players`, {
        headers: this.authHeaders(),
        params: { format: 'json' },
      }),
      this.yahooApi.get(`/league/${leagueKey}/players;status=A;count=75;sort=AR`, {
        headers: this.authHeaders(),
        params: { format: 'json' },
      }),
    ]);

    const rosterObj = rosterRes.data.fantasy_content.team[1].roster;
    const rosterPlayers = extractPlayersMap(rosterObj);
    const wirePlayers = wireRes.data.fantasy_content.league[1].players;

    const onRoster: any[] = [];
    const onWire: any[] = [];

    for (const [k, v] of Object.entries(rosterPlayers) as [string, any][]) {
      if (k === 'count') continue;
      const info = parsePlayerInfo(v.player[0]);
      const prospect = prospectMap.get(normalizeName(info.name));
      if (!prospect) continue;
      onRoster.push({ name: info.name, position: info.position, mlbTeam: info.mlbTeam, age: prospect.age, debut: prospect.debutYear ?? 'pre-2024' });
    }

    for (const [k, v] of Object.entries(wirePlayers) as [string, any][]) {
      if (k === 'count') continue;
      const info = parsePlayerInfo(v.player[0]);
      const prospect = prospectMap.get(normalizeName(info.name));
      if (!prospect) continue;
      onWire.push({ name: info.name, position: info.position, mlbTeam: info.mlbTeam, age: prospect.age, debut: prospect.debutYear ?? 'pre-2024' });
    }

    onRoster.sort((a, b) => a.age - b.age);
    onWire.sort((a, b) => a.age - b.age);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          criteria: `Age <=${maxAge}, MLB debut ${prospectDebutCutoff} or later (or no debut yet)`,
          on_your_roster: onRoster,
          available_on_wire: onWire,
          note: 'debut = first MLB appearance year. These players still have prospect-adjacent upside.',
        }, null, 2),
      }],
    };
  }

  private async rebuildProgressTracker() {
    const [teamKey, ageMap] = await Promise.all([this.buildTeamKey(), this.getAgeMap()]);

    const res = await this.yahooApi.get(`/team/${teamKey}/roster/players`, {
      headers: this.authHeaders(),
      params: { format: 'json' },
    });

    const rosterObj = res.data.fantasy_content.team[1].roster;
    const players = extractPlayersMap(rosterObj);

    const roster = Object.entries(players)
      .filter(([k]) => k !== 'count')
      .map(([, v]: [string, any]) => {
        const info = parsePlayerInfo(v.player[0]);
        const age = lookupAge(ageMap, info.name, info.jerseyNumber) ?? null;
        return { name: info.name, age };
      });

    const ages = roster.filter((p) => p.age !== null).map((p) => p.age as number);
    const median = this.calcMedian(ages);

    const snapshot = {
      date: new Date().toISOString().slice(0, 10),
      timestamp: new Date().toISOString(),
      median_age: median,
      rebuild_score: {
        age_24_and_under: ages.filter((a) => a <= 24).length,
        age_25_to_27: ages.filter((a) => a >= 25 && a <= 27).length,
        age_28_to_29: ages.filter((a) => a >= 28 && a <= 29).length,
        age_30_plus: ages.filter((a) => a >= 30).length,
        total: ages.length,
      },
      roster_snapshot: roster.map((p) => `${p.name} (${p.age ?? '?'})`),
    };

    const historyPath = path.join(DATA_DIR, 'rebuild_progress.json');
    let history: any[] = [];
    if (fs.existsSync(historyPath)) {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    }

    // Replace same-day entry, otherwise append
    const existingIdx = history.findIndex((s: any) => s.date === snapshot.date);
    if (existingIdx >= 0) {
      history[existingIdx] = snapshot;
    } else {
      history.push(snapshot);
    }

    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));

    const trend = history.map((s: any) => ({
      date: s.date,
      median_age: s.median_age,
      age_30_plus: s.rebuild_score?.age_30_plus ?? '?',
      age_24_and_under: s.rebuild_score?.age_24_and_under ?? '?',
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          current: snapshot,
          history: trend,
          note: 'Each run saves a snapshot. Call daily/weekly to track rebuild progress over time.',
        }, null, 2),
      }],
    };
  }

  private async regretList(args: any) {
    const action: string = args?.action ?? 'check';
    const regretPath = path.join(DATA_DIR, 'regret_list.json');

    let regretPlayers: any[] = [];
    if (fs.existsSync(regretPath)) {
      regretPlayers = JSON.parse(fs.readFileSync(regretPath, 'utf8'));
    }

    if (action === 'add') {
      const toAdd: { name: string; position?: string; mlbTeam?: string; dropped_for?: string; notes?: string }[] = args?.players ?? [];
      const date = new Date().toISOString().slice(0, 10);
      for (const p of toAdd) {
        const idx = regretPlayers.findIndex((r: any) => normalizeName(r.name) === normalizeName(p.name));
        const entry = {
          name: p.name,
          position: p.position ?? '?',
          mlbTeam: p.mlbTeam ?? '?',
          dropped_date: date,
          dropped_for: p.dropped_for ?? null,
          notes: p.notes ?? null,
        };
        if (idx >= 0) {
          regretPlayers[idx] = entry;
        } else {
          regretPlayers.push(entry);
        }
      }
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(regretPath, JSON.stringify(regretPlayers, null, 2));
      return {
        content: [{ type: 'text', text: JSON.stringify({ added: toAdd.map((p) => p.name), total_on_regret_list: regretPlayers.length }, null, 2) }],
      };
    }

    if (action === 'remove') {
      const names: string[] = (args?.players ?? []).map((p: any) => (typeof p === 'string' ? p : p.name));
      regretPlayers = regretPlayers.filter((r: any) => !names.some((n) => normalizeName(r.name) === normalizeName(n)));
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(regretPath, JSON.stringify(regretPlayers, null, 2));
      return {
        content: [{ type: 'text', text: JSON.stringify({ removed: names, total_on_regret_list: regretPlayers.length }, null, 2) }],
      };
    }

    // action === 'check'
    if (regretPlayers.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ message: 'Regret list is empty. Use action: "add" to log dropped players.', regret_list: [] }, null, 2) }],
      };
    }

    const leagueKey = await this.buildLeagueKey();
    const ageMap = await this.getAgeMap();

    const wireRes = await this.yahooApi.get(
      `/league/${leagueKey}/players;status=A;count=100;sort=AR`,
      { headers: this.authHeaders(), params: { format: 'json' } }
    );
    const wirePlayers = wireRes.data.fantasy_content.league[1].players;

    const availableNorms = new Set<string>();
    const wireDetails: Record<string, any> = {};
    for (const [k, v] of Object.entries(wirePlayers) as [string, any][]) {
      if (k === 'count') continue;
      const info = parsePlayerInfo(v.player[0]);
      const norm = normalizeName(info.name);
      availableNorms.add(norm);
      wireDetails[norm] = {
        name: info.name,
        position: info.position,
        mlbTeam: info.mlbTeam,
        age: lookupAge(ageMap, info.name, info.jerseyNumber) ?? null,
      };
    }

    const results = regretPlayers.map((r: any) => {
      const norm = normalizeName(r.name);
      const available = availableNorms.has(norm);
      return { ...r, available_on_wire: available, current_info: available ? wireDetails[norm] : null };
    });

    const available = results.filter((r: any) => r.available_on_wire);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: `${available.length} of ${regretPlayers.length} regret players currently on wire`,
          available_right_now: available,
          not_available: results.filter((r: any) => !r.available_on_wire),
        }, null, 2),
      }],
    };
  }

  private async tradeHistoryLog(args: any) {
    const action: string = args?.action ?? 'view';
    const tradePath = path.join(DATA_DIR, 'trade_history.json');

    let trades: any[] = [];
    if (fs.existsSync(tradePath)) {
      trades = JSON.parse(fs.readFileSync(tradePath, 'utf8'));
    }

    if (action === 'log') {
      const sent: string[] = args?.sent ?? [];
      const received: string[] = args?.received ?? [];
      if (sent.length === 0 && received.length === 0) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Provide at least one player in sent or received.' }, null, 2) }],
        };
      }
      const entry = {
        id: trades.length + 1,
        date: new Date().toISOString().slice(0, 10),
        timestamp: new Date().toISOString(),
        counterpart_team: args?.counterpart_team ?? null,
        sent,
        received,
        notes: args?.notes ?? null,
        status: args?.status ?? 'pending',
      };
      trades.push(entry);
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(tradePath, JSON.stringify(trades, null, 2));

      // Cross-reference trade_scenarios.md if a crown jewel is being sent
      const crownJewelKeys = ['ohtani', 'raleigh'];
      const sentLower = sent.map((n) => n.toLowerCase());
      const jewelsInvolved = crownJewelKeys.filter((k) => sentLower.some((n) => n.includes(k)));
      let scenarioRef: any = null;
      if (jewelsInvolved.length > 0) {
        const playerFilter = jewelsInvolved[0];
        const matched = this.parseScenarios(playerFilter, args?.counterpart_team ?? undefined);
        if (matched.length > 0) scenarioRef = matched;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            logged: entry,
            total_trades: trades.length,
            ...(scenarioRef ? { scenario_reference: scenarioRef } : {}),
          }, null, 2),
        }],
      };
    }

    if (action === 'update_status') {
      const id: number = args?.trade_id;
      const trade = trades.find((t: any) => t.id === id);
      if (!trade) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `No trade found with id ${id}` }, null, 2) }],
        };
      }
      trade.status = args?.status ?? trade.status;
      if (args?.notes) trade.notes = args.notes;
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(tradePath, JSON.stringify(trades, null, 2));
      return {
        content: [{ type: 'text', text: JSON.stringify({ updated: trade }, null, 2) }],
      };
    }

    // action === 'view'
    const pending = trades.filter((t: any) => t.status === 'pending');
    const accepted = trades.filter((t: any) => t.status === 'accepted');
    const rejected = trades.filter((t: any) => t.status === 'rejected');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: { total: trades.length, accepted: accepted.length, pending: pending.length, rejected: rejected.length },
          pending_trades: pending,
          accepted_trades: accepted,
          rejected_trades: rejected,
        }, null, 2),
      }],
    };
  }

  // Map a display_position string to canonical position buckets
  private positionBuckets(displayPosition: string): string[] {
    const p = displayPosition.toUpperCase();
    const buckets = new Set<string>();
    if (/(?<![A-Z])C(?![A-Z])/.test(p) && !p.includes('CF')) buckets.add('C');
    if (p.includes('1B')) buckets.add('1B');
    if (p.includes('2B') || p.includes('MI')) buckets.add('2B');
    if (p.includes('3B') || p.includes('CI')) buckets.add('3B');
    if (p.includes('SS')) buckets.add('SS');
    if (p.includes('LF') || p.includes('CF') || p.includes('RF') || /\bOF\b/.test(p)) buckets.add('OF');
    if (p.includes('SP')) buckets.add('SP');
    if (p.includes('RP')) buckets.add('RP');
    return [...buckets];
  }

  // Fetch all league rosters in one call, return parsed per-team data
  private async fetchLeagueRosters(ageMap: Map<string, { age: number; jersey: string }[]>) {
    const leagueKey = await this.buildLeagueKey();
    const myTeamKey = await this.buildTeamKey();
    const res = await this.yahooApi.get(`/league/${leagueKey}/teams/roster/players`, {
      headers: this.authHeaders(),
      params: { format: 'json' },
    });
    const teamsData = res.data.fantasy_content.league[1].teams;
    const teams: any[] = [];

    for (const [tk, tv] of Object.entries(teamsData) as [string, any][]) {
      if (tk === 'count') continue;
      const teamArr = tv.team;
      const teamInfo: any[] = teamArr[0];
      const teamName = extractField(teamInfo, 'name') as string;
      const teamKey = extractField(teamInfo, 'team_key') as string;
      const isMe = teamKey === myTeamKey;

      const rosterObj = teamArr[1]?.roster;
      if (!rosterObj) continue;
      const playersMap = extractPlayersMap(rosterObj);

      const roster: any[] = [];
      for (const [pk, pv] of Object.entries(playersMap) as [string, any][]) {
        if (pk === 'count') continue;
        const info = parsePlayerInfo(pv.player[0]);
        const age = lookupAge(ageMap, info.name, info.jerseyNumber) ?? null;
        roster.push({ ...info, age });
      }

      teams.push({ teamName, teamKey, isMe, roster });
    }
    return teams;
  }

  // Score a single player across three lenses: ADP value, age multiplier, positional scarcity
  private scorePlayer(name: string, position: string, age: number | null, adp: number | null, top30: string[]): {
    adp_score: number; age_multiplier: number; scarcity_multiplier: number; top30_bonus: number; total: number; adp_tier: string;
  } {
    // ADP score — market consensus value
    let adpScore = 3; // default: no ADP = waiver-fringe
    let adpTier = 'unranked';
    if (adp !== null) {
      if (adp <= 30)       { adpScore = 10; adpTier = 'elite (1-30)'; }
      else if (adp <= 75)  { adpScore = 8;  adpTier = 'strong (31-75)'; }
      else if (adp <= 150) { adpScore = 6;  adpTier = 'solid (76-150)'; }
      else if (adp <= 250) { adpScore = 4;  adpTier = 'depth (151-250)'; }
      else                 { adpScore = 2;  adpTier = 'fringe (251+)'; }
    }

    // Age multiplier — rebuild lens
    let ageMult = 1.0;
    if (age !== null) {
      if (age <= 22)      ageMult = 1.5;
      else if (age <= 24) ageMult = 1.3;
      else if (age <= 26) ageMult = 1.1;
      else if (age <= 28) ageMult = 1.0;
      else if (age <= 29) ageMult = 0.9;
      else                ageMult = 0.7;
    }

    // Positional scarcity multiplier
    const pos = position.toUpperCase();
    let scarcityMult = 1.0;
    if (/(?<![A-Z])C(?![A-Z])/.test(pos) && !pos.includes('CF')) scarcityMult = 1.3;
    else if (pos.includes('SS'))                                   scarcityMult = 1.2;
    else if (pos.includes('SP'))                                   scarcityMult = 1.15;
    else if (pos.includes('RP'))                                   scarcityMult = 1.1;
    else if (pos.includes('2B') || pos.includes('3B'))            scarcityMult = 1.05;

    // Top-30 bonus (from rubric config)
    const isTop30 = top30.some((n) => normalizeName(n) === normalizeName(name));
    const top30Bonus = isTop30 ? 2 : 0;

    const total = parseFloat((adpScore * ageMult * scarcityMult + top30Bonus).toFixed(2));

    return { adp_score: adpScore, age_multiplier: ageMult, scarcity_multiplier: scarcityMult, top30_bonus: top30Bonus, total, adp_tier: adpTier };
  }

  private async evaluateTrade(args: any) {
    const sendNames: string[] = args?.send ?? [];
    const receiveNames: string[] = args?.receive ?? [];

    const configPath = path.join(DATA_DIR, 'rubric_config.json');
    const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const top30: string[] = cfg.top_30_bonus_players ?? [];

    const [teamKey, leagueKey, ageMap] = await Promise.all([
      this.buildTeamKey(), this.buildLeagueKey(), this.getAgeMap(),
    ]);

    // Fetch my roster
    const rosterRes = await this.yahooApi.get(`/team/${teamKey}/roster/players`, {
      headers: this.authHeaders(), params: { format: 'json' },
    });
    const rosterPlayers = extractPlayersMap(rosterRes.data.fantasy_content.team[1].roster);
    const myRoster = Object.entries(rosterPlayers)
      .filter(([k]) => k !== 'count')
      .map(([, v]: [string, any]) => {
        const info = parsePlayerInfo(v.player[0]);
        const age = lookupAge(ageMap, info.name, info.jerseyNumber) ?? null;
        return { ...info, age };
      });

    // Match sent players from roster
    const sentPlayers = sendNames.map((name) => {
      const match = myRoster.find((p) =>
        normalizeName(p.name).includes(normalizeName(name)) ||
        normalizeName(name).includes(normalizeName(p.name))
      );
      return match ?? { name, position: '?', mlbTeam: '?', playerKey: '', jerseyNumber: '', age: null };
    });

    // Fetch received players from Yahoo (with ADP)
    const receivedPlayers = await Promise.all(
      receiveNames.map(async (name) => {
        const encoded = encodeURIComponent(name);
        const res = await this.yahooApi.get(
          `/league/${leagueKey}/players;search=${encoded};count=1;out=draft_analysis`,
          { headers: this.authHeaders(), params: { format: 'json' } }
        );
        const players = res.data.fantasy_content.league[1].players;
        if (!players || players.count === 0) return { name, position: '?', mlbTeam: '?', age: null, adp: null };
        const first = players['0'];
        if (!first) return { name, position: '?', mlbTeam: '?', age: null, adp: null };
        const info = parsePlayerInfo(first.player[0]);
        const adpRaw = first.player[1]?.draft_analysis?.average_pick;
        const adp = adpRaw ? parseFloat(adpRaw) : null;
        const age = lookupAge(ageMap, info.name, info.jerseyNumber) ?? null;
        return { ...info, age, adp };
      })
    );

    // Fetch ADP for sent players too
    const sentWithAdp = await Promise.all(
      sentPlayers.map(async (p) => {
        if (p.playerKey) {
          try {
            const res = await this.yahooApi.get(
              `/league/${leagueKey}/players;search=${encodeURIComponent(p.name)};count=1;out=draft_analysis`,
              { headers: this.authHeaders(), params: { format: 'json' } }
            );
            const players = res.data.fantasy_content.league[1].players;
            const first = players?.['0'];
            const adpRaw = first?.player[1]?.draft_analysis?.average_pick;
            return { ...p, adp: adpRaw ? parseFloat(adpRaw) : null };
          } catch { return { ...p, adp: null }; }
        }
        return { ...p, adp: null };
      })
    );

    // Score everyone
    const scoreSent = sentWithAdp.map((p) => ({
      name: p.name, position: p.position, age: p.age, adp: (p as any).adp ?? null,
      scoring: this.scorePlayer(p.name, p.position, p.age, (p as any).adp ?? null, top30),
    }));
    const scoreReceived = receivedPlayers.map((p) => ({
      name: p.name, position: p.position, age: p.age, adp: p.adp ?? null,
      scoring: this.scorePlayer(p.name, p.position, p.age, p.adp ?? null, top30),
    }));

    const totalSent     = parseFloat(scoreSent.reduce((s, p) => s + p.scoring.total, 0).toFixed(2));
    const totalReceived = parseFloat(scoreReceived.reduce((s, p) => s + p.scoring.total, 0).toFixed(2));
    const differential  = parseFloat((totalReceived - totalSent).toFixed(2));
    const pctDiff       = totalSent > 0 ? parseFloat(((differential / totalSent) * 100).toFixed(1)) : 0;

    const verdict =
      pctDiff >= 15  ? 'ADVANTAGEOUS' :
      pctDiff <= -15 ? 'UNFAVORABLE'  : 'EQUITABLE';

    // Age impact
    const myAges    = myRoster.filter((p) => p.age !== null).map((p) => p.age as number);
    const sentAges  = scoreSent.filter((p) => p.age !== null).map((p) => p.age as number);
    const recvAges  = scoreReceived.filter((p) => p.age !== null).map((p) => p.age as number);
    const beforeMedian = this.calcMedian(myAges);
    const afterAges    = [...myAges.filter((a) => !sentAges.includes(a)), ...recvAges];
    const afterMedian  = this.calcMedian(afterAges);
    const ageDelta     = beforeMedian !== null && afterMedian !== null
      ? parseFloat((afterMedian - beforeMedian).toFixed(1)) : null;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          verdict,
          value_summary: {
            you_send_total:    totalSent,
            you_receive_total: totalReceived,
            differential,
            pct_advantage: `${pctDiff > 0 ? '+' : ''}${pctDiff}%`,
            threshold: '±15% = equitable, >+15% = advantageous, <-15% = unfavorable',
          },
          age_impact: {
            median_before: beforeMedian,
            median_after:  afterMedian,
            delta: ageDelta !== null ? `${ageDelta > 0 ? '+' : ''}${ageDelta}` : 'N/A',
            direction: ageDelta === null ? 'N/A' : ageDelta < 0 ? 'gets younger' : ageDelta > 0 ? 'gets older' : 'no change',
          },
          you_send:    scoreSent.map((p) => ({ name: p.name, age: p.age, position: p.position, adp_tier: p.scoring.adp_tier, score: p.scoring.total })),
          you_receive: scoreReceived.map((p) => ({ name: p.name, age: p.age, position: p.position, adp_tier: p.scoring.adp_tier, score: p.scoring.total })),
          scoring_note: 'Score = ADP value × age multiplier × positional scarcity + top-30 bonus. Higher = more valuable.',
        }, null, 2),
      }],
    };
  }

  private async teamNeedsAnalysis(args: any) {
    const teamFilter: string | undefined = args?.team;
    const maxAgeAssets: number = args?.max_age_assets ?? 27;

    const ageMap = await this.getAgeMap();
    const teams = await this.fetchLeagueRosters(ageMap);

    const thresholds: Record<string, number> = { C: 2, OF: 4, SP: 4, RP: 2, '1B': 1, '2B': 1, '3B': 1, SS: 1 };

    const results = teams
      .filter((t) => !teamFilter || t.teamName.toLowerCase().includes(teamFilter.toLowerCase()))
      .map((t) => {
        // Count by bucket
        const depth: Record<string, number> = { C: 0, '1B': 0, '2B': 0, '3B': 0, SS: 0, OF: 0, SP: 0, RP: 0 };
        for (const p of t.roster) {
          for (const bucket of this.positionBuckets(p.position)) {
            if (bucket in depth) depth[bucket] = (depth[bucket] ?? 0) + 1;
          }
        }

        const thinSpots = Object.entries(thresholds)
          .filter(([pos, min]) => (depth[pos] ?? 0) < min)
          .map(([pos]) => pos);

        const youngAssets = t.roster
          .filter((p: any) => p.age !== null && p.age <= maxAgeAssets)
          .sort((a: any, b: any) => a.age - b.age)
          .map((p: any) => ({ name: p.name, pos: p.position, age: p.age, mlbTeam: p.mlbTeam }));

        const ages = t.roster.filter((p: any) => p.age !== null).map((p: any) => p.age as number);
        const median = this.calcMedian(ages);

        return {
          team: t.teamName,
          is_my_team: t.isMe,
          median_age: median,
          positional_depth: depth,
          thin_spots: thinSpots,
          young_assets: youngAssets,
        };
      })
      .sort((a, b) => (a.thin_spots.length > b.thin_spots.length ? -1 : 1));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          note: `Thin = below minimum roster depth. young_assets = players age <=${maxAgeAssets}.`,
          thresholds,
          teams: results,
        }, null, 2),
      }],
    };
  }

  private async tradePartnerFinder(args: any) {
    const playerName: string = args?.player_name;
    const maxAgeReturn: number = args?.max_age_return ?? 27;

    const ageMap = await this.getAgeMap();
    const teams = await this.fetchLeagueRosters(ageMap);

    // Find the player on my roster
    const myTeam = teams.find((t) => t.isMe);
    if (!myTeam) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Could not find your roster.' }) }] };
    }

    const targetPlayer = myTeam.roster.find((p: any) =>
      normalizeName(p.name).includes(normalizeName(playerName)) ||
      normalizeName(playerName).includes(normalizeName(p.name))
    );

    if (!targetPlayer) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `${playerName} not found on your roster.` }) }],
      };
    }

    const playerBuckets = this.positionBuckets(targetPlayer.position);
    const thresholds: Record<string, number> = { C: 2, OF: 4, SP: 4, RP: 2, '1B': 1, '2B': 1, '3B': 1, SS: 1 };

    const partners = teams
      .filter((t) => !t.isMe)
      .map((t) => {
        // Measure their depth at player's position(s)
        const depth: Record<string, number> = { C: 0, '1B': 0, '2B': 0, '3B': 0, SS: 0, OF: 0, SP: 0, RP: 0 };
        for (const p of t.roster) {
          for (const bucket of this.positionBuckets(p.position)) {
            if (bucket in depth) depth[bucket] = (depth[bucket] ?? 0) + 1;
          }
        }

        // Need score: how many of the player's buckets are they thin on?
        const thinMatches = playerBuckets.filter((b) => b in thresholds && (depth[b] ?? 0) < thresholds[b]!);
        const needScore = thinMatches.length > 0 ? 'HIGH' : playerBuckets.some((b) => (depth[b] ?? 0) === (thresholds[b] ?? 99)) ? 'MEDIUM' : 'LOW';

        // Their young assets you'd want back
        const youngAssets = t.roster
          .filter((p: any) => p.age !== null && p.age <= maxAgeReturn)
          .sort((a: any, b: any) => a.age - b.age)
          .map((p: any) => ({ name: p.name, pos: p.position, age: p.age, mlbTeam: p.mlbTeam }));

        const ages = t.roster.filter((p: any) => p.age !== null).map((p: any) => p.age as number);
        const median = this.calcMedian(ages);

        return {
          team: t.teamName,
          need_score: needScore,
          thin_at: thinMatches,
          depth_at_position: playerBuckets.map((b) => ({ bucket: b, count: depth[b] ?? 0, threshold: thresholds[b] ?? '—' })),
          young_assets_available: youngAssets,
          their_median_age: median,
          young_asset_count: youngAssets.length,
        };
      })
      .sort((a, b) => {
        const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
        const diff = (order[a.need_score as keyof typeof order] ?? 2) - (order[b.need_score as keyof typeof order] ?? 2);
        return diff !== 0 ? diff : b.young_asset_count - a.young_asset_count;
      });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          player: { name: targetPlayer.name, position: targetPlayer.position, age: targetPlayer.age, mlbTeam: targetPlayer.mlbTeam },
          position_buckets: playerBuckets,
          max_age_return: maxAgeReturn,
          trade_partners: partners,
          tip: 'HIGH need = they\'re thin at this position. Sort priority: need score first, then young asset count.',
        }, null, 2),
      }],
    };
  }

  private readonly SCENARIOS_PATH = path.join(__dirname, '..', 'docs', 'trade_scenarios.md');

  // Parse trade_scenarios.md and return matching rows for a given crown jewel + optional team filter
  private parseScenarios(playerFilter?: string, teamFilter?: string): any[] {
    if (!fs.existsSync(this.SCENARIOS_PATH)) return [];
    const md = fs.readFileSync(this.SCENARIOS_PATH, 'utf8');

    const crownJewels = [
      { key: 'ohtani', section: 'Shohei Ohtani' },
      { key: 'raleigh', section: 'Cal Raleigh' },
    ];

    const results: any[] = [];

    for (const jewel of crownJewels) {
      if (playerFilter && !jewel.key.includes(playerFilter.toLowerCase()) && !playerFilter.toLowerCase().includes(jewel.key)) continue;

      const sectionStart = md.indexOf(`## ${jewel.section}`);
      if (sectionStart === -1) continue;
      const nextSection = md.indexOf('\n## ', sectionStart + 4);
      const sectionText = nextSection >= 0 ? md.slice(sectionStart, nextSection) : md.slice(sectionStart);

      // Extract the floor/ceiling/note lines
      const floorMatch = sectionText.match(/\*\*Floor:\*\*([^\n]+)/);
      const ceilingMatch = sectionText.match(/\*\*Ceiling:\*\*([^\n]+)/);
      const noteMatch = sectionText.match(/\*\*Note:\*\*([^\n]+)/);

      // Parse table rows — skip header and separator
      const rows = sectionText.split('\n').filter((l) =>
        l.startsWith('|') && !l.includes('---') && !l.includes('Trading Partner') && !l.includes('They\'ll Likely')
      );

      for (const row of rows) {
        const cells = row.split('|').map((c) => c.trim()).filter(Boolean);
        if (cells.length < 4) continue;
        const partner = cells[0]?.replace(/\*\*/g, '').trim() ?? '';
        if (!partner) continue;

        if (teamFilter) {
          const tf = teamFilter.toLowerCase();
          if (!partner.toLowerCase().includes(tf) && !tf.includes(partner.toLowerCase())) continue;
        }

        results.push({
          crown_jewel: jewel.section,
          trading_partner: partner,
          their_likely_offer: cells[1] ?? '',
          our_counter: cells[2] ?? '',
          viability: cells[3] ?? '',
          notes: cells[4] ?? '',
          floor: floorMatch?.[1]?.trim() ?? '',
          ceiling: ceilingMatch?.[1]?.trim() ?? '',
          general_note: noteMatch?.[1]?.trim() ?? '',
        });
      }
    }

    return results;
  }

  private async getTradeScenarios(args: any) {
    const playerFilter: string | undefined = args?.player;
    const teamFilter: string | undefined = args?.team;

    if (!fs.existsSync(this.SCENARIOS_PATH)) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: 'docs/trade_scenarios.md not found. Create it first.' }, null, 2) }],
      };
    }

    const scenarios = this.parseScenarios(playerFilter, teamFilter);

    if (scenarios.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ message: 'No matching scenarios found.', filters: { player: playerFilter, team: teamFilter } }, null, 2) }],
      };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          filters: { player: playerFilter ?? 'all', team: teamFilter ?? 'all' },
          scenarios,
          source: 'docs/trade_scenarios.md',
          tip: 'Update trade_scenarios.md to keep this current. Log final outcomes via trade_history_log.',
        }, null, 2),
      }],
    };
  }

  private async getRebuildScorecard() {
    const configPath = path.join(DATA_DIR, 'rubric_config.json');
    let cfg: any = {};
    if (fs.existsSync(configPath)) {
      cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }

    // --- Roster + Ages ---
    const [teamKey, leagueKey, ageMap] = await Promise.all([
      this.buildTeamKey(), this.buildLeagueKey(), this.getAgeMap(),
    ]);
    const rosterRes = await this.yahooApi.get(`/team/${teamKey}/roster/players`, {
      headers: this.authHeaders(), params: { format: 'json' },
    });
    const rosterObj = rosterRes.data.fantasy_content.team[1].roster;
    const players = extractPlayersMap(rosterObj);
    const roster = Object.entries(players)
      .filter(([k]) => k !== 'count')
      .map(([, v]: [string, any]) => {
        const info = parsePlayerInfo(v.player[0]);
        const age = lookupAge(ageMap, info.name, info.jerseyNumber) ?? null;
        return { ...info, age };
      });
    const ages = roster.filter((p) => p.age !== null).map((p) => p.age as number);
    const median = this.calcMedian(ages);

    // --- Dimension 1: Age Progress ---
    const today = new Date();
    const milestones: { label: string; date: string; target_median: number }[] = cfg.milestones ?? [];
    const upcoming = milestones
      .filter((m) => new Date(m.date) >= today)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    const currentMilestone = upcoming[0] ?? { label: 'Post-2027', date: '', target_median: 25 };
    const ageOnTrack = median !== null && median <= currentMilestone.target_median;

    const historyPath = path.join(DATA_DIR, 'rebuild_progress.json');
    let history: any[] = [];
    if (fs.existsSync(historyPath)) history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    const prevSnapshot = history.length >= 2 ? history[history.length - 2] : null;
    const ageTrend = (prevSnapshot && median !== null)
      ? parseFloat((median - prevSnapshot.median_age).toFixed(1))
      : null;

    // --- Dimension 2: Core Stability ---
    const youngCore = roster.filter((p) => p.age !== null && p.age <= 27).map((p) => p.name);
    if (!cfg.young_core_baseline) {
      cfg.young_core_baseline = { seeded_date: today.toISOString().slice(0, 10), players: youngCore };
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    }
    const baseline: string[] = cfg.young_core_baseline.players ?? [];
    const retained = baseline.filter((n) =>
      youngCore.some((cn) => normalizeName(cn) === normalizeName(n))
    );
    const retainedPct = baseline.length > 0 ? Math.round((retained.length / baseline.length) * 100) : 100;
    const coreStatus = retainedPct >= 80 ? 'STABLE' : retainedPct >= 60 ? 'SHIFTING' : 'HIGH TURNOVER';

    // --- Dimension 3: Asset Quality Score ---
    const w = cfg.age_weights ?? { '22_and_under': 5, '23_to_24': 4, '25_to_26': 3, '27_to_28': 2, '29': 1, '30_plus': 0 };
    const top30: string[] = cfg.top_30_bonus_players ?? [];
    let assetScore = 0;
    const scoredRoster: { name: string; age: number | null; pts: number }[] = [];
    for (const p of roster) {
      let pts = 0;
      if (p.age !== null) {
        if (p.age <= 22) pts = w['22_and_under'] ?? 5;
        else if (p.age <= 24) pts = w['23_to_24'] ?? 4;
        else if (p.age <= 26) pts = w['25_to_26'] ?? 3;
        else if (p.age <= 28) pts = w['27_to_28'] ?? 2;
        else if (p.age === 29) pts = w['29'] ?? 1;
        else pts = w['30_plus'] ?? 0;
        if (top30.some((n) => normalizeName(n) === normalizeName(p.name))) pts += 2;
      }
      assetScore += pts;
      scoredRoster.push({ name: p.name, age: p.age, pts });
    }
    scoredRoster.sort((a, b) => b.pts - a.pts);

    // --- Dimension 4: Competitive Viability ---
    let compViability: any = { status: 'NO STANDINGS YET' };
    try {
      const standRes = await this.yahooApi.get(`/league/${leagueKey}/standings`, {
        headers: this.authHeaders(), params: { format: 'json' },
      });
      const teams = standRes.data.fantasy_content.league[1].standings[0].teams;
      for (const [tk, tv] of Object.entries(teams) as [string, any][]) {
        if (tk === 'count') continue;
        const tInfo = tv.team[0];
        const tKey = extractField(tInfo, 'team_key');
        if (tKey === teamKey) {
          const s = tv.team[2]?.team_standings?.outcome_totals;
          const rank = tv.team[2]?.team_standings?.rank;
          if (s) {
            const wins = parseInt(s.wins ?? '0');
            const losses = parseInt(s.losses ?? '0');
            const total = wins + losses;
            const winRate = total > 0 ? parseFloat((wins / total).toFixed(3)) : null;
            const targets = cfg.competitive_targets ?? {};
            compViability = {
              wins, losses, rank: rank || '—', win_rate: winRate,
              status: winRate === null ? 'SEASON NOT STARTED'
                : winRate >= (targets.win_rate_target ?? 0.55) ? 'PLAYOFF TRACK'
                : winRate >= (targets.win_rate_floor ?? 0.45) ? 'BUBBLE'
                : 'BELOW TARGET',
              note: (cfg.competitive_targets?.rebuild_years_playoff_expected === false)
                ? 'Playoff not required in rebuild years — focus on dimensions 1-3.'
                : '',
            };
          }
          break;
        }
      }
    } catch { /* standings unavailable */ }

    // --- Dimension 5: Transaction Quality ---
    let tradeData: any = { note: 'No trades logged yet. Use trade_history_log to start tracking.' };
    const tradePath = path.join(DATA_DIR, 'trade_history.json');
    if (fs.existsSync(tradePath)) {
      const trades = JSON.parse(fs.readFileSync(tradePath, 'utf8'));
      const accepted = trades.filter((t: any) => t.status === 'accepted');
      const pending = trades.filter((t: any) => t.status === 'pending');
      tradeData = {
        total: trades.length,
        accepted: accepted.length,
        pending: pending.length,
        rejected: trades.length - accepted.length - pending.length,
      };
    }

    let regretData: any = { note: 'No drops logged yet. Use regret_list to start tracking.' };
    const regretPath = path.join(DATA_DIR, 'regret_list.json');
    if (fs.existsSync(regretPath)) {
      const regrets = JSON.parse(fs.readFileSync(regretPath, 'utf8'));
      regretData = { players_logged: regrets.length, players: regrets.map((r: any) => r.name) };
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          scorecard_date: today.toISOString().slice(0, 10),
          next_milestone: currentMilestone.label,
          milestone_target_date: currentMilestone.date,

          dim_1_age_progress: {
            median_age: median,
            target_median: currentMilestone.target_median,
            status: ageOnTrack ? 'ON TRACK' : 'BEHIND',
            age_30_plus: ages.filter((a) => a >= 30).length,
            trend: ageTrend !== null ? `${ageTrend > 0 ? '+' : ''}${ageTrend} since last snapshot` : 'no prior snapshot yet',
          },

          dim_2_core_stability: {
            baseline_seeded: cfg.young_core_baseline.seeded_date,
            baseline_count: baseline.length,
            currently_retained: retained.length,
            pct_retained: `${retainedPct}%`,
            status: coreStatus,
            departed: baseline.filter((n) => !retained.includes(n)),
            newly_added: youngCore.filter((n) =>
              !baseline.some((b) => normalizeName(b) === normalizeName(n))
            ),
          },

          dim_3_asset_quality: {
            score: assetScore,
            max_possible: roster.length * 5,
            top_scorers: scoredRoster.slice(0, 8),
            top_30_bonus_active: top30.filter((n) =>
              roster.some((p) => normalizeName(p.name) === normalizeName(n))
            ),
            note: 'Edit top_30_bonus_players in data/rubric_config.json as your roster changes.',
          },

          dim_4_competitive_viability: compViability,

          dim_5_transaction_quality: {
            trades: tradeData,
            regret_list: regretData,
          },

          rubric_config_file: 'data/rubric_config.json',
        }, null, 2),
      }],
    };
  }

  private async getStandings() {
    const leagueKey = await this.buildLeagueKey();
    const res = await this.yahooApi.get(`/league/${leagueKey}/standings`, {
      headers: this.authHeaders(),
      params: { format: 'json' },
    });

    const teamsData = res.data.fantasy_content.league[1].standings[0].teams;
    const teams: any[] = [];

    for (const [k, v] of Object.entries(teamsData) as [string, any][]) {
      if (k === 'count') continue;
      const teamInfo = v.team[0];
      const teamStandings = v.team[2]?.team_standings;

      const name = teamInfo.find((x: any) => x.name !== undefined)?.name ?? '?';
      const rank = teamStandings?.rank ?? '?';
      const wins = teamStandings?.outcome_totals?.wins ?? '?';
      const losses = teamStandings?.outcome_totals?.losses ?? '?';
      const ties = teamStandings?.outcome_totals?.ties ?? '?';
      const winPct = teamStandings?.outcome_totals?.percentage ?? '?';
      const streak = teamStandings?.streak?.type && teamStandings?.streak?.value
        ? `${teamStandings.streak.type.charAt(0).toUpperCase()}${teamStandings.streak.value}`
        : '—';

      teams.push({ rank: Number(rank), name, wins, losses, ties, win_pct: winPct, streak });
    }

    teams.sort((a, b) => a.rank - b.rank);

    return {
      content: [{ type: 'text', text: JSON.stringify({ standings: teams }, null, 2) }],
    };
  }

  private async getLeagueTransactions(args: any) {
    const txType: string = args?.type ?? 'all';
    const count: number = args?.count ?? 25;
    const leagueKey = await this.buildLeagueKey();

    const typeFilter = txType === 'all' ? 'add,drop,trade' : txType;
    const res = await this.yahooApi.get(
      `/league/${leagueKey}/transactions;types=${typeFilter};count=${count}`,
      { headers: this.authHeaders(), params: { format: 'json' } }
    );

    const txData = res.data.fantasy_content.league[1].transactions;
    const transactions: any[] = [];

    for (const [k, v] of Object.entries(txData) as [string, any][]) {
      if (k === 'count') continue;
      const tx = v.transaction[0];
      const type = extractField(tx, 'type') ?? '?';
      const status = extractField(tx, 'status') ?? '?';
      const timestampRaw = extractField(tx, 'timestamp');
      const timestamp = timestampRaw
        ? new Date(Number(timestampRaw) * 1000).toISOString().slice(0, 10)
        : '?';

      const playersObj = v.transaction[1]?.players;
      const players: any[] = [];
      if (playersObj) {
        for (const [pk, pv] of Object.entries(playersObj) as [string, any][]) {
          if (pk === 'count') continue;
          const info = parsePlayerInfo(pv.player[0]);
          const txData2 = pv.player[1]?.transaction_data?.[0] ?? pv.player[1]?.transaction_data ?? {};
          players.push({
            name: info.name,
            position: info.position,
            mlbTeam: info.mlbTeam,
            tx_type: txData2.type ?? '?',
            destination_team: txData2.destination_team_name ?? null,
            source_team: txData2.source_team_name ?? null,
          });
        }
      }

      transactions.push({ type, status, date: timestamp, players });
    }

    return {
      content: [{ type: 'text', text: JSON.stringify({ count: transactions.length, transactions }, null, 2) }],
    };
  }

  private async getMatchup(args: any) {
    const leagueKey = await this.buildLeagueKey();
    const myTeamKey = await this.buildTeamKey();

    // Fetch league settings to determine current week
    const settingsRes = await this.yahooApi.get(`/league/${leagueKey}/settings`, {
      headers: this.authHeaders(),
      params: { format: 'json' },
    });
    const leagueSettings = settingsRes.data.fantasy_content.league;
    const currentWeek: number = args?.week
      ?? Number(extractField(leagueSettings[0], 'current_week') ?? 1);

    // Fetch scoreboard for the requested week
    const sbRes = await this.yahooApi.get(`/league/${leagueKey}/scoreboard;week=${currentWeek}`, {
      headers: this.authHeaders(),
      params: { format: 'json' },
    });

    const matchups = sbRes.data.fantasy_content.league[1].scoreboard[0].matchups;
    let myMatchup: any = null;

    for (const [k, v] of Object.entries(matchups) as [string, any][]) {
      if (k === 'count') continue;
      const teams = v.matchup[0].teams;
      const teamKeys: string[] = [];
      for (const [tk, tv] of Object.entries(teams) as [string, any][]) {
        if (tk === 'count') continue;
        const tk2 = tv.team[0];
        const tKey = tk2.find((x: any) => x.team_key !== undefined)?.team_key ?? '';
        teamKeys.push(tKey);
      }
      if (teamKeys.some((k2) => k2 === myTeamKey)) {
        myMatchup = v.matchup;
        break;
      }
    }

    if (!myMatchup) {
      return { content: [{ type: 'text', text: `No matchup found for week ${currentWeek}.` }] };
    }

    const matchupMeta = myMatchup[0];
    const teamsObj = matchupMeta.teams;
    const result: any = { week: currentWeek, status: matchupMeta.status ?? '?', teams: [] };

    for (const [tk, tv] of Object.entries(teamsObj) as [string, any][]) {
      if (tk === 'count') continue;
      const teamArr = tv.team[0];
      const statsArr = tv.team[1]?.team_stats?.stats ?? [];
      const pointsArr = tv.team[1]?.team_points;

      const name = teamArr.find((x: any) => x.name !== undefined)?.name ?? '?';
      const teamKey = teamArr.find((x: any) => x.team_key !== undefined)?.team_key ?? '?';
      const isMe = teamKey === myTeamKey;

      const stats: any[] = [];
      for (const s of statsArr) {
        if (s.stat) stats.push({ stat_id: s.stat.stat_id, value: s.stat.value });
      }

      result.teams.push({
        name,
        is_my_team: isMe,
        total_points: pointsArr?.total ?? null,
        stats,
      });
    }

    // Fetch stat categories from settings to label the stats
    const statCats: Record<string, string> = {};
    const statSettings = leagueSettings[1]?.settings?.[0]?.stat_categories?.stats ?? [];
    for (const s of statSettings) {
      if (s.stat) statCats[String(s.stat.stat_id)] = s.stat.abbr ?? s.stat.display_name ?? String(s.stat.stat_id);
    }

    if (Object.keys(statCats).length > 0) {
      for (const t of result.teams) {
        t.stats = t.stats.map((s: any) => ({
          ...s,
          name: statCats[String(s.stat_id)] ?? String(s.stat_id),
        }));
      }
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }

  private async evaluateAdvice(args: any) {
    const action: string = args?.action ?? 'score';
    const logPath = path.join(DATA_DIR, 'advice_log.json');
    const log: any[] = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, 'utf8')) : [];

    if (action === 'log') {
      const entry = {
        id: log.length + 1,
        date: new Date().toISOString().slice(0, 10),
        call: args?.call ?? '(no call text)',
        category: args?.category ?? 'other',
        players: args?.players ?? [],
        result: 'tbd',
        outcome_notes: null,
      };
      log.push(entry);
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
      return { content: [{ type: 'text', text: JSON.stringify({ logged: entry }, null, 2) }] };
    }

    if (action === 'outcome') {
      const id: number = args?.advice_id;
      const entry = log.find((e) => e.id === id);
      if (!entry) {
        return { content: [{ type: 'text', text: `No advice entry with id ${id}.` }] };
      }
      entry.result = args?.result ?? 'tbd';
      entry.outcome_notes = args?.outcome_notes ?? null;
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
      return { content: [{ type: 'text', text: JSON.stringify({ updated: entry }, null, 2) }] };
    }

    // action === 'score'
    const scored = log.filter((e) => e.result !== 'tbd');
    const correct = scored.filter((e) => e.result === 'correct').length;
    const partial = scored.filter((e) => e.result === 'partial').length;
    const incorrect = scored.filter((e) => e.result === 'incorrect').length;
    const total = scored.length;
    const hitRate = total > 0 ? `${Math.round(((correct + partial * 0.5) / total) * 100)}%` : 'n/a';

    const byCategory: Record<string, { correct: number; partial: number; incorrect: number; tbd: number }> = {};
    for (const e of log) {
      if (!byCategory[e.category]) byCategory[e.category] = { correct: 0, partial: 0, incorrect: 0, tbd: 0 };
      const cat = byCategory[e.category]!;
      cat[e.result as 'correct' | 'partial' | 'incorrect' | 'tbd']++;
    }

    const pending = log.filter((e) => e.result === 'tbd');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          summary: { total_calls: log.length, scored: total, correct, partial, incorrect, hit_rate: hitRate },
          by_category: byCategory,
          pending_outcomes: pending.map((e) => ({ id: e.id, date: e.date, call: e.call, players: e.players })),
          full_log: log,
        }, null, 2),
      }],
    };
  }

  private async getLeaguePowerRankings() {
    const ageMap = await this.getAgeMap();
    const configPath = path.join(DATA_DIR, 'rubric_config.json');
    const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const top30: string[] = cfg.top_30_bonus_players ?? [];
    const ageWeights = cfg.age_weights ?? {
      '22_and_under': 5, '23_to_24': 4, '25_to_26': 3, '27_to_28': 2, '29': 1, '30_plus': 0,
    };

    // Fetch all rosters + standings in parallel
    const [allTeams, standingsRes] = await Promise.all([
      this.fetchLeagueRosters(ageMap),
      this.yahooApi.get(`/league/${await this.buildLeagueKey()}/standings`, {
        headers: this.authHeaders(), params: { format: 'json' },
      }),
    ]);

    // Build win rate map from standings
    const winRateMap: Record<string, number> = {};
    const teamsStandings = standingsRes.data.fantasy_content.league[1].standings[0].teams;
    for (const [k, v] of Object.entries(teamsStandings) as [string, any][]) {
      if (k === 'count') continue;
      const tKey = v.team[0].find((x: any) => x.team_key !== undefined)?.team_key ?? '';
      const pct = parseFloat(v.team[2]?.team_standings?.outcome_totals?.percentage ?? '0');
      const wins = parseInt(v.team[2]?.team_standings?.outcome_totals?.wins ?? '0', 10);
      const losses = parseInt(v.team[2]?.team_standings?.outcome_totals?.losses ?? '0', 10);
      // Pre-season: no games yet — use 0.5 as neutral baseline
      winRateMap[tKey] = (wins + losses === 0) ? 0.5 : pct;
    }

    const rankings: any[] = [];

    for (const team of allTeams) {
      const ages = team.roster.map((p: any) => p.age).filter((a: any) => a !== null) as number[];
      if (ages.length === 0) continue;

      const sorted = [...ages].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const medianAge: number = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

      // Age score: invert median age (lower = younger = better for rebuild value; cap at 0)
      // Scale: median 24 = 10, 26 = 8, 28 = 6, 30 = 4, 32+ = 2
      const ageScore = Math.max(2, 10 - (medianAge - 24));

      // Asset quality score (same rubric as get_rebuild_scorecard)
      let assetScore = 0;
      for (const p of team.roster) {
        const a: number | null = p.age;
        if (a === null) continue;
        let pts = 0;
        if (a <= 22)      pts = ageWeights['22_and_under'] ?? 5;
        else if (a <= 24) pts = ageWeights['23_to_24'] ?? 4;
        else if (a <= 26) pts = ageWeights['25_to_26'] ?? 3;
        else if (a <= 28) pts = ageWeights['27_to_28'] ?? 2;
        else if (a <= 29) pts = ageWeights['29'] ?? 1;
        else              pts = ageWeights['30_plus'] ?? 0;
        if (top30.some((n) => normalizeName(n) === normalizeName(p.name))) pts += 2;
        assetScore += pts;
      }
      // Normalize asset score to 0-10 (max possible = roster_size * 7)
      const maxAsset = team.roster.length * 7;
      const assetNorm = parseFloat(((assetScore / maxAsset) * 10).toFixed(2));

      const winRate = winRateMap[team.teamKey] ?? 0.5;
      // Composite: 35% age score, 40% asset score, 25% win rate
      const composite = parseFloat((ageScore * 0.35 + assetNorm * 0.40 + winRate * 10 * 0.25).toFixed(2));

      rankings.push({
        team: team.teamName,
        is_my_team: team.isMe,
        composite_score: composite,
        age_score: parseFloat(ageScore.toFixed(2)),
        median_age: parseFloat(medianAge.toFixed(1)),
        asset_score: assetNorm,
        raw_asset_pts: assetScore,
        win_rate: parseFloat(winRate.toFixed(3)),
      });
    }

    rankings.sort((a, b) => b.composite_score - a.composite_score);
    rankings.forEach((r, i) => { r.rank = i + 1; });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          note: 'Composite = 35% age score + 40% asset quality + 25% win rate. Age score: lower median age = higher score.',
          rankings,
        }, null, 2),
      }],
    };
  }

  // Fetch live ADP for a single player via Yahoo player search
  private async fetchAdpForPlayer(name: string, leagueKey: string): Promise<number | null> {
    try {
      const res = await this.yahooApi.get(
        `/league/${leagueKey}/players;search=${encodeURIComponent(name)};count=1;out=draft_analysis`,
        { headers: this.authHeaders(), params: { format: 'json' } }
      );
      const players = res.data.fantasy_content.league[1].players;
      const first = players?.['0'];
      const adpRaw = first?.player[1]?.draft_analysis?.average_pick;
      return adpRaw ? parseFloat(adpRaw) : null;
    } catch { return null; }
  }

  // Build an offer package whose combined score reaches targetPct × targetValue.
  // Pulls from a pre-sorted, ADP-enriched candidate list.
  private buildOfferTier(candidates: any[], targetValue: number, targetPct: number): { players: any[]; total: number } {
    const goal = targetValue * targetPct;
    const offer: any[] = [];
    let total = 0;
    for (const c of candidates) {
      if (total >= goal) break;
      offer.push(c);
      total += c.score;
    }
    return { players: offer, total: parseFloat(total.toFixed(2)) };
  }

  private async autoGenerateTradePitch(args: any) {
    const mode: string = args?.mode ?? 'buying';
    const targetTeamFilter: string | undefined = args?.target_team;
    const maxOfferAge: number = args?.max_offer_age ?? 32;

    const ageMap = await this.getAgeMap();
    const leagueKey = await this.buildLeagueKey();
    const configPath = path.join(DATA_DIR, 'rubric_config.json');
    const cfg = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const top30: string[] = cfg.top_30_bonus_players ?? [];

    const allTeams = await this.fetchLeagueRosters(ageMap);
    const myTeam = allTeams.find((t) => t.isMe);
    if (!myTeam) return { content: [{ type: 'text', text: 'Could not find your team.' }] };

    // ── SELLING MODE ──────────────────────────────────────────────────────────
    if (mode === 'selling') {
      const offerPlayerName: string = args?.offer_player ?? '';
      if (!offerPlayerName) return { content: [{ type: 'text', text: 'selling mode requires offer_player.' }] };

      const offerNorm = normalizeName(offerPlayerName);
      const offerPlayerInfo = myTeam.roster.find((p: any) =>
        normalizeName(p.name).includes(offerNorm) || offerNorm.includes(normalizeName(p.name))
      );
      if (!offerPlayerInfo) {
        return { content: [{ type: 'text', text: `Could not find "${offerPlayerName}" on your roster.` }] };
      }

      // Enrich offer player with live ADP
      const offerAdp = await this.fetchAdpForPlayer(offerPlayerInfo.name, leagueKey);
      const offerScore = this.scorePlayer(offerPlayerInfo.name, offerPlayerInfo.position, offerPlayerInfo.age, offerAdp, top30);

      // Find teams thin at offer player's position
      const offerBuckets = this.positionBuckets(offerPlayerInfo.position);
      const buyerTeams = allTeams
        .filter((t) => !t.isMe)
        .filter((t) => !targetTeamFilter || t.teamName.toLowerCase().includes(targetTeamFilter.toLowerCase()))
        .map((t) => {
          const posDepth: Record<string, number> = {};
          for (const p of t.roster) {
            for (const b of this.positionBuckets(p.position)) {
              posDepth[b] = (posDepth[b] ?? 0) + 1;
            }
          }
          const needsPosition = offerBuckets.some((b) => (posDepth[b] ?? 0) <= 2);
          // Score their young return assets
          const youngAssets = t.roster
            .filter((p: any) => (p.age ?? 99) <= 27)
            .map((p: any) => ({ ...p, score: this.scorePlayer(p.name, p.position, p.age, null, top30).total }))
            .sort((a: any, b: any) => b.score - a.score);
          const returnPool = youngAssets.reduce((s: number, p: any) => s + p.score, 0);
          return { team: t, needsPosition, youngAssets, returnPool, posDepth };
        })
        .sort((a, b) => {
          if (a.needsPosition !== b.needsPosition) return a.needsPosition ? -1 : 1;
          return b.returnPool - a.returnPool;
        });

      if (buyerTeams.length === 0) {
        return { content: [{ type: 'text', text: 'No suitable buyer teams found.' }] };
      }

      const bestBuyer = buyerTeams[0]!;

      // Build ask tiers (what you want back from them)
      const askCandidates = bestBuyer.youngAssets;
      const floorAsk  = this.buildOfferTier(askCandidates, offerScore.total, 0.80);
      const targetAsk = this.buildOfferTier(askCandidates, offerScore.total, 1.00);
      const ceilingAsk = this.buildOfferTier(askCandidates, offerScore.total, 1.20);

      const fmtPlayers = (players: any[]) =>
        players.map((p: any) => `${p.name} (${p.position}, age ${p.age ?? '?'})`).join(', ') || '(none available)';

      const pitch = [
        `Selling: ${offerPlayerInfo.name} (${offerPlayerInfo.position}, age ${offerPlayerInfo.age ?? '?'}) — ADP tier: ${offerScore.adp_tier}`,
        ``,
        `Best landing spot: ${bestBuyer.team.teamName}${bestBuyer.needsPosition ? ` (thin at ${offerBuckets.join('/')})` : ''}`,
        ``,
        `Ask tiers (what to request in return):`,
        `  Ceiling ask (open with): ${fmtPlayers(ceilingAsk.players)} — total score ${ceilingAsk.total.toFixed(1)}`,
        `  Target ask (want):       ${fmtPlayers(targetAsk.players)} — total score ${targetAsk.total.toFixed(1)}`,
        `  Floor ask (walk-away):   ${fmtPlayers(floorAsk.players)} — total score ${floorAsk.total.toFixed(1)}`,
        ``,
        `Your player's score: ${offerScore.total.toFixed(1)}`,
        ``,
        `Why they take it: ${bestBuyer.needsPosition ? `They're thin at ${offerBuckets.join('/')} — this fills a real hole.` : 'Lead with the upgrade angle over their current starter.'}`,
      ].join('\n');

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            mode: 'selling',
            pitch,
            your_player: { name: offerPlayerInfo.name, position: offerPlayerInfo.position, age: offerPlayerInfo.age, adp: offerAdp, score: offerScore.total, adp_tier: offerScore.adp_tier },
            best_buyer: bestBuyer.team.teamName,
            buyer_needs_position: bestBuyer.needsPosition,
            ask_tiers: {
              ceiling: { players: ceilingAsk.players.map((p: any) => ({ name: p.name, position: p.position, age: p.age, score: p.score })), total: ceilingAsk.total },
              target:  { players: targetAsk.players.map((p: any) => ({ name: p.name, position: p.position, age: p.age, score: p.score })), total: targetAsk.total },
              floor:   { players: floorAsk.players.map((p: any) => ({ name: p.name, position: p.position, age: p.age, score: p.score })), total: floorAsk.total },
            },
            other_buyer_teams: buyerTeams.slice(1, 4).map((b) => ({
              team: b.team.teamName, needs_position: b.needsPosition, young_return_pool: parseFloat(b.returnPool.toFixed(1)),
            })),
          }, null, 2),
        }],
      };
    }

    // ── BUYING MODE ───────────────────────────────────────────────────────────
    const targetPlayer: string = args?.target_player ?? '';
    if (!targetPlayer) return { content: [{ type: 'text', text: 'buying mode requires target_player.' }] };

    const targetNorm = normalizeName(targetPlayer);
    let ownerTeam: any = null;
    let targetPlayerInfo: any = null;

    for (const team of allTeams) {
      if (team.isMe) continue;
      if (targetTeamFilter && !team.teamName.toLowerCase().includes(targetTeamFilter.toLowerCase())) continue;
      const found = team.roster.find((p: any) =>
        normalizeName(p.name).includes(targetNorm) || targetNorm.includes(normalizeName(p.name))
      );
      if (found) { ownerTeam = team; targetPlayerInfo = found; break; }
    }

    if (!ownerTeam || !targetPlayerInfo) {
      return {
        content: [{
          type: 'text',
          text: `Could not find "${targetPlayer}" on any opponent roster${targetTeamFilter ? ` (filtered to "${targetTeamFilter}")` : ''}.`,
        }],
      };
    }

    // Positional thin spots on the owner's team
    const posDepth: Record<string, number> = {};
    for (const p of ownerTeam.roster) {
      for (const b of this.positionBuckets(p.position)) {
        posDepth[b] = (posDepth[b] ?? 0) + 1;
      }
    }
    const thinSpots = Object.entries(posDepth).filter(([, cnt]) => cnt <= 2).map(([pos]) => pos).sort();

    // Initial sort of my offer candidates (no ADP yet — fast pass)
    const rawCandidates = myTeam.roster
      .filter((p: any) => (p.age ?? 99) <= maxOfferAge && !normalizeName(p.name).includes(targetNorm))
      .map((p: any) => {
        const fillsThinSpot = this.positionBuckets(p.position).some((b) => thinSpots.includes(b));
        return { ...p, fillsThinSpot };
      })
      .sort((a: any, b: any) => {
        if (a.fillsThinSpot !== b.fillsThinSpot) return a.fillsThinSpot ? -1 : 1;
        return (a.age ?? 99) - (b.age ?? 99); // younger first as tiebreak
      });

    // Enrich top 10 candidates + target player with live ADP in parallel
    const topCandidates = rawCandidates.slice(0, 10);
    const [targetAdp, ...candidateAdps] = await Promise.all([
      this.fetchAdpForPlayer(targetPlayerInfo.name, leagueKey),
      ...topCandidates.map((p: any) => this.fetchAdpForPlayer(p.name, leagueKey)),
    ]);

    const targetScore = this.scorePlayer(targetPlayerInfo.name, targetPlayerInfo.position, targetPlayerInfo.age, targetAdp, top30);

    const scoredCandidates = topCandidates.map((p: any, i: number) => {
      const adp = candidateAdps[i] ?? null;
      const score = this.scorePlayer(p.name, p.position, p.age, adp, top30);
      return { ...p, adp, score: score.total, adp_tier: score.adp_tier, fills_need: p.fillsThinSpot };
    }).sort((a: any, b: any) => {
      if (a.fills_need !== b.fills_need) return a.fills_need ? -1 : 1;
      return b.score - a.score;
    });

    // Build three offer tiers
    const floorOffer   = this.buildOfferTier(scoredCandidates, targetScore.total, 0.80);
    const targetOffer  = this.buildOfferTier(scoredCandidates, targetScore.total, 1.00);
    const ceilingOffer = this.buildOfferTier(scoredCandidates, targetScore.total, 1.20);

    const fmtPlayers = (players: any[]) =>
      players.map((p: any) => `${p.name} (${p.position}, age ${p.age ?? '?'})`).join(', ') || '(none available)';

    const needsPhrase = thinSpots.length > 0
      ? `Their roster is thin at ${thinSpots.join(', ')}.`
      : 'Their roster looks balanced — lead with the age/upside angle.';

    const pitch = [
      `Buying: ${targetPlayerInfo.name} (${targetPlayerInfo.position}, age ${targetPlayerInfo.age ?? '?'}) from ${ownerTeam.teamName} — ADP tier: ${targetScore.adp_tier}`,
      ``,
      `Offer tiers:`,
      `  Floor (open with):   ${fmtPlayers(floorOffer.players)} — total score ${floorOffer.total.toFixed(1)}`,
      `  Target (want):       ${fmtPlayers(targetOffer.players)} — total score ${targetOffer.total.toFixed(1)}`,
      `  Ceiling (max give):  ${fmtPlayers(ceilingOffer.players)} — total score ${ceilingOffer.total.toFixed(1)}`,
      ``,
      `Target score: ${targetScore.total.toFixed(1)}`,
      ``,
      `Why they take it: ${needsPhrase}${thinSpots.length > 0 && scoredCandidates.some((p: any) => p.fills_need) ? ' Your offer fills that gap directly.' : ''}`,
      `Why you take it: ${targetPlayerInfo.name} at age ${targetPlayerInfo.age ?? '?'} fits the rebuild. Adds ${targetScore.adp_tier} talent.`,
    ].join('\n');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          mode: 'buying',
          pitch,
          target: { name: targetPlayerInfo.name, position: targetPlayerInfo.position, age: targetPlayerInfo.age, adp: targetAdp, score: targetScore.total, adp_tier: targetScore.adp_tier },
          owner_team: ownerTeam.teamName,
          their_thin_spots: thinSpots,
          offer_tiers: {
            floor:   { players: floorOffer.players.map((p: any) => ({ name: p.name, position: p.position, age: p.age, adp: p.adp, score: p.score })), total: floorOffer.total },
            target:  { players: targetOffer.players.map((p: any) => ({ name: p.name, position: p.position, age: p.age, adp: p.adp, score: p.score })), total: targetOffer.total },
            ceiling: { players: ceilingOffer.players.map((p: any) => ({ name: p.name, position: p.position, age: p.age, adp: p.adp, score: p.score })), total: ceilingOffer.total },
          },
          scoring_note: 'Scores use live ADP from Yahoo draft analysis. Higher = more valuable.',
        }, null, 2),
      }],
    };
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('Yahoo Fantasy Baseball MCP server running on stdio');
  }
}

const phil = new FlatbottomPhil();
phil.run().catch(console.error);
