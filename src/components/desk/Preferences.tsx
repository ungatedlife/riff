import { useEffect, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { emit, invoke, isNative, listen } from '@/platform';
import type { RiffSettings } from '@/types';
import ShortcutRecorder from '../ShortcutRecorder';
import { SYSTEM_SHORTCUT_DEFAULTS } from '@/utils/systemShortcuts';
import Icon from './Icon';

export default function Preferences({ onClose, initialTab = 'Writing' }: { onClose: () => void; initialTab?: string }) {
  const [settings, setSettings] = useState<RiffSettings | null>(null);
  const [tab, setTab] = useState(initialTab);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  useEffect(() => {
    const refresh = () => invoke<RiffSettings>('get_settings').then(s => { if (!savingRef.current) setSettings(s); }).catch(e => setError(String(e)));
    void refresh();
    const changed = listen<RiffSettings>('settings-changed', e => { if (!savingRef.current) setSettings(e.payload); });
    const summoned = listen('settings-summoned', refresh);
    return () => { void changed.then(fn => fn()); void summoned.then(fn => fn()); };
  }, []);
  const change = async (patch: Partial<RiffSettings>) => {
    if (!settings || savingRef.current) return;
    const next = { ...settings, ...patch };
    savingRef.current = true; setSaving(true); setError('');
    try {
      await invoke('save_settings', { settings: next });
      setSettings(next); await emit('settings-changed', next);
      if (patch.system_shortcuts) await invoke('reload_shortcuts');
      if (patch.hide_dock_icon !== undefined) await invoke('set_dock_icon_visibility', { hide: next.hide_dock_icon });
    } catch (e) { setError(`Couldn't apply that change. ${String(e)}`); }
    finally { savingRef.current = false; setSaving(false); }
  };
  const chooseFolder = async () => {
    if (!isNative) { setError('Choose your Obsidian folder in the Mac app. This preview keeps its own local drafts.'); return; }
    try { const path = await open({ directory: true, multiple: false, title: 'Where should your riffs land?' }); if (typeof path === 'string') await change({ vault_dir: path }); }
    catch (e) { setError(String(e)); }
  };
  const chooseSparks = async () => {
    if (!isNative) return;
    try { const path = await open({ directory: true, multiple: false, title: 'Where should sparks land?', defaultPath: settings?.sparks_dir || settings?.vault_dir || undefined }); if (typeof path === 'string') await change({ sparks_dir: path }); }
    catch (e) { setError(String(e)); }
  };
  const chooseScript = async () => {
    if (!isNative) return;
    try { const path = await open({ directory: false, multiple: false, title: 'A script to run after something ships', defaultPath: settings?.site_dir || undefined }); if (typeof path === 'string') await change({ site_dir: path }); }
    catch (e) { setError(String(e)); }
  };
  const chooseQuickies = async () => {
    if (!isNative) return;
    try { const path = await save({ title: 'Your running quickies note', defaultPath: settings?.quickies_file || 'Quickies.md', filters: [{ name: 'Markdown', extensions: ['md'] }] }); if (path) await change({ quickies_file: path }); }
    catch (e) { setError(String(e)); }
  };
  return <section className="preferences">
    <header className="panel-header" data-tauri-drag-region><div><h2>Settings</h2></div><button className="icon-button" aria-label="Close settings" disabled={saving} onClick={onClose}><Icon name="close" /></button></header>
    <nav className="panel-tabs" aria-label="Settings sections">{['Writing', 'Files', 'Keys'].map(label => <button key={label} aria-pressed={tab === label} onClick={() => setTab(label)}>{label}</button>)}</nav>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {!settings ? <p className="panel-empty">Opening settings…</p> : <div className="preferences-body" aria-busy={saving}>
      {tab === 'Writing' && <>
        <label className="setting-label">Appearance</label>
        <div className="theme-options">{[{ id: 'light', name: 'Paper', icon: 'sun' as const }, { id: 'dark', name: 'Ink', icon: 'moon' as const }, { id: 'system', name: 'With the day', icon: 'spark' as const }].map(theme => <button disabled={saving} key={theme.id} className={`theme-option theme-${theme.id}`} aria-pressed={(settings.active_theme || 'system') === theme.id} onClick={() => void change({ active_theme: theme.id })}><Icon name={theme.icon} size={24} /><span>{theme.name}</span></button>)}
          {/* A colour scheme kept from an older Riff stays chosen, and visibly so, until another is picked. */}
          {settings.active_theme && !['light', 'dark', 'system'].includes(settings.active_theme) && <button className="theme-option" aria-pressed="true" title="Kept from an earlier Riff. Choose another to change it."><Icon name="moon" size={24} /><span>{keptThemeName(settings)}</span></button>}
        </div>
        <div className="setting-row"><div><label htmlFor="type-size">Writing size</label><p>Room to hear yourself think.</p></div><select id="type-size" disabled={saving} value={settings.font_size} onChange={e => void change({ font_size: Number(e.target.value) })}>{Array.from(new Set([18, 19, 20, 21, 22, 24, 26, 28, settings.font_size])).sort((a,b) => a-b).map(n => <option key={n} value={n}>{n} px</option>)}</select></div>
        <div className="setting-row"><div><label htmlFor="typeface">Typeface</label><p>iA Writer Duo, a face made for writing.</p></div><select id="typeface" disabled={saving} value={settings.font_family || ''} onChange={e => void change({ font_family: e.target.value || null })}><option value="">iA Writer Duo</option><option value="Georgia">Bookish serif</option><option value="Menlo">Classic mono</option>{settings.font_family && !['Georgia', 'Menlo'].includes(settings.font_family) && <option>{settings.font_family}</option>}</select></div>
        <div className="type-specimen" style={{ fontSize: settings.font_size }}>A thought becomes a thing<br /><em>when you give it a little room.</em></div>
        <div className="setting-row"><label htmlFor="direction">Text direction</label><select id="direction" value={settings.text_direction} disabled={saving} onChange={e => void change({ text_direction: e.target.value })}><option value="auto">Automatic</option><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></div>
      </>}
      {tab === 'Files' && <>
        <p className="quiet-note">Riff writes plain Markdown files, with front matter Obsidian reads. Any folder works.</p>
        <div className="setting-row"><div><span>Riffs</span><p>{settings.vault_dir || 'Where finished riffs go: a folder in your Obsidian vault, or any folder.'}</p></div><button className="text-button" disabled={saving} onClick={() => void chooseFolder()}>{settings.vault_dir ? 'Change' : 'Choose'}</button></div>
        <div className="setting-row"><div><span>Sparks</span><p>{settings.sparks_dir || 'A Sparks folder at the top of your vault (or beside your riffs).'}</p></div><button className="text-button" disabled={!isNative || saving} onClick={() => void chooseSparks()}>{settings.sparks_dir ? 'Change' : 'Choose'}</button></div>
        <div className="setting-row"><div><span>Quickies</span><p>{settings.quickies_file || 'One running Quickies.md note, beside your riffs.'}</p></div><button className="text-button" disabled={!isNative || saving} onClick={() => void chooseQuickies()}>Choose note</button></div>
        <div className="setting-row"><div><span>Unfinished riffs</span><p>{settings.drafts_dir || '~/Documents/Riff'}</p></div><span className="small-label">Saved as you write</span></div>
        <div className="setting-row"><div><span>After something ships</span><p>{settings.site_dir || 'Nothing else happens. Choose a script to run each time, like one that publishes your website. Riff tells you how it went.'}</p></div><span className="row-actions">{settings.site_dir && <button className="text-button" disabled={saving} onClick={() => void change({ site_dir: null })}>Clear</button>}<button className="text-button" disabled={!isNative || saving} onClick={() => void chooseScript()}>{settings.site_dir ? 'Change' : 'Choose a script'}</button></span></div>
        {settings.site_dir && <label className="setting-row"><div><span>Run it each time something ships</span><p>In the background. It can also be run from the menu bar.</p></div><input type="checkbox" disabled={saving} checked={settings.auto_publish_site !== false} onChange={e => void change({ auto_publish_site: e.target.checked })}/></label>}
      </>}
      {tab === 'Keys' && <>
        <label className="setting-row"><div><span>Open Riff when I log in</span><p>So the three doors always open.</p></div><input type="checkbox" disabled={saving} checked={settings.launch_at_login} onChange={e => void change({ launch_at_login: e.target.checked })}/></label>
        <p className="quiet-note">The three doors open from anywhere on your Mac. The rest work while a Riff window is open.</p>
        {Object.entries(SYSTEM_SHORTCUT_DEFAULTS).map(([id, fallback]) => <div className="setting-row" key={id}><span>{({ summon: 'Riff', spark: 'Spark', quickie: 'Quickie', search: 'Drafts', last_note: 'Last draft', zen_mode: 'Focus' } as Record<string,string>)[id]}</span><span className="shortcut-field"><ShortcutRecorder value={settings.system_shortcuts[id] || fallback} existingShortcuts={Object.entries(settings.system_shortcuts).filter(([k]) => k !== id).map(([,v]) => v)} reservedShortcuts={['Cmd+Enter', 'Cmd+N', 'Cmd+Comma', 'Cmd+K', 'Cmd+1', 'Cmd+2', 'Cmd+3']} onChange={value => void change({ system_shortcuts: { ...settings.system_shortcuts, [id]: value } })}/></span></div>)}
        <div className="setting-row"><span>Send</span><kbd>⌘↵</kbd></div>
        <div className="setting-row"><span>Conversation · topic · what it builds on</span><kbd>⌘1 ⌘2 ⌘3</kbd></div>
        <div className="setting-row"><span>Set aside</span><kbd>esc</kbd></div>
      </>}
    </div>}
    <footer className="preferences-footer"><span>riff</span><span role="status">{saving ? 'Saving…' : 'Saved automatically'}</span></footer>
  </section>;
}

/** The name of a colour scheme kept from an older Riff (Dracula, Nord…). */
function keptThemeName(settings: RiffSettings): string {
  const custom = settings.custom_themes?.find(t => t.id === settings.active_theme);
  if (custom) return custom.name;
  return settings.active_theme.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}
