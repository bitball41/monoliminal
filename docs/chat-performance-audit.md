# Chat performance audit — 2.24.4

The reported symptom is intermittent, page-wide frame drops on an 8 GB
Chromebook with backgrounds Off and about three people online. Earlier narrow
profile/ring tests did not establish the cause of the user's remaining spikes.

## Recorder correction in 2.24.4

Two uploaded 2.24.3 reports are snapshots of the same session at 4m23s and
5m41s. Both show Chrome 147 on ChromeOS, 8 GB memory, eight threads, backgrounds
Off, no voice peers, five live members, and a healthy realtime connection.
Mounted messages increased from 61 to 75; images increased from 126 to 188.
Both reports contain zero slow frames. Those zeros do **not** establish that
the device had no stalls: the previous recorder was attached to the wrong
document when running inside the launcher.

The launcher loads Chat into a same-origin `srcdoc` iframe. Long animation
frames are reported to the nearest same-origin root. Registering an observer
in the child succeeds but receives no entries in the reproduced Chrome 147
and 153 setup. A deliberately inserted 180 ms child-thread freeze produces
one parent frame and zero entries in the old child-only observer. The earlier
full-boot performance harness used a top-level Chat document and therefore
missed this integration failure. Its lab measurements below remain lab
measurements; they do not validate the old on-device recorder.

The correction constructs the frame observer in the highest accessible
same-origin ancestor, translates its timestamps to Chat's clock, and exports
the observation scope. A separate passive local long-task observer records
tasks even without a rendered frame. Pending entries are drained on export;
`pagehide` disconnects both observers, including the parent-owned observer, so
reloading the child does not retain the old Chat document. A persisted
`pageshow` reconnects them once. No launcher replacement is required.

An optional **Record frames (60s)** control captures callback intervals and
keeps at most 120 gaps over 35 ms plus a histogram. It defaults to Off, has
one RAF callback outstanding while active, stops after 60 seconds, and stops
on download, manual stop or page hiding. Returning from a hidden tab cannot
create a fake long interval. This adds evidence for dips below the long-frame
API's threshold; callback intervals are not a measurement of displayed GPU
frames. The automatic passive observers do not create an animation loop.

Native browser regressions cover top-level, HTTPS srcdoc, local-file srcdoc,
nested same-origin srcdoc and an inaccessible sandboxed parent. The actual
launcher plus full application boot is also exercised with offline backend
fixtures, animated media, application timers and realtime callbacks. The
known freeze is a positive control: the test requires real recorded entries,
not merely successful observer registration. In Chrome 147 and 153, the opaque
sandbox still omits LoAF entries; local long tasks and the opt-in interval
capture remain available. Frame observer coverage fields describe registration
and document scope, not proof that a missing entry implies no lag.
Child script attribution can also be empty, so a
captured frame does not guarantee a function name.

This release corrects a confirmed diagnostic defect. The supplied reports
cannot identify or establish a fix for the user's remaining intermittent
spikes. No further rendering-quality reduction or speculative optimization
is included in this release.

## Coverage

| Area | Review and evidence | Result |
| --- | --- | --- |
| Launcher and iframe | Loader removal, handshake, force-refresh subscription, 30-second fallback/5-minute reconciliation, media permission bridge, repeated boot; native diagnostic positive control added in 2.24.4 | No recurring download or loader animation in the signed-in steady state. Chat now observes long frames in the accessible root rather than its srcdoc child. No launcher change. |
| Boot and effects | `init`, `standaloneBoot`, `bootApp`, auth shader shutdown, background destruction, theme/media-query/visibility observers | Background Off has no canvas in the background stage. Shader quality and resolution remain unchanged. |
| Timers and lifecycle | Actual 1/5/20/30/60-second application timers; focus/wake, subscription acknowledgement, presence sync, fallback/recovery, duplicate payloads | Normal boot and callbacks included in browser traces. No heartbeat RPC or full profile refresh was added. |
| Scroll and composer | Incoming messages, explicit pins, image resize, history anchor restoration, duplicate capture/local scroll listeners, typing | Removed synchronous/event-time geometry reads and the nine-frame repinning loop. Pins coalesce. Native textarea sizing avoids resetting and measuring height on every keystroke. |
| Timeline/history | Initial load, three older pages, paging in both directions, new messages during history reading, deletion/read-receipt/poll paths | History now has a bounded window and preserves retained message/media nodes. Incoming messages do not expand a timeline the member is reading indefinitely. |
| Profiles and avatars | Partial/full row differences, author refreshes, auto-save, Noelle mirror, member/DM row identity, animated images and rings | Only timeline identity fields refresh author UI; author/profile edits retain message bodies and media. Visibility handling also suppresses offscreen images, not only rings. |
| Media and pickers | GIF/image/sticker rendering, lazy loading, previews, private media, hidden dialogs, viewport restoration | Original image URLs and dimensions are retained. Browser regression checks cover image identity and visibility restoration. |
| Voice | Per-stream level RAFs, link timer, media track/peer cleanup, leave/cancel paths | Work starts with a call and cleanup cancels it. It cannot explain the reproduced no-call stalls. No voice behavior change. |
| Backend | Read-only aggregate traffic/payload/storage inspection; message, DM, roster and participant indexes; AI invocation gating | Low traffic, small recent message rows, and existing indexes do not explain page-wide frame loss. No schema, account or server configuration changes. |

The backend snapshot had 71 profiles, 51 avatar images and 17 current GIF
avatars (about 24.8 MB of GIF source data). The latest 200 public messages
contained 11 GIFs, 5 images, 7 stickers and 177 text messages. Recent traffic
was 48 messages from four senders in 30 minutes. These are aggregate workload
observations, not proof that a particular person's image caused their spikes.

## Confirmed costs and changes

1. **Scroll layout work:** a native trace attributed roughly 20 ms of forced
   layout to individual timeline scroll callbacks under 4x CPU throttling.
   Message insertion also synchronously pinned and started nine more settling
   frames. Geometry reads now happen together in a scheduled frame; resize and
   message requests share one pin. Scrolling up cancels queued work. Explicit Latest/conversation navigation also clears a pending history anchor hold. The generic
   scroll listener no longer races the timeline's class/timer handling.
2. **History rebuilds:** each older page rebuilt all existing message HTML,
   restarted images/previews, and allowed histories to grow without a bound.
   Paging now retains keyed nodes and caps the window at 200 rows (120 in lite
   mode), with older/newer pagination preserving access to the remaining rows.
   The live cache remains separate. A member reading above the latest messages
   keeps that page while incoming rows update the bounded live cache and badge.
3. **Profile rebuilds:** saving a profile rebuilt the entire timeline, even for
   a bio edit. Identity updates now patch the author name, badges, avatar and
   ring in place. Bio, banner and unrelated metadata no longer invalidate
   message bodies. Noelle's mirrored profile and open bio card still update.
4. **Animated media:** native lazy loading does not guarantee that already
   loaded, nearby animated images stop consuming resources. The old observer
   controlled rings only. The visibility controller now covers avatars and
   message media, preserving source, node identity and layout while suppressing
   offscreen/hidden-tab image visibility. Unsupported browsers retain the
   normal rendering fallback.
5. **Composer:** supported browsers use CSS `field-sizing: content`, with the
   existing JavaScript sizing fallback retained. A timeline ResizeObserver
   handles the viewport change when the composer grows.

## Browser measurements

The harness runs a normal signed-in application boot using an offline Supabase
fixture, actual subscriptions/callbacks and timers, three live members, 71
profiles, 17 representative 200×200 animated GIF sources, mixed media/text,
and a 1366×768 viewport. Chromium 153 ran with 4x CPU throttling and software
graphics. CPU/layout/GC/compositor tracing, long tasks, long animation frames
and RAF gaps were captured. The control and revised sources used the same
fixture and were run sequentially.

| Workload | Before p95 / worst frame | Revised p95 / worst frame |
| --- | --- | --- |
| Idle, backgrounds Off | 16.8 / 66.7 ms | 16.8 / 16.8 ms |
| Incoming messages | 50.0 / 66.6 ms | 16.8 / 49.9 ms |
| Three history pages | 83.4 / 400.0 ms | 16.8 / 166.6 ms |
| Typing after history load | 83.4 / 150.0 ms | 16.8 / 50.0 ms |
| Presence payloads and focus/wake | 66.8 / 83.4 ms | 16.8 / 33.4 ms |

Three history renders consumed 611.8 ms of synchronous rendering before and
213.6 ms afterward. Eighteen composer updates consumed 79.7 ms before and
3.1 ms afterward; layout count fell from 37 to 18. A separate 60-second run
delivered 1,000 further messages while reading history: live cache 250,
history/mounted rows 200, p95 16.7 ms, worst RAF gap 33.4 ms, no long JavaScript
tasks, and one nonblocking long-animation-frame entry.

These are laboratory measurements, not a claim about physical Chromebook FPS.
History loading still has measurable pauses. Disabling rings alone did not
eliminate all software-graphics stalls; hiding images as a diagnostic control
did. Keep those observations separate from attribution to one exact device,
image or driver. The user's remaining on-device spikes cannot be declared
eliminated from these tests alone.

## Verification and reproduction

`npm test` covers scrolling cancellation/coalescing, native composer sizing,
history window bounds and retained live aliases, media visibility cleanup,
metadata-only profile changes, diagnostics bounds/privacy and the existing
auth, permission, voice, polling, background and Noelle behavior suites.
`node scripts/validate-deployments.mjs` checks the eight deployment artifacts.

The browser harness requires Playwright, a Chromium executable and a directory
of representative animated GIF test assets. It intercepts all network access;
it does not sign into or send traffic to production. Asset files and raw traces
are intentionally not committed.

```sh
CHAT_BROWSER_PATH=/path/to/chromium \
CHAT_MEDIA_DIR=/path/to/gif-test-assets \
CHAT_AUDIT_OUTPUT=/tmp/chat-audit \
node scripts/chat-runtime.browser.mjs Chat/chat.html revised --realistic --verify
```

Use `--quick` for shorter intervals. Omit `--verify` when benchmarking an older
source without the new bounds/diagnostics. `--verify` also checks retained
message/image identity, late image loading, composer resize, scroll cancellation,
full-resolution visibility restoration, a deliberate known freeze, recording
start/stop, download cleanup, and troubleshooting layout at 320 and 1536 px.
Add `--launcher` to run inside the actual launcher, including its loader and
handshake; only backend responses are replaced with fixtures.

Run the fast native observer regression separately, using the actual browser
executable rather than only a Chrome user-agent string:

```sh
CHAT_BROWSER_PATH=/path/to/chromium node scripts/chat-diagnostics.browser.mjs
```

The 2.24.4 full unit suite passes 165 tests; deployment validation checks all
eight HTML artifacts. No raw user reports, profile media URLs or local browser
assets are committed.

## On-device evidence

After reopening Chat on 2.24.4, use Settings → Security → Troubleshooting →
**Record frames (60s)**, return to Chat and reproduce the spike, then choose
**Download performance report**. Download stops an active recording. It can
also export passive long-frame/task timings when frame recording is Off.
Both passive lists retain at most 120 entries, with five script timing
summaries per frame and 64 recent operation markers. Hidden-tab observations
are excluded. The report contains version, relative timings, device/rendering
settings, observation coverage and aggregate resource counts; no messages,
usernames, profile URLs, tokens or stored drafts. There is no network uploader.
An unsupported long-frame count is `null`, rather than a misleading zero.

Relevant platform references: [long animation frames](https://developer.chrome.com/docs/web-platform/long-animation-frames),
[same-origin root reporting](https://www.w3.org/TR/long-animation-frames/#sec-limitations),
[content visibility](https://web.dev/articles/content-visibility), and
[native field sizing](https://developer.chrome.com/docs/css-ui/css-field-sizing).
