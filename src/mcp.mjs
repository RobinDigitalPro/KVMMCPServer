import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { definitions } from './tools.mjs';
import { DesktopController } from './controller.mjs';
import { LocalEndpoint } from './local-client.mjs';
import { parseOptions } from './broker.mjs';
export { tools } from './tools.mjs';

export function createMcpServer(endpoint) {
  const server = new McpServer({ name: 'open-desktop-hid', version: '0.8.1' }, {
    instructions: 'Local physical-console desktop control. Acquire a short lease, capture and inspect, perform one small action, verify, and release. Relative move-click and drag execute locally with bounded timing and release on interruption. Recordings are MP4 with system playback audio by default when available, never microphone; max 600 seconds. One optional 30-second recent-media buffer supports audio/video/combined and fixed light/standard/high profiles. Recording stops buffering first; no simultaneous buffer/recording or automatic restart. Media is connection-bound and independent of input lease release. Inspect media_buffer_status for state/reason/resources; unseen owner events appear on subsequent results, without waking the model. Respect operator stop. Owner/job labels are descriptive; do not expose tokens. No RDP backend, microphone, livestream or transcription.',
  });
  for (const { name, description, schema, annotations } of definitions) {
    server.registerTool(name, { description, inputSchema: schema, annotations },
      (args, context) => endpoint.call(name, args, { signal: context.mcpReq.signal }));
  }
  return server;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  let endpoint;
  if (options.simulated && !options.dataRoot) {
    // Isolated protocol tests. Persistent/multi-client simulation supplies a root.
    const controller = await DesktopController.create({ simulated: true });
    const client = controller.attach(options.agent ?? 'simulation');
    endpoint = { call: (name, args, context) => controller.call(client, name, args, context), close: () => controller.close() };
  } else {
    if (!options.dataRoot || (options.autostart && !options.simulated && !options.executable)) throw new Error('Usage: --simulate | --live ABSOLUTE_NATIVE_EXE --data-root ABSOLUTE_DATA_ROOT | --connect --data-root ABSOLUTE_DATA_ROOT');
    endpoint = await new LocalEndpoint(options).connect();
  }
  const server = createMcpServer(endpoint);
  let closed = false;
  const cleanup = async () => { if (closed) return; closed = true; await endpoint.close(); };
  server.server.onclose = () => { void cleanup(); };
  server.server.onerror = error => { console.error('MCP:', error.message); };
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => { void cleanup().finally(() => server.close()); });
  await server.connect(new StdioServerTransport(process.stdin, process.stdout, { maxBufferSize: 65536 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
