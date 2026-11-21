# Desktop acceptance

## CPU bitmap tracking, 0.10.0

The suite passes 97 JavaScript/MCP tests. Native bitmap/source/history self-tests
pass 7/11/7 checks without opening capture or injecting input. The native build
uses C++17 /W4 /WX /O2. No kernel or SYSTEM-service update is required.

The existing main chat executed the real official SDK -> stdio MCP -> isolated
broker -> native graphics route with a 48x48 software-cursor template and a
128x128 tracking readback. Over 60 seconds the final binary processed 2,854
observations (47.57/s), with warm matching p95 0.235 ms and measurement-age p95
34 ms. Cumulative-counter CPU averaged 0.872% of host capacity; the maximum
rolling ten-second value was 1.172%, and the short-window peak was 2.070%.
Private memory peaked at 44.5 MB. Every predefined performance gate passed. The runner checked
the actual inherited calling-chat identity; it was not overridden by the test.

The same run verified exact source-relative XY, PNG dimension rejection,
connection ownership, survival after input lease release, recording/buffer
sharing, decoded media, loss without automatic full search, explicit lost
recovery, ambiguity, idempotent stop and cleanup on disconnect. HID writes were
suppressed; these observations do not prove game-specific cursor delivery.
The adapter was NVIDIA GeForce GTX 1060 6GB with native D3D11 fence completion.

Failed attempts are retained: one restricted-account run could not initialize
Windows.Graphics.Capture, and early candidates exceeded sustained CPU limits.
An initial media-sharing test also observed an unexpected extra full search;
the stricter follow-up and main-chat run assert uninterrupted tracking during
sharing without calling locate to recover. The source regression also caught
an immediate-minimize cached-frame return: full-source requests now validate
window state directly, while ROI tracking keeps its bounded periodic health
check. All 13 capture-source regression cases passed, including the nine
snapshot/recording/buffer pixel combinations. Main-chat evidence is stored outside
the repository under tests/tracking-0.10/main-acceptance-final; source regression
evidence is in final-capture-regression-2. These measurements
describe this workstation and fixture, not every application or hardware setup.

See [bitmap API, limits and reproduction](BITMAP_TRACKING.md).

## Capture sources, 0.9.1

The JavaScript/MCP suite passes 94 tests. Native source-contract self-tests pass
11 checks and encoded-history checks pass seven, without opening HID/capture.
The new combined-history checks prevent a clip boundary from excluding its
first complete video keyframe while retaining only audio packets.

All nine native source/media combinations passed with a dedicated non-activating
fixture: fullscreen/window/region snapshots, finalized decoded MP4 recordings,
and decoded recent-buffer exports. The tests also verify same-source sharing,
different-source refusal during capture, invalid bounds, minimized windows,
recovery and a finalized recording stopped on resize. All nine combinations now
check the fixture's expected RGB patch/background values: exact PNG pixels and
bounded codec tolerance for decoded video/buffer pixels, including client cropping.

The actual official SDK/stdio/broker/native route captured all three snapshot
sources, finalized and decoded a 60-second window recording with 300 video frames
and real system-loopback audio, and decoded both tracks of a combined window
buffer export. Tests suppress HID writes; no user application input is injected.
Host receipts and timings are external under `tests/capture-sources-0.9.0`.

The worker still enforces its CPU/private-memory limits. The kernel and UAC
service were not changed. [Capture source usage](CAPTURE_SOURCES.md) describes
supported formats, source lifetimes, geometry, audio scope and frame freshness.

The initial 0.9.0 checks missed black first frames: decoding and dimensions alone
do not prove picture content. A measured initial DXGI pointer-only update had no
desktop presentation. 0.9.1 waits for a real first content frame, reuses only an
existing content frame for pointer updates, and retains DXGI ownership through
GPU readback. Failed receipts are retained; corrected pixel checks passed in
`pixel-matrix-2` and a fresh minute MCP run in `mcp-pointer-fix`.

## Relative mouse release, 0.8.1

The isolated suite passes 91 JavaScript/MCP tests. The native helper passes 35
self-checks without opening HID, including twelve checks of its actual
Send/Release implementation through an in-memory writer. New tests cover stale
absolute coordinates after relative clicks, completed absolute clicks, previous
owners, distinct held mouse collections, desktop resets, uncertain down/up
writes and continued/retryable release after failure. Held absolute buttons
still release at the intended position; completed absolute movement/clicks no
longer cause an absolute report during release.

The kernel watchdog and UAC-service installation are unchanged. On-host
acceptance uses a dedicated observed receiver and stores receipts outside the
repository. A packet-level proof does not by itself prove guest game-cursor
behavior; any guest-specific observation must be reported separately.

Seven on-host acceptance cases passed through two real official SDK/MCP clients:
five alternating-owner relative clicks each incremented the receiver's click
counter, moved the physical cursor, emitted no absolute Raw Input, and preserved
the exact cursor position across release. An actually held absolute button still
produced its required absolute button-up. Cancelling during the local pause
released the lease without a click or absolute replay. These checks use the
physical console and our own receiver, not the virtual-machine guest/game cursor.

The capture-source proposal was implemented subsequently in 0.9.0.

## Relative gestures and recent-media buffer, 0.8.0

The ordinary suite passes 83 JavaScript tests, including both gestures,
cancellation/expiry/lost acknowledgements, buffer ownership/lifetime, serialized
recording preemption, invalid requests, event delivery, queue capacity and
disconnect cleanup. A failed media state leaves healthy input usable.

The native capture executable builds with C++17 /W4 /WX. Five native history
checks cover time eviction, 32 MiB encoded byte eviction, invalid timestamps,
oversized packets and low-memory admission. Native synthetic acceptance passes
all nine audio/video/combined and light/standard/high combinations. Combined
buffers run 35 seconds each; 5/15/30-second exports and a running-buffer export
are produced without re-encoding. Media Foundation independently decodes every
export to end-of-stream. Video/combined have decodable H.264; audio/combined
have 48 kHz stereo AAC; video-only has no audio.

The worker reports OS CPU/private-commit limits active in every case. Synthetic
combined private memory was approximately 77/91/119 MiB for light/standard/high;
retained history stayed below 32 MiB and available history below 30 seconds.
The high-profile 30-second request produced about 29.07 seconds after keyframe
alignment. These are synthetic measurements, not GPU/build-load guarantees.
Reproduce with scripts/Test-MediaBuffer.mjs and a new external output directory.

Live host acceptance is performed separately after the main chat's explicit
maintenance checkpoint. No HID kernel or SYSTEM UAC-service update is required.
The live receiver observed a relative move-click (100 ms pause/50 ms hold),
17 selected characters after a 500 ms relative drag, and neutral release after
SDK cancellation. All 23 tools were discovered by the official SDK adapter.
The actual NativeTransport is additionally tested with isolated fake processes:
an encoder fault keeps the HID connection healthy and a fresh observation
recreates media; a HID fault still calls the controller stop path.

On-host audio/video/combined buffers also passed through the official stdio MCP
adapter. A combined buffer ran over 35 seconds and exported 5/15/30-second clips
with decodable video and actual system-loopback audio (a quiet test tone).
Retained history was about 29.33 seconds; live private memory was approximately
12/92/120 MiB for the tested audio/light-video/standard-combined modes. CPU is
workload-dependent; the combined case approached its 5% hard cap.

A recording start stopped that buffer with `recording_started`, and buffer
startup was refused while recording. The full 60-second 1280x720 recording
finalized correctly, with system audio and 509 fully decodable video frames.
The hard CPU ceiling can lower actual frame rate. A too-aggressive soft CPU
auto-stop on ordinary recordings was removed; background buffers still stop
on sustained CPU pressure, while all media retains the hard job limits.

Host-specific receipts are external: native-buffer-acceptance.json,
gestures-live-acceptance.json and live-buffer-acceptance.json. No screenshots,
recordings, host credentials or personal paths are published in this repository.

## Bounded native text-plan replies, 0.7.2

A 78-unit string reproduced the old native JavaScriptSerializer exception without
opening the HID device. Its actual live-protocol plan required 2111 JSON
characters, beyond the former 2048-character response limit. Planning failed
before the session could send its first text stroke; the resulting transport
failure correctly latched the controller stop.

The response limit is now 65536 JSON characters, with unchanged 8192-character
requests. Native planning also enforces 1024 normalized UTF-16 units and at most
2048 strokes. A synthetic worst-case full response takes 55510 characters. Plan
serialization failures are classified before output as no-input refusals;
unknown device/transport failures retain the existing stop behavior.

The native self-test passed 23 checks, including the complete maximum reply,
roundtrip and oversized-reply refusal. Seven read-only Windows planner cases
passed: short/78-unit/1024-unit ASCII, 1024 accented characters (2048 strokes),
and refusal of oversized, unsupported and normalization-expanding input. All
67 JavaScript/MCP regression tests passed. These tests do not claim that the
receiving application consumed typed text; that is checked separately on-host.

The on-host MCP test then typed the exact original 78-unit string into our own
visually checked receiver with Belgian (Period), interval 15 ms. The receiver's
actual text matched exactly. A 1025-unit request was refused with the field
unchanged; a native unsupported-Unicode refusal also left it unchanged. A
subsequent `MCP` typed successfully through the same live controller. Status
confirmed helper connected, physical-console session matched, and no stop/fault.
The failed text action was not replayed into its original application.

## Local operator UAC consent, service policy 0.8.0

On 2026-11-20 the protected service was updated and its status reported
`consentPolicy: recognized_prompt`, `policyVersion: 0.8.0`. Controller/MCP remains
0.7.1. The user explicitly requested removal of the per-executable allowlist.

A copy of the harmless elevated-token probe at a nonregistered operational
path was launched through ordinary Windows RunAs. A real `hid_capture` returned
its Winlogon consent screenshot. The actual MCP `hid_click` on Yes returned
`inputSent: true`, `secureConsent: true`; the program exited with code 0.
An earlier off-button click was refused without input or a controller fault.
The post-click capture returned to Default, and the lease was released.
The probe changes no host configuration. Initial bootstrap installation was
separate from this normal-MCP acceptance test.

Host receipts stay in the operational data directory, not the public repository.
No Windows UAC policy was disabled. Existing stale-prompt, caller/session,
deadline, credential and operator-stop checks remain in the code. Physical
Ctrl+Alt+F12 on Winlogon still requires the previously documented manual test.

## Base-layout detection correction, 0.7.1

An additional test after reloading the Codex MCP connection caught a false IME
classification of Belgian (Period). No input was sent on that refusal. The
planner now restricts mapping to loaded base layouts and checks for an associated
IME file instead of rejecting ordinary layouts on `ImmIsIME` alone. This Windows
compatibility issue is also described in the
[Chromium input implementation](https://chromium.googlesource.com/chromium/src/+/5e16d46c92747ae76914b9a5db114a19cdb00bde/ui/base/ime/win/imm32_manager.cc).
Layout variants and composition input remain unsupported.

The corrected executable passed nineteen native checks, including base/variant
classification, and the suite passed all 67 JavaScript tests. A fresh physical
MCP test matched the 59-character sample beginning with `MCP` exactly, followed
by the same accent, AltGr, Caps Lock, chord, click and refusal checks below.
The original Caps Lock state was restored. Agent documentation and the raw
keyboard tool description now explicitly distinguish held keys (which can
auto-repeat across tool round trips) from locally timed text and taps.

## Text, chords and atomic clicks, 0.7.0

The suite has 67 passing JavaScript tests and nineteen native checks. Three
tools add Windows-layout HID text, locally timed chords and single-call mouse
clicks. The SYSTEM consent service and kernel driver are unchanged.

A physical-console MCP test in our own foreground receiver matched the complete
55-character sample, including Belgian (Period) letters/digits, AltGr symbols
(`@`, euro, backslash, brackets and braces), direct accents, composed dead-key
accents (`êëôûï`), literal accents, Enter and Tab. A second mixed-case sample
matched with Caps Lock enabled; the original lock state was restored. Ctrl+Alt
completed, Ctrl+A selected the entire sample, and explicit-position/current-
position clicks each activated the receiver's test button once. An unsupported
emoji string was refused before its ordinary-text prefix could be typed.

`scripts/Test-ConvenienceInput.mjs --live ABS_HID_EXE ABS_OBSERVER_EXE ABS_DATA_ROOT`
reproduces this explicit test using the receiver built by `Build-Observer.ps1`.
Inspect its screenshot before sending `run`. The test uses an isolated data
root, ordinary user rights, and a topmost receiver above the paused target.
It never types into the paused application. A startup-failure regression also
checks that failed status publication closes the native transport.

## Individual keys and local timing, 0.6.0

The JavaScript suite has 55 passing tests. The official MCP SDK discovers all
fourteen tools and calls key down/up/press. Regression checks cover modifier
composition, six-key rollover, invalid durations, insufficient lease time,
cancellation, expiry, disconnect, explicit release and desktop transitions.
The unchanged HID helper passes its eighteen native wire checks.

The physical-console test used an independent foreground Raw Input receiver,
filtered to this virtual HID device. Right Shift down/up were both observed.
Timed F8 presses requested at 750 ms and 10000 ms were observed at 754.9 ms and
10017.1 ms respectively, including the entire long hold without heartbeat loss.
F8 was directed only to the empty receiver window. Timing is approximate.

Reproduce with `scripts/Build-Observer.ps1`, then run
`scripts/Test-KeyTiming.mjs --live ABS_HID_EXE ABS_OBSERVER_EXE ABS_DATA_ROOT`.
Inspect the emitted receiver screenshot before sending `run` on stdin. This
live script is excluded from ordinary tests and requires an idle controller.

## Secure desktop, 0.5.0

Actual consent screenshots, details expansion, the approved protected probe's
elevated exit code 0, refusal of an identical probe at an unapproved path, wrong
client rejection and expired screenshot refusal were verified. A ninety-second
MP4 crossed Default/UAC/Default twice, contained system playback audio and fully
decoded to 900 video frames plus 48-kHz stereo AAC. MCP emergency stop while UAC
was active released the controller and finalized the recording. Both ordinary
mouse collections worked again after returning to Default. The physical
Ctrl+Alt+F12 chord on UAC still needs a manual test; see
[secure desktop scope](SECURE_DESKTOP.md).

## System playback audio, 0.4.0

The JavaScript suite has 41 passing tests, including default-enabled system
audio, explicit opt-out and unavailable-audio metadata. The user-mode helper
builds with warnings treated as errors; the HID kernel driver is unchanged.

On 18 November 2026 the host initially had no active render endpoint. An actual
recording requested system audio by default, returned audio=false with an
unavailable reason, and still produced a finalized, decodable video. After
separate installation of the publisher's signed virtual cable, actual Windows
playback/loopback was checked:

- A five-second 1280x720 recording contained a 48-kHz stereo AAC track and 75
  video frames. A quiet test WAV was played through Windows, not supplied to the
  recording encoder; the resulting AAC decoded to end-of-stream with nonzero
  signal (observed peak 1156, normalized RMS approximately 0.0135).
- Explicit systemAudio=false produced a video-only MP4 and disabled metadata.
- A full one-minute real-loopback run completed with 900 video frames and
  2880000 submitted stereo PCM frames. AAC decoded to end-of-stream at 48 kHz,
  stereo, with test signals near 993 ms and again through 59233 ms. The decoded
  container audio duration was 60010 ms because of AAC block padding; native
  video/source duration was 60000 ms. Both early and late playback were present.
- A separately marked synthetic diagnostic tested the same muxer/clock without
  an endpoint. A pulse beginning at 500 ms and ending at 2000 ms decoded at
  approximately 499..1999 ms. This is timing/mux evidence, not real loopback
  evidence. Its source cannot be selected through MCP.
- An earlier real-loopback attempt was interrupted by DXGI display access loss;
  it finalized its partial video and captured audio. The successful retry is
  separate evidence; desktop-transition support is not claimed.

AAC block padding can extend a short container by less than one 1024-sample
block. The user-facing 600-second limit and native source-sample deadlines
remain enforced. Microphone capture and secure-desktop support were not added.
The latter has a separate [design investigation](SECURE_DESKTOP_PLAN.md).

## Screenshots and recording, 0.3.0

On 18 November 2026 the separate user-mode DXGI/WIC/Media Foundation helper
built with warnings treated as errors. The JavaScript suite has 39 passing
tests, including recording ownership, input-lease independence, cancellation
during start, disconnect cleanup, single-recorder exclusion and duration bounds.

Explicit capture-only live tests sent no mouse/keyboard input and verified:

- Full-size 1920x1080 PNG, downscaled JPEG and PNG, with source-coordinate metadata.
- Warm resized snapshots in roughly 36..83 ms in short host observations;
  first-process/startup snapshots were approximately 310..330 ms. These are
  observations on one host, not a general benchmark or latency guarantee.
- A two-second 1280x720, 15-fps recording finalized with 30 frames, and its MP4
  decoded back to a visually checked first-frame PNG. Cursor alpha was flattened
  before scaling to prevent a black cursor rectangle.
- Early stop of a request configured for 600 seconds.
- A later one-minute run through the official SDK/stdio/broker path completed
  automatically at 60000 ms. The 1280x720 MP4 was approximately 8.2 MB and a full
  decode reached end-of-stream with 900 video frames, container duration 59999 ms
  and final-frame timestamp 59933 ms. Native sample submission counted 899 frames;
  the encoded/decode frame count can differ due to media-pipeline timing.
- Direct native rejection of 601 seconds, independently of MCP validation.
- Parent-pipe EOF finalized a partial recording; missing heartbeat stopped and
  finalized a recording after approximately five seconds from the last ping.
- Two official SDK clients over stdio and the authenticated local broker saw
  eleven tools. Actual screenshots/MP4 recording completed; a second connection
  could not stop the owner's recording. Owner disconnect finalized recording.
  That isolated harness suppressed HID writes; the active desktop controller
  serving another chat was not restarted for these capture tests.

Quick acceptance uses a two-second deadline; the one-minute run is additional
duration coverage. A full ten-minute endurance
run and lock/UAC/display changes during recording remain separate acceptance.
No livestream or audio capture was added. Operational evidence stays outside Git.

## Controller/MCP 0.2.0

The installed kernel driver remains 0.1.0. User-mode controller changes use the
official MCP SDK 2.4.0 and are covered by 31 JavaScript tests plus the native
helper's 18 self-checks. Additional verified behavior:

- Two real stdio SDK clients share one local controller; concurrent startup is
  also tested in simulation.
- Leases bind to the acquiring connection; a borrowed token is refused.
- Operator stop survives controller restart and is honored from the local stop
  file independently of an MCP connection.
- Emergency stop interrupts pending capture and split movement; official SDK
  cancellation reaches the controller and releases its lease.
- A late cancellation cannot release a newer lease.
- A live physical-console SDK run received relative and absolute movement and a
  1920x1080 PNG. Disconnecting the first client independently released its held
  Shift key in 34 ms in the first 0.2.0 run.
- Local endpoint authentication rejects invalid credentials, including malformed
  Unicode input; the controller binds only 127.0.0.1.

The endpoint credential/stop state are protected for the current Windows user
and SYSTEM. That does not isolate arbitrary programs sharing the same user.
Owner/job labels are descriptive. Broader device ACL and Driver Verifier work
below remains pending.

## Driver 0.1.0 and initial host input

Measured on the physical host on 17 November 2026 with development-signed
OpenDesktopHID 0.1.0. The controller ran without an administrator token in
physical-console session 1; primary display 1920x1080. Independent Raw Input
reception and cursor measurements establish delivery, rather than a write ACK.

| Test | Result |
| --- | --- |
| JavaScript reports/descriptors/session/MCP | Passed; malformed requests, ownership, expiry and capture lease checks |
| Native wire/session checks | Passed: 18 checks |
| Portable C report contract | Passed: 12 checks |
| VHF build/signability | Passed, zero errors/warnings; warm build 5689 ms |
| Package validation/rejection | Passed: four cases, including corrupt SYS and changed manifest |
| Installation | Passed, device and collections started; no further reboot requested |
| Relative movement | Requested dx=10, dy=5 received exactly; cursor moved 10,5 in this setup |
| Absolute movement | Pixel 360,211 via HID 6147,6408; measured cursor 360,211 |
| Click and drag | Left down/up received; dx=10 drag occurred between down/up |
| Wheel | One detent received as wheel data +120 |
| Keyboard | Usage 4 make/break, scan 0x1e; Q on Belgian AZERTY |
| Modifier combination | Left Shift plus usage 4 make/break received |
| Native heartbeat loss | Held Shift released after 2106 ms; stopped/released reported |
| Kernel watchdog | Own helper forcibly terminated; independent release after 3100 ms |
| Live MCP | Eight tools; input, second owner rejected, emergency stop releases and blocks reacquisition |
| MCP capture | Valid 1920x1080 PNG visually checked; session/time/cursor metadata |
| RDP mismatch | Actual startup refused before input; physical-console run passed |
| Normal-user operation | Live helper reported administrator=false |

A prior RDP attempt acknowledged reports without delivering input to its test
window. That failure is retained in the evidence. Session guards were added
before successful console tests. Failed screenshot attempts are also retained.

## Still to validate

- Physical Ctrl+Alt+F12 takeover; API emergency stop passed separately.
- Lock/unlock and UAC transitions: predicates are tested, no live secure-desktop
  interaction was performed.
- Other display layouts/DPI, secondary displays and negative coordinates.
- Elevated applications and exclusive-fullscreen/protected-video capture.
- Power transitions, OS failures, concurrency under Driver Verifier and device
  ACL isolation between Windows users.

Keep per-run JSON, receiver logs, PNGs, host readiness, binary hashes and source
manifest in the external operational data area. The installed kernel package
remains pinned separately from subsequent user-mode helper changes.

This is a tested development prototype. Complete workstation control,
secure-desktop access and crash-proof recovery are not claimed. No production-signed driver distribution is provided.

## Direct coding-agent chat, 18 November 2026

Actual MCP tool calls in an existing local chat verified a usable 1920x1080
desktop image, relative movement from (999,507) to (1009,512), absolute movement
to (800,450), and left-button down/up at that position. Independent Raw Input
and cursor measurements confirmed delivery. This was not a standalone SDK
substitute for the chat integration.

The first image was black and is a failed observation. Later images were usable.
Focus loss caused an input batch to be released without sending a movement.
The optional keyboard step was skipped when another application was foreground.
The final lease was released and no held input remained. These findings do not
validate unattended screenshot reliability, other displays or every agent role.
