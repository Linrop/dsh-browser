# dsh Browser Control Extension (Chrome and Firefox MV3)

English | [中文](README.zh.md)

The **browser-operation end** of dsh: the model reads and operates the browser page you have open — extract content, click elements, fill forms, scroll, and navigate, all in the real page with your login state preserved. The side panel is the conversation entry.

**Two explicit channels**: browser pages are still rendered as structured text (a numbered interactive-element inventory), so browser reads stay text; a screenshot is captured only when the model explicitly asks for `browser_screenshot`, which the host saves as a file. Separately, a dsh 0.1.2 host can advertise multimodal image limits; the side panel then accepts PNG, JPEG, WebP, and GIF attachments and renders their durable history references.

## What the model can do

| Capability | Action | Notes |
|---|---|---|
| Read page | `browser_snapshot` | Title/URL/main text/numbered inventory/form fields (sensitive values masked); `delta: true` returns only changes |
| Click element | `browser_click` | Click by inventory number (links/buttons/checkboxes…), React/Vue compatible |
| Fill forms | `browser_type` | Type text; `replace` clears first |
| Keys | `browser_press` | Enter/Tab/Escape/arrows etc. |
| Scroll | `browser_scroll` | Viewport scrolling (up/down/top/bottom) |
| Navigate | `browser_navigate` / `browser_open_tab` / `browser_back` / `browser_forward` / `browser_reload` | Navigation inside the controlled tab, or open a URL in a new tab and follow it |
| List tabs | `browser_list_tabs` | List accessible tabs with stable IDs, titles, URLs, owned/controlled state, and `origin` (`created` when this session opened the tab, `adopted` when it did not) |
| Follow tab | `browser_follow_tab` | Bind later browser tools to a listed tab without activating it |
| Close tab | `browser_close_tab` | Close a listed tab |
| Close session tabs | `browser_close` | Close every tab this session opened when no tab is named; when there are none it succeeds with an empty list, and a tab this session does not own is refused |
| Read region | `browser_get_text` | Lazy-loaded content / partial text |
| Wait | `browser_wait` | Page load and render-settle detection |
| Choose an option | `browser_select` | Select by option value, label, or index; an unmatched value lists the available options |
| Search the inventory | `browser_find` | Rank inventory elements by a query and return the closest indices |
| Attach files | `browser_upload_file` | Build `File` objects from host-supplied bytes and set them on a file input |
| Hover / drag | `browser_hover` / `browser_drag` | Real input events through a debugger session on the controlled tab; synthesized DOM events when it cannot attach |
| Click variants | `browser_click` with `button` / `count` / `modifiers` | Right/middle click, double/triple click, and modifier chords through a debugger session |
| Run page JavaScript | `browser_evaluate` | Requires approval; results are redacted and length-capped |
| Screenshot | `browser_screenshot` | Whole viewport or an integer clip in viewport pixels, saved by the host as a file path; `scale` is 1, 2, or 3 and defaults to 2 with a region; a negative origin, a zero size, a clip outside the viewport, or a render over 8192 px per side or 4,194,304 pixels fails with the real viewport and the requested rectangle, and the reported dimensions come from that plan |
| Live view | side panel toggle | Optional JPEG view of the controlled tab, off by default: frames from a CDP screencast are acknowledged before handling, stale frames are dropped by sequence, and switching tabs or losing the debugger clears the image |
| Console and network | `browser_console` / `browser_network` | Buffered per tab from the first call; headers and URL credentials redacted, request bodies recorded as byte counts only |
| Resize the window | `browser_resize` | Resize the window holding the controlled tab |
| Emulate a viewport | `browser_viewport` | Emulate a viewport through the debugger (`mobile` defaults to false); separate from window resize, ends when the debugger detaches (60 s idle), and `reset: true` drops it now |
| Print to PDF | `browser_pdf` | Print the controlled tab to a PDF the host saves as a file path; requires the debugger |
| Batch | `browser_batch` | Sequential tool calls with stop-on-first-error |
| Chat with images | `session.prompt` / `session.attachment` | Host-gated image selection, image-only sends, and durable history previews |
| Quote what you highlight | side panel composer | The text you select in the page becomes a quote in the composer and rides along with your next message |

## Architecture

```
side panel (React) ◄─port─► background SW/event page ◄─WS─► dsh bridge plugin
                                 │
                  tabs.sendMessage (DSH_ACTION, DSH_SELECTION_WATCH)
                                 ▲ DSH_SELECTION
                                 ▼
                        content script (snapshot/actions/privacy/selection)
```

- **background** (`src/background/`): bridge connection (token auth + exponential-backoff reconnect + keepalive), gateway RPC client, and **fail-closed tool dispatch to a user-controlled tab**.
- **content script** (`src/content/`): text-only snapshot (readability main text + numbered interactive inventory + form fields), **stable element numbers** (`data-dsh-el`), delta changes, click/type/press/scroll/navigate actions, sensitive-field masking, and a debounced selection watcher that stays disarmed until a side panel is open and page sharing is not `off`.
- **panel** (`src/panel/`): React conversation UI (resumable session/history/live events/settings); host-advertised image limits gate image selection and preflight checks, durable attachments render through session-authorized reads, messages render as sanitized Markdown, `ask_user_question` requests render as answerable cards, manual tab switches render a control-handoff strip, an active turn exposes a standard stop control, and a highlighted page passage renders as a removable quote that the next prompt carries inside the untrusted-content boundary.
- **Protocol**: `protocol.ts` in the `@yuxianglin/dsh-bridge-browser` workspace package is the single source of truth, shared by both ends through the package's source export.

## Build

```sh
pnpm install
pnpm --filter dsh-browser-extension run build
pnpm --filter dsh-browser-extension run build:firefox
pnpm --filter dsh-browser-extension run test
```

Run these commands from the repository root. Chrome outputs to `extensions/dsh-browser/dist/`; Firefox outputs to `extensions/dsh-browser/dist-firefox/`.

## Install and use

The recommended zero-configuration command does not require Git or a local clone:

1. **Build and install the extension**:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.sh | bash
   ```

   On Windows, run this in PowerShell instead:

   ```powershell
   $s="$env:TEMP\dsh-install.ps1"; irm https://raw.githubusercontent.com/Lum1104/dsh-browser/refs/heads/main/scripts/install.ps1 -OutFile $s; powershell -NoProfile -ExecutionPolicy Bypass -File $s
   ```

   The script downloads a managed workspace to `~/.dsh/dsh-browser`, builds the bridge plugin, registers its official bundle in the local dsh `web` profile, builds the extension, copies the output to the stable directory `~/.dsh/browser-extension`, and opens `chrome://extensions`. Enable Developer mode, choose Load unpacked, and select the extension directory. Running the command again updates the managed installation.

   A cloned checkout uses the same installer without downloading or overwriting source files:

   ```sh
   git clone https://github.com/Lum1104/dsh-browser.git
   cd dsh-browser
   ./scripts/install.sh
   ```

   Windows checkouts run `.\scripts\install.ps1` instead. Paths containing spaces are supported: the installer uses a profile-local directory junction instead of putting the absolute checkout path in pnpm's link spec.

2. **Start dsh with the bridge plugin mounted**. Use either the workspace-pinned runtime:

   ```sh
   cd ~/.dsh/dsh-browser && pnpm start
   ```

   From a clone, run `pnpm start` in the repository root instead.

   Or use the exact supported public runtime:

   ```sh
   npx @deepseek-ai/dsh@0.2.0-rc.2 web
   ```

   Both commands load the same bundle from the local `web` profile. Port 3080 is used by default; append `--port <port>` when it is occupied.

   **DSH Desktop users**: the Desktop app assigns a random local Web port by default (`dsh-desktop.port: 0`), so port-based auto-discovery cannot predict it. Pin the port to `43189` in Desktop settings (see the [deepseek-harness-desktop user guide](https://github.com/anywhere-labs/deepseek-harness-desktop/blob/master/docs/user-guide.en.md)); auto-discovery covers that port. Alternatively, enter `http://127.0.0.1:<port>` manually in the side-panel settings.

   Loading or reloading the extension is passive: it does not probe local ports or open a WebSocket until the side panel is opened. A healthy connection established by the user may remain available for background approvals after the panel closes, but it will not reconnect without an open panel if it drops or another browser replaces it.

3. **Use it**: open a normal `http://` or `https://` page and click the DeepSeek whale icon. Both builds auto-discover local dsh. Chrome loopback connections need no address or token; Firefox must be given the token from `~/.dsh/ext-bridge-token` because a `moz-extension://` UUID is not an add-on identity. Chat directly or click "Read page" first.

Pages that were already open before extension installation or reload are instrumented automatically on the first action, so they do not require a manual refresh. Browser-internal and protected pages such as `chrome://` and the Chrome Web Store expose only tab metadata and browser-level HTTP(S) navigation, back, forward, and reload; their DOM cannot be read or operated.

For extension-only development, load `extensions/dsh-browser/dist/` from `chrome://extensions`, or run `build:firefox` and load `extensions/dsh-browser/dist-firefox/manifest.json` from `about:debugging#/runtime/this-firefox`. Rebuild and reload after code changes.

## Why browser operation stays text-only

- **Snapshot as the view**: the model's entire view of the page is structured text (title/URL/main/numbered elements/forms), budgeted at 32k chars by default (plugin-configurable, negotiated to the extension via `hello.ok`).
- **Page text is untrusted input**: snapshots and targeted text reads are enclosed in a fresh nonce-bound trust marker and explicitly tell the model never to treat page-authored commands as instructions. This is defense in depth; extension-side action approval is the enforcement boundary.
- **Stable numbering**: element numbers persist across snapshots (WeakMap + `data-dsh-el`), so the model can say "click 7"; a large page change explicitly reports "numbers reindexed". Each number also records a stable CSS selector, so an action on a re-rendered node re-locates it and says so in the result; zero or multiple matches fail with the selector and the match count.
- **Delta mode**: `browser_snapshot({delta:true})` returns only changed element numbers, saving tokens.
- **Privacy**: password/credit-card values always render as `••••` and never leave the page; accessible names never use a sensitive field's current value.
- **Tab affinity**: prompt submission binds the active tab before the model starts working; a direct browser-tool call also performs the initial bind when needed. A manual tab/window switch pauses later tools and asks whether the assistant should stay on the original tab or follow the newly visible one. Staying permits explicit background operation without changing the user's visible tab; following resets page-reference state. A closed controlled tab fails closed until the user selects the current page, and a switch withdraws any open action approval.
- **Proportional approval**: the default `auto` mode lets the model read the controlled tab without an extra prompt; `ask` restores per-read confirmation and `off` blocks reads. In `ask` mode, the read dialog can allow one read or persistently switch back to `auto`, which remains reversible in Settings. State-changing tools still fail closed and show their exact origin plus a redacted action summary. The user may deny, allow once, or trust one origin for the current side-panel session; temporary trust clears when the last panel closes or the service worker restarts. Permanent trust is managed explicitly in Settings. If the panel is closed, an approval remains pending for up to 60 seconds and, when enabled, a system notification opens the panel for review. The panel restores the requesting session before showing a session-scoped approval. Caller cancellation or bridge timeout withdraws any open approval before an action can run.
- **Unrestricted control is explicit**: **Allow unrestricted browser control** becomes active only after the setting is saved successfully, then lets page reads, page actions, and tab list/follow/close operations run without confirmation. Calls capture their access mode when received, so enabling unrestricted control never retroactively elevates an existing restricted call. Disabling it takes effect immediately, cancels calls that have not dispatched an action, waits for already-dispatched browser operations to settle, and only then saves the restrictive setting. A rapid re-enable remains restricted until that revocation finishes, and concurrent saves persist in request order. Protected-page DOM content remains inaccessible.
- **Conversation continuity**: reopening the panel resumes the most recently active browser conversation by default, falling back to the latest non-empty durable session before creating a new one. This can be disabled in Settings.

## Permissions

Chrome uses `sidePanel`; Firefox uses `sidebar_action`. Both request `storage` (settings and recent-session continuity), `notifications` (optional reminders for approvals received while the panel is closed), `tabs` + `activeTab` + `scripting` (observe tab changes and inject/message the explicitly controlled tab, including lazy recovery for pages opened before install), `webNavigation` (enumerate and bind messages to that tab's frame documents), `alarms` (background keepalive), and `http/https` (content-script injection on normal pages). Both also request `debugger`, used only for the controlled tab: it carries real pointer input, page JavaScript evaluation, clip/scale screenshots, and the console/network buffers. Chrome shows its "started debugging this browser" bar while a debugger session is attached; dismissing that bar detaches the session, and every tool that needed it falls back to the DOM-only implementation and says so. Firefox does not expose `chrome.debugger`; the extension detects the missing API and degrades every debugger-dependent tool to its DOM-only implementation instead of throwing. Firefox's AMO manifest declares the browsing activity, website content/activity, and personal communications that the add-on sends to the configured dsh/model service. The extension never changes the visible tab or silently follows a manual switch; background operation happens only after the user chooses to stay on the original tab.

## Known limitations

- Only one extension connection at a time. An unopened browser profile never claims it; if another open panel replaces a live connection, the replaced client yields instead of starting a reconnect fight.
- Tab affinity is global to that extension connection rather than per chat session.
- Accessible cross-origin iframes are snapshotted and operated with stable `(frame, index)` addresses. Restricted or short-lived frames are reported as unavailable without failing the whole page snapshot. A snapshot always covers every accessible frame, while every element-addressed tool takes the optional `frame` from that address — find, get_text, click, type, press, hover, select, drag, upload_file, scroll and wait — defaulting to the top page.
- A restored history entry keeps its iframes in the snapshot: when Chrome's frame enumeration omits the subframes of a back/forward-cached document, the last frame tree for that document is re-used by frame id.
- Captcha/image-only controls cannot be handled — the tool result reports "elements with no accessible name" and asks the user to complete that step manually.
- No automatic token rotation.
- `browser_press` sends real key events through the browser input pipeline while the controlled tab is active in a focused window and the debugger is attached, so Tab focus movement, arrow-key scrolling, and Enter submission follow the browser's defaults. When real input is unavailable it synthesizes `KeyboardEvent`s instead, says so and why in the result, and those synthesized events do not trigger browser-native defaults.
- `browser_wait` considers page load plus a fixed quiet window, but does not observe continuously changing DOM state; a live-updating SPA may be reported as stable.
- Real pointer input, clip/scale screenshots, page JavaScript evaluation, and the console/network buffers all depend on a debugger session scoped to the controlled tab. The session attaches on demand, detaches after 60 seconds idle or when the tab leaves the session's ownership, and never targets a tab the user has not handed to this session. If the user dismisses Chrome's debugging bar, those tools fall back to DOM-only behavior and say so in the result.
- Real input reaches a page only while its tab is active in a focused window. When it cannot, pointer tools synthesize DOM events instead, say so, and keep the requested button, click count and modifier semantics; browser-level defaults such as navigation and native context menus do not follow synthesized events.
- Drag targets that declare native drag-and-drop semantics receive `Input.dispatchDragEvent` enter/over/drop events with a `text/plain` payload; targets without them keep the plain mouse-drag sequence, and a browser that refuses the drag protocol falls back to synthesized drag events.
- Native drag-and-drop detection reads only what the isolated world can observe: a `draggable` attribute on the endpoint or an ancestor, and inline drag handlers on the element, document (`ondrop`), document element, or window. A page that registers drag/drop listeners exclusively with `addEventListener` cannot be detected and keeps the plain mouse-drag path, so its drop handlers may not run.
- Console and network buffers survive an idle debugger detach: history is kept until the main-frame document is replaced (reload or cross-document navigation), the tab closes, or the session ends, while same-document hash, query, and SPA changes keep it. Re-attaching replays Chrome's log history, and those replays are de-duplicated against what the buffer already holds.
- The fallback screenshot path uses `captureVisibleTab`, so it can only capture the visible area of the active tab and ignores `scale`; the debugger path captures the controlled tab with clip and scale. Supported scales are 1, 2, and 3 only; a `scale` below 1 (the earlier 0.1–1 range) is rejected as an invalid argument.
- The live view's actual frame-stop timing on background tabs, without a debugger, and on Firefox has not been verified on real hardware; in those states the panel reports the reason instead of showing a stale frame.
- `browser_console` and `browser_network` start recording at the first call on a tab. Without a debugger session they hook `console`, `fetch`, and `XMLHttpRequest` in the page world, which misses requests issued before the hook, document/resource requests, and service-worker traffic; the result says which path produced it.
