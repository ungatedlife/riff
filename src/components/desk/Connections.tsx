import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@/platform';
import type { Connections as Conn, Vocabulary } from '@/types';
import Icon from './Icon';

/**
 * The chip row: what this piece connects to. Three quiet adders —
 * conversation, topic, and the note it builds on — each opening a small
 * picker fed by the vault itself, so the vocabulary never drifts. ⌘1 ⌘2 ⌘3
 * open the three pickers from the keyboard.
 */
type Group = 'conversations' | 'topics' | 'links';
const GROUPS: Group[] = ['conversations', 'topics', 'links'];
type Option = { name: string; hint?: string; hub?: boolean; fresh?: boolean };

const linkName = (link: string) => link.replace(/^\[\[/, '').replace(/\]\]$/, '');

export default function Connections({ value, onChange, linkLabel, open, onOpenHandled, onDone }: {
  value: Conn;
  onChange: (next: Conn) => void;
  /** "sparked by" for a spark, "riffs on" for a riff. */
  linkLabel: string;
  /** Bump to open a picker from outside (⌘1/2/3). */
  open?: { group: Group; n: number } | null;
  onOpenHandled?: () => void;
  /** Called when a picker closes, so the editor can take focus back. */
  onDone?: () => void;
}) {
  const [picker, setPicker] = useState<Group | null>(null);
  const [vocab, setVocab] = useState<Vocabulary>({ conversations: [], topics: [] });
  const refresh = useCallback(() => { void invoke<Vocabulary>('vault_vocabulary').then(setVocab).catch(() => {}); }, []);
  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!open) return;
    refresh(); setPicker(open.group); onOpenHandled?.();
  }, [open, onOpenHandled, refresh]);

  const remove = (group: Group, item: string) => onChange({ ...value, [group]: value[group].filter(v => v !== item) });
  const add = (group: Group, item: string) => {
    const clean = group === 'links' ? `[[${linkName(item.trim())}]]` : item.trim().replace(/^#/, '');
    if (!clean || clean === '[[]]') return;
    if (value[group].some(v => v.toLowerCase() === clean.toLowerCase())) return;
    onChange({ ...value, [group]: [...value[group], clean] });
  };
  const close = () => { setPicker(null); onDone?.(); };
  const labels: Record<Group, string> = { conversations: 'conversation', topics: 'topic', links: linkLabel };
  const keys: Record<Group, string> = { conversations: '⌘1', topics: '⌘2', links: '⌘3' };

  return <div className="connections" role="group" aria-label="Connections">
    {GROUPS.map(group => <span key={group} className={`connection-group is-${group}`}>
      {value[group].map(item => <span key={item} className="chip">
        {group === 'topics' && <i>#</i>}{group === 'links' ? linkName(item) : item}
        <button aria-label={`Remove ${group === 'links' ? linkName(item) : item}`} onClick={() => remove(group, item)}><Icon name="close" size={10}/></button>
      </span>)}
      <span className="chip-adder-wrap">
        <button className={`chip-adder ${value[group].length ? 'is-compact' : ''}`} aria-expanded={picker === group} title={`${labels[group]} · ${keys[group]}`} onClick={() => { refresh(); setPicker(p => p === group ? null : group); }}>
          <Icon name="plus" size={11}/>{!value[group].length && <span>{labels[group]}</span>}
        </button>
        {picker === group && <Picker group={group} label={labels[group]} vocab={vocab} chosen={value[group]} onPick={item => { add(group, item); if (group === 'links') close(); }} onClose={close}/>}
      </span>
    </span>)}
  </div>;
}

function Picker({ group, label, vocab, chosen, onPick, onClose }: { group: Group; label: string; vocab: Vocabulary; chosen: string[]; onPick: (item: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [links, setLinks] = useState<Option[]>([]);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    if (group !== 'links') return;
    let alive = true;
    void invoke<{ name: string }[]>('search_vault_links', { query }).then(r => { if (alive) setLinks(r.map(l => ({ name: l.name }))); }).catch(() => {});
    return () => { alive = false; };
  }, [group, query]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  const q = query.trim().toLowerCase();
  const taken = new Set(chosen.map(c => linkName(c).toLowerCase()));
  let options: Option[];
  if (group === 'links') options = links.filter(o => !taken.has(o.name.toLowerCase()));
  else {
    const source = group === 'conversations' ? vocab.conversations : vocab.topics;
    options = source.filter(o => !taken.has(o.name.toLowerCase()) && (!q || o.name.toLowerCase().includes(q))).map(o => ({ name: o.name, hint: o.count ? String(o.count) : '', hub: o.hub }));
    if (q && !source.some(o => o.name.toLowerCase() === q)) options.push({ name: query.trim(), fresh: true });
  }
  options = options.slice(0, 9);
  const current = Math.min(active, Math.max(options.length - 1, 0));

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, options.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); const pick = options[current]; if (pick) { onPick(pick.name); setQuery(''); setActive(0); } }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    else if (e.key === 'Tab') { onClose(); }
  };
  return <div ref={box} className="picker" role="dialog" aria-label={`Add ${label}`}>
    <input ref={input} className="picker-input" value={query} placeholder={group === 'links' ? 'a note in the vault…' : `${label}…`} onChange={e => { setQuery(e.target.value); setActive(0); }} onKeyDown={onKey} aria-label={`Search ${label}`} autoCorrect="off" autoCapitalize="off" spellCheck={false}/>
    <ul role="listbox" className="picker-list">
      {options.length ? options.map((o, i) => <li key={o.name} role="option" aria-selected={i === current} className={`picker-option ${i === current ? 'is-active' : ''} ${o.fresh ? 'is-fresh' : ''}`} onMouseEnter={() => setActive(i)} onMouseDown={e => { e.preventDefault(); onPick(o.name); setQuery(''); }}>
        <span>{o.hub && <i className="hub-dot" aria-label="conversation page"/>}{o.name}</span>
        <small>{o.fresh ? 'new' : o.hint}</small>
      </li>) : <li className="picker-empty">{group === 'links' ? (q ? 'Nothing by that name.' : 'Type to search the vault.') : 'Nothing yet.'}</li>}
    </ul>
  </div>;
}
