import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { completionStatus } from '@codemirror/autocomplete';
import { invoke, listen, convertFileSrc, isNative } from '@/platform';
import { open } from '@tauri-apps/plugin-shell';
import Editor, { type EditorRef } from '../Editor';
import { DraftSession } from '@/utils/draftSession';
import { countWords } from '@/utils/wordCount';
import { isMarkdownEffectivelyEmpty, normalizeMarkdownForCopy } from '@/utils/normalizeMarkdownForCopy';
import { resolveImagePaths, unresolveImagePaths } from '@/utils/imageMarkdownPaths';
import { SYSTEM_SHORTCUT_DEFAULTS } from '@/utils/systemShortcuts';
import { eventMatchesShortcut } from '@/utils/shortcutMatch';
import { loadCustomFont } from '@/utils/fonts';
import { attachQuote, detachQuote } from '@/utils/quote';
import { EMPTY_CONNECTIONS, type Connections as Conn, type DeskKind, type Quote, type RiffSettings, type SitePublishEvent } from '@/types';
import Paper from './Paper';
import Sheet from './Sheet';
import Preferences from './Preferences';
import DraftShelf from './DraftShelf';
import Connections from './Connections';
import AttachedQuote from './AttachedQuote';

const initialSettings: RiffSettings = { theme_mode: '', active_theme: '', font_size: 21, text_direction: 'auto', hide_dock_icon: true, hide_tray_icon: false, launch_at_login: true, custom_themes: [], system_shortcuts: SYSTEM_SHORTCUT_DEFAULTS };

/** Each door keeps its own recovery record and its own scratch on disk. */
function createSession(kind: DeskKind) {
  const key = `riff:desk:${kind}`;
  let recovered = { path: null as string | null, text: '' };
  try { const raw = localStorage.getItem(key); if (raw) { const parsed = JSON.parse(raw); if (typeof parsed.text === 'string') recovered = { text: parsed.text, path: typeof parsed.path === 'string' ? parsed.path : null }; } } catch { /* Disk drafts remain reachable from the shelf. */ }
  const scratch = kind === 'quickie' ? 'save_quickie_draft' : kind === 'spark' ? 'save_spark_draft' : null;
  return new DraftSession({
    create: async text => (await invoke<{ path: string }>(scratch ?? 'save_note', { content: text })).path,
    update: async (path, text) => { await invoke(scratch ?? 'update_note', { path, content: text, preserveEmpty: true }); },
    recover: value => localStorage.setItem(key, JSON.stringify(value)),
  }, recovered);
}

function loadLocalConnections(kind: DeskKind): Conn {
  try { const raw = localStorage.getItem(`riff:desk:${kind}:connections`); if (raw) return { ...EMPTY_CONNECTIONS, ...JSON.parse(raw) }; } catch { /* fresh */ }
  return EMPTY_CONNECTIONS;
}

type Completion = { title: string; path: string; text: string; words: number; status?: string; skipped?: string | null };
type PickerOpen = { group: 'conversations' | 'topics' | 'links'; n: number } | null;

const DATE = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric' });

export default function CaptureDesk({ kind, onDismiss }: { kind: DeskKind; onDismiss?: () => void }) {
  const isRiff = kind === 'riff';
  const [session] = useState(() => createSession(kind));
  const draft = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const editor = useRef<EditorRef>(null);
  const [settings, setSettings] = useState(initialSettings);
  const [ready, setReady] = useState(false);
  const [panel, setPanel] = useState<'settings' | 'drafts' | 'quickie' | 'spark' | null>(null);
  const [sparkSeed, setSparkSeed] = useState('');
  const [focus, setFocus] = useState(() => { try { return isRiff && localStorage.getItem('riff:zen-mode') === '1'; } catch { return false; } });
  const [format, setFormat] = useState(false);
  const [message, setMessage] = useState('');
  const [complete, setComplete] = useState<Completion | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [settingsTab, setSettingsTab] = useState('Writing');
  const [conn, setConn] = useState<Conn>(() => (isRiff ? EMPTY_CONNECTIONS : loadLocalConnections(kind)));
  const [pickerOpen, setPickerOpen] = useState<PickerOpen>(null);
  const [site, setSite] = useState<SitePublishEvent | null>(null);
  const [savedFlash, setSavedFlash] = useState(false);
  const cursorReady = useRef(false);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connLoadedFor = useRef<string | null>(null);
  const empty = isMarkdownEffectivelyEmpty(draft.text);
  const words = countWords(draft.text);
  const shortcuts = { ...SYSTEM_SHORTCUT_DEFAULTS, ...settings.system_shortcuts };
  const notify = useCallback((e: unknown) => setMessage(String(e)), []);
  const dismiss = useCallback(async () => {
    if (onDismiss) onDismiss();
    else if (isNative) await invoke('hide_window');
  }, [onDismiss]);

  // ---- boot: settings, scratch recovery ----
  useEffect(() => {
    const boot = async () => {
      setSettings(await invoke<RiffSettings>('get_settings'));
      if (!isRiff && !session.getSnapshot().text) {
        const text = await invoke<string>(kind === 'spark' ? 'get_spark_draft' : 'get_quickie_draft');
        if (text) session.replace(text);
      }
    };
    void boot().catch(notify).finally(() => setReady(true));
    const off = listen<RiffSettings>('settings-changed', e => setSettings(e.payload));
    return () => { void off.then(fn => fn()); };
  }, [notify, kind, isRiff, session]);

  // ---- autosave ----
  useEffect(() => {
    if (!ready || draft.locked || draft.status !== 'waiting') return;
    const timer = setTimeout(() => void session.flush().catch(() => {}), 500);
    return () => clearTimeout(timer);
  }, [draft.text, draft.status, draft.locked, ready, session]);
  useEffect(() => {
    if (draft.status !== 'saved' || empty) return;
    setSavedFlash(true);
    const timer = setTimeout(() => setSavedFlash(false), 1400);
    return () => clearTimeout(timer);
  }, [draft.status, draft.text, empty]);
  useEffect(() => {
    const onBlur = () => { void session.flush().catch(() => {}); };
    window.addEventListener('blur', onBlur);
    const off = listen('flush-drafts', async () => {
      try { await session.flush(); } finally { if (isRiff) await invoke('flush_complete'); }
    });
    return () => { window.removeEventListener('blur', onBlur); void off.then(fn => fn()); };
  }, [session, isRiff]);

  // ---- connections: a riff's ride in a sidecar keyed by its draft; the small doors keep theirs locally ----
  useEffect(() => {
    if (isRiff) return;
    try { localStorage.setItem(`riff:desk:${kind}:connections`, JSON.stringify(conn)); } catch { /* fine */ }
  }, [conn, kind, isRiff]);
  useEffect(() => {
    if (!isRiff || !draft.path || connLoadedFor.current === draft.path) return;
    const path = draft.path;
    connLoadedFor.current = path;
    void invoke<Conn | null>('get_connections', { id: path }).then(saved => { if (saved) setConn({ ...EMPTY_CONNECTIONS, ...saved }); }).catch(() => {});
  }, [draft.path, isRiff]);
  useEffect(() => {
    if (!isRiff || !draft.path || connLoadedFor.current !== draft.path) return;
    const path = draft.path;
    const timer = setTimeout(() => { void invoke('save_connections', { id: path, connections: conn }).catch(() => {}); }, 300);
    return () => clearTimeout(timer);
  }, [conn, draft.path, isRiff]);
  useEffect(() => {
    if (!isRiff) return;
    const off = listen<SitePublishEvent>('site-publish', e => setSite(e.payload));
    return () => { void off.then(fn => fn()); };
  }, [isRiff]);

  // ---- focus & the small doors' auto-dismiss after a send ----
  useEffect(() => {
    if (!ready || panel || complete || pickerOpen) return;
    const timer = setTimeout(() => editor.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [ready, draft.id, panel, complete, focus, pickerOpen]);
  useEffect(() => {
    if (isRiff || !complete) return;
    const timer = setTimeout(() => { setComplete(null); void dismiss(); }, complete.skipped && kind === 'spark' ? 2600 : 900);
    return () => clearTimeout(timer);
  }, [isRiff, kind, complete, dismiss]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    const custom = settings.custom_fonts?.find(f => f.name === settings.font_family);
    if (custom) void loadCustomFont(custom.name, custom.path);
  }, [settings.font_family, settings.custom_fonts]);
  useEffect(() => { if (isRiff) { try { localStorage.setItem('riff:zen-mode', focus ? '1' : '0'); } catch { /* fine */ } } }, [focus, isRiff]);

  // ---- window events ----
  const openDraft = useCallback(async (path: string) => {
    if (path === session.getSnapshot().path) { setPanel(null); return; }
    await session.transact(async () => {
      const text = await invoke<string>('get_note_content', { path });
      setConn(EMPTY_CONNECTIONS); connLoadedFor.current = null;
      session.replace(text, path);
      setComplete(null); setPanel(null);
    });
  }, [session]);
  useEffect(() => {
    if (kind === 'spark') {
      const off = listen<{ text: string }>('spark-prefill', e => { const text = e.payload?.text ?? ''; if (text) { session.replace(text); setComplete(null); } });
      return () => { void off.then(fn => fn()); };
    }
    if (!isRiff) return;
    const off = listen<{ path: string }>('open-draft', e => { void openDraft(e.payload.path).catch(notify); });
    const settingsOff = listen('show-settings', () => setPanel('settings'));
    const draftsOff = listen('show-drafts', () => setPanel('drafts'));
    const quickieOff = listen('show-quickie', () => setPanel('quickie'));
    const sparkOff = listen<{ text?: string }>('show-spark', e => { setSparkSeed(e.payload?.text ?? ''); setPanel('spark'); });
    return () => { for (const promise of [off, settingsOff, draftsOff, quickieOff, sparkOff]) void promise.then(fn => fn()); };
  }, [kind, isRiff, openDraft, notify, session]);

  // ---- actions ----
  const fresh = useCallback(async (start: Conn = EMPTY_CONNECTIONS) => {
    try { await session.transact(async () => session.replace('')); setConn(start); connLoadedFor.current = null; setComplete(null); setPanel(null); setMessage(''); setSite(null); }
    catch (e) { notify(e); }
  }, [session, notify]);
  const park = useCallback(async () => {
    try { await session.transact(dismiss); if (!isNative && !onDismiss) setMessage('Saved. It will be here when you return.'); }
    catch (e) { notify(e); }
  }, [session, dismiss, onDismiss, notify]);
  const needsHome = () => {
    if (!isNative) return false;
    if (kind === 'quickie') return !(settings.quickies_file || settings.vault_dir);
    return !settings.vault_dir;
  };
  const send = useCallback(async () => {
    if (session.getSnapshot().locked || isMarkdownEffectivelyEmpty(session.getSnapshot().text)) return;
    if (needsHome()) { setSettingsTab('Files'); setPanel('settings'); setMessage('Choose where this should land.'); return; }
    setPublishing(true); setSite(null);
    try {
      await session.transact(async () => {
        const { text, path } = session.getSnapshot();
        if (kind === 'quickie') {
          const result = await invoke<{ file_path: string }>('append_quickie', { content: text });
          await invoke('save_quickie_draft', { content: '' }).catch(() => setMessage('Caught. A spare copy remains in quickie recovery.'));
          session.replace('');
          setComplete({ title: 'Caught.', path: result.file_path, text, words: countWords(text) });
        } else if (kind === 'spark') {
          const result = await invoke<{ name: string; vault_path: string; site_publish_skipped: string | null }>('publish_spark', { text, connections: { ...conn, ship: true } });
          await invoke('save_spark_draft', { content: '' }).catch(() => {});
          session.replace(''); setConn(EMPTY_CONNECTIONS);
          setComplete({ title: result.name, path: result.vault_path, text, words: countWords(text), status: 'shipped', skipped: result.site_publish_skipped });
        } else {
          if (!path) throw new Error('The draft needs to save before it can leave the room.');
          const result = await invoke<{ title: string; vault_path: string; status: string; site_publish_skipped: string | null }>('publish_riff', { path, connections: conn });
          session.replace(''); setConn(EMPTY_CONNECTIONS); connLoadedFor.current = null;
          setComplete({ title: result.title, path: result.vault_path, text, words: countWords(text), status: result.status, skipped: result.site_publish_skipped });
        }
      });
    } catch (e) { notify(e); }
    finally { setPublishing(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, kind, conn, settings.quickies_file, settings.vault_dir, notify]);
  // ---- a passage handed over by another app (Trove opens `riff://spark?handoff=…`) ----
  // The quote never goes into the editor. A spark takes it on beside whatever
  // is in its window now. A riff starts a fresh draft first (the one in the
  // room is saved and waits on the shelf), so the quote lands on a clean page.
  const takeHandoff = useCallback(async () => {
    const quote = await invoke<Quote | null>('take_handoff', { door: kind });
    if (!quote) return;
    if (isRiff) await fresh(attachQuote(EMPTY_CONNECTIONS, quote));
    else { setConn(c => attachQuote(c, quote)); setComplete(null); }
  }, [kind, isRiff, fresh]);
  useEffect(() => {
    if (kind === 'quickie' || !ready) return;
    // Ask once as soon as this window can hear the event: when the URL is
    // what launched Riff, the event went out before anything was listening.
    const off = listen('handoff', () => { void takeHandoff().catch(notify); });
    void off.then(() => takeHandoff()).catch(notify);
    return () => { void off.then(fn => fn()); };
  }, [kind, ready, takeHandoff, notify]);

  /** A quickie that turns out to be a riff, or a spark. */
  const handOff = useCallback(async (to: 'riff' | 'spark') => {
    try {
      await session.transact(async () => {
        const { text } = session.getSnapshot();
        if (!text.trim()) return;
        if (to === 'riff') {
          const { path } = await invoke<{ path: string }>('save_note', { content: text });
          await invoke('open_draft', { path });
        } else {
          await invoke('open_spark', { text });
        }
        await invoke('save_quickie_draft', { content: '' });
        session.replace('');
        await dismiss();
      });
    } catch (e) { notify(e); }
  }, [session, dismiss, notify]);
  const copy = useCallback(async () => {
    try {
      const text = complete?.text || session.getSnapshot().text;
      await navigator.clipboard.writeText(normalizeMarkdownForCopy(text));
      setMessage('Copied as Markdown.');
    } catch (e) { notify(e); }
  }, [complete, session, notify]);

  // ---- keys ----
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || panel || document.querySelector('dialog[open]')) return;
      const mod = e.metaKey || e.ctrlKey;
      const inPicker = (e.target as HTMLElement)?.closest('.picker');
      if (e.key === 'Escape') {
        if (inPicker) return;
        const view = editor.current?.getView();
        if (view && ['active', 'pending'].includes(completionStatus(view.state) || '')) return;
        if ((e.target as HTMLElement)?.closest('.link-popover')) return;
        e.preventDefault(); if (complete) { setComplete(null); void dismiss(); } else void park();
      } else if (mod && e.key === ',') { e.preventDefault(); setPanel('settings'); }
      else if (mod && !e.shiftKey && !e.altKey && ['1', '2', '3'].includes(e.key) && !complete) {
        e.preventDefault();
        setPickerOpen(p => ({ group: (['conversations', 'topics', 'links'] as const)[Number(e.key) - 1], n: (p?.n ?? 0) + 1 }));
      }
      else if (isRiff && eventMatchesShortcut(e, shortcuts.zen_mode)) { e.preventDefault(); setFocus(v => !v); }
      else if (isRiff && (eventMatchesShortcut(e, shortcuts.search) || (mod && e.key.toLowerCase() === 'k'))) { e.preventDefault(); setPanel('drafts'); }
      else if (isRiff && eventMatchesShortcut(e, shortcuts.last_note)) { e.preventDefault(); void invoke('reopen_last_note').catch(notify); }
      else if (isRiff && mod && e.key.toLowerCase() === 'n') { e.preventDefault(); void fresh(); }
      else if (mod && e.key === 'Enter' && complete && isRiff) { e.preventDefault(); void fresh(); }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [panel, shortcuts.zen_mode, shortcuts.search, shortcuts.last_note, isRiff, complete, park, dismiss, fresh, notify]);

  // ---- cursor memory (riff only) ----
  useEffect(() => {
    cursorReady.current = false;
    let active = true;
    if (!ready) return;
    const restore = async () => {
      if (draft.path && isRiff) {
        const position = await invoke<{ head: number; anchor: number } | null>('get_cursor_position', { id: draft.path });
        if (active && position) editor.current?.setCursor(position.head, position.anchor);
      }
    };
    void restore().catch(() => {}).finally(() => { if (active) cursorReady.current = true; });
    return () => { active = false; if (cursorTimer.current) clearTimeout(cursorTimer.current); };
  }, [draft.id, draft.path, ready, isRiff]);
  const saveCursor = useCallback((head: number, anchor: number) => {
    if (!draft.path || !isRiff || !cursorReady.current) return;
    if (cursorTimer.current) clearTimeout(cursorTimer.current);
    const id = draft.path;
    cursorTimer.current = setTimeout(() => { void invoke('save_cursor_position', { id, head, anchor }).catch(() => {}); }, 400);
  }, [draft.path, isRiff]);

  // ---- images ----
  const imagePaste = useCallback(async (file: File) => {
    try {
      const imageData = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
      if (!isNative) return imageData;
      const [path] = await invoke<[string, string]>('save_note_image', { imageData }); return convertFileSrc(path);
    } catch (e) { notify(e); return null; }
  }, [notify]);
  const imageDrop = useCallback(async (filePath: string) => {
    try { const [path] = await invoke<[string, string]>('save_note_image_from_path', { filePath }); return convertFileSrc(path); }
    catch (e) { notify(e); return null; }
  }, [notify]);

  // ---- render ----
  const storedText = draft.path && isNative && isRiff ? resolveImagePaths(draft.text, draft.path.slice(0, draft.path.lastIndexOf('/')), convertFileSrc) : draft.text;
  const fontSize = kind === 'riff' ? settings.font_size : kind === 'spark' ? Math.min(settings.font_size, 19) : Math.min(settings.font_size, 17);
  const home = kind === 'quickie' ? settings.quickies_file?.split('/').pop() || 'Quickies.md' : kind === 'spark' ? (settings.sparks_dir?.split('/').pop() || 'Sparks') : settings.vault_dir?.split('/').pop();
  const verb = kind === 'quickie' ? 'Save' : kind === 'spark' ? 'Spark' : conn.ship ? 'Ship' : 'Send';
  const status = draft.error ? 'Couldn’t save' : draft.status === 'saving' || draft.status === 'waiting' ? 'saving' : savedFlash ? 'saved' : '';
  const siteLine = site ? (site.phase === 'done' ? `Live. ${site.detail}` : site.phase === 'failed' ? `The site didn’t publish: ${site.detail}` : site.phase === 'queued' ? 'Publishing after the one in flight.' : 'Publishing to the site…') : '';
  const placeholder = kind === 'quickie' ? 'A thought for later…' : kind === 'spark' ? 'What just struck you?' : 'Begin anywhere…';
  // The attached passage: above the page for a riff, under it for a spark
  // (his words, then the quote, like a quote tweet). Removing it also
  // removes the link it brought.
  const quoted = kind !== 'quickie' && conn.quote ? <AttachedQuote quote={conn.quote} onRemove={() => { setConn(detachQuote); editor.current?.focus(); }}/> : null;
  const sendButton = <button className="send" disabled={empty || draft.locked || !ready || publishing} onClick={() => void send()}>{publishing ? 'Sending…' : verb}<kbd>⌘↵</kbd></button>;

  return <main className={`desk desk-${kind} ${focus ? 'is-focus' : ''} ${!empty ? 'has-writing' : ''} ${complete ? 'is-done' : ''} ${quoted ? 'has-quote' : ''}`} style={{ '--editor-font-size': `${fontSize}px`, '--editor-font-family': settings.font_family ? `"${settings.font_family}", "iA Writer Duo S", monospace` : '"iA Writer Duo S", monospace' } as React.CSSProperties}>
    <Paper/>
    <header className="desk-top" data-tauri-drag-region>
      <span className="eyebrow" data-tauri-drag-region>{kind}<i>·</i>{DATE.format(new Date())}{isRiff && draft.path && !complete && <><i>·</i>{conn.ship ? 'live' : 'draft'}</>}</span>
      <span className="desk-top-actions">
        {isRiff && !complete && <>
          <button className="quiet" aria-pressed={format} onClick={() => setFormat(v => !v)} title="Formatting">Aa</button>
          <button className="quiet" onClick={() => setPanel('drafts')} title="Drafts · ⌘K">drafts<kbd>⌘K</kbd></button>
        </>}
        {!isRiff && <button className="quiet" onClick={() => void park()} title="Set aside · esc">esc</button>}
      </span>
    </header>

    {complete ? <section className="done" role="status">
      <p className="eyebrow">{kind === 'quickie' ? 'caught' : kind === 'spark' ? 'sparked' : isNative ? 'in the vault' : 'saved in the preview'}</p>
      <h1>{kind === 'quickie' ? home : complete.title}</h1>
      {kind === 'riff' && <p className="done-line">{complete.words} words{complete.status === 'draft' ? ' · kept as a draft' : siteLine ? ` · ${siteLine}` : complete.skipped ? ` · ${complete.skipped}` : ' · shipped'}</p>}
      {kind === 'spark' && complete.skipped && <p className="done-line">{complete.skipped}</p>}
      {isRiff && <div className="done-actions">
        <button className="quiet" onClick={() => void fresh()}>Another<kbd>⌘↵</kbd></button>
        {isNative && <button className="quiet" onClick={() => void open(`obsidian://open?path=${encodeURIComponent(complete.path)}`).catch(notify)}>Open in Obsidian</button>}
        <button className="quiet" onClick={() => void copy()}>Copy</button>
        <button className="quiet" onClick={() => { setComplete(null); void dismiss(); }}>Close<kbd>esc</kbd></button>
      </div>}
    </section> : <>
      {isRiff && quoted}
      <section className="desk-page" aria-label={kind === 'riff' ? 'Writing room' : `${kind} capture`}>
        {ready && <Editor key={draft.id} ref={editor} initialContent={storedText} onChange={text => session.edit(unresolveImagePaths(text))} readOnly={draft.locked} placeholder={placeholder} showFormatToolbar={isRiff && format && !focus} textDirection={settings.text_direction as 'auto' | 'ltr' | 'rtl'} forgedCaret onPublish={() => void send()} onImagePaste={isRiff ? imagePaste : undefined} onImageDropPath={isRiff ? imageDrop : undefined} onCursorChange={saveCursor}/>}
      </section>
      {kind === 'spark' && quoted}
      <footer className="desk-bottom">
        {kind !== 'quickie' && <Connections value={conn} onChange={setConn} linkLabel={kind === 'spark' ? 'sparked by' : 'riffs on'} open={pickerOpen} onOpenHandled={() => setPickerOpen(null)} onDone={() => editor.current?.focus()}/>}
        {kind === 'quickie' && <span className="handoff">
          <button className="quiet" disabled={empty || draft.locked} onClick={() => void handOff('spark')}>make it a spark</button>
          <button className="quiet" disabled={empty || draft.locked} onClick={() => void handOff('riff')}>keep going in riff</button>
        </span>}
        <span className="desk-meta">
          <span className={`save-state is-${draft.error ? 'error' : status}`} role="status">{status}</span>
          {isRiff && !empty && <span className="words">{words} {words === 1 ? 'word' : 'words'}</span>}
          {isRiff && <button className="quiet ship-toggle" aria-pressed={conn.ship} title={conn.ship ? 'Ships live. Click to keep it a draft.' : 'Stays a vault draft. Click to ship.'} onClick={() => setConn(c => ({ ...c, ship: !c.ship }))}>{conn.ship ? 'live' : 'draft'}</button>}
          {!isRiff && <span className="home" title={home}>→ {home}</span>}
          {sendButton}
        </span>
      </footer>
    </>}

    {(draft.error || message) && <div className={`desk-message ${draft.error ? 'is-error' : ''}`} role={draft.error ? 'alert' : 'status'}>{draft.error || message}{draft.error && <button className="quiet" onClick={() => void session.flush().catch(() => {})}>Try saving again</button>}</div>}
    {panel === 'settings' && <Sheet label="Settings" onClose={() => setPanel(null)}><Preferences initialTab={settingsTab} onClose={() => setPanel(null)}/></Sheet>}
    {panel === 'drafts' && <Sheet label="Drafts" onClose={() => setPanel(null)}><DraftShelf currentPath={draft.path} onOpen={openDraft} onNew={() => void fresh()} onClose={() => setPanel(null)}/></Sheet>}
    {panel === 'quickie' && <Sheet label="Quickie" className="door-sheet" onClose={() => setPanel(null)}><CaptureDesk kind="quickie" onDismiss={() => setPanel(null)}/></Sheet>}
    {panel === 'spark' && <Sheet label="Spark" className="door-sheet" onClose={() => setPanel(null)}><SparkInSheet seed={sparkSeed} onDismiss={() => setPanel(null)}/></Sheet>}
  </main>;
}

/** Browser preview only: the spark door inside the room, pre-filled from a quickie. */
function SparkInSheet({ seed, onDismiss }: { seed: string; onDismiss: () => void }) {
  useEffect(() => { if (seed) { try { localStorage.setItem('riff:desk:spark', JSON.stringify({ path: null, text: seed })); } catch { /* fine */ } } }, [seed]);
  return <CaptureDesk kind="spark" onDismiss={onDismiss}/>;
}
