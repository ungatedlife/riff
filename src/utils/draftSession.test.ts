import { describe, expect, it, vi } from 'vitest';
import { DraftSession } from './draftSession';
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => resolve = r); return { promise, resolve }; }
function setup() {
  const files = new Map<string, string>(); let id = 0;
  const storage = { create: vi.fn(async (text: string) => { const path = `draft-${++id}`; files.set(path, text); return path; }), update: vi.fn(async (path: string, text: string) => { files.set(path, text); }), recover: vi.fn() };
  return { files, storage, session: new DraftSession(storage) };
}
describe('document lifecycle', () => {
  it('keeps one file when typing during an in-flight first save', async () => {
    const { session, storage } = setup(); const created = deferred<string>(); storage.create.mockImplementationOnce(() => created.promise);
    session.edit('first phrase'); const first = session.flush(); await Promise.resolve();
    session.edit('first phrase, then more'); const second = session.flush(); created.resolve('draft-1'); await Promise.all([first, second]);
    expect(storage.create).toHaveBeenCalledTimes(1); expect(storage.update).toHaveBeenCalledWith('draft-1', 'first phrase, then more'); expect(session.getSnapshot().status).toBe('saved');
  });
  it('leaves the old document in the room when saving before a switch fails', async () => {
    const { session, storage } = setup(); session.edit('words worth keeping'); storage.create.mockRejectedValueOnce(new Error('Disk full'));
    await expect(session.transact(async () => session.replace('another draft', 'other'))).rejects.toThrow('Disk full');
    expect(session.getSnapshot()).toMatchObject({ text: 'words worth keeping', path: null, locked: false, status: 'error' });
    await session.flush(); expect(session.getSnapshot().status).toBe('saved');
  });
  it('finishes the previous save before attaching another draft', async () => {
    const { session, storage } = setup(); const created = deferred<string>(); storage.create.mockImplementationOnce(() => created.promise);
    session.edit('old thought'); const pending = session.flush(); await Promise.resolve();
    const switching = session.transact(async () => session.replace('new thought', 'new-path'));
    created.resolve('old-path'); await Promise.all([pending, switching]);
    expect(storage.update).not.toHaveBeenCalled(); expect(session.getSnapshot()).toMatchObject({ text: 'new thought', path: 'new-path' });
  });
  it('records every edit for recovery before the debounce has elapsed', () => {
    const { session, storage } = setup(); session.edit('the last keystroke'); expect(storage.recover).toHaveBeenLastCalledWith({ path: null, text: 'the last keystroke' });
  });
  it('persists intentional emptying without detaching or discarding the draft', async () => {
    const { session, files } = setup(); session.edit('a thought'); await session.flush(); const path = session.getSnapshot().path!;
    session.edit(''); await session.flush(); expect(files.get(path)).toBe(''); expect(session.getSnapshot().path).toBe(path);
  });
  it('leaves words intact and unlocks editing after a failed send', async () => {
    const { session } = setup(); session.edit('keep this'); await expect(session.transact(async () => { throw new Error('Vault unavailable'); })).rejects.toThrow();
    expect(session.getSnapshot()).toMatchObject({ text: 'keep this', locked: false }); session.edit('keep this too'); expect(session.getSnapshot().text).toBe('keep this too');
  });
  it('allows only one send at a time', async () => {
    const { session } = setup(); session.edit('once'); const sending = deferred<void>(); const first = session.transact(() => sending.promise);
    await expect(session.transact(async () => {})).rejects.toThrow('Another action'); sending.resolve(); await first;
  });
});
