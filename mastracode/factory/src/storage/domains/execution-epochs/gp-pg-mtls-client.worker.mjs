// Test-only separate-OS-process mTLS client. No production keys.
import { X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
const input=JSON.parse(process.env.FACTORY_GP_PG_TLS_TEST_INPUT??'null');
if(!input)throw new Error('isolated TLS worker input required');
const u=new URL('https://127.0.0.1:'+input.port+'/private/gp-pg/v1/'+input.body.kind);
const data=JSON.stringify(input.body);
const req=httpsRequest(u,{
  method:'POST',servername:'factory.local',rejectUnauthorized:true,
  ca:input.ca,key:input.key,cert:input.cert,timeout:3000,
  headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)},
  checkServerIdentity(_name,peer){
    const actual=new X509Certificate(peer.raw).fingerprint256.replaceAll(':','').toLowerCase();
    return actual===input.serverPin?undefined:new Error('factory test TLS pin mismatch');
  }
},res=>{
  let body='';res.on('data',chunk=>body+=chunk);
  res.on('end',()=>process.stdout.write('ACK:'+JSON.stringify({
    http:res.statusCode,body:JSON.parse(body||'null')
  })+'\n'));
});
req.on('error',error=>{process.stdout.write('ERROR:'+error.message+'\n');process.exitCode=4;});
req.once('timeout',()=>req.destroy(new Error('test TLS timeout')));
req.end(data);
