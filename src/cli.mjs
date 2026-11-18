import { absoluteReport, relativeReports, keyboardReport, controlReport, pixelToAbsolute } from './reports.mjs';

try {
  const [command, json] = process.argv.slice(2);
  if (command !== 'plan' || !json) throw new Error('Usage: node src/cli.mjs plan \'{"type":"relative","dx":10,"dy":-5}\'');
  const { type, viewport, ...options } = JSON.parse(json);
  let reports;
  if (type === 'relative') reports = relativeReports(options);
  else if (type === 'absolute') reports = [absoluteReport(viewport ? { ...options, ...pixelToAbsolute(options, viewport) } : options)];
  else if (type === 'keyboard') reports = [keyboardReport(options)];
  else throw new Error('type must be relative, absolute, or keyboard');
  console.log(JSON.stringify({ mode: 'plan', inputSent: false, reportCount: reports.length, reports: reports.map(r => ({ input: r.toString('hex'), control: controlReport(r).toString('hex') })) }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
