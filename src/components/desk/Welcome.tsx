import { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke, isNative, emit } from '@/platform';
import type { RiffSettings } from '@/types';
import { SYSTEM_SHORTCUT_DEFAULTS } from '@/utils/systemShortcuts';
import { formatShortcutDisplay } from '../ShortcutRecorder';

const DOORS = [
  { id: 'summon', name: 'riff', what: 'A quiet full-screen room for one small, complete thing.' },
  { id: 'spark', name: 'spark', what: 'A line or three, sent the moment it strikes.' },
  { id: 'quickie', name: 'quickie', what: 'A note for later, added to one running note.' },
] as const;

/**
 * The first thing a new install shows. Riff has no Dock icon and no window
 * of its own until a key opens one, so without this a first launch looks
 * like nothing happened. It says what the three doors are, asks where the
 * writing should go and whether Riff should open at login, then steps aside.
 */
export default function Welcome({ settings, onDone }: { settings: RiffSettings; onDone: () => void }) {
  const [folder, setFolder] = useState(settings.vault_dir || '');
  const [atLogin, setAtLogin] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const keys = { ...SYSTEM_SHORTCUT_DEFAULTS, ...settings.system_shortcuts };

  const chooseFolder = async () => {
    if (!isNative) { setError('Choosing a folder works in the Mac app.'); return; }
    try {
      const path = await open({ directory: true, multiple: false, title: 'Where should your writing go?' });
      if (typeof path === 'string') { setFolder(path); setError(''); }
    } catch (e) { setError(String(e)); }
  };

  const begin = async () => {
    setSaving(true); setError('');
    try {
      const next: RiffSettings = { ...settings, vault_dir: folder || settings.vault_dir || null, launch_at_login: atLogin, welcomed: true };
      await invoke('save_settings', { settings: next });
      await emit('settings-changed', next);
      onDone();
      await invoke('hide_window');
      await invoke('open_room').catch(() => {});
    } catch (e) { setError(`Couldn't save that. ${String(e)}`); }
    finally { setSaving(false); }
  };

  return <section className="welcome">
    <header className="panel-header" data-tauri-drag-region><h2>Welcome to riff</h2></header>
    <div className="welcome-body">
      <h1>A little room for what’s alive.</h1>
      <p className="quiet-note">Riff lives in the menu bar. Three keys open it from anywhere on your Mac:</p>
      <ul className="welcome-doors">
        {DOORS.map(door => <li key={door.id}><kbd>{formatShortcutDisplay(keys[door.id])}</kbd><span><b>{door.name}</b>{door.what}</span></li>)}
      </ul>

      <label className="setting-label">Where your writing goes</label>
      <div className="setting-row">
        <div><span>{folder ? folder.split('/').slice(-2).join('/') : 'No folder yet'}</span><p>{folder || 'Riff writes plain Markdown files. Choose a folder in your Obsidian vault, or any folder at all. Sparks get a Sparks folder of their own, and quickies collect in one Quickies.md note.'}</p></div>
        <button className="text-button" disabled={saving} onClick={() => void chooseFolder()}>{folder ? 'Change' : 'Choose a folder'}</button>
      </div>

      <label className="setting-row"><div><span>Open Riff when I log in</span><p>So the three keys always work.</p></div><input type="checkbox" checked={atLogin} disabled={saving} onChange={e => setAtLogin(e.target.checked)}/></label>

      <p className="quiet-note">Everything here, and the keys themselves, can be changed later in Settings: ⌘, from any Riff window, or from the menu bar icon.</p>
      {error && <p className="inline-error" role="alert">{error}</p>}
    </div>
    <footer className="preferences-footer welcome-footer">
      <span>{folder ? '' : 'You can choose the folder later, too.'}</span>
      <button className="send" autoFocus disabled={saving} onClick={() => void begin()}>{saving ? 'Opening…' : 'Start writing'}<kbd>↵</kbd></button>
    </footer>
  </section>;
}
