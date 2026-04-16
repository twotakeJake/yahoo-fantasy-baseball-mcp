import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  lookupAge,
  extractField,
  parsePlayerInfo,
  extractPlayersMap,
  computeCategoryRankings,
  buildOptimalLineup,
} from '../utils/transforms.js';

// ---------------------------------------------------------------------------
// normalizeName
// ---------------------------------------------------------------------------

describe('normalizeName', () => {
  it('lowercases ascii names', () => {
    assert.equal(normalizeName('Mike Trout'), 'mike trout');
  });

  it('strips accent marks', () => {
    assert.equal(normalizeName('José Ramírez'), 'jose ramirez');
  });

  it('strips parentheticals like (Batter) or (Pitcher)', () => {
    assert.equal(normalizeName('Shohei Ohtani (Batter)'), 'shohei ohtani');
  });

  it('strips parentheticals and accents together', () => {
    assert.equal(normalizeName('Félix (Closer) Hernández'), 'felix  hernandez');
  });

  it('trims leading and trailing whitespace', () => {
    assert.equal(normalizeName('  Aaron Judge  '), 'aaron judge');
  });

  it('strips non-alpha characters other than spaces', () => {
    assert.equal(normalizeName("Jo-el Márquez Jr."), 'joel marquez jr');
  });

  it('returns empty string for empty input', () => {
    assert.equal(normalizeName(''), '');
  });
});

// ---------------------------------------------------------------------------
// lookupAge
// ---------------------------------------------------------------------------

describe('lookupAge', () => {
  it('returns age when player is found uniquely', () => {
    const map = new Map([['mike trout', [{ age: 32, jersey: '27' }]]]);
    assert.equal(lookupAge(map, 'Mike Trout', '27'), 32);
  });

  it('normalizes the lookup name before searching', () => {
    const map = new Map([['jose ramirez', [{ age: 31, jersey: '11' }]]]);
    assert.equal(lookupAge(map, 'José Ramírez', '11'), 31);
  });

  it('returns undefined for unknown player', () => {
    const map = new Map<string, { age: number; jersey: string }[]>();
    assert.equal(lookupAge(map, 'Unknown Player', '99'), undefined);
  });

  it('disambiguates same-name players by jersey number', () => {
    const map = new Map([
      ['max muncy', [
        { age: 34, jersey: '13' },
        { age: 22, jersey: '75' },
      ]],
    ]);
    assert.equal(lookupAge(map, 'Max Muncy', '75'), 22);
    assert.equal(lookupAge(map, 'Max Muncy', '13'), 34);
  });

  it('returns undefined when same-name jersey does not match', () => {
    const map = new Map([
      ['max muncy', [
        { age: 34, jersey: '13' },
        { age: 22, jersey: '75' },
      ]],
    ]);
    assert.equal(lookupAge(map, 'Max Muncy', '99'), undefined);
  });
});

// ---------------------------------------------------------------------------
// extractField
// ---------------------------------------------------------------------------

describe('extractField', () => {
  it('extracts a value from an array of single-key objects', () => {
    const arr = [{ player_key: '458.p.1234' }, { display_position: 'SS' }];
    assert.equal(extractField(arr, 'display_position'), 'SS');
  });

  it('returns null when key is not present', () => {
    const arr = [{ player_key: '458.p.1234' }];
    assert.equal(extractField(arr, 'uniform_number'), null);
  });

  it('returns null for empty array', () => {
    assert.equal(extractField([], 'name'), null);
  });

  it('skips array items that are themselves arrays', () => {
    const arr: any[] = [['nested', 'array'], { name: { full: 'Aaron Judge' } }];
    assert.deepEqual(extractField(arr, 'name'), { full: 'Aaron Judge' });
  });

  it('skips null items without throwing', () => {
    const arr = [null, { display_position: '1B' }];
    assert.equal(extractField(arr, 'display_position'), '1B');
  });
});

// ---------------------------------------------------------------------------
// parsePlayerInfo
// ---------------------------------------------------------------------------

describe('parsePlayerInfo', () => {
  const sampleInfoArray = [
    { player_key: '458.p.9988' },
    { name: { full: 'Aaron Judge', first: 'Aaron', last: 'Judge' } },
    { display_position: 'OF' },
    { editorial_team_abbr: 'NYY' },
    { uniform_number: '99' },
  ];

  it('extracts name', () => {
    assert.equal(parsePlayerInfo(sampleInfoArray).name, 'Aaron Judge');
  });

  it('extracts position', () => {
    assert.equal(parsePlayerInfo(sampleInfoArray).position, 'OF');
  });

  it('extracts mlbTeam', () => {
    assert.equal(parsePlayerInfo(sampleInfoArray).mlbTeam, 'NYY');
  });

  it('extracts playerKey', () => {
    assert.equal(parsePlayerInfo(sampleInfoArray).playerKey, '458.p.9988');
  });

  it('extracts jerseyNumber', () => {
    assert.equal(parsePlayerInfo(sampleInfoArray).jerseyNumber, '99');
  });

  it('returns empty strings for missing fields', () => {
    const result = parsePlayerInfo([]);
    assert.equal(result.name, '');
    assert.equal(result.position, '');
    assert.equal(result.mlbTeam, '');
    assert.equal(result.playerKey, '');
    assert.equal(result.jerseyNumber, '');
  });

  it('extracts status when present', () => {
    const arr = [{ player_key: '458.p.9988' }, { status: 'IL' }];
    assert.equal(parsePlayerInfo(arr).status, 'IL');
  });

  it('extracts injuryNote when present', () => {
    const arr = [{ player_key: '458.p.9988' }, { injury_note: 'left elbow inflammation' }];
    assert.equal(parsePlayerInfo(arr).injuryNote, 'left elbow inflammation');
  });

  it('omits status key when not present', () => {
    const result = parsePlayerInfo([{ player_key: '458.p.9988' }]);
    assert.equal('status' in result, false);
  });

  it('omits injuryNote key when not present', () => {
    const result = parsePlayerInfo([{ player_key: '458.p.9988' }]);
    assert.equal('injuryNote' in result, false);
  });
});

// ---------------------------------------------------------------------------
// extractPlayersMap
// ---------------------------------------------------------------------------

describe('extractPlayersMap', () => {
  it('extracts players from numeric-indexed roster object', () => {
    const players = { 0: { player: [] }, count: 1 };
    const rosterObj = { 0: { players } };
    assert.deepEqual(extractPlayersMap(rosterObj), players);
  });

  it('extracts players from string-indexed roster object', () => {
    const players = { 0: { player: [] }, count: 1 };
    const rosterObj = { '0': { players } };
    assert.deepEqual(extractPlayersMap(rosterObj), players);
  });

  it('returns empty object when roster structure is missing', () => {
    assert.deepEqual(extractPlayersMap({}), {});
  });
});

// ---------------------------------------------------------------------------
// buildOptimalLineup
// ---------------------------------------------------------------------------

describe('buildOptimalLineup', () => {
  it('assigns IL-eligible injured player to IL slot', () => {
    const players = [{ playerKey: 'p1', eligiblePositions: ['SP', 'P', 'IL', 'BN'], isInjured: true }];
    const result = buildOptimalLineup(players, { SP: 1, BN: 3, IL: 1 });
    assert.equal(result.find((r) => r.playerKey === 'p1')?.position, 'IL');
  });

  it('sends injured player to BN when no IL slot available', () => {
    const players = [{ playerKey: 'p1', eligiblePositions: ['SP', 'P', 'BN'], isInjured: true }];
    const result = buildOptimalLineup(players, { SP: 1, BN: 3 });
    assert.equal(result.find((r) => r.playerKey === 'p1')?.position, 'BN');
  });

  it('sends injured player to BN when IL slot exists but player not IL-eligible', () => {
    const players = [{ playerKey: 'p1', eligiblePositions: ['SP', 'P', 'BN'], isInjured: true }];
    const result = buildOptimalLineup(players, { SP: 1, BN: 3, IL: 2 });
    assert.equal(result.find((r) => r.playerKey === 'p1')?.position, 'BN');
  });

  it('assigns healthy player to their position slot', () => {
    const players = [{ playerKey: 'p1', eligiblePositions: ['C', 'Util', 'BN'], isInjured: false }];
    const result = buildOptimalLineup(players, { C: 1, Util: 1, BN: 5 });
    assert.equal(result.find((r) => r.playerKey === 'p1')?.position, 'C');
  });

  it('places most-constrained player in scarce slot before versatile player', () => {
    // p1 can only play C; p2 can play C or Util — p1 should get C
    const players = [
      { playerKey: 'p1', eligiblePositions: ['C', 'BN'], isInjured: false },
      { playerKey: 'p2', eligiblePositions: ['C', 'Util', 'BN'], isInjured: false },
    ];
    const result = buildOptimalLineup(players, { C: 1, Util: 1, BN: 5 });
    assert.equal(result.find((r) => r.playerKey === 'p1')?.position, 'C');
    assert.equal(result.find((r) => r.playerKey === 'p2')?.position, 'Util');
  });

  it('fills multiple OF slots', () => {
    const players = [
      { playerKey: 'p1', eligiblePositions: ['OF', 'BN'], isInjured: false },
      { playerKey: 'p2', eligiblePositions: ['OF', 'BN'], isInjured: false },
      { playerKey: 'p3', eligiblePositions: ['OF', 'BN'], isInjured: false },
    ];
    const result = buildOptimalLineup(players, { OF: 3, BN: 3 });
    const ofAssigned = result.filter((r) => r.position === 'OF').length;
    assert.equal(ofAssigned, 3);
  });

  it('sends healthy player to BN when all active slots are filled', () => {
    const players = [
      { playerKey: 'p1', eligiblePositions: ['SP', 'BN'], isInjured: false },
      { playerKey: 'p2', eligiblePositions: ['SP', 'BN'], isInjured: false },
    ];
    const result = buildOptimalLineup(players, { SP: 1, BN: 5 });
    const bn = result.filter((r) => r.position === 'BN');
    assert.equal(bn.length, 1);
  });

  it('assigns every player exactly once', () => {
    const players = [
      { playerKey: 'p1', eligiblePositions: ['C', 'BN'], isInjured: false },
      { playerKey: 'p2', eligiblePositions: ['SP', 'IL', 'BN'], isInjured: true },
      { playerKey: 'p3', eligiblePositions: ['OF', 'Util', 'BN'], isInjured: false },
    ];
    const result = buildOptimalLineup(players, { C: 1, OF: 1, Util: 1, SP: 1, BN: 3, IL: 1 });
    const keys = result.map((r) => r.playerKey);
    assert.equal(keys.length, players.length);
    assert.equal(new Set(keys).size, players.length);
  });

  it('returns empty array for empty player list', () => {
    assert.deepEqual(buildOptimalLineup([], { C: 1, BN: 5 }), []);
  });
});

// ---------------------------------------------------------------------------
// computeCategoryRankings
// ---------------------------------------------------------------------------

describe('computeCategoryRankings', () => {
  const teams = [
    { teamKey: 'A', value: 150 },
    { teamKey: 'B', value: 200 },
    { teamKey: 'C', value: 100 },
  ];

  it('ranks higher-is-better stats with highest value at rank 1', () => {
    const result = computeCategoryRankings(teams, true);
    const byKey = Object.fromEntries(result.map((r) => [r.teamKey, r.rank]));
    assert.equal(byKey['B'], 1);
    assert.equal(byKey['A'], 2);
    assert.equal(byKey['C'], 3);
  });

  it('ranks lower-is-better stats with lowest value at rank 1', () => {
    const result = computeCategoryRankings(teams, false);
    const byKey = Object.fromEntries(result.map((r) => [r.teamKey, r.rank]));
    assert.equal(byKey['C'], 1);
    assert.equal(byKey['A'], 2);
    assert.equal(byKey['B'], 3);
  });

  it('pushes null values to last rank', () => {
    const input = [
      { teamKey: 'A', value: 50 },
      { teamKey: 'B', value: null },
      { teamKey: 'C', value: 80 },
    ];
    const result = computeCategoryRankings(input, true);
    const byKey = Object.fromEntries(result.map((r) => [r.teamKey, r.rank]));
    assert.equal(byKey['C'], 1);
    assert.equal(byKey['A'], 2);
    assert.equal(byKey['B'], 3); // null → last
  });

  it('assigns same last rank to multiple null-value teams', () => {
    const input = [
      { teamKey: 'A', value: 10 },
      { teamKey: 'B', value: null },
      { teamKey: 'C', value: null },
    ];
    const result = computeCategoryRankings(input, true);
    const byKey = Object.fromEntries(result.map((r) => [r.teamKey, r.rank]));
    assert.equal(byKey['A'], 1);
    assert.equal(byKey['B'], byKey['C']); // both null → same rank
    assert.equal(byKey['B'], 2);
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(computeCategoryRankings([], true), []);
  });

  it('handles a single team', () => {
    const result = computeCategoryRankings([{ teamKey: 'A', value: 42 }], true);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.rank, 1);
  });

  it('preserves value in output', () => {
    const result = computeCategoryRankings([{ teamKey: 'A', value: 3.14 }], false);
    assert.equal(result[0]!.value, 3.14);
  });
});
