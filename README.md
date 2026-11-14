# Deepdive
Read any article with AI aid

See [VISIE.md](VISIE.md) (in Dutch) for the idea, the features and the build plan. Built so far: step 1 (opening sources), step 2 (providers and models, with optional sign-in with ChatGPT), step 3 (the blueprint) and step 4 (selecting, asking and highlighting).

Deepdive is open source under the [MIT license](LICENSE).

## Installing on macOS

**Required:** a Mac with Apple Silicon (M1 or newer). There is no version for Intel Macs or Windows yet.

1. Download `Deepdive_1.3.0_aarch64.dmg` from the [latest release](https://github.com/gevezex/Deepdive/releases/latest).
2. Open the file and drag **Deepdive** to the **Applications** folder.
3. Open Deepdive from Applications.

**Opening it the first time.** Deepdive is not signed with Apple. That is why macOS says the first time that the app cannot be opened, or that Apple cannot check it for malware. That is expected. This is how you open it anyway:

1. Click **OK** or **Done** in the message, not "Move to Trash".
2. Open **System Settings → Privacy & Security** and scroll to **Security**.
3. It says there that Deepdive was blocked. Click **Open Anyway** and confirm with your password or Touch ID.
4. Click **Open Anyway** once more in the next message.

After that Deepdive opens normally, also after a restart.

If that does not work, you can also use Terminal. This only removes the "downloaded from the internet" mark from the app:

```bash
xattr -dr com.apple.quarantine /Applications/Deepdive.app
```

**Updates.** When Deepdive starts, it checks once on GitHub whether there is a newer version. If there is, an **Update available** button appears at the top right. Click it: Deepdive downloads the new version, checks its signature, installs it and restarts. You do not have to do the steps above again for an update installed this way. Version 1.0.0 does not have this button yet, so install the next version once by hand.

**Getting started.** Click **Providers** and add an AI service: Anthropic, an OpenAI-compatible service (also local, such as Ollama or LM Studio) or your own ChatGPT subscription. Then choose a model at the top of the right-hand panel. Paste a web address, choose a PDF or paste text. Select a piece of text to ask the professor something or to highlight it.

**Where your data is.** Everything stays on your own computer. Copies, blueprints, conversations and highlights are in `~/Library/Application Support/app.deepdive.reader`. API keys and the ChatGPT login are in the macOS keychain.

**Uninstalling.** Drag Deepdive from Applications to the Trash. If you also want your data gone, delete the folder above. Remove the keys in the app first, under Providers.

## Languages

The interface is in English by default. Under **Settings** you can switch it to Dutch or Turkish: menus, the selection bar and its ⋯ menu, the highlight menu, notices and the messages from the backend all follow.

The language the AI writes in is a separate choice per article. The flag next to the model picker sets it for the article that is open, so you can read a Turkish website with the blueprint and answers in Turkish while the rest of the app stays in English. An article without its own choice follows the interface language. Quotes always stay in the language of the source.

How it works:

- **Frontend:** `src/i18n/` has one file per area with the texts in all three languages side by side. English leads; a missing Dutch or Turkish key fails the type check. Static texts in `index.html` carry `data-i18n` attributes, code calls `t()`.
- **Backend:** `src-tauri/src/i18n.rs` keeps the interface language (the frontend sets it with `set_ui_language`). Messages are written in place with `tr(en, nl, tr)` or `tr_fmt!`. Texts that are stored, such as the completeness verdict of a copy, keep the language they were made in.
- **Prompts:** all prompts are in English and name the output language (`{{LANGUAGE}}`). The article's choice is `aiLanguage` in `source.json`. Blueprints are saved per model, prompt version and language, so a Turkish blueprint does not replace a Dutch one.
- **Adding a language:** add it to `LANGUAGES` in `src/i18n/index.ts`, to every file in `src/i18n/`, to `Lang` in `i18n.rs` and to every `tr(...)` call.

## Building it yourself

Required: Node, Rust and the system requirements of [Tauri 2](https://tauri.app/start/prerequisites/).

```bash
npm install
```

```bash
npm run tauri dev
```

Building an app on macOS:

```bash
npm run tauri build -- --bundles app
```

Tests:

```bash
npm test
```

```bash
npx tsc --noEmit
```

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

## Publishing a new version

The in-app updater reads `latest.json` from the latest GitHub release (`plugins.updater` in `tauri.conf.json`) and only installs an update signed with the updater key. That key is separate from Apple signing. The private key is in `~/.tauri/deepdive-updater.key`, outside the repository; the public key is in `tauri.conf.json`. Keep a backup of the private key: without it no installed copy can be updated any more.

**The key.** The private key has no password, so whoever has it can make an update that every installed copy accepts. It never goes in the repository, a chat or a plain note. Keep a copy in a password manager (the Passwords app or 1Password): the file is one line of text, so it fits in the notes of an item. Copy it with the command below, paste it into the item and then copy something else, so the key does not stay on the clipboard:

```bash
pbcopy < ~/.tauri/deepdive-updater.key
```

To put it back on another Mac, paste the text into `~/.tauri/deepdive-updater.key` and make the file readable for you only:

```bash
chmod 600 ~/.tauri/deepdive-updater.key
```

The public key may stay next to it; it is not secret. The public key is built into every installed copy, so a new key pair means installed copies no longer accept updates and have to be reinstalled by hand once.

1. Raise the version in `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Build with the key:

```bash
TAURI_SIGNING_PRIVATE_KEY=~/.tauri/deepdive-updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" npm run tauri build -- --bundles app,dmg
```

3. Write `latest.json` next to the update:

```bash
node scripts/latest-json.mjs --notes "What is new"
```

4. Make a GitHub release with the tag `v<version>` (for example `v1.1.0`) and upload from `src-tauri/target/release/bundle/` the dmg, `macos/Deepdive.app.tar.gz` and `macos/latest.json`. The release must be the latest one and not a draft or prerelease.

**Testing an update locally.** Without publishing anything: build an old and a new version that look for updates at a local address, serve the new one and click the button in the old one. `--config` only changes these builds, not `tauri.conf.json`.

```bash
export TAURI_SIGNING_PRIVATE_KEY=~/.tauri/deepdive-updater.key TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

```bash
LOCAL='"plugins":{"updater":{"endpoints":["http://127.0.0.1:18765/latest.json"],"dangerousInsecureTransportProtocol":true}}'
```

```bash
npm run tauri build -- --bundles app --config "{$LOCAL}" && mkdir -p /tmp/dd-upd/old /tmp/dd-upd/serve && cp -R src-tauri/target/release/bundle/macos/Deepdive.app /tmp/dd-upd/old/
```

```bash
npm run tauri build -- --bundles app --config "{\"version\":\"9.9.9\",$LOCAL}" && cp src-tauri/target/release/bundle/macos/Deepdive.app.tar.gz* /tmp/dd-upd/serve/ && node scripts/latest-json.mjs --version 9.9.9 --target /tmp/dd-upd/serve --base-url http://127.0.0.1:18765
```

```bash
python3 -m http.server 18765 --bind 127.0.0.1 --directory /tmp/dd-upd/serve
```

Then open `/tmp/dd-upd/old/Deepdive.app` and click **Update available**. After the restart the app is version 9.9.9 and the button is gone. These test builds use your normal app data.

## Frontend

Plain TypeScript with Vite, without a framework. The parts of the screen are small and pdf.js works directly on the DOM, so a framework adds nothing for now.

## Structure

| Part | Job |
|---|---|
| `src-tauri/src/engine/` | Loading pages behind the trait `PageEngine`. Another engine, such as CEF, only has to implement this. |
| `src-tauri/src/engine/capture.js` | Runs in the hidden webview: waits until the page is built, scrolls through it, removes cookie layers and reads out the DOM and text blocks. |
| `src-tauri/src/snapshot.rs` | Makes the visual copy: sanitises the HTML again and stores images, CSS and fonts locally. |
| `src-tauri/src/model.rs` | The shared source model: blocks with fixed numbers, for websites, PDFs and pasted text. |
| `src-tauri/src/store.rs` | Storage per source in the app data folder. |
| `src-tauri/src/import.rs` | From input to saved source, and the assessment of what was fetched. |
| `src/pdf.ts`, `src/pdfBlocks.ts` | Showing a PDF with pdf.js and turning the text into blocks. |
| `src-tauri/src/ai/` | The AI layer: the only place that talks to an AI service. Later steps use `ai::stream_chat` with a `Target` from `ProviderStore::target`. |
| `src-tauri/src/providers/` | Providers and models in `providers.json`, keys via `secrets.rs` in the keychain. `Selection.perAction` prepares for "a model per action". |
| `src-tauri/src/chatgpt/` | Signing in with ChatGPT: login, ID token, refreshing and logging out. The tokens are only in the keychain. |
| `src-tauri/src/ai/responses.rs` | The Responses API for the ChatGPT subscription, behind the same entry point `ai::stream_chat`. |
| `src/providers.ts`, `src/providerLogic.ts` | The providers screen and the model picker. |
| `src-tauri/src/blueprint/` | The blueprint: schema, prompts and checks (`schema.rs`, `prompts/`, `validate.rs`), the two calls (`mod.rs`), reading an answer while it comes in (`stream.rs`), storage (`saved.rs`) and the commands for the interface (`commands.rs`). |
| `src/blueprint.ts`, `src/blueprintLogic.ts` | The panel: button, progress, the three layers and the diagram. |
| `src-tauri/src/engine/bridge.js` | The only script in the website copy: passes on the selection, draws highlights and jumps to paragraphs. |
| `src-tauri/src/professor/` | Selecting and asking: the prompt (`prompts/system.md`, the task per action in `mod.rs`), conversations per source in `threads/` and highlights in `highlights.json` (`highlights.rs`). |
| `src/reading.ts`, `src/answers.ts`, `src/readingLogic.ts` | The selection bar with the ⋯ menu, highlighting with a note, and the answers in the Questions tab. |
| `src/i18n/`, `src-tauri/src/i18n.rs` | Languages: interface texts, the interface language and the per-article AI language. |
| `src-tauri/src/update.rs`, `src/update.ts` | Updates: one check on GitHub at start, the button, downloading, installing and restarting. Debug builds do not check. |

**Isolation:** the copy is in an iframe with `sandbox="allow-scripts"`, without `allow-same-origin`, and a CSP without network. The site's scripts are not in the copy. When serving it, the app adds one script of its own (`engine/bridge.js`). The CSP in the header only allows that script, by its sha-256 hash: no other inline script, no handlers in attributes and no script from an address. The CSP in the saved page is removed when serving, because it forbids all scripts. The script has its own opaque origin and only talks to the main window via `postMessage`. The main window only accepts messages from that iframe and only uses text and numbers from them. The hidden window has no capability, so a page cannot call the app's commands.

**Preview:** as soon as there is text, the app shows the page while the copy is made in the background. The preview gets the same cleaning and sandbox, without scripts, but still loads images, CSS and fonts directly from the site. It only lives in memory.

**Blocks in the copy:** every text block has an attribute `data-dd-n` with its paragraph number in the visual copy. Later steps can use it to link text and image. For PDFs the page number and position are in the block itself.

**Popups in the copy:** without scripts a layer cannot be clicked away. So two things happen. While capturing, `capture.js` removes cookie layers and sign-up, newsletter and app layers, and turns scrolling back on if the page had turned it off. A layer that asks you to log in or pay without a close button stays. If something still gets in the way, there is the **Remove popup** button under the copy. The choice is stored as `hideFloating` in `source.json`. When serving, the app then adds a style that hides what floats according to the copy's CSS (`position: fixed`, dialogs, and `position: absolute` with a z-index of 1000 or more). Elements with or around a numbered paragraph always stay. The copy on disk, the text and the completeness verdict do not change, and the isolation stays the same. The copy reloads and starts at the top. Fetching again carries the choice over to the new copy.

**Jumping in the copy:** the app's own script scrolls to the paragraphs and makes them light up, without reloading the page. The last target is in `data-jump` on the iframe. If the script is not there yet, for example during the preview, the iframe requests a new address: `index.html?hl=31-40#dd-doel`. The server then puts a style in the page and the browser scrolls to the anchor itself. Only numbers are taken from the query. A PDF is not in an iframe: there a highlight is drawn on the page, at the position from the block.

**Selecting and asking:** when you select something, a bar appears with a question field, Explain, Simpler, ⋯ (What does this word mean?, Is this still true?, Where else does this come up?, Counterargument, Copy quote), Highlight and Note. If you type while something is selected, the letters go to the question field. The question goes with the whole source, the selection and the paragraph numbers to the model chosen under Model (`model_for_action("ask")`). The answer appears in the Questions tab and is saved per source, with follow-up questions. "Is this still true?" does not search the web yet: the model says what it knows and that it was not checked.

**Highlighting:** four colours. Click a highlight for another colour, a note, Explain or removing it. The copy never changes, so a place is fixed: for a website as a character position in the page's text, for a PDF as rectangles on the page.

**Blueprints:** one file per source, model, prompt version and language in `sources/<id>/blueprints/`. The iframe cannot request that folder. Opening again does not call a model. An incomplete blueprint never replaces a complete one of the same model.

**API keys:** only in the keychain. `CachedSecrets` reads each item once per session and then keeps it only in the app's memory. The frontend passes a key to Rust and only gets `hasKey` back. `ApiKey` cannot be serialised, error messages go through `errors::redact`, redirects are not followed and a key is only sent over https or to this computer. After a new build macOS may ask for keychain access again, because the app no longer has the same signature.

**ChatGPT tokens:** one item per link in the keychain, under `chatgpt:<provider-id>`. The frontend only gets the email address and the status. The OpenAI addresses are fixed in a release build; only debug builds can point to a local mock server. `chatgpt-host-id` in the app data folder holds the anonymous ID of this installation, which is not a secret.

## Signing in with ChatGPT

This follows [OpenAI's description for open-source apps](https://developers.openai.com/siwc/token-sharing-open-source), which is still in preview. Every user links their own account and subscription. There is no shared key in the app and there is no server.

To try it: open **Providers**, choose **New provider** and click **Continue with ChatGPT**. Log in in your browser and give permission. Then choose a model at the top of the right-hand panel. You can log out via the provider.

## The end-to-end test of the providers

Drives the real app and the real keychain with a fake key under its own service name, against the local mock server in `tests/e2e/mock-ai.mjs`. No real provider or key is needed. The end-to-end tests run the interface in Dutch (`DEEPDIVE_LANGUAGE=nl`, debug builds only), so their text checks do not depend on the language chosen in your own app.

```bash
npm run tauri build -- --debug --no-bundle --features screenshots
```

```bash
node tests/e2e/providers.e2e.mjs
```

The test of signing in with ChatGPT works the same way, against a local fake of OpenAI in `tests/e2e/mock-chatgpt.mjs`. It does not use a real account:

```bash
node tests/e2e/chatgpt.e2e.mjs
```

The test with the real keychain at Rust level:

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored keychain
```

## The end-to-end test of the blueprint

Drives the real app against the local mock server: button, showing step by step, jumping, cancelling, notices, saving and opening again. No real model or key is needed. Building works as above.

```bash
node tests/e2e/blueprint.e2e.mjs
```

## The end-to-end test of selecting and highlighting

Drives the real app against the local mock server. In the website copy the test cannot select itself, because the iframe is isolated. So the test checks that the app's own script runs there, and then replays its messages. In the PDF the test really selects. Building works as above.

```bash
node tests/e2e/reading.e2e.mjs
```

## The end-to-end test of the popups

Drives the real app against the local test site `tests/e2e/mock-site.mjs`, without real sites or accounts:

```bash
npm run tauri build -- --debug --no-bundle --features screenshots
```

```bash
node tests/e2e/popups.e2e.mjs
```

## Repeating the site test

The test hook is only in debug builds. `docs/site-test-urls.txt` contains the addresses, which can go out of date over time.

```bash
npm run tauri build -- --debug --no-bundle
```

```bash
DEEPDIVE_DATA_DIR=/tmp/dd DEEPDIVE_SITE_TEST=docs/site-test-urls.txt DEEPDIVE_SITE_TEST_OUT=/tmp/dd.json src-tauri/target/debug/deepdive
```
