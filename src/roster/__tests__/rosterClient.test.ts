import { describe, it, expect, beforeEach, vi } from 'vitest';

const orderMock = vi.fn();
const insertMock = vi.fn();
const deleteEqMock = vi.fn();
const selectMock = vi.fn(() => ({ order: orderMock }));
const deleteMock = vi.fn(() => ({ eq: deleteEqMock }));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: selectMock,
      insert: insertMock,
      delete: deleteMock,
    }),
  },
}));

import { listRoster, addScouter, removeScouter } from '../rosterClient';

beforeEach(() => {
  orderMock.mockReset();
  insertMock.mockReset();
  deleteEqMock.mockReset();
});

describe('rosterClient', () => {
  it('listRoster returns mapped rows', async () => {
    orderMock.mockResolvedValue({ data: [{ id: '1', name: 'Ada' }], error: null });
    const rows = await listRoster();
    expect(rows).toEqual([{ id: '1', name: 'Ada' }]);
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
});
