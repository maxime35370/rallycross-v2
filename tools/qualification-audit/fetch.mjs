// Config lue dans js/firebase.js : pas de duplication de la cle projet.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const FB = readFileSync(new URL('../../js/firebase.js', import.meta.url), 'utf8');
const pick = k => (FB.match(new RegExp(k + '\\s*:\\s*"([^"]+)"')) || [])[1];
const KEY = pick('apiKey'), PROJECT = pick('projectId');
if (!KEY || !PROJECT) throw new Error('config Firebase introuvable dans js/firebase.js');
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function unwrap(v){
  if(v==null) return null;
  if('stringValue' in v) return v.stringValue;
  if('integerValue' in v) return Number(v.integerValue);
  if('doubleValue' in v) return v.doubleValue;
  if('booleanValue' in v) return v.booleanValue;
  if('nullValue' in v) return null;
  if('timestampValue' in v) return v.timestampValue;
  if('arrayValue' in v) return (v.arrayValue.values||[]).map(unwrap);
  if('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields||{}).map(([k,x])=>[k,unwrap(x)]));
  return null;
}
function doc2obj(d){
  const o={id:d.name.split('/').pop()};
  for(const [k,v] of Object.entries(d.fields||{})) o[k]=unwrap(v);
  return o;
}
async function fetchAll(col){
  let out=[], token=null, page=0;
  do{
    const url=`${BASE}/${col}?pageSize=300&key=${KEY}`+(token?`&pageToken=${encodeURIComponent(token)}`:'');
    const r=await fetch(url);
    if(!r.ok) throw new Error(col+' HTTP '+r.status+' '+(await r.text()).slice(0,300));
    const j=await r.json();
    (j.documents||[]).forEach(d=>out.push(doc2obj(d)));
    token=j.nextPageToken||null;
    page++;
    if(page%10===0) process.stderr.write(`  ${col}: ${out.length}\n`);
  }while(token);
  return out;
}
mkdirSync(new URL('./data/', import.meta.url), { recursive: true });
const cols=process.argv.slice(2);
for(const c of cols){
  const t=Date.now();
  const rows=await fetchAll(c);
  writeFileSync(new URL(`./data/${c}.json`, import.meta.url), JSON.stringify(rows));
  console.log(`${c}: ${rows.length} docs (${((Date.now()-t)/1000).toFixed(1)}s)`);
}
