import { invoke as nativeInvoke, convertFileSrc as nativeFileSrc, isTauri } from '@tauri-apps/api/core';
import { listen as nativeListen, emit as nativeEmit, type EventCallback } from '@tauri-apps/api/event';
import { getCurrentWindow as nativeWindow } from '@tauri-apps/api/window';
import type { NoteInfo, RiffSettings } from '@/types';
import { SYSTEM_SHORTCUT_DEFAULTS } from '@/utils/systemShortcuts';

export const isNative = isTauri();
const bus: EventTarget = import.meta.hot?.data.bus ?? new EventTarget();
if (import.meta.hot) import.meta.hot.data.bus = bus;
const key = 'riff:browser-preview:v1';
type PreviewStore = { settings: RiffSettings; notes: NoteInfo[]; quickies: string; sent: NoteInfo[]; quickieDraft?: string; sparkDraft?: string; sparks?: { name: string; text: string }[]; connections?: Record<string, unknown> };
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
    case 'search_vault_links': {
      const q = String(args.query ?? '').toLowerCase();
      const names = ['Phil Stutz', 'Growth is death', 'I riff, therefore I am', 'Tiny habits, humble beginnings', 'Francis Weller', 'The Tools'];
      result = names.filter(n => !q || n.toLowerCase().includes(q)).map(n => ({ name: n, path: `preview/${n}.md`, modified: 0 })); break;
    }
    case 'vault_vocabulary': result = {
      conversations: [{ name: 'Ember 2026', count: 45, hub: true }, { name: 'Befriending commitment', count: 22, hub: true }, { name: 'Befriending shame', count: 8, hub: true }, { name: 'The Girl', count: 8, hub: true }, { name: 'Befriending technology', count: 1, hub: true }, { name: 'Building Dialogic', count: 1, hub: true }, { name: 'Start Close In', count: 2, hub: true }],
      topics: [{ name: 'recovery', count: 37, hub: false }, { name: 'humanity', count: 23, hub: false }, { name: 'creativity', count: 18, hub: false }, { name: 'spirituality', count: 17, hub: false }, { name: 'entrepreneurship', count: 14, hub: false }, { name: 'perfectionism', count: 13, hub: false }, { name: 'money', count: 13, hub: false }, { name: 'conversation', count: 13, hub: false }, { name: 'community', count: 12, hub: false }, { name: 'ai', count: 10, hub: false }],
    }; break;
    case 'get_connections': result = data.connections?.[String(args.id)] ?? null; break;
    case 'save_connections': data.connections = { ...(data.connections ?? {}), [String(args.id)]: args.connections }; write(data); break;
    case 'remove_connections': if (data.connections) { delete data.connections[String(args.id)]; write(data); } break;
    // Passages are handed over by other Mac apps; the preview never has one waiting.
    case 'take_handoff': result = null; break;
    case 'get_spark_draft': result = data.sparkDraft || ''; break;
    case 'save_spark_draft': data.sparkDraft = content; write(data); result = { path: 'preview/spark-draft.md' }; break;
    case 'publish_spark': {
      const text = String(args.text ?? '');
      const name = titleOf(text);
      data.sparks = [{ name, text }, ...(data.sparks ?? [])]; write(data);
      result = { vault_path: `Sparks/${name}.md`, name, site_publish_skipped: 'Browser preview: the site publish runs in the Mac app.' }; break;
    }
    case 'publish_site': await emit('site-publish', { phase: 'failed', detail: 'Browser preview: the site publish runs in the Mac app.' }); break;
    case 'open_spark': await emit('show-spark', { text: args.text ?? '' }); break;
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
      const conn = args.connections as { ship?: boolean } | undefined;
      result = { title: titleOf(note.content), vault_path: note.filename, word_count: note.content.split(/\s+/).length, status: conn?.ship === false ? 'draft' : 'shipped', site_publish_skipped: conn?.ship === false ? 'Kept as a draft in the vault.' : 'Browser preview: the site publish runs in the Mac app.' };
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
