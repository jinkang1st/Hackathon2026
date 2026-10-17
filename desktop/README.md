# AI Firewall · macOS message reminders

A native Swift menu bar app that checks drafts in explicitly allowed applications.
All app UI, prompts, generated explanations, and errors use English.

## Run

Requires macOS 13+, Xcode Command Line Tools, and the running Python backend.

1. Start the backend as described in the root README and configure `NEBIUS_API_KEY`.
2. Build and launch from a terminal:

```bash
cd desktop
swift run MessageGuard --app com.apple.TextEdit
```

For multiple applications, repeat `--app`. The exact bundle ID is required:

```bash
swift run MessageGuard \
  --app com.apple.TextEdit \
  --app com.tinyspeck.slackmacgap \
  --server http://127.0.0.1:8000
```

No app is allowed implicitly. You can also launch the app without `--app` and choose
**Configure allowed apps…** from the shield menu. App-list changes last for the current
session; protection remains paused until explicitly started.
If your backend requires authentication, export its
`FIREWALL_API_TOKEN` in the launch terminal. The desktop app never needs the Nebius key.
Use HTTPS for remote backends. HTTP is allowed only for loopback addresses.

The shield menu initially reads **Paused**. Choose **Start protection…**, review the
app list and data-sharing explanation, and choose **Enable**. The app fetches the
keyword list from the backend before enabling monitoring. If configuration cannot be
loaded, protection remains paused.

For troubleshooting, `--start` opens the normal enable-confirmation dialog on launch,
and `--diagnostics` prints fixed processing-stage labels without draft content or keys:

```bash
./dist/MessageGuard.app/Contents/MacOS/MessageGuard \
  --app com.apple.TextEdit --server http://127.0.0.1:8000 --start --diagnostics
```

Read-only permission diagnostics are also available:

```bash
./dist/MessageGuard.app/Contents/MacOS/MessageGuard --check-permissions
```

Run permission diagnostics in a normal desktop terminal; a sandbox can report denied
access even when the same executable has permission outside the sandbox.

Automated tools may direct input to a target app without going through the global
keyboard event stream. A physical keypress is required to verify the global-listener
path in that environment; HTTP checks and static preview alone do not verify it.

macOS requires **Accessibility** and **Input Monitoring** permissions. When prompted,
open System Settings → Privacy & Security and enable the executable or the terminal
launching it, as shown by macOS. Restart if requested, then start protection again.
The app never requests administrator access or changes system permission settings itself.

For a standalone app bundle:

```bash
bash scripts/build-app.sh
open dist/MessageGuard.app --args --app com.apple.TextEdit
```

If using a backend token, launching the bundle executable directly preserves the terminal environment:

```bash
./dist/MessageGuard.app/Contents/MacOS/MessageGuard --app com.apple.TextEdit
```

Ad-hoc signing is for local development. Rebuilding may require macOS permissions to be granted again.

## Try it

With TextEdit allowed and protection started, type a test draft such as:

```text
You are an idiot. Fix the report.
```

After a 600 ms pause in typing, the app checks for configured sensitive terms locally.
Only a match is sent for AI assessment. A keyword match does not force a warning:
quoted, educational, or otherwise benign usage can be judged safe by the model.

When the model recommends a reminder, a nonactivating panel offers **Keep editing**,
**Copy suggestion** (if available), and **Pause protection**. Copying requires a click;
the app does not replace draft text, press keys, send messages, or click send buttons.

To inspect the popup without a backend, system permissions, or keyboard monitoring:

```bash
swift run MessageGuard --app com.apple.TextEdit --preview
```

Preview displays explicitly labeled sample content and stays paused.

## Capture and request behavior

- The event tap is listen-only and never decodes or stores individual key characters.
- Keyboard activity schedules a check; the main-thread event callback does no network I/O.
- The Accessibility API reads only the currently focused, supported editable control
  in an allowed foreground application. Standard secure text fields and inaccessible
  or unsupported controls are skipped. Custom controls depend on the metadata exposed
  by the host application; this is not a universal detector for every kind of sensitive field.
- At most 4,000 UTF-16 code units around the cursor are read for assessment, across both
  sides where available. Context is from that focused draft, not the conversation history
  or text in other applications. The fallback skips documents over 200,000 UTF-16 units.
- Accessibility reads the actual text, so the app does not reconstruct drafts from raw
  keystrokes. It works with pasted or edited text when keyboard activity triggers a check;
  mouse-only edits are not independently observed.
- At least three seconds separate inference starts. Identical draft/field hashes are
  suppressed for 120 seconds in a bounded 128-entry memory cache.
- Changes in text, field, foreground app, or pause state invalidate pending results.
  Results are checked against the current field again before a reminder appears.
- On backend failure, the shield status changes to **Check** and the app backs off for
  15 seconds. Failure is never presented as an AI judgment that the draft is safe.
- Pause stops the event tap, cancels pending work, closes the panel, and clears the cache.
  A request already received by the backend/provider may still finish there after cancellation.
- Draft text is not logged or written to disk by this app. Network sessions use ephemeral
  storage without cookies or response caching; redirects are rejected.

This version reminds while typing. It cannot guarantee intervention before a user immediately
presses Enter or clicks Send. Actual send interception requires a later application-specific integration.
Some applications do not expose editable text through Accessibility; these are skipped.

## Tests

```bash
swift test
```

Tests cover keyword normalization/boundaries, stale result rejection, pause behavior,
deduplication, request encoding, and backend URL constraints. Live keyboard capture and
permission-dependent behavior require a manual run in an authorized application.
