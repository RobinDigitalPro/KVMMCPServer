# Optional secure desktop / UAC support

Implementation: 0.5.0 candidate. Native builds and ordinary desktop regression
checks pass. A successful real UAC capture/consent/recording transition must be
recorded before claiming host acceptance. The first service installation needs
one manual Windows UAC approval; the extension cannot bootstrap its own rights.

## Installation

Normal MCP adapters, the shared controller, HID helper, recorder and WASAPI audio
remain ordinary user processes. The optional `KVMMCPServerSecureDesktop` service
runs as SYSTEM from `C:\Program Files\KVMMCPServer\SecureDesktop`. Its own fixed
helper runs in the active physical console session. Cross-session communication
uses a separate SYSTEM-only private named pipe, not inherited handles. A job
kills the helper when the service stops and prevents child-process creation.

Build to an external directory:

```powershell
.\scripts\Build-Native.ps1 -OutputDirectory D:\AgentData\uac-build
.\scripts\Build-Capture.ps1 -EwdkRoot E:\ -OutputDirectory D:\AgentData\uac-build
.\scripts\Build-SecureDesktop.ps1 -OutputDirectory D:\AgentData\uac-build
$hashes = @{}
foreach ($name in 'SecureDesktopBroker.exe','UacProbe.exe') {
    $hashes[$name] = (Get-FileHash -LiteralPath (Join-Path D:\AgentData\uac-build $name)).Hash
}
@{version='0.5.0';hashes=$hashes} | ConvertTo-Json |
    Set-Content -LiteralPath D:\AgentData\uac-build\secure-package.json -Encoding UTF8
```

Review the sources and exact package hashes. Stop the normal controller before
installation. From an administrator PowerShell run the following, supplying the
SID of the Windows account that actually runs the local MCP (obtain it with
`whoami /user` before elevation if elevation uses a different account):

```powershell
.\scripts\Install-SecureDesktop.ps1 -BuildDirectory D:\AgentData\uac-build `
    -OperatorSid S-1-5-21-EXAMPLE-ACCOUNT-SID
```

The installer pins copied executable hashes, restricts directory/file ownership
and permissions to administrators/SYSTEM with operator read/execute, creates a
noninteractive automatic service and starts it. No UAC policy, desktop ACL,
certificate trust or third-party driver setting is changed. Installation fails
if a service/target folder already exists; it never silently replaces a live
privileged binary. For an update, stop the controller, use the removal script,
review/retain the protected files, then prepare a reviewed replacement install.

Deploy both newly built `HidTransport.exe` and `ScreenCapture.exe` plus 0.5.0
user-mode source. Restart the normal controller after service installation or
restart. A service identity change causes control to stop, requiring the normal
explicit local resume. `hid_status.native.secureDesktopSupported` must be true
before claiming the UAC route is available. Ordinary desktop use still works
without the optional service.

## Existing agent workflow

The same eleven MCP tools remain. Acquire a short lease and inspect a fresh
`hid_capture` image. On a real Windows consent dialog it reports
`desktop="Winlogon"` and a short-lived `uacPromptId`; this is internally forwarded
to the input helper. The normal HID writer pauses, neutralizes its state and
hands off its session mutex. The service may then send a bounded one-shot VHF
mouse action. Default-desktop input resumes after the prompt closes.

For UAC, move with either mouse collection, but use an **absolute left click**
for an identified consent button. `Show more details` may be operated so the
executable location is visible. Take a new screenshot after expanding it. A
click on Yes requires that exact executable path and SHA-256 match an approved
staged application. No/Cancel can dismiss an identified prompt. A click on
another control, right click, wheel, keyboard entry, credentials, unrelated secure
desktop, stale prompt or unknown executable is refused. No denied input is
silently retried as ordinary desktop input.

Approval sends a complete click and neutralization. The caller's subsequent
mouse-up is harmless even if the prompt already closed. Take a fresh ordinary
desktop screenshot before the next action. Owner disconnect/cancellation stops
an in-flight privileged input process; the service checks caller PID/start time,
active session, prompt identity and both elapsed/UTC deadlines immediately
before input. Unknown write outcomes fault control. A pre-input policy refusal
preserves the lease so the caller can inspect a fresh frame.

The first frame from a newly created normal DXGI duplicator can still be black.
Inspect a subsequent fresh usable frame. Never treat a black/old frame as proof
of the consent dialog or of a successful click.

## Application permissions

Only the harmless protected `UacProbe.exe` is included initially. It has an
administrator manifest, checks whether its token is elevated, exits with code
0 on success and changes no host configuration. The service does not launch it
or any requested program; ordinary Windows elevation must already be pending.

To allow a real **standalone** application, an administrator must explicitly
review its source/publisher and SHA-256, stop the controller, then stage a copy:

```powershell
.\scripts\Register-SecureDesktopApplication.ps1 -Id my-installer `
    -Executable D:\ReviewedPackages\Setup.exe -Sha256 EXACT_REVIEWED_SHA256
```

Launch the protected staged copy shown by the script. A rebuild/update changes
its hash and requires a new reviewed grant. General shells, script hosts and
command interpreters are not suitable grants. The helper script rejects common
interpreter filenames. Applications with companion files, installers whose
details hide the requested executable path, other UI languages, multi-monitor
consent dialogs and credential prompts need separate validation; do not broaden
matching rules to force approval. This is an executable permission, not a
promise that every possible argument of an application is harmless.

## Recordings and operator stop

MP4 encoding and system playback audio remain under the ordinary user. During
UAC, fresh SYSTEM/GDI pixel buffers replace the DXGI image source; the service
writes no screenshots or recordings. Output stays in the configured data root.
Short transition gaps are black placeholder frames, never cached Default/UAC
images. Unavailable capture beyond the bounded grace interrupts/finalizes the
recording. Receipts report `secureDesktopFrames`, `transitionFrames` and
`desktopTransitions`. The native 600-second cap remains.

The SYSTEM helper observes Ctrl+Alt+F12 on the secure desktop and signals the
registered normal HID controller through a restricted event. That controller
persists the existing operator stop and stops recordings. The independent kernel
watchdog remains enabled. Input grants also expire and are invalidated by the
operator stop epoch. Normal MCP tools cannot clear the stop.

## Inspection, audit and removal

```powershell
Get-Service KVMMCPServerSecureDesktop
& 'C:\Program Files\KVMMCPServer\SecureDesktop\SecureDesktopBroker.exe' status
Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='KVMMCPServerSecureDesktop'}
```

The named pipe rejects remote connections and authenticates the configured
Windows SID and active physical-console session. Its PID must match the running
SCM service. Only one registered normal HID controller can submit secure input.
The public service API has no arbitrary shell, process launch, registry, general
file write or credential entry endpoint. Native controller action logs remain
in the configured runtime data root; consent actions also reach Windows Event
Log. Only the administrator-controlled setup scripts change application grants.

Stop the ordinary controller, then remove the optional service as administrator:

```powershell
.\scripts\Remove-SecureDesktop.ps1 -ConfirmControllerStopped
```

The script retains protected files for review and leaves recordings, VHF input
driver and optional third-party display/audio drivers untouched.

## Host acceptance still required

1. Read-only SYSTEM helper status and a visually verified real consent screenshot.
2. Denial of an unapproved executable, stale prompt and wrong input owner.
3. One approved, harmless probe click, with its elevated exit code checked.
4. Recording Default -> UAC -> Default, decoded video/audio and transition counts.
5. Owner disconnect/cancel, local operator stop and clean restoration of normal
   desktop control. Do not claim acceptance based on compiler/unit tests alone.
