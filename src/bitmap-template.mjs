import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const signature=Buffer.from('89504e470d0a1a0a','hex');
// Keep lossless pixel chunks only. No metadata, arbitrary paths or animated PNG.
export function decodeTemplate(encoded,maximum){
  if(typeof encoded!=='string'||encoded.length>43692||!encoded.length||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw Error('Bitmap must be canonical PNG base64, maximum 32 KiB');
  const data=Buffer.from(encoded,'base64');
  if(data.length>32768||data.toString('base64')!==encoded||data.length<45||!data.subarray(0,8).equals(signature))throw Error('Invalid PNG bitmap');
  let offset=8,width,height,ended=false;const chunks=[signature];
  while(offset<data.length){
    if(offset+12>data.length)throw Error('Truncated PNG chunk');const size=data.readUInt32BE(offset),end=offset+12+size;
    if(end>data.length)throw Error('Truncated PNG data');const type=data.toString('ascii',offset+4,offset+8);
    if(offset===8&&type!=='IHDR')throw Error('PNG IHDR required');
    if(type==='IHDR'){
      if(offset!==8||size!==13)throw Error('Invalid PNG IHDR');width=data.readUInt32BE(offset+8);height=data.readUInt32BE(offset+12);
      if(width<2||height<2||width>maximum||height>maximum)throw Error(`Bitmap must be 2..${maximum} pixels in each dimension`);
    }
    if(type==='acTL'||type==='fcTL'||type==='fdAT')throw Error('Animated PNG is unsupported');
    if(['IHDR','PLTE','tRNS','IDAT','IEND'].includes(type))chunks.push(data.subarray(offset,end));
    else if(/^[A-Z]/.test(type))throw Error('Unsupported critical PNG chunk');
    offset=end;if(type==='IEND'){if(size||offset!==data.length)throw Error('Invalid PNG end');ended=true;break;}
  }
  if(!ended||!chunks.some(x=>x.toString('ascii',4,8)==='IDAT'))throw Error('Incomplete PNG bitmap');
  return {bytes:Buffer.concat(chunks),width,height};
}
export async function withTemplate(root,options,maximum,action){
  const image=decodeTemplate(options.bitmapPngBase64,maximum);
  const anchor=options.anchor??{x:Math.floor(image.width/2),y:Math.floor(image.height/2)};
  if(anchor.x>=image.width||anchor.y>=image.height||anchor.x<0||anchor.y<0)throw Error('Anchor is outside the bitmap');
  const folder=path.join(root,'templates');await fs.mkdir(folder,{recursive:true});const templateId=randomUUID(),file=path.join(folder,templateId+'.png');
  await fs.writeFile(file,image.bytes,{flag:'wx',mode:0o600});
  try{return await action(templateId,anchor);}finally{await fs.rm(file,{force:true});}
}
