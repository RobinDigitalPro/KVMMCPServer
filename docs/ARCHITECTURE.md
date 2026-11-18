# Local controller architecture

The stdio adapter uses the official MCP SDK for message validation, tool schemas,
protocol compatibility and cancellation. It forwards only the eleven declared
desktop tools to a shared local controller. No arbitrary command execution is
accepted by that controller.

Each adapter has its own internal TCP connection and a server-issued random
connection ID. A lease binds its opaque token to that connection. Human-readable
agent, owner and job labels help monitoring; they do not establish identities or
per-role permissions. All authorized local adapters currently have the same
eleven tools. Windows accounts and the agent's surrounding execution policy
remain the access boundaries.

The controller binds an ephemeral port on 127.0.0.1 only. Its random 256-bit
credential and endpoint metadata are in the private controller/ directory.
The local hello exchanges nonce-bound HMAC proofs of that credential in both
directions; it does not transmit the credential itself.
On Windows the directory has inheritable grants only for the current user's
SID and SYSTEM, with inherited permissions removed on that directory alone.
The share root and other directories are not modified. On other platforms the
test directory uses 0700. Do not publish or distribute the credential directory.

An exclusive startup lock and the native session mutex prevent duplicate live
controllers/helpers. Concurrent adapter startup is tested. The first live
adapter can autostart a detached, hidden controller as the current interactive
user. Subsequent adapters attach to it. It is not a Windows Session 0 service.
Closing one adapter releases its held input but leaves the controller available
for the others. Management shutdown closes connections and releases the helper.
The adapter reconnects for status/acquisition after controller loss, but never
retries submitted input. Old connection tokens cannot control the replacement.

HidSession serializes complete input operations and verifies expiry between
split packets. Operator stop is marked synchronously; its neutral cleanup waits
only for the current packet acknowledgement, not for remaining movement packets
or a screenshot. Capture has a separate abortable process and rechecks the lease
after completion. A late cancellation cannot release a newer lease.

Operator stop is saved atomically with file flush before a successful stop
response. A restarted controller reads it before opening the HID helper. Native
faults, session changes and hotkey stops also persist a stop. The CLI can write
the stop state even when the controller is offline; the controller polls it
while running. Normal shutdown does not clear the stop. Resume is an explicit
local management action after shutdown and is absent from MCP and broker RPC.

The native helper uses a monotonic two-second heartbeat watchdog, physical
console/default-desktop guards and neutral cleanup. The unchanged driver has an
independent three-second watchdog. Held-key release was observed independently
in both watchdog failure modes. This does not establish recovery from all OS,
power, hardware or kernel failures.

Before opening a new helper session, startup waits 3.5 seconds while holding the
native mutex and sending no heartbeats. This lets the installed driver's
watchdog clear previous held state before a new controller can refresh it.
Live transport requires the OpenDesktopHID watchdog driver version 0x0100;
an unrelated legacy vmulti driver is not an equivalent recovery backend.

live-status.json updates about every 250 ms. events.jsonl records connection,
lease and action metadata, omitting credentials, lease tokens and raw key values.
Screenshots are operational artifacts. status.json is the separate verification
snapshot. Source, dependencies and setup live outside the operational data root.

This version targets the physical console only. It does not implement RDP input,
secure-desktop interaction, multi-monitor capture, an authenticated remote MCP
endpoint, or an audited Windows-user device ACL policy. Display
variants, elevated apps, physical takeover and Driver Verifier remain acceptance
work described in ACCEPTANCE.md.

## Screenshot and recording worker (0.3.0)

An optional persistent ScreenCapture.exe, beside the HID helper, owns DXGI
Desktop Duplication and uses WIC for PNG/JPEG and Media Foundation for H.264/MP4.
It is an ordinary user-mode child with private stdin/stdout pipes and no network
listener. No kernel-driver change is involved. See SCREEN_CAPTURE.md.

The controller authorizes recording start with its existing input lease, then
binds the recording lifecycle to the requesting connection separately from
input. Releasing/expiring the input lease does not end recording. Only that
connection can inspect/stop its most recent recording; disconnect, shutdown and
operator stop terminate it. A pending start is also cleaned up after cancellation.
The native worker rejects durations above 600 seconds and uses a monotonic
deadline, session/default-desktop guards, parent EOF detection and a five-second
heartbeat watchdog. Encoder errors leave explicit finalization state. MP4s and
JSON receipts are external artifacts; frame data is never put in the event log.
