import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addClaim, claimedByOthers, readClaims, removeClaim } from '../claims.js';
import { ProjectPaths } from '../paths.js';

let dir: string;
let paths: ProjectPaths;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vn-claims-'));
  paths = new ProjectPaths(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the claims ledger', () => {
  it('reads nothing from a project with no ledger', async () => {
    expect(await readClaims(paths)).toEqual(new Map());
  });

  it('records one empty file per project and hash', async () => {
    await addClaim(paths, 'aa', 'p1');
    await addClaim(paths, 'aa', 'p2');
    await addClaim(paths, 'bb', 'p1');
    expect(await readClaims(paths)).toEqual(
      new Map([
        ['aa', new Set(['p1', 'p2'])],
        ['bb', new Set(['p1'])],
      ]),
    );
  });

  it('answers the hashes some other project claims', async () => {
    await addClaim(paths, 'aa', 'p1');
    await addClaim(paths, 'bb', 'p2');
    const claims = await readClaims(paths);
    expect(claimedByOthers(claims, 'p1')).toEqual(new Set(['bb']));
    expect(claimedByOthers(claims, undefined)).toEqual(new Set(['aa', 'bb']));
  });

  it('drops a claim, and the hash folder with its last one', async () => {
    await addClaim(paths, 'aa', 'p1');
    await addClaim(paths, 'aa', 'p2');
    expect(await removeClaim(paths, 'aa', 'p1')).toBe(paths.claimFile('aa', 'p1'));
    expect(await readdir(paths.claimsDir)).toEqual(['aa']);
    await removeClaim(paths, 'aa', 'p2');
    expect(await readdir(paths.claimsDir)).toEqual([]);
    expect(await removeClaim(paths, 'aa', 'p2')).toBeUndefined();
  });
});
