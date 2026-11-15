import { useEffect } from 'react';
import { invoke } from '@/platform';
import CaptureDesk from './components/desk/CaptureDesk';
import DraftShelf from './components/desk/DraftShelf';
import Preferences from './components/desk/Preferences';
import Paper from './components/desk/Paper';

/** One page, four windows: the three doors and the satellites (settings, drafts). */
export default function App() {
  const type = new URLSearchParams(window.location.search).get('window');
  const close = () => { void invoke('hide_window'); };
  useEffect(() => {
    if (!['settings', 'command-palette', 'search', 'manager'].includes(type || '')) return;
    const dismiss = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[aria-busy="true"]')) return;
      e.preventDefault(); void invoke('hide_window');
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [type]);
  if (type === 'settings') return <main className="satellite-window"><Paper/><Preferences onClose={close}/></main>;
  if (['command-palette', 'search', 'manager'].includes(type || '')) return <main className="satellite-window"><Paper/><DraftShelf onClose={close} onOpen={async path => { await invoke('open_draft', { path }); close(); }}/></main>;
  if (type === 'quickie') return <CaptureDesk kind="quickie"/>;
  if (type === 'spark') return <CaptureDesk kind="spark"/>;
  return <CaptureDesk kind="riff"/>;
}
