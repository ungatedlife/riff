import { invoke as nativeInvoke, convertFileSrc as nativeFileSrc, isTauri } from '@tauri-apps/api/core';
import { listen as nativeListen, emit as nativeEmit, type EventCallback } from '@tauri-apps/api/event';
import { getCurrentWindow as nativeWindow } from '@tauri-apps/api/window';
import type { NoteInfo, RiffSettings } from '@/types';
import { SYSTEM_SHORTCUT_DEFAULTS } from '@/utils/systemShortcuts';

export const isNative = isTauri();
const bus: EventTarget = import.meta.hot?.data.bus ?? new EventTarget();
if (import.meta.hot) import.meta.hot.data.bus = bus;
const key = 'riff:browser-preview:v1';
type PreviewStore = { settings: RiffSettings; notes: NoteInfo[]; quickies: string; sent: NoteInfo[]; quickieDraft?: string };
const defaults: PreviewStore = {
  settings: { theme_mode: 'dark', active_theme: 'dark', font_size: 21, text_direction: 'auto', hide_dock_icon: true, hide_tray_icon: false, launch_at_login: true, custom_themes: [], system_shortcuts: SYSTEM_SHORTCUT_DEFAULTS },
  notes: [], quickies: '', sent: [],
};
function read(): PreviewStore {
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw) : structuredClone(defaults);
}
function write(data: PreviewStore) { localStorage.setItem(key, JSON.stringify(data)); }
export async function emit<T>(name: string, payload?: T): Promise<void> {
  if (isNative) return nativeEmit(name, payload);
  bus.dispatchEvent(new CustomEvent(name, { detail: payload }));
}
export async function listen<T>(name: string, handler: EventCallback<T>): Promise<() => void> {
  if (isNative) return nativeListen(name, handler);
  const fn = (e: Event) => handler({ event: name, id: 0, payload: (e as CustomEvent).detail });
  bus.addEventListener(name, fn);
  return () => bus.removeEventListener(name, fn);
}
export const convertFileSrc = (path: string) => isNative ? nativeFileSrc(path) : path;
export function getCurrentWindow(): ReturnType<typeof nativeWindow> {
  if (isNative) return nativeWindow();
  return { startDragging: async () => {}, onDragDropEvent: async () => () => {}, isFocused: async () => document.hasFocus(), emit, hide: async () => {}, setFocus: async () => {} } as unknown as ReturnType<typeof nativeWindow>;
}

/** The browser preview uses its own local storage. It never touches the Mac's vault. */
export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isNative) return nativeInvoke<T>(command, args);
  const data = read();
  let result: unknown;
  const content = String(args.content ?? '');
  const path = String(args.path ?? '');
  const titleOf = (text: string) => text.split('\n').find(l => l.trim())?.replace(/^#+\s*/, '').slice(0, 80) || 'Untitled thought';
  switch (command) {
    case 'get_settings': result = data.settings; break;
    case 'save_settings': data.settings = args.settings as RiffSettings; write(data); await emit('settings-changed', data.settings); break;
    case 'get_drafts_directory': result = 'Browser preview'; break;
    case 'list_notes': result = data.notes; break;
    case 'search_notes': result = data.notes.filter(n => n.content.toLowerCase().includes(String(args.query ?? '').toLowerCase())).map(n => ({ ...n, title: titleOf(n.content), snippet: n.content })); break;
    case 'search_vault_links': result = []; break;
    case 'get_cursor_position': result = null; break;
    case 'save_note': {
      const filename = `${titleOf(content)}.md`;
      const note = { path: `preview/${crypto.randomUUID()}/${filename}`, filename, content, created: new Date().toISOString() };
      data.notes.unshift(note); write(data); result = note; await emit('files-changed'); break;
    }
    case 'update_note': {
      const note = data.notes.find(n => n.path === path);
      if (!note) throw new Error('This draft could not be found. Your words are still in the room.');
      note.content = content; write(data); result = note; await emit('files-changed'); break;
    }
    case 'get_note_content': {
      const note = data.notes.find(n => n.path === path);
      if (!note) throw new Error('Draft not found');
      result = note.content; break;
    }
    case 'open_draft': {
      const note = data.notes.find(n => n.path === path);
      if (!note) throw new Error('Draft not found');
      await emit('open-draft', note); break;
    }
    case 'delete_note': data.notes = data.notes.filter(n => n.path !== path); write(data); await emit('note-deleted', path); await emit('files-changed'); break;
    case 'publish_riff': {
      const note = data.notes.find(n => n.path === path);
      if (!note) throw new Error('Draft not found');
      data.sent.unshift(note); data.notes = data.notes.filter(n => n.path !== path); write(data);
      result = { title: titleOf(note.content), vault_path: note.filename, word_count: note.content.split(/\s+/).length };
      await emit('files-changed'); break;
    }
    case 'get_quickie_draft': result = data.quickieDraft || ''; break;
    case 'save_quickie_draft': data.quickieDraft = content; write(data); result = { path: 'preview/quickie-draft.md' }; break;
    case 'append_quickie': data.quickies += `\n\n${new Date().toISOString()}\n${content}`; write(data); result = { file_path: 'Preview quickies' }; break;
    case 'open_quickie': await emit('show-quickie'); break;
    case 'open_settings': await emit('show-settings'); break;
    case 'open_command_palette': await emit('show-drafts'); break;
    case 'hide_window': await emit('preview-dismiss'); break;
    case 'focused_riff_window': result = 'main'; break;
    case 'copy_rich_text_to_clipboard': await navigator.clipboard.writeText(String(args.plainText)); break;
    case 'save_cursor_position': case 'flush_complete': case 'reload_shortcuts': case 'pause_shortcuts': case 'resume_shortcuts': case 'set_dock_icon_visibility': case 'set_tray_icon_visibility': case 'rebuild_index': break;
    default: throw new Error('This action is available in the Mac app.');
  }
  return result as T;
}
