<p align="center">
  <img src="app-icon.svg" width="96" height="96" alt="Riff icon">
</p>

<h1 align="center">Riff</h1>

<p align="center">
  <strong>A quiet room for writing one small, complete thing at a time.</strong>
</p>

Riff is a macOS menu-bar writing app for one job: noticing when something
feels alive, sitting with it for two or ten minutes, and shipping it —
imperfect, complete, out the door. Not quick capture. Not a second brain.
A writing room with one exit: **Publish**.

## The ritual

1. **Summon** — `⌘⇧R` opens the room from anywhere.
2. **Riff** — an Obsidian-style live markdown editor: rendered headings,
   hidden syntax markers, task lists, tables, inline images,
   `==highlights==`, `[[wiki-links]]` between drafts. `⌘.` for zen mode.
3. **Publish** — `⌘↩` stamps the riff with a title and date, moves it
   (images included) into your Obsidian vault, and clears the room. Your
   site's pipeline takes it from there.

Drafts are plain markdown in `~/Documents/Riff` until they're published.
`esc` saves and hides; an emptied draft deletes itself. `⌘⇧P` lists your
drafts, `⌘⇧L` reopens the last one, `⌘⇧,` opens settings.

## Why

Perfectionism kills more writing than laziness does. Ideas arrive small and
alive, then get buried under over-explaining until they're impossible to
finish. A riff refuses that: it's the smallest complete expression of a
thought, published to move the conversation forward. Maybe wrong, maybe a
dead end — but out there, which is the whole point.

## Publishing details

Publish derives the title from a leading `# Heading` (removed from the body
so your CMS doesn't render it twice) or from the first line. The file lands
in the vault as `<slug>.md` with YAML frontmatter:

```markdown
---
title: "On riffs"
date: 2026-08-16T17:20:11+01:00
---
```

Referenced images are copied into `<vault>/assets/` and their links
rewritten (Obsidian ignores dot-directories). Slug collisions get `-2`,
`-3`, … suffixes. Pick the vault folder in **Settings → Publishing**.

## Build

Requires [Rust](https://rustup.rs) and Node 18+.

```bash
npm install
npm run tauri dev     # development with hot reload
npm run tauri build   # production .app bundle
```

On first launch macOS asks for access to your Documents folder (drafts live
there). The app icon is a placeholder — drop a 1024×1024 PNG on
`npx tauri icon` to regenerate the set.

## Credit

Riff is a fork of [Stik](https://github.com/0xMassi/stik_app) by Massi
(MIT). The live-preview markdown editor and the writing feel are his craft;
Riff strips the capture toolkit around it and adds the publish ritual.

## License

[MIT](LICENSE)
