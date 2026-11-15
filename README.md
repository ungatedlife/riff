<p align="center"><img src="app-icon.svg" width="96" height="96" alt="Riff"></p>
<h1 align="center">riff</h1>
<p align="center">A little room for what’s alive.</p>

Riff is a small Mac app for catching a thought and following it somewhere. It lives in the menu bar and has three doors, each a key away from any app: a **quickie** is a note for later, a **spark** is a line or three you send the moment it strikes, a **riff** is a small complete thing written in one sitting. Everything it writes is plain Markdown in a folder you choose, with front matter Obsidian reads, so it sits happily inside an Obsidian vault (or any folder at all).

The interface is one page of paper, mono chrome in lowercase, iA Writer Duo for the words and nothing else at full size.

## Install

Download `Riff-<version>.dmg` from the [latest release](https://github.com/ungatedlife/riff/releases/latest), open it, and drag Riff onto Applications. It runs on Apple silicon Macs with macOS 10.15 or later, and keeps itself up to date (see *Updates* below).

The first launch opens a welcome screen: what the three doors are, where your writing should go, and whether Riff should open when you log in. After that Riff stays out of sight in the menu bar until a key opens one of its doors.

## Three doors

The keys below are the defaults; change them in Settings → Keys.

**Riff** opens the fullscreen room with ⌃⌥⌘R. A live Markdown editor with wiki links, headings, lists, images, undo, native spellcheck. The footer carries the riff’s connections and the verb: ⌘↵ ships it (`status: shipped`), or flip the `live` pill to `draft` to keep it a draft. Unfinished riffs save as you write to `~/Documents/Riff` and wait behind ⌘K; ⌘N starts fresh; Escape sets the room aside; ⌘. fades the chrome.

**Spark** opens a small window with ⌃⌥⌘S. What just struck you, a chip or two, ⌘↵. The note is written to `Sparks/` named by its first line, stamped with the minute, `status: shipped`, and the window is gone.

**Quickie** opens a small window with ⌃⌥⌘Q. ⌘↵ adds it to one running `Quickies.md` note. Two hand-offs: *make it a spark* and *keep going in riff*.

## Connections

Every spark and riff can say what it belongs to, in the vault’s own vocabulary:

- **conversation** — notes in the vault marked `type: conversation`, with how often each is used. ⌘1.
- **topic** — every topic in use across the vault, by frequency, or a new one. ⌘2.
- **sparked by / riffs on** — any note in the vault, written as a `[[wikilink]]`. ⌘3.

The pickers read the vault live, so spelling never drifts. For a riff the chips ride in a sidecar keyed by the draft (`~/.riff/connections.json`) and become `topics`, `riffs-on`, and `conversations` in the front matter on send; a spark’s become `topics`, `sparked-by`, and `conversations`.

## From another app

Another app can hand Riff a passage to respond to (Trove, a reading app, does). It writes `~/.riff/handoffs/<id>.json` (`kind`, `quote`, `link`, `title`, `author`, `page`) and opens `riff://spark?handoff=<id>` or `riff://riff?handoff=<id>`. Riff reads the file, deletes it, and opens that door with the passage attached: under the words in the spark window, above the page in the room. The room starts a fresh draft for it; the one in progress is saved and waits behind ⌘K.

The passage is never part of the text being edited. On send it joins the note as a blockquote with its attribution, below a spark's words or above a riff's, and its `link` lands in `sparked-by` / `riffs-on`. The note is still named by the first line of what was written, never by the quote, and a quote with no words of your own can't be sent. The small × takes the passage off again, along with its link.

## After something ships

Riff can run a script of your choosing each time a spark or a shipped riff leaves it: one that publishes your website, say, or syncs or backs up. Choose it in Settings → Files (or choose a folder holding a `Publish.command`). It runs in the background from its own folder; two sends in quick succession queue one extra run rather than racing. Its last line starting with `✓` becomes the summary Riff shows. If it fails, the menu bar item says so and the next spark window or room shows why, with *Publish again*, until a run succeeds. The menu bar also has *Publish the site* for a run by hand. With no script chosen, nothing extra happens.

## Settings

⌘, from any door. Writing: appearance, size, typeface. Files: the Riffs folder, the Sparks folder (defaults to `Sparks/` at the top of the vault), the Quickies note, and the after-ship script. Keys: whether Riff opens at login, and the keys; the three doors open from anywhere, the rest while a Riff window is open. Unfinished riffs live in `~/Documents/Riff`; the spark and quickie windows keep their unfinished text in `~/.riff/`.

## Updates

Riff keeps itself current. A little after launch, and every six hours while it sits in the menu bar, it reads the release feed on GitHub. A newer version is downloaded, checked against the update key built into the app, and put in place; it opens the next time Riff starts. The menu bar shows which version is running, with *Check for Updates…*, which becomes *Restart to Update* once one is installed.

## Releasing

```sh
./scripts/release.sh minor     # raise the version (patch | minor | major) and build it
./scripts/release.sh publish   # put that build on GitHub
```

Building signs Riff with the Developer ID certificate, has Apple check it (through Xcode's signed-in account, no password), and makes a disk image, the update archive, and `latest.json`, all in `src-tauri/target/release-copy/out`. Nothing leaves the Mac until `publish`, which pushes `main` and a version tag and makes the GitHub release that installed copies read. The script's opening comment says what it needs, including the update key at `~/.tauri/riff-updater.key`.

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
