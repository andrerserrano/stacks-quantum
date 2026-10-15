import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, rmSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileJournal } from '../snapshot/source/vault/src/journal.mjs';
const exec=promisify(execFile), moduleUrl=new URL('../snapshot/source/vault/src/journal.mjs',import.meta.url).href;
test('eight competing processes cannot claim one key for different digests',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'pq-audit-race-')), key='ab'.repeat(32);
  try {
    const code=`import { fileJournal } from ${JSON.stringify(moduleUrl)}; const [dir,digest]=process.argv.slice(1); const held=fileJournal(dir).claim('${key}',{digest}); console.log(JSON.stringify({won:held.digest===digest,held:held.digest}));`;
    const results=await Promise.all(Array.from({length:8},(_,i)=>exec(process.execPath,['--input-type=module','-e',code,dir,String(i)],{timeout:15000})));
    const values=results.map(r=>JSON.parse(r.stdout));assert.equal(values.filter(v=>v.won).length,1);assert.equal(new Set(values.map(v=>v.held)).size,1);
    assert.deepEqual(readdirSync(dir),[`${key}.json`]);assert.equal(statSync(join(dir,`${key}.json`)).mode&0o777,0o600);
    assert.equal(JSON.parse(readFileSync(join(dir,`${key}.json`))).digest,values[0].held);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('a corrupt existing claim stops recovery instead of overwriting history',()=>{
  const dir=mkdtempSync(join(tmpdir(),'pq-audit-corrupt-')), key='cd'.repeat(32);
  try {
    writeFileSync(join(dir,`${key}.json`),'partial',{mode:0o600});const j=fileJournal(dir);
    assert.throws(()=>j.get(key));assert.throws(()=>j.claim(key,{digest:'new'}));
    assert.equal(readFileSync(join(dir,`${key}.json`),'utf8'),'partial');
    assert.deepEqual(readdirSync(dir),[`${key}.json`]);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
