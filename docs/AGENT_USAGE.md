# Local agent use

An MCP client launches a local adapter with stdin/stdout connected:

```powershell
node D:\Source\OpenDesktopHID\src\mcp.mjs --live D:\AgentData\desktop-hid\native\HidTransport.exe --data-root D:\AgentData\desktop-hid --agent local-codex
```

Adapters share one controller. Starting another adapter does not open a second
HID helper. `--connect --data-root ...` attaches without autostart. `--simulate`
alone is an isolated protocol test; `--simulate --data-root ...` uses a shared,
persistent simulator. Use separate data roots for live and simulated controllers;
mode mismatches are refused.

For Codex registration, run the supplied installation script as the normal user:

```powershell
.\scripts\Install-McpConnection.ps1 -NodePath C:\Tools\node.exe -NativeExecutable D:\AgentData\desktop-hid\native\HidTransport.exe -DataRoot D:\AgentData\desktop-hid
```

It registers fourteen tools and leaves the client's approval policy unchanged.
Reload the client MCP connection if its catalog has not refreshed. A terminal
launch alone does not attach tools to a chat.

## One short batch

1. `hid_status`: check simulated=false, liveHelperConnected=true,
   screenCapture=true, matching native current/console sessions and no operator
   stop/fault. Owner/job labels describe the task; client identity is assigned
   by the controller. Labels are not authenticated agent identities.
2. Acquire a lease, maximum 60 seconds:

   ```json
   {"name":"hid_acquire","arguments":{"owner":"local-test","jobId":"JOB-ID","ttlMs":15000}}
   ```

3. Capture with its opaque token and inspect the image before acting:

   ```json
   {"name":"hid_capture","arguments":{"token":"LEASE_TOKEN"}}
   ```

   The response contains image content, frame ID, timestamp, bounds, cursor
   coordinates and saved path. The new capture helper supports PNG/JPEG,
   downscaling and cursor overlay. With resizing, use sourceWidth/sourceHeight
   for physical mouse coordinates. Lease validity is checked before/after capture.
4. Perform one small action; observe the actual result. A successful tool call
   means the transport accepted the request, not that the app completed a task.
5. Release, including after failure. Leases are not renewed in place.

```json
{"name":"hid_mouse_relative","arguments":{"token":"LEASE_TOKEN","dx":10,"dy":5,"buttons":0}}
{"name":"hid_mouse_absolute","arguments":{"token":"LEASE_TOKEN","x":6147,"y":6408,"buttons":0}}
{"name":"hid_mouse_relative","arguments":{"token":"LEASE_TOKEN","wheel":1,"buttons":0}}
{"name":"hid_keyboard","arguments":{"token":"LEASE_TOKEN","modifiers":2,"keys":[4]}}
{"name":"hid_keyboard","arguments":{"token":"LEASE_TOKEN","modifiers":0,"keys":[]}}
{"name":"hid_release","arguments":{"token":"LEASE_TOKEN"}}
```

Relative dx/dy are HID counts, subject to Windows pointer acceleration. Absolute
x/y use 0..32767 on the primary display. Convert physical pixels with
round(pixelX * 32767 / (width - 1)), and equivalently Y. Pixel 360,211 on
1920x1080 becomes 6147,6408. Verify cursor metadata after moving. Multi-monitor
mapping is unvalidated.

Buttons are the complete held state: left=1, right=2, middle=4. Click with 1 then
0 in the same mouse mode; drag with 1 during movement, then release. Release
before switching relative/absolute collections. Keyboard usages are physical:
usage 4 is Q on the tested Belgian AZERTY layout. Left Ctrl/Shift/Alt/GUI bits
are 1/2/4/8; right are 16/32/64/128. This version has no Unicode typing tool.

## Individual keys and timed presses

`hid_key_down` adds one held key and `hid_key_up` removes one, preserving other
held keys/modifiers. They compose with `hid_keyboard`, which still replaces the
complete keyboard state. Each tool takes `key`: physical HID usage 4..101, or
modifier usage 224..231 (left Ctrl/Shift/Alt/GUI, then right Ctrl/Shift/Alt/GUI).

```json
{"name":"hid_key_down","arguments":{"token":"LEASE_TOKEN","key":224}}
{"name":"hid_key_press","arguments":{"token":"LEASE_TOKEN","key":4,"durationMs":250}}
{"name":"hid_key_up","arguments":{"token":"LEASE_TOKEN","key":224}}
```

This holds left Ctrl, presses physical usage 4 for 250 ms, then releases Ctrl.
On Belgian AZERTY that usage is Q, so choose usages for the target's keyboard
layout. `durationMs` defaults to 100; integers 1..10000 are accepted. The lease
must cover the duration plus a 50 ms release margin. The local controller waits
between down/up; client/network latency is not used as the timer. `elapsedMs`
includes local transport acknowledgements and scheduling, so this is not hard
real-time timing. A held key may generate normal Windows key repeats.

A timed press is serialized with other input and restores the preceding keyboard
state after success. Pressing a key already held is refused. Cancellation,
owner disconnect, explicit lease release, emergency stop or lease expiry release
all input. A detected desktop transition cancels a timed hold and discards the
cached modifiers. These tools do not enter keys on UAC/credential desktops.

## Intervention, cancellation and disconnect

`hid_emergency_stop` is available from any authorized local connection. It
releases input, cancels captures and persists the stop across process restarts.
The physical Ctrl+Alt+F12 path is implemented but still needs manual acceptance.
Do not restart or reset the controller to override a user's intervention.

The local operator can stop/resume using manage.mjs; resume requires the
controller to be stopped and the explicit --confirm RESUME argument. Resume is
not available over MCP. The emergency-stop CLI also persists a stop while the
controller is offline. A running controller watches that stop file independently
of the MCP connection.

Cancellation releases the affected lease. Disconnect releases that connection's
lease; another connection cannot inject using a borrowed token. Other agents
can inspect status or request the next lease. Input batches are serialized;
emergency stop can interrupt a split batch between packets.

Native heartbeat loss releases/stops at two seconds; the VHF watchdog is
independent at three seconds. Session changes and unsupported input desktops
stop the native helper and persist a fault. With the optional 0.5.0
[UAC service](SECURE_DESKTOP.md), the normal writer pauses for real consent
dialogs. Inspect a fresh UAC screenshot, expand its details if necessary and
use an absolute left click. Yes is limited to administrator-staged path/hash
permissions; credential entry and unknown programs are refused. No automatic RDP/session transfer
is performed. Use the shared physical console and validate the chosen remote
viewer separately.

## Monitoring and trust boundary

Read live-status.json for active owner/job, last action and native health.
events.jsonl records action/result metadata without tokens or raw key contents.
Captures are saved under captures/. MP4 recordings (maximum 600 seconds)
and JSON receipts go under recordings/. Start a recording with an input lease,
then release input; the recording remains bound to that MCP connection. See
[SCREEN_CAPTURE.md](SCREEN_CAPTURE.md) for start/status/stop examples and limits.
Disconnect and emergency stop also stop recording. These files are in the operational data
root; the private controller/ directory contains the local endpoint credential
and stop state and must not be shared with other computers or published.

The adapter speaks standard stdio MCP. Internal IPC binds only 127.0.0.1 and
requires a random credential protected by the current Windows user's ACL. This
is a boundary between Windows accounts, not a sandbox between arbitrary programs
already running as that same user. There is no remote MCP gateway, host-shell
tool or automatic administrator grant. Remote Codexes submit jobs through the
existing handoff to local agents; do not launch the host EXE from another pc.

System playback audio is enabled by default when a default output is available.
Inspect recording.audioStatus/audioReason; unavailable audio leaves video
working. The recorder never opens a microphone. Explicit systemAudio=false opts
out for a particular recording. See SCREEN_CAPTURE.md for device/timing details.
