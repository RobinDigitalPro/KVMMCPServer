# KVMMCPServer

Local Windows desktop control for coding agents: a stdio MCP server, shared
controller, primary-display screenshots, silent MP4 recordings up to ten minutes,
and a small KMDF/VHF keyboard/mouse
driver. Project source is MIT; dependency/protocol attribution is in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Controller/MCP **0.3.0** uses the official MCP TypeScript SDK 2.4.0. The installed
development driver remains **0.1.0**. Relative and absolute movement, click,
drag, wheel, keyboard and modifiers were independently observed on the physical
host. Two official MCP clients shared the controller and received a valid
1920x1080 PNG. Client disconnect released held Shift within 34 ms in the first
shared-controller live test. See [acceptance](docs/ACCEPTANCE.md).

This is a development release of [KVMMCPServer](https://github.com/RobinDigitalPro/KVMMCPServer), using the OpenDesktopHID driver. No production-signed driver distribution is provided. Other displays/DPI and physical
hotkey acceptance remain separate tests.

## Architecture

Local MCP clients use stdio adapters. All adapters connect to one controller,
which owns the native helper and enforces one active, connection-bound lease.
Agents on another computer use the existing task handoff to local agents.

The internal controller binds **only 127.0.0.1**, on an ephemeral TCP port, with
a random credential in its private data directory. On Windows that directory
grants access only to the current user and SYSTEM. It is local IPC, not a remote
MCP endpoint. No firewall rule or remote gateway is installed. See
[architecture](docs/ARCHITECTURE.md) for the trust and lifecycle boundaries.

## Install dependencies and run tests

Prerequisites: Node.js 22+, pnpm, Windows x64 for the native components. Copy deployment.example.json to deployment.local.json and edit your own paths and reviewed signing pins before using the local deployment convenience scripts. The generic MCP commands below do not require that local configuration file.

```powershell
pnpm install --frozen-lockfile --ignore-scripts
node --test test/reports.test.mjs
node --test test/session.test.mjs
node --test test/mcp.test.mjs test/broker.test.mjs
node --test test/recording.test.mjs
```

No ordinary test injects desktop input. Operational data belongs outside source:

```powershell
.\scripts\Test-Local.ps1 -DataRoot D:\AgentData\desktop-hid -Function all
```

The short suite has 39 JavaScript tests and 18 native HID checks. Stop the live
controller before rebuilding its executable. The driver has a separate portable
C contract (12 checks), package-validation tests (four cases), and explicit live
acceptance scripts. Live scripts are never included in the ordinary suite.

## Start a local MCP adapter

```powershell
node src/mcp.mjs --simulate
node src/mcp.mjs --live D:\AgentData\desktop-hid\native\HidTransport.exe --data-root D:\AgentData\desktop-hid --agent local-codex
```

The live adapter attaches to the existing controller or starts it hidden as the
normal interactive user. Additional adapters share that controller. Closing an
adapter releases its lease; it does not shut down the shared controller. Use
`--connect --data-root ...` to attach without autostart. An isolated `--simulate`
has no persistent data; add a separate external data root for shared simulation.

After controller loss, status/acquire calls can reconnect. Submitted input is
never retried; inspect a fresh frame and acquire a new lease. A new native helper
waits 3.5 seconds under its mutex before heartbeats, allowing the installed
driver's three-second watchdog to clear stale state from a previous helper.

Eleven tools: `hid_status`, `hid_capture`, `hid_acquire`, `hid_mouse_relative`,
`hid_mouse_absolute`, `hid_keyboard`, `hid_release`, `hid_emergency_stop`,
`screen_record_start`, `screen_record_status`, `screen_record_stop`.
Capture and input require the acquiring connection's token. The owner/job labels
are descriptive; the controller assigns the connection identity.

For faster PNG/JPEG screenshots and silent H.264/MP4 recordings, build the
persistent `ScreenCapture.exe` beside the HID helper. Recordings have a native
**600-second hard limit**, independent of the short input lease, and stop on
owner disconnect or operator/session stop. See [screen capture and demo
examples](docs/SCREEN_CAPTURE.md). There is no livestream endpoint.

```powershell
node src/manage.mjs status --data-root D:\AgentData\desktop-hid
node src/manage.mjs emergency-stop --data-root D:\AgentData\desktop-hid
node src/manage.mjs stop --data-root D:\AgentData\desktop-hid
# Explicit local operator decision, after stopping the controller:
node src/manage.mjs resume --data-root D:\AgentData\desktop-hid --confirm RESUME
```

Emergency stop survives adapter/controller restarts. It cancels captures and
interrupts split input between packets. Resume is deliberately absent from the
MCP tools. Normal shutdown does not create or clear an operator stop. Native
heartbeat loss releases/stops after two seconds; the driver has an independent
three-second watchdog. Native session/hotkey faults also persist a stop.

## Data and observation

`live-status.json` updates approximately four times per second while the
controller runs. It exposes owner/job, connection count, last action, session,
native health and persistent stop state. `events.jsonl` records actions/results
without lease tokens or raw typed keys; images are under `captures/`, MP4s and
recording receipts under `recordings/`. Recording state is included in status. A stopped
controller leaves a final running=false status. The management command also
marks an old status as stale.

Live mode requires the active physical-console session and normal Default input
desktop. RDP mismatch and secure desktops are refused. Remote viewing should
share that physical console. There is no RDP backend or automatic session
transfer. Secure-desktop access is outside this version.

Keyboard usages represent physical keys, not Unicode. Usage 4 produced Q on
Belgian AZERTY. Relative movement is in HID counts; Windows acceleration can
alter pixel movement. Absolute coordinates cover 0..32767 on the validated
primary display. The persistent capture helper uses DXGI, WIC and Media Foundation;
legacy PNG capture falls back to GDI when it is absent. Resized screenshots include
source dimensions for coordinate mapping. Multiple monitors, other DPI and exclusive-fullscreen
or protected content are not validated.

## Native and driver builds

```powershell
.\scripts\Build-Native.ps1 -OutputDirectory D:\AgentData\desktop-hid\native
.\scripts\Build-Observer.ps1 -OutputDirectory D:\AgentData\desktop-hid\native
node scripts/fetch-ewdk.mjs
# Mount the EWDK ISO read-only and use its actual drive letter:
.\scripts\Build-Driver.ps1 -EwdkRoot E:\ -OutputDirectory D:\AgentData\desktop-hid\driver
.\scripts\Build-Capture.ps1 -EwdkRoot E:\ -OutputDirectory D:\AgentData\desktop-hid\native
```

The .NET Framework compiler ships with Windows. The x64 driver uses SDK/WDK
26100; its warm build took about six seconds. Building does not install or
change boot security. Test-signing, pinned package validation and the approved
host installation are documented in [HOST_SETUP.md](docs/HOST_SETUP.md).

Use [AGENT_USAGE.md](docs/AGENT_USAGE.md) for connection and tool examples.
Keep credentials, signing keys, local deployment files, recordings, binaries and
installer ISOs outside Git. The source includes a dependency lockfile.

## Application-chat acceptance

Direct MCP calls from an existing local coding-agent chat verified primary-display
screenshots, relative movement (10,5), absolute positioning and left-button
down/up on 18 November 2026. One initial capture was black; later captures
showed the intended desktop. Always inspect fresh image content before input.
The keyboard step in that particular chat run was skipped after the test window
lost focus; the earlier independent SDK/native keyboard tests remain separate.
