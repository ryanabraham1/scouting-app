import { beforeEach, describe, expect, it, vi } from 'vitest';
const { upload, getPublicUrl } = vi.hoisted(() => ({ upload: vi.fn(), getPublicUrl: vi.fn() }));
vi.mock('@/lib/supabase', () => ({ supabase: { storage: { from: () => ({ upload, getPublicUrl }) } } }));
import { uploadBoardImage } from '../assets';

beforeEach(() => {
  upload.mockReset().mockResolvedValue({ error: null });
  getPublicUrl.mockReset().mockImplementation((path: string) => ({ data: { publicUrl: `https://assets.test/${path}` } }));
});
describe('board image upload', () => {
  it('leaves offline source immutable and returns a content-addressed cloud record', async () => {
    const src = 'data:image/png;base64,aGk=';
    const original = { type: 'image', id: 's:img', rev: 1, by: 'a', src };
    const result = await uploadBoardImage('event', original);
    expect(result).toMatchObject({ id: 's:img', rev: 1, src: expect.stringMatching(/^https:\/\/assets.test\/event\/[a-f0-9]{64}\.png$/) });
    expect(original.src).toBe(src);
    expect(upload).toHaveBeenCalledWith(expect.any(String), expect.any(Blob), expect.objectContaining({ upsert: true }));
  });
  it('surfaces network failures to the durable retry queue', async () => {
    upload.mockResolvedValue({ error: new TypeError('Failed to fetch') });
    await expect(uploadBoardImage('event', { type: 'image', src: 'data:image/png;base64,aGk=' })).rejects.toThrow('Failed to fetch');
  });
  it('does not upload a cloud URL or a tombstone again', async () => {
    await uploadBoardImage('event', { type: 'image', src: 'https://assets.test/a.png' });
    await uploadBoardImage('event', { id: 's:img', deleted: true });
    expect(upload).not.toHaveBeenCalled();
  });
});
