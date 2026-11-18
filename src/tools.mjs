import * as z from 'zod/v4';

const token = z.string().min(1).max(100);
const buttons = z.number().int().min(0).max(7).optional();
const count = z.number().int().min(-32767).max(32767).optional();
const coordinate = z.number().int().min(0).max(32767);
const define = (name, description, shape, readOnly = false) => ({
  name, description, schema: z.strictObject(shape),
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false },
});
export const definitions = [
  define('hid_status', 'Read controller, lease owner, job, session, last action and persistent operator-stop status. No input or screen capture.', {}, true),
  define('hid_capture', 'Capture the primary physical display as PNG with timestamp, session, pixel bounds and cursor metadata. Requires the active lease. The cursor is metadata, not drawn into the image.', { token }, true),
  define('hid_acquire', 'Acquire exclusive desktop control for a short batch, up to 60 seconds. Owner and optional jobId are descriptive labels, not authenticated identities.', { owner: z.string().trim().min(1).max(100), jobId: z.string().min(1).max(100).optional(), ttlMs: z.number().int().min(100).max(60000).optional() }),
  define('hid_mouse_relative', 'Move by relative HID counts; buttons is the complete held state (left=1/right=2/middle=4); wheel is in detents.', { token, dx: count, dy: count, wheel: count, buttons }),
  define('hid_mouse_absolute', 'Move to primary-display HID coordinates 0..32767. Release buttons before switching mouse collections. Other display layouts require calibration.', { token, x: coordinate, y: coordinate, wheel: z.number().int().min(-127).max(127).optional(), buttons }),
  define('hid_keyboard', 'Set the complete physical keyboard state: modifier bits and up to six distinct HID usages. Empty keys with modifiers=0 releases all keys. No Unicode typing.', { token, modifiers: z.number().int().min(0).max(255).optional(), keys: z.array(z.number().int().min(4).max(101)).max(6).optional() }),
  define('hid_release', 'Release this connection\'s lease and all held keys/buttons.', { token }),
  define('hid_emergency_stop', 'Release input, cancel captures and persist operator stop across controller restarts. Only explicit local operator resume can clear it.', {}),
];
export const tools = definitions.map(({ schema, ...definition }) => ({ ...definition, inputSchema: z.toJSONSchema(schema) }));
export function parseTool(name, args) {
  const definition = definitions.find(tool => tool.name === name);
  if (!definition) throw new Error('Unknown tool');
  return definition.schema.parse(args ?? {});
}
