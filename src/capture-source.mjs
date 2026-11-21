import * as z from 'zod/v4';
export const captureSource=z.discriminatedUnion('mode',[
  z.strictObject({mode:z.literal('fullscreen'),display:z.literal('primary').optional()}),
  z.strictObject({mode:z.literal('region'),display:z.literal('primary').optional(),x:z.number().int().min(0).max(32767),y:z.number().int().min(0).max(32767),width:z.number().int().min(2).max(32768),height:z.number().int().min(2).max(32768)}),
  z.strictObject({mode:z.literal('window'),title:z.string().min(1).max(256).refine(v=>!v.includes('\0'),'NUL is not allowed'),match:z.literal('exact').optional(),area:z.enum(['client','window']).optional(),processId:z.number().int().min(1).max(4294967295).optional()}),
]);
// One bounded, newline-free private-protocol field. Window titles are UTF-8 hex.
export function sourceWire(source){
  const s=captureSource.parse(source??{mode:'fullscreen'});
  if(s.mode==='fullscreen')return 'fullscreen';
  if(s.mode==='region')return ['region',s.x,s.y,s.width,s.height].join(':');
  return ['window',s.processId??0,s.area??'client',Buffer.from(s.title,'utf8').toString('hex')].join(':');
}
