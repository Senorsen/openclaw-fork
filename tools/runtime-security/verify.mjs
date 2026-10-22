import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {brotliCompressSync, brotliDecompressSync} from 'node:zlib';
import {rootCertificates} from 'node:tls';
import {X509Certificate} from 'node:crypto';
import {execFileSync} from 'node:child_process';
assert.equal(process.version, 'v24.22.1');
const text=Buffer.from('Claw runtime security update');
assert.deepEqual(brotliDecompressSync(brotliCompressSync(text)),text);
assert(!rootCertificates.some(p=>new X509Certificate(p).subject.includes('CN=emSign ECC Root CA - G3')));
const require=createRequire('/app/package.json');
try {const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');assert.equal(db.prepare('SELECT 1 AS n').get().n,1);db.close();}catch(e){throw new Error('SQLite smoke failed: '+e.message);}
const py=execFileSync('python3',['-S','-c','import ssl,sys; c=ssl.create_default_context(); assert not any("emSign ECC Root CA - G3" in str(x["subject"]) for x in c.get_ca_certs()); print(sys.version.split()[0])'],{encoding:'utf8'}).trim();
console.log(JSON.stringify({node:process.version,python:py,caDistrust:true,brotliRoundtrip:true,sqlite:true}));
