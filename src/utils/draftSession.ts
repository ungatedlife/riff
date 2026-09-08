export type SaveStatus = 'empty' | 'waiting' | 'saving' | 'saved' | 'error';
export interface DraftSnapshot { id: number; path: string | null; text: string; status: SaveStatus; error: string | null; locked: boolean }
export interface DraftStorage {
  create(text: string): Promise<string>;
  update(path: string, text: string): Promise<void>;
  recover(value: { path: string | null; text: string }): void;
}

/** One owner for the active document. Every transition waits for its writes. */
export class DraftSession {
  private value: DraftSnapshot;
  private listeners = new Set<() => void>();
  private chain: Promise<void> = Promise.resolve();
  private savedText: string | null = null;
  constructor(private storage: DraftStorage, initial = { path: null as string | null, text: '' }) {
    this.value = { ...initial, id: 0, status: initial.text ? 'waiting' : 'empty', error: null, locked: false };
  }
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(next: Partial<DraftSnapshot>) { this.value = { ...this.value, ...next }; this.listeners.forEach(fn => fn()); }
  private recover() { this.storage.recover({ path: this.value.path, text: this.value.text }); }
  edit = (text: string) => {
    if (this.value.locked) return;
    this.patch({ text, status: 'waiting', error: null });
    try { this.recover(); } catch { this.patch({ status: 'error', error: 'Recovery storage is full. Keep this window open until the draft saves.' }); }
  };
  flush = (): Promise<void> => {
    const run = async () => {
      const { text, path } = this.value;
      if (text === this.savedText) return;
      if (!text.trim() && !path) { this.patch({ status: 'empty' }); return; }
      this.patch({ status: 'saving', error: null });
      try {
        if (path) await this.storage.update(path, text);
        else {
          const newPath = await this.storage.create(text);
          this.patch({ path: newPath });
        }
        this.savedText = text;
        this.recover();
        this.patch({ status: this.value.text === text ? 'saved' : 'waiting' });
      } catch (error) {
        this.patch({ status: 'error', error: `Couldn't save. ${String(error)}` });
        throw error;
      }
    };
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  };
  transact = async <T>(work: () => Promise<T>): Promise<T> => {
    if (this.value.locked) throw new Error('Another action is finishing.');
    this.patch({ locked: true });
    try { await this.flush(); return await work(); }
    finally { this.patch({ locked: false }); }
  };
  replace = (text: string, path: string | null = null) => {
    // Called within a transaction, after the previous document is safely saved.
    this.savedText = path ? text : null;
    this.patch({ id: this.value.id + 1, text, path, error: null, status: path ? 'saved' : text ? 'waiting' : 'empty' });
    this.recover();
  };
}
