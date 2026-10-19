import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { describe, it, expect, beforeEach } from 'vitest';
import { db, getBoardRecords, writeBoardRecords, boardRecordKey } from '../localStore';

describe("Ryan's Board local records", () => {
  beforeEach(async () => {
    await db.boardRecords.clear();
  });

  it('stores puts as dirty rows scoped to their board', async () => {
    await writeBoardRecords('2026casj', [{ id: 'shape:a', data: { id: 'shape:a', x: 1 }, deleted: false }]);
    await writeBoardRecords('2026other', [{ id: 'shape:b', data: { id: 'shape:b' }, deleted: false }]);

    const records = await getBoardRecords('2026casj');
    expect([...records.keys()]).toEqual(['shape:a']);
    expect(records.get('shape:a')).toEqual({ id: 'shape:a', x: 1 });

    const row = await db.boardRecords.get(boardRecordKey('2026casj', 'shape:a'));
    expect(row?.syncState).toBe('dirty');
    expect(row?.deleted).toBe(false);
  });

  it('tombstones keep their merge data instead of deleting the row', async () => {
    await writeBoardRecords('2026casj', [{ id: 'shape:a', data: { id: 'shape:a' }, deleted: false }]);
    const tomb = { id: 'shape:a', deleted: true, rev: 5, by: 'c1' };
    await writeBoardRecords('2026casj', [{ id: 'shape:a', data: tomb, deleted: true }]);

    expect((await getBoardRecords('2026casj')).size).toBe(0);
    const row = await db.boardRecords.get(boardRecordKey('2026casj', 'shape:a'));
    expect(row).toMatchObject({ deleted: true, data: tomb, syncState: 'dirty' });
  });

  it('remote merges can be written as already synced', async () => {
    await writeBoardRecords('2026casj', [{ id: 'shape:c', data: { id: 'shape:c' }, deleted: false }], 'synced');
    const row = await db.boardRecords.get(boardRecordKey('2026casj', 'shape:c'));
    expect(row?.syncState).toBe('synced');
  });

  it('keeps v5 rows when the database upgrades to v6', async () => {
    const name = 'board-upgrade-test';
    const v5 = new Dexie(name);
    v5.version(5).stores({ strategyCanvas: 'key, eventKey, syncState' });
    await v5.table('strategyCanvas').put({ key: 'e:m:auto', eventKey: 'e', syncState: 'dirty' });
    v5.close();

    const v6 = new Dexie(name);
    v6.version(5).stores({ strategyCanvas: 'key, eventKey, syncState' });
    v6.version(6).stores({
      strategyCanvas: 'key, eventKey, syncState',
      boardRecords: 'key, boardKey, syncState',
    });
    await v6.open();
    expect(await v6.table('strategyCanvas').count()).toBe(1);
    expect(await v6.table('boardRecords').count()).toBe(0);
    v6.close();
    await Dexie.delete(name);
  });
});
