/** Remote pinned functions/catalog; only the HTTP transport is configured here. */
import { FunctionRegistry, ReadOnlyCatalogInterface, Worker } from '@query-farm/vgi';
import { makeWisdomtreeGet } from './src/client.ts';
import { makeProductsScan, makeHoldingsScan } from './src/functions.ts';
import { makeCatalog } from './src/catalog.ts';
import { readFileSync, appendFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
const mode=process.env.NOTEBOOK_WISDOMTREE_DATA_MODE;
if(mode!=='recorded'&&mode!=='live')throw Error('Choose recorded or live in the notebook');
let client;
if(mode==='live'){
  client=makeWisdomtreeGet();
}else{
  const directory=process.env.NOTEBOOK_WISDOMTREE_RECORDINGS;
  const audit=process.env.NOTEBOOK_WISDOMTREE_AUDIT;
  if(!directory||!audit)throw Error('Notebook recording paths are required');
  const manifest=JSON.parse(readFileSync(join(directory,'manifest.json'),'utf8'));
  const responses=new Map<string,Buffer>();
  for(const record of manifest.records){
    const bytes=readFileSync(join(directory,record.file));
    if(createHash('sha256').update(bytes).digest('hex')!==record.sha256)throw Error('Recording hash mismatch');
    responses.set(record.url,bytes);
  }
  client=makeWisdomtreeGet(async(input,init)=>{
    const url=String(input);
    if(init?.method&&init.method!=='GET')throw Error('Read-only recordings accept GET');
    const bytes=responses.get(url);if(!bytes)throw Error(`Unrecorded request: ${url}`);
    appendFileSync(audit,JSON.stringify({url})+'\n');
    return new Response(bytes,{status:200});
  });
}
const products=makeProductsScan(client);const holdings=makeHoldingsScan(client);
const registry=new FunctionRegistry();registry.register(products);registry.register(holdings);
const catalogInterface=new ReadOnlyCatalogInterface(makeCatalog([],products,holdings),registry);
new Worker({functions:[products,holdings],catalogInterface}).run();
