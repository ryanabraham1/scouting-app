import { describe, it, expect, beforeEach, vi } from 'vitest';

const orderMock = vi.fn();
const eqMock = vi.fn(() => ({ order: orderMock }));
const insertMock = vi.fn();
const deleteEqMock = vi.fn();
const selectMock = vi.fn(() => ({ order: orderMock, eq: eqMock }));
const deleteMock = vi.fn(() => ({ eq: deleteEqMock }));
const rpcMock = vi.fn();

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: selectMock,
      insert: insertMock,
      delete: deleteMock,
    }),
    rpc: (name: string, args: unknown) => rpcMock(name, args),
  },
}));

import {
  listRoster,
  addScouter,
  removeScouter,
  setScouterHidden,
  deleteRosterScouter,
} from '../rosterClient';

beforeEach(() => {
  orderMock.mockReset();
  eqMock.mockReset().mockReturnValue({ order: orderMock });
  insertMock.mockReset();
  deleteEqMock.mockReset();
  rpcMock.mockReset();
});

describe('rosterClient', () => {
  it('listRoster maps rows and excludes hidden by default', async () => {
    orderMock.mockResolvedValue({ data: [{ id: '1', name: 'Ada', hidden: false }], error: null });
    const rows = await listRoster();
    expect(eqMock).toHaveBeenCalledWith('hidden', false);
    expect(rows).toEqual([{ id: '1', name: 'Ada', hidden: false }]);
  });

  it('listRoster({ includeHidden }) does not filter on hidden', async () => {
    orderMock.mockResolvedValue({
      data: [
        { id: '1', name: 'Ada', hidden: false },
        { id: '2', name: 'Bob', hidden: true },
      ],
      error: null,
    });
    const rows = await listRoster({ includeHidden: true });
    expect(eqMock).not.toHaveBeenCalled();
    expect(rows).toEqual([
      { id: '1', name: 'Ada', hidden: false },
      { id: '2', name: 'Bob', hidden: true },
    ]);
  });

  it('addScouter trims and inserts', async () => {
    insertMock.mockResolvedValue({ error: null });
    await addScouter('  Grace  ');
    expect(insertMock).toHaveBeenCalledWith({ name: 'Grace' });
  });

  it('addScouter ignores blank names', async () => {
    await addScouter('   ');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('addScouter swallows a unique-violation (duplicate name)', async () => {
    insertMock.mockResolvedValue({ error: { code: '23505', message: 'dup' } });
    await expect(addScouter('Ada')).resolves.toBeUndefined();
  });

  it('addScouter throws on other errors', async () => {
    insertMock.mockResolvedValue({ error: { code: '500', message: 'boom' } });
    await expect(addScouter('Ada')).rejects.toThrow('boom');
  });

  it('removeScouter deletes by id', async () => {
    deleteEqMock.mockResolvedValue({ error: null });
    await removeScouter('xyz');
    expect(deleteEqMock).toHaveBeenCalledWith('id', 'xyz');
  });

  it('setScouterHidden calls the set_roster_hidden RPC', async () => {
    rpcMock.mockResolvedValue({ error: null });
    await setScouterHidden('Ada', true);
    expect(rpcMock).toHaveBeenCalledWith('set_roster_hidden', { p_name: 'Ada', p_hidden: true });
  });

  it('deleteRosterScouter calls the delete_roster_scouter RPC', async () => {
    rpcMock.mockResolvedValue({ error: null });
    await deleteRosterScouter('Ada');
    expect(rpcMock).toHaveBeenCalledWith('delete_roster_scouter', { p_name: 'Ada' });
  });

  it('deleteRosterScouter throws on error', async () => {
    rpcMock.mockResolvedValue({ error: { message: 'boom' } });
    await expect(deleteRosterScouter('Ada')).rejects.toThrow('boom');
  });
});
