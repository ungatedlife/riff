<p align="center"><img src="app-icon.svg" width="96" height="96" alt="Riff"></p>
<h1 align="center">riff</h1>
<p align="center">A little room for what’s alive.</p>

Riff is Rob’s macOS writing room for catching a thought and following it somewhere. Quickie captures a fragment. Riff gives it room to unfold. Finished writing lands in an Obsidian vault as ordinary Markdown.

The visual language comes from Bricks. Woven paper, warm light and dark palettes, indigo and amber ink, restrained glass surfaces, iA Writer Duo body text, and bookish serif headings.

## Two ways in

**Quickie** opens a compact window with Hyper+Q. Write a fragment and use ⌘↵ to append it to your running Quickies.md note. “There’s more here” saves that fragment as a riff and brings it into the writing room. Escape saves the unfinished quickie and tucks it away.

**Riff** opens the writing room with Hyper+R. The live Markdown editor supports headings, emphasis, lists, tasks, tables, images, links, wiki links, undo, native spellcheck, and find. Use the Aa button for formatting tools. Focus view with ⌘. leaves more space around the words.

The Drafts shelf holds unfinished riffs. ⌘K opens it. ⌘N starts a new riff after saving the current one. Escape saves and hides the room. Shortcuts can be changed in Settings.

## Your words

Edits enter a local recovery record immediately and save to disk after a 500 ms pause. Switching drafts, starting fresh, and sending wait for the current write to finish. Failed writes leave the current document open with an error and retry action. Changing text direction reconfigures the editor without replacing the document or its undo history.

Drafts live in `~/Documents/Riff` unless a previous configuration specifies another folder. Quickie has a separate scratch file in `~/.riff/quickie-draft.md`. This keeps the same thought from being edited in two windows. Clearing a draft preserves the empty document. Source images are retained because multiple drafts can refer to the same asset.

Choose a folder inside your Obsidian vault in Settings, under Files. “Send to vault” creates a Markdown file with a title, slug, and date. A leading H1 becomes its title. Names and image collisions preserve existing vault files. Missing images stop the send and keep the draft. File writes stage and flush a complete file before replacing the destination.

The completion screen offers another thought, a copy for sharing, and a way to open the note in Obsidian. Sending writes to the vault. Any website publishing behavior belongs to the separate vault publishing workflow.

## Development

Requires Node and Rust with the macOS toolchain.

```sh
npm install
npm run dev
npm run tauri dev
```

The browser preview stores its own drafts locally in the browser. It does not access the Mac’s files or Obsidian vault. Native file dialogs, OS shortcuts, images from disk, and Obsidian opening run in the Mac app.

```sh
npm test
npm run build
cd src-tauri
cargo test
cargo clippy --all-targets -- -D warnings
```

`npm run tauri build` creates the macOS app bundle. A debug build can isolate settings, drafts, and quickie recovery by setting `RIFF_TEST_HOME` to an absolute temporary folder at build time. Release builds ignore this override.

## Provenance

Riff began as a fork of [Stik](https://github.com/0xMassi/stik_app) by Massi. The rebuilt app retains and extends the live Markdown editor. iA Writer Duo is bundled under the SIL Open Font License. See [LICENSE](LICENSE) and the font notice in `public/fonts`.
