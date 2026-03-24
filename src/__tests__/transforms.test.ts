import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeName,
  lookupAge,
  extractField,
  parsePlayerInfo,
  extractPlayersMap,
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
