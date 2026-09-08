import { useEffect, useState } from 'react';
import { invoke, listen } from '@/platform';
import type { NoteInfo } from '@/types';
import { extractNoteTitle, normalizeNoteSnippet } from '@/utils/notePresentation';
import Icon from './Icon';

export default function DraftShelf({ currentPath, onOpen, onNew, onClose }: { currentPath?: string | null; onOpen: (path: string) => Promise<void>; onNew?: () => void; onClose: () => void }) {
  const [notes, setNotes] = useState<NoteInfo[]>([]);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    const refresh = () => invoke<NoteInfo[]>('list_notes').then(n => { if (alive) { setNotes(n); setLoading(false); } }).catch(e => { if (alive) { setError(String(e)); setLoading(false); } });
    void refresh(); const off = listen('files-changed', refresh);
    return () => { alive = false; void off.then(fn => fn()); };
  }, []);
  const filtered = notes.filter(n => n.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <section className="draft-shelf">
    <header className="panel-header" data-tauri-drag-region><div><h2>Drafts</h2></div><button className="icon-button" aria-label="Close drafts" onClick={onClose}><Icon name="close"/></button></header>
    <label className="shelf-search"><Icon name="search"/><input autoFocus aria-label="Search drafts" placeholder="Find a thought…" value={query} onChange={e => setQuery(e.target.value)}/><kbd>⌘K</kbd></label>
    {error && <p role="alert" className="inline-error">{error}</p>}
    <div className="shelf-notes">{loading ? <p className="panel-empty">Finding your thoughts…</p> : filtered.length ? filtered.map(note => <button key={note.path} className="shelf-note" onClick={() => void onOpen(note.path).catch(e => setError(String(e)))}><span className="shelf-note-mark"><Icon name="riff"/></span><span className="shelf-note-text"><strong>{extractNoteTitle(note.content) || 'Untitled thought'}</strong><span>{normalizeNoteSnippet(note.content).slice(0, 150) || 'A little room for later.'}</span><small>{note.path === currentPath ? 'Writing now' : new Date(note.created).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small></span><Icon name="arrow" size={16}/></button>) : <div className="panel-empty"><Icon name="riff" size={32}/><h3>{query ? 'Nothing by that name.' : 'Room for a new thought.'}</h3><p>{query ? 'Try a word from the writing.' : 'Riffs you set aside will be waiting here.'}</p></div>}</div>
    <footer className="shelf-footer"><span>{notes.length} {notes.length === 1 ? 'unfinished thought' : 'unfinished thoughts'}</span>{onNew && <button className="text-button" onClick={onNew}><Icon name="plus" size={15}/>New riff</button>}</footer>
  </section>;
}
