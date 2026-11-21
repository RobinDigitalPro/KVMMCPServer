# Explicit input-helper recovery

Version 0.11.0 adds `hid_try_restart` to the ordinary local MCP catalog (28 tools).
It recovers the user-mode input helper inside the existing controller. It does
not restart Windows services, the kernel HID driver, Windows, a VM or an application.
The caller needs its existing local MCP connection, no administrator account.

Inspect `hid_status.recovery` first. After an eligible technical fault:

```json
{"name":"hid_try_restart","arguments":{}}
```

The tool closes the old helper/media resources, starts a fresh input helper,
checks the physical console, verifies three heartbeat acknowledgements and
confirms neutral input. The native startup retains its kernel-watchdog grace
period. All old leases, held states, capture context and media ownership are
discarded. No key, click, drag, text, recording, buffer or tracker is replayed.

On success `restarted` and `neutralizationConfirmed` are true. The agent must
acquire a **new lease**, request and inspect a **fresh screenshot**, then decide
what work is still needed. Input is refused until that screenshot succeeds.
Recovery cannot fix an underlying GPU-driver timeout; it only restores this
control layer after the host becomes responsive again.

Eligible reasons are `heartbeat_timeout`, a native helper exit, `write EPIPE`,
and the existing native-write timeout. Unknown faults, a session change, an
unavailable desktop, the operator hotkey, `hid_emergency_stop` and the local
emergency-stop command require explicit local operator handling. There is no
`force`, `resume` or arbitrary executable argument in the MCP tool.

One restart may run at a time. Attempts are durably limited to one per thirty
seconds and at most three per five minutes; restarting the controller does not
reset that budget. A healthy controller is a no-op, preserving its current
lease. A failed/cancelled attempt remains stopped; inspect its actual result
before trying again. A lost acknowledgement never triggers an automatic retry.

Manual stop uses a separate sticky `controller/operator-inhibit.json`. Recovery
never removes it. A manual stop arriving during helper startup cancels recovery
and wins over clearing an earlier technical fault. Only the existing explicit
local operator command clears a manual inhibit. Legacy heartbeat stop records
from earlier versions remain eligible for this migration.

`controller/recovery.json` stores the bounded retry history. `events.jsonl`
records restart started/succeeded/failed without lease tokens. These files and
the broker credential remain private operational data, outside source control.

Maintenance note: an existing stdio MCP adapter caches its tool catalog. Reload
the `opendesktophid` connection once after installing 0.11.0 to discover the new
tool. Future helper recovery itself needs no MCP reload or service operation.
