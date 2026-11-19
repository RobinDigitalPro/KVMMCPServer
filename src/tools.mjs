import * as z from 'zod/v4';

const token = z.string().min(1).max(100);
const buttons = z.number().int().min(0).max(7).optional();
const count = z.number().int().min(-32767).max(32767).optional();
const coordinate = z.number().int().min(0).max(32767);
const key = z.union([z.number().int().min(4).max(101), z.number().int().min(224).max(231)]);
const define = (name, description, shape, readOnly = false) => ({
  name, description, schema: z.strictObject(shape),
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false },
});
export const definitions = [
  define('hid_status', 'Read controller, lease owner, job, session, last action and persistent operator-stop status. No input or screen capture.', {}, true),
  define('hid_capture', 'Capture a fresh primary-display image. PNG by default; optional JPEG, maxWidth downscaling and cursor inclusion require ScreenCapture.exe. Coordinates refer to sourceWidth/sourceHeight when resized. Requires the active input lease.', { token, format: z.enum(['png', 'jpeg']).optional(), maxWidth: z.number().int().min(320).max(3840).optional(), includeCursor: z.boolean().optional() }, true),
  define('screen_record_start', 'Start one MP4 desktop recording, with cursor and system playback audio by default when available, for at most 600 seconds. Never captures a microphone. If audio is unavailable, video continues with audioStatus/audioReason. Set systemAudio=false only to explicitly opt out. Requires an input lease to start; recording then continues independently of input lease expiry/release. Bound to this MCP connection; disconnect, emergency stop or session change stops it. Returns immediately with recordingId.', { token, maxSeconds: z.number().int().min(1).max(600).optional(), fps: z.number().int().min(1).max(30).optional(), maxWidth: z.number().int().min(320).max(3840).optional(), bitrate: z.number().int().min(1000000).max(20000000).optional(), systemAudio: z.boolean().optional() }),
  define('screen_record_status', 'Read this connection\'s most recent recording status. No input lease needed; recordingId must match. A completed result includes MP4 path, dimensions, duration and finalization state.', { recordingId: z.string().uuid() }, true),
  define('screen_record_stop', 'Stop and finalize this connection\'s recording early. No input lease needed. Idempotent after completion; the native 600-second limit also works without a stop call.', { recordingId: z.string().uuid() }),
  define('hid_acquire', 'Acquire exclusive desktop control for a short batch, up to 60 seconds. Owner and optional jobId are descriptive labels, not authenticated identities.', { owner: z.string().trim().min(1).max(100), jobId: z.string().min(1).max(100).optional(), ttlMs: z.number().int().min(100).max(60000).optional() }),
  define('hid_mouse_relative', 'Move by relative HID counts; buttons is the complete held state (left=1/right=2/middle=4); wheel is in detents.', { token, dx: count, dy: count, wheel: count, buttons }),
  define('hid_mouse_absolute', 'Move to primary-display HID coordinates 0..32767. Release buttons before switching mouse collections. Other display layouts require calibration.', { token, x: coordinate, y: coordinate, wheel: z.number().int().min(-127).max(127).optional(), buttons }),
  define('hid_keyboard', 'Set the complete physical keyboard state: modifier bits and up to six distinct HID usages. Keys remain held until replaced or released and Windows may auto-repeat them. Use hid_type_text for text or hid_key_press for a locally timed tap. Empty keys with modifiers=0 releases all keys.', { token, modifiers: z.number().int().min(0).max(255).optional(), keys: z.array(z.number().int().min(4).max(101)).max(6).optional() }),
  define('hid_key_down', 'Hold one physical HID key, preserving other held keys. key=4..101 or modifier usage 224..231. Ordinary desktop only; lease expiry/disconnect releases input.', { token, key }),
  define('hid_key_up', 'Release one physical HID key, preserving other held keys. key=4..101 or modifier usage 224..231. Ordinary desktop only.', { token, key }),
  define('hid_key_press', 'Press one physical HID key for durationMs (default 100, range 1..10000), then restore the previous keyboard state. Timing runs in the local controller and is approximate, not hard real time. Requires enough lease time; cancellation/disconnect releases input. Ordinary desktop only; key must not already be held.', { token, key, durationMs: z.number().int().min(1).max(10000).optional() }),
  define('hid_key_chord', 'Press a complete chord in one locally timed action, then restore previously held keys. keys are up to six distinct HID usages 4..101; modifiers is the existing 0..255 mask (Ctrl+Alt=5). durationMs defaults to 100, max 10000. Ordinary desktop only. Chord keys must not already be held.', { token, keys: z.array(z.number().int().min(4).max(101)).max(6).optional(), modifiers: z.number().int().min(0).max(255).optional(), durationMs: z.number().int().min(1).max(10000).optional() }),
  define('hid_type_text', 'Type 1..1024 UTF-16 units using physical HID strokes planned by Windows. layout defaults to active; Belgian (Period) or its ID 00000813 select a loaded mapping without changing host/guest layouts. Inspect and focus the intended field first. Unsupported characters fail before typing; target/layout changes interrupt without automatic retry. Ordinary desktop only; release held keyboard keys first. intervalMs defaults to 10 (0..100).', { token, text: z.string().min(1).max(1024), layout: z.string().min(1).max(80).optional(), intervalMs: z.number().int().min(0).max(100).optional() }),
  define('hid_click', 'Press and release one mouse button in one locally timed action. button defaults left; durationMs defaults 80 (1..1000). Optional x/y are absolute HID coordinates 0..32767; omit both to click at the current pointer. Release held mouse buttons first. For UAC use explicit x/y and left; existing consent rules and the service fixed click timing apply.', { token, button: z.enum(['left', 'right', 'middle']).optional(), x: coordinate.optional(), y: coordinate.optional(), durationMs: z.number().int().min(1).max(1000).optional() }),
  define('hid_release', 'Release this connection\'s lease and all held keys/buttons.', { token }),
  define('hid_emergency_stop', 'Release input, cancel captures and persist operator stop across controller restarts. Only explicit local operator resume can clear it.', {}),
];
export const tools = definitions.map(({ schema, ...definition }) => ({ ...definition, inputSchema: z.toJSONSchema(schema) }));
export function parseTool(name, args) {
  const definition = definitions.find(tool => tool.name === name);
  if (!definition) throw new Error('Unknown tool');
  return definition.schema.parse(args ?? {});
}
