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
import { formatShortcutDisplay } from '../ShortcutRecorder';
import { loadCustomFont } from '@/utils/fonts';
import type { RiffSettings } from '@/types';
import Icon from './Icon';
import Paper from './Paper';
import Sheet from './Sheet';
import Preferences from './Preferences';
import DraftShelf from './DraftShelf';

const initialSettings: RiffSettings = { theme_mode: '', active_theme: '', font_size: 21, text_direction: 'auto', hide_dock_icon: true, hide_tray_icon: false, launch_at_login: true, custom_themes: [], system_shortcuts: SYSTEM_SHORTCUT_DEFAULTS };
function createSession(quick: boolean) {
  const key = quick ? 'riff:desk:quickie' : 'riff:desk:riff';
  let recovered = { path: null as string | null, text: '' };
  try { const raw = localStorage.getItem(key); if (raw) { const parsed = JSON.parse(raw); if (typeof parsed.text === 'string') recovered = { text: parsed.text, path: typeof parsed.path === 'string' ? parsed.path : null }; } } catch { /* Disk drafts remain accessible in the shelf. */ }
  return new DraftSession({
    create: async text => (await invoke<{ path: string }>(quick ? 'save_quickie_draft' : 'save_note', { content: text })).path,
    update: async (path, text) => { await invoke(quick ? 'save_quickie_draft' : 'update_note', { path, content: text, preserveEmpty: true }); },
    recover: value => localStorage.setItem(key, JSON.stringify(value)),
  }, recovered);
}

type Completion = { title: string; path: string; text: string; words: number };
export default function CaptureDesk({ quick = false, onDismiss }: { quick?: boolean; onDismiss?: () => void }) {
  const [session] = useState(() => createSession(quick));
  const draft = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const editor = useRef<EditorRef>(null);
  const [settings, setSettings] = useState(initialSettings);
  const [ready, setReady] = useState(false);
  const [panel, setPanel] = useState<'settings' | 'drafts' | 'quickie' | null>(null);
  const [focus, setFocus] = useState(false);
  const [format, setFormat] = useState(false);
  const [message, setMessage] = useState('');
  const [complete, setComplete] = useState<Completion | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [settingsTab, setSettingsTab] = useState('Writing');
  const [copyOpen, setCopyOpen] = useState(false);
  const [noteCount, setNoteCount] = useState(0);
  const [promptIndex, setPromptIndex] = useState(0);
  const cursorReady = useRef(false);
  const cursorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prompt = ['Follow the thought.', 'What feels alive?', 'Say the true thing.', 'Start with the messy bit.'][promptIndex];
  const empty = isMarkdownEffectivelyEmpty(draft.text);
  const words = countWords(draft.text);
  const shortcuts = { ...SYSTEM_SHORTCUT_DEFAULTS, ...settings.system_shortcuts };
  const notify = useCallback((e: unknown) => setMessage(String(e)), []);
  const dismiss = useCallback(async () => {
    if (onDismiss) onDismiss();
    else if (isNative) await invoke('hide_window');
  }, [onDismiss]);

  useEffect(() => {
    const boot = async () => {
      setSettings(await invoke<RiffSettings>('get_settings'));
      if (quick && !session.getSnapshot().text) {
        const text = await invoke<string>('get_quickie_draft');
        if (text) session.replace(text);
      }
    };
    void boot().catch(notify).finally(() => setReady(true));
    const off = listen<RiffSettings>('settings-changed', e => setSettings(e.payload));
    return () => { void off.then(fn => fn()); };
  }, [notify, quick, session]);
  useEffect(() => {
    if (!ready || draft.locked || draft.status !== 'waiting') return;
    const timer = setTimeout(() => void session.flush().catch(() => {}), 500);
    return () => clearTimeout(timer);
  }, [draft.text, draft.status, draft.locked, ready, session]);
  useEffect(() => {
    const onBlur = () => { void session.flush().catch(() => {}); };
    window.addEventListener('blur', onBlur);
    const off = listen('flush-drafts', async () => {
      try { await session.flush(); } finally { if (!quick) await invoke('flush_complete'); }
    });
    return () => { window.removeEventListener('blur', onBlur); void off.then(fn => fn()); };
  }, [session, quick]);
  useEffect(() => {
    const refresh = () => invoke<unknown[]>('list_notes').then(n => setNoteCount(n.length)).catch(() => {});
    void refresh(); const off = listen('files-changed', refresh);
    return () => { void off.then(fn => fn()); };
  }, []);
  useEffect(() => {
    if (!ready || panel || complete) return;
    const timer = setTimeout(() => editor.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, [ready, draft.id, panel, complete]);
  useEffect(() => {
    if (!quick || !complete) return;
    const timer = setTimeout(() => { setComplete(null); void dismiss(); }, 900);
    return () => clearTimeout(timer);
  }, [quick, complete, dismiss]);
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(''), 6000);
    return () => clearTimeout(timer);
  }, [message]);
  useEffect(() => {
    const custom = settings.custom_fonts?.find(f => f.name === settings.font_family);
    if (custom) void loadCustomFont(custom.name, custom.path);
  }, [settings.font_family, settings.custom_fonts]);

  const openDraft = useCallback(async (path: string) => {
    if (path === session.getSnapshot().path) { setPanel(null); return; }
    await session.transact(async () => {
      const text = await invoke<string>('get_note_content', { path });
      session.replace(text, path);
      setComplete(null); setPanel(null);
    });
  }, [session]);
  useEffect(() => {
    if (quick) return;
    const off = listen<{ path: string }>('open-draft', e => { void openDraft(e.payload.path).catch(notify); });
    const settingsOff = listen('show-settings', () => setPanel('settings'));
    const draftsOff = listen('show-drafts', () => setPanel('drafts'));
    const quickieOff = listen('show-quickie', () => setPanel('quickie'));
    return () => { for (const promise of [off, settingsOff, draftsOff, quickieOff]) void promise.then(fn => fn()); };
  }, [quick, openDraft, notify]);

  const fresh = useCallback(async () => {
    try { await session.transact(async () => session.replace('')); setComplete(null); setPanel(null); setMessage(''); }
    catch (e) { notify(e); }
  }, [session, notify]);
  const park = useCallback(async () => {
    try { await session.transact(dismiss); if (!isNative && !onDismiss) setMessage('Draft saved. It will be here when you return.'); }
    catch (e) { notify(e); }
  }, [session, dismiss, onDismiss, notify]);
  const send = useCallback(async () => {
    if (session.getSnapshot().locked || isMarkdownEffectivelyEmpty(session.getSnapshot().text)) return;
    if (isNative && !(quick ? settings.quickies_file || settings.vault_dir : settings.vault_dir)) { setSettingsTab('Files'); setPanel('settings'); setMessage('Choose where this thought should land.'); return; }
    setPublishing(true); setCopyOpen(false);
    try {
      await session.transact(async () => {
        const { text, path } = session.getSnapshot();
        if (!path) throw new Error('The draft needs to save before it can leave the room.');
        if (quick) {
          const result = await invoke<{ file_path: string }>('append_quickie', { content: text });
          // Clear the private scratch file only after the vault append succeeds.
          await invoke('save_quickie_draft', { content: '' }).catch(() => setMessage('Captured. A spare copy remains in quickie recovery.'));
          session.replace('');
          setComplete({ title: 'Thought caught.', path: result.file_path, text, words: countWords(text) });
        } else {
          const result = await invoke<{ title: string; vault_path: string }>('publish_riff', { path });
          session.replace('');
          setComplete({ title: result.title, path: result.vault_path, text, words: countWords(text) });
        }
      });
    } catch (e) { notify(e); }
    finally { setPublishing(false); }
  }, [session, quick, settings.quickies_file, settings.vault_dir, notify]);
  const deepen = useCallback(async () => {
    try {
      await session.transact(async () => {
        const { text } = session.getSnapshot();
        if (!text.trim()) return;
        const { path } = await invoke<{ path: string }>('save_note', { content: text });
        await invoke('open_draft', { path });
        await invoke('save_quickie_draft', { content: '' });
        session.replace('');
        await dismiss();
      });
    } catch (e) { notify(e); }
  }, [session, dismiss, notify]);
  const copy = useCallback(async (rich: boolean) => {
    try {
      const text = complete?.text || session.getSnapshot().text;
      if (rich && !complete) await invoke('copy_rich_text_to_clipboard', { html: editor.current?.getHTML() || '', plainText: text });
      else await navigator.clipboard.writeText(normalizeMarkdownForCopy(text));
      setMessage(rich ? 'Copied with formatting.' : 'Markdown copied. Take it somewhere.');
      setCopyOpen(false);
    } catch (e) { notify(e); }
  }, [complete, session, notify]);

  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || panel || document.querySelector('dialog[open]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') {
        if (copyOpen) { setCopyOpen(false); e.preventDefault(); return; }
        const view = editor.current?.getView();
        if (view && ['active', 'pending'].includes(completionStatus(view.state) || '')) return;
        if ((e.target as HTMLElement)?.closest('.link-popover')) return;
        e.preventDefault(); if (complete) { setComplete(null); void dismiss(); } else void park();
      } else if (mod && e.key === ',') { e.preventDefault(); setPanel('settings'); }
      else if (eventMatchesShortcut(e, shortcuts.zen_mode)) { e.preventDefault(); setFocus(v => !v); }
      else if (!quick && (eventMatchesShortcut(e, shortcuts.search) || (mod && e.key.toLowerCase() === 'k'))) { e.preventDefault(); setPanel('drafts'); }
      else if (!quick && eventMatchesShortcut(e, shortcuts.last_note)) { e.preventDefault(); void invoke('reopen_last_note').catch(notify); }
      else if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); void fresh(); }
    };
    window.addEventListener('keydown', handle);
    return () => window.removeEventListener('keydown', handle);
  }, [panel, copyOpen, shortcuts.zen_mode, shortcuts.search, shortcuts.last_note, quick, complete, park, dismiss, fresh, notify]);

  useEffect(() => {
    cursorReady.current = false;
    let active = true;
    if (!ready) return;
    const restore = async () => {
      if (draft.path && !quick) {
        const position = await invoke<{ head: number; anchor: number } | null>('get_cursor_position', { id: draft.path });
        if (active && position) editor.current?.setCursor(position.head, position.anchor);
      }
    };
    void restore().catch(() => {}).finally(() => { if (active) cursorReady.current = true; });
    return () => { active = false; if (cursorTimer.current) clearTimeout(cursorTimer.current); };
  }, [draft.id, draft.path, ready, quick]);
  const saveCursor = useCallback((head: number, anchor: number) => {
    if (!draft.path || quick || !cursorReady.current) return;
    if (cursorTimer.current) clearTimeout(cursorTimer.current);
    const id = draft.path;
    cursorTimer.current = setTimeout(() => { void invoke('save_cursor_position', { id, head, anchor }).catch(() => {}); }, 400);
  }, [draft.path, quick]);

  const imagePaste = useCallback(async (file: File) => {
    try {
      const imageData = await new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = reject; r.readAsDataURL(file); });
      if (!isNative) return imageData;
      const [path] = await invoke<[string,string]>('save_note_image', { imageData }); return convertFileSrc(path);
    } catch (e) { notify(e); return null; }
  }, [notify]);
  const imageDrop = useCallback(async (filePath: string) => {
    try { const [path] = await invoke<[string,string]>('save_note_image_from_path', { filePath }); return convertFileSrc(path); }
    catch (e) { notify(e); return null; }
  }, [notify]);
  const storedText = draft.path && isNative ? resolveImagePaths(draft.text, draft.path.slice(0, draft.path.lastIndexOf('/')), convertFileSrc) : draft.text;
  const saveText = ({ empty: 'A little room for a thought', waiting: 'Saving your thought…', saving: 'Saving your thought…', saved: isNative ? 'Draft saved on this Mac' : 'Saved in this browser', error: 'Your draft needs attention' })[draft.status];
  const destination = quick ? settings.quickies_file?.split('/').pop() || 'Quickies.md' : settings.vault_dir?.split('/').pop();
  return <main className={`capture-desk ${quick ? 'quickie-desk' : ''} ${focus ? 'focus-view' : ''} ${!empty ? 'has-writing' : ''}`} style={{ '--editor-font-size': `${quick ? Math.min(settings.font_size, 20) : settings.font_size}px`, '--editor-font-family': settings.font_family ? `"${settings.font_family}", "iA Writer Duo S", monospace` : '"iA Writer Duo S", monospace' } as React.CSSProperties}>
    <Paper/>
    {!quick ? <header className="desk-header" data-tauri-drag-region>
      <button className="wordmark" aria-label="New riff" onClick={() => void fresh()}>riff<span>✳</span></button>
      <nav className="mode-switch" aria-label="Capture mode"><button onClick={() => void invoke('open_quickie').catch(notify)}><Icon name="spark" size={16}/>quickie</button><button aria-current="page"><Icon name="riff" size={19}/>riff</button></nav>
      <div className="desk-header-actions"><button className="shelf-button" onClick={() => setPanel('drafts')} title="Unfinished thoughts · ⌘K"><Icon name="shelf"/><span>Drafts</span>{noteCount > 0 && <small>{noteCount}</small>}</button><button className="icon-button" aria-label="Settings" title="Settings · ⌘," onClick={() => setPanel('settings')}><Icon name="settings"/></button></div>
    </header> : <header className="quickie-header" data-tauri-drag-region><span className="quickie-brand"><Icon name="spark"/>quickie<span className="small-label">by riff</span></span><button className="icon-button" aria-label="Save and close quickie" onClick={() => void park()}><Icon name="close" size={16}/></button></header>}
    {complete ? <section className="completion" role="status"><div className="completion-orbit"><Icon name="check" size={34}/></div><span className="eyebrow">{isNative ? quick ? 'SAFELY SAVED' : 'SAFELY IN YOUR VAULT' : 'SAVED IN THE PREVIEW'}</span><h1>{quick ? 'Thought caught.' : 'Out of your head.\nInto the world.'}</h1>{!quick && <p className="completion-title">{complete.title}</p>}<p>{quick ? 'A little less to carry.' : `${complete.words} words. A thought with a life of its own.`}</p><div className="completion-actions"><button className="primary-button" onClick={() => void fresh()}>Another thought<Icon name="plus" size={16}/></button><button className="text-button" onClick={() => { setComplete(null); void dismiss(); }}>Done for now</button></div>{!quick && <div className="completion-links"><button className="text-button" onClick={() => void copy(false)}><Icon name="copy" size={15}/>Copy Markdown</button>{isNative && <button className="text-button" onClick={() => void open(`obsidian://open?path=${encodeURIComponent(complete.path)}`).catch(notify)}><Icon name="vault" size={15}/>Open in Obsidian</button>}</div>}{!isNative && <small>Your real vault is connected in the Mac app.</small>}</section> : <>
      {!quick && <div className="page-meta"><span className="eyebrow"><span className="ink-dot"/>DEEP CAPTURE</span><span>{new Date().toLocaleDateString(undefined, { weekday: 'short', month: 'long', day: 'numeric' })}</span></div>}
      <section className="writing-page" aria-label={quick ? 'Quick capture' : 'Writing room'}>
        {ready && <Editor key={draft.id} ref={editor} initialContent={storedText} onChange={text => session.edit(unresolveImagePaths(text))} readOnly={draft.locked} placeholder={quick ? 'Catch the little thing.' : prompt} showFormatToolbar={!quick && format && !focus} textDirection={settings.text_direction as 'auto' | 'ltr' | 'rtl'} forgedCaret onPublish={() => void send()} onImagePaste={quick ? undefined : imagePaste} onImageDropPath={quick ? undefined : imageDrop} onWikiLinkClick={(_slug, path) => void openDraft(path).catch(notify)} onCursorChange={saveCursor}/>} 
        {empty && <div className="writing-whisper">{quick ? 'A sentence, a spark, something for later.' : 'A fragment is a perfectly good beginning.'}</div>}
      </section>
      {!quick && <div className="page-tools"><button className="text-button" onClick={() => void park()} disabled={draft.locked}>Set aside<kbd>esc</kbd></button><div className="page-tools-right"><button className="icon-button type-button" aria-label="Formatting tools" aria-pressed={format} onClick={() => setFormat(v => !v)}>Aa</button><button className="icon-button" aria-label={focus ? 'Leave focus view' : 'Focus view'} title={`Focus view · ${formatShortcutDisplay(shortcuts.zen_mode)}`} aria-pressed={focus} onClick={() => setFocus(v => !v)}><Icon name="focus" size={17}/></button><div className="copy-control"><button className="icon-button" aria-label="Copy options" disabled={empty} aria-expanded={copyOpen} onClick={() => setCopyOpen(v => !v)}><Icon name="copy" size={16}/></button>{copyOpen && <div className="copy-menu"><button onClick={() => void copy(false)}>Copy Markdown</button><button onClick={() => void copy(true)}>Copy formatted text</button></div>}</div></div></div>}
      <footer className="capture-footer"><div className="draft-status" role="status"><span className={`status-dot ${draft.status}`}/><span>{quick ? draft.status === 'saved' ? 'Draft saved' : 'QUICK CAPTURE' : saveText}</span></div><span className="word-meter">{words > 0 ? `${words} ${words === 1 ? 'word' : 'words'}` : 'yours, at your pace'}</span><button className="primary-button" disabled={empty || draft.locked || !ready} onClick={() => void send()}>{publishing ? 'Sending…' : quick ? 'Catch it' : 'Send to vault'}<kbd>⌘↵</kbd></button></footer>
      {quick ? <div className="quickie-bottom"><span>{isNative ? `→ ${destination}` : 'Browser preview'}</span><button className="text-button" disabled={empty || draft.locked} onClick={() => void deepen()}>There’s more here<Icon name="arrow" size={15}/></button></div> : <div className="desk-bottom"><button className="destination-button" onClick={() => { setSettingsTab('Files'); setPanel('settings'); }}><Icon name="vault" size={13}/>{isNative ? destination ? `To ${destination}` : 'Connect your Obsidian vault' : 'Browser preview · local drafts'}</button>{empty ? <button className="prompt-button" onClick={() => setPromptIndex(i => (i + 1) % 4)}>Another way in<Icon name="riff" size={15}/></button> : <span className="permission-note">One thought is enough.</span>}</div>}
    </>}
    {(draft.error || message) && <div className={`desk-message ${draft.error ? 'is-error' : ''}`} role={draft.error ? 'alert' : 'status'}>{draft.error || message}{draft.error && <button className="text-button" onClick={() => void session.flush().catch(() => {})}>Try saving again</button>}</div>}
    {panel === 'settings' && <Sheet label="Settings" onClose={() => setPanel(null)}><Preferences initialTab={settingsTab} onClose={() => setPanel(null)}/></Sheet>}
    {panel === 'drafts' && <Sheet label="Unfinished thoughts" onClose={() => setPanel(null)}><DraftShelf currentPath={draft.path} onOpen={openDraft} onNew={() => void fresh()} onClose={() => setPanel(null)}/></Sheet>}
    {panel === 'quickie' && <Sheet label="Quickie" className="quickie-sheet" onClose={() => setPanel(null)}><CaptureDesk quick onDismiss={() => setPanel(null)}/></Sheet>}
  </main>;
}
