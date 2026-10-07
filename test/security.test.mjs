import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

async function freePort() { return new Promise(resolve => {const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});}); }
async function server(withAdmin=true) {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'funding-ready-test-'));
  const port=await freePort();
  const env={...process.env,PORT:String(port),DATA_DIR:directory,ADMIN_EMAIL:withAdmin?'admin@example.test':'',ADMIN_PASSWORD:withAdmin?'synthetic-long-password-for-tests':''};
  const child=spawn('node',['node_modules/tsx/dist/cli.mjs','server.ts'],{cwd:process.cwd(),env,stdio:'ignore'});
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;i<100;i++){try{await fetch(base+'/FundingReady/');return {base,directory,child,close:()=>{child.kill();fs.rmSync(directory,{recursive:true,force:true});}};}catch{await new Promise(resolve=>setTimeout(resolve,40));}}
  child.kill();throw Error('Server did not start');
}
function client(base) {
  const cookies=new Map();
  async function call(url,{method='GET',json,form,headers={},redirect='follow',raw}={}){
    const inputHeaders={...headers};if(cookies.size) inputHeaders.cookie=[...cookies].map(([k,v])=>`${k}=${v}`).join('; ');
    let body;
    if(json!==undefined){inputHeaders['content-type']='application/json';body=JSON.stringify(json);}
    if(form){inputHeaders['content-type']='application/x-www-form-urlencoded';body=new URLSearchParams(form).toString();}
    if(raw){inputHeaders['content-type']='application/pdf';body=raw;}
    const response=await fetch(base+url,{method,headers:inputHeaders,body,redirect});
    for(const line of response.headers.getSetCookie()){const [pair]=line.split(';');const at=pair.indexOf('=');if(at>=0)cookies.set(pair.slice(0,at),pair.slice(at+1));}
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    return {status:response.status,data,headers:response.headers};
  }
  return {call,cookies};
}
function adminCsrf(html){return /name="csrf" value="([^"]+)"/.exec(html)?.[1];}
function tokenFromHtml(html){return /\/FundingReady\/access\/([A-Za-z0-9_-]{30,})/.exec(html)?.[1];}
function testProfile(){return {respondentName:'Synthetic Applicant',ngoName:'Synthetic Organisation',email:'applicant@example.test',phoneNumber:'9999999999',position:'Coordinator',entityType:'trust',registrationYear:'2020',completedFinancialYears:'3',staffing:'employees',programmeContext:'general_direct_contact',websitePresence:'no',fundingHistory:'no',fundingSources:'domestic',seekingCsr:'no',evidenceUrl:''};}

test('admin configuration and login protections',async()=>{
  const absent=await server(false);try{const visitor=client(absent.base);const page=await visitor.call('/FundingReady/admin');assert.match(page.data,/configure ADMIN_EMAIL/);const csrf=adminCsrf(page.data);const login=await visitor.call('/FundingReady/admin',{method:'POST',form:{csrf,login:'1',email:'contact@ngocompass.com',password:'admin123'},redirect:'manual'});assert.equal(login.status,503);}finally{absent.close();}
  const host=await server();try{const visitor=client(host.base);let page=await visitor.call('/FundingReady/admin');let csrf=adminCsrf(page.data);assert.ok(csrf);let noToken=await visitor.call('/FundingReady/admin',{method:'POST',form:{login:'1',email:'admin@example.test',password:'synthetic-long-password-for-tests'},redirect:'manual'});assert.equal(noToken.status,403);for(let i=0;i<5;i++){const failed=await visitor.call('/FundingReady/admin',{method:'POST',form:{csrf,login:'1',email:'admin@example.test',password:'admin123'},redirect:'manual'});assert.equal(failed.status,401);}const limited=await visitor.call('/FundingReady/admin',{method:'POST',form:{csrf,login:'1',email:'admin@example.test',password:'synthetic-long-password-for-tests'},redirect:'manual'});assert.equal(limited.status,429);}finally{host.close();}
});

test('payment entitlement, access links, validation, revisions and report protection',async()=>{
 const host=await server();try{
  const publicClient=client(host.base),admin=client(host.base),other=client(host.base);
  const boot=(await publicClient.call('/api/assessments/bootstrap')).data;const csrf=boot.csrfToken;
  assert.equal((await publicClient.call('/api/assessments',{method:'POST',json:{profile:testProfile()},headers:{'x-csrf-token':csrf}})).status,403);
  const adminPage=await admin.call('/FundingReady/admin');const aCsrf=adminCsrf(adminPage.data);
  assert.equal((await admin.call('/FundingReady/admin',{method:'POST',form:{csrf:aCsrf,login:'1',email:'admin@example.test',password:'synthetic-long-password-for-tests'},redirect:'manual'})).status,302);
  let dashboard=await admin.call('/FundingReady/admin');let token=adminCsrf(dashboard.data);
  assert.equal((await admin.call('/FundingReady/admin',{method:'POST',form:{create_manual:'1',manualNgoName:'Synthetic Organisation'},redirect:'manual'})).status,403);
  const manual=await admin.call('/FundingReady/admin',{method:'POST',form:{csrf:token,create_manual:'1',manualNgoName:'Synthetic Organisation'}});
  const accessToken=tokenFromHtml(manual.data);assert.ok(accessToken);
  const link=`/FundingReady/access/${accessToken}`;
  const [one,two]=await Promise.all([publicClient.call(link,{redirect:'manual'}),other.call(link,{redirect:'manual'})]);
  assert.equal([one,two].filter(item=>item.headers.get('location')==='/FundingReady/assessment/').length,1);
  const owner=one.headers.get('location')==='/FundingReady/assessment/'?publicClient:other;
  const outsider=owner===publicClient?other:publicClient;
  assert.equal((await outsider.call(link,{redirect:'manual'})).headers.get('location'),'/FundingReady/payment/?access=invalid');
  const ownerBoot=(await owner.call('/api/assessments/bootstrap')).data;
  const ownerCsrf=ownerBoot.csrfToken;assert.equal(ownerBoot.access,true);
  const created=await owner.call('/api/assessments',{method:'POST',json:{profile:testProfile()},headers:{'x-csrf-token':ownerCsrf}});assert.equal(created.status,200);
  const id=created.data.id;
  assert.equal((await outsider.call(`/api/assessments/${id}`)).status,404);
  assert.equal((await owner.call(`/api/assessments/${id}`,{method:'PATCH',json:{revision:0,draft:{profile:testProfile(),answers:{q999:'yes'}}},headers:{'x-csrf-token':ownerCsrf}})).status,422);
  assert.equal((await owner.call(`/api/assessments/${id}`,{method:'PATCH',json:{revision:0,draft:{profile:testProfile(),answers:{q1:'bad'}}},headers:{'x-csrf-token':ownerCsrf}})).status,422);
  assert.equal((await owner.call(`/api/assessments/${id}`,{method:'PATCH',json:{revision:0,draft:{profile:testProfile(),answers:{q1:'yes'},completed:true}},headers:{'x-csrf-token':ownerCsrf}})).status,422);
  assert.equal((await owner.call(`/api/assessments/${id}`,{method:'PATCH',json:{revision:0,draft:{profile:testProfile(),answers:{q1:'yes'}}}})).status,403);
  const saved=await owner.call(`/api/assessments/${id}`,{method:'PATCH',json:{revision:0,draft:{profile:testProfile(),answers:{q1:'yes'}}},headers:{'x-csrf-token':ownerCsrf}});assert.equal(saved.status,200);assert.equal(saved.data.revision,1);
  assert.equal((await owner.call(`/api/assessments/${id}`,{method:'PATCH',json:{revision:0,draft:{profile:testProfile(),answers:{q1:'no'}}},headers:{'x-csrf-token':ownerCsrf}})).status,409);
  assert.equal((await outsider.call(`/api/assessments/${id}`,{method:'DELETE',headers:{'x-csrf-token':ownerCsrf}})).status,403);
  const cleared=await owner.call(`/api/assessments/${id}`,{method:'DELETE',headers:{'x-csrf-token':ownerCsrf}});assert.equal(cleared.status,200);assert.deepEqual(cleared.data.assessment.answers,{});
  const questions=JSON.parse(fs.readFileSync('site/questions.json','utf8')).flatMap(section=>section.questions);
  const answers=Object.fromEntries(questions.map(question=>[question.id,'yes']));
  const completed=await owner.call(`/api/assessments/${id}`,{method:'PATCH',json:{revision:2,draft:{profile:testProfile(),answers,completed:true}},headers:{'x-csrf-token':ownerCsrf}});assert.equal(completed.status,200);
  assert.equal((await owner.call(`/api/assessments/${id}`,{method:'PATCH',json:{revision:3,draft:{profile:testProfile(),answers}},headers:{'x-csrf-token':ownerCsrf}})).status,409);
  assert.equal((await owner.call(`/api/assessments/${id}/report`)).status,404);
  const paymentFile=fs.readdirSync(path.join(host.directory,'payments')).find(name=>name.endsWith('.json'));
  const payment=JSON.parse(fs.readFileSync(path.join(host.directory,'payments',paymentFile),'utf8'));
  dashboard=await admin.call('/FundingReady/admin');token=adminCsrf(dashboard.data);
  const reviewed=await admin.call('/FundingReady/admin',{method:'POST',form:{csrf:token,update_payment:'1',payment_id:payment.id,reviewer:'Synthetic Reviewer',evidenceStatus:'in_progress',reviewStatus:'in_review',reviewerScore:'72',internalNotes:'Synthetic review notes'}});
  assert.equal(reviewed.status,200);
  let reviewRecord=JSON.parse(fs.readFileSync(path.join(host.directory,'payments',paymentFile),'utf8'));
  assert.equal(reviewRecord.reviewStatus,'in_review');assert.equal(reviewRecord.reviewerScore,72);assert.equal(reviewRecord.reviewHistory.at(-1).by,'admin@example.test');
  const report=await admin.call(`/FundingReady/admin/report/${payment.id}`,{method:'POST',raw:Buffer.from('%PDF-1.4\nsynthetic test report'),headers:{'x-csrf-token':token}});assert.equal(report.status,200);
  assert.equal((await outsider.call(`/api/assessments/${id}/report`)).status,403);
  const download=await owner.call(`/api/assessments/${id}/report`);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.equal(download.headers.get('x-content-type-options'),'nosniff');
  let updated;
  for(let attempt=0;attempt<20;attempt++){updated=JSON.parse(fs.readFileSync(path.join(host.directory,'payments',paymentFile),'utf8'));if(updated.reviewStatus==='delivered')break;await new Promise(resolve=>setTimeout(resolve,20));}
  assert.equal(updated.reviewStatus,'delivered');assert.equal(updated.downloadHistory.length,1);
  dashboard=await admin.call('/FundingReady/admin');token=adminCsrf(dashboard.data);
  assert.equal((await admin.call('/FundingReady/admin',{method:'POST',form:{csrf:token,logout:'1'},redirect:'manual'})).status,302);
  assert.equal((await admin.call(`/FundingReady/admin/report/${payment.id}`)).status,403);
 }finally{host.close();}
});

test('pending payments stay pending and proof content is checked',async()=>{
 const host=await server();try{
  const admin=client(host.base),applicant=client(host.base),visitor=client(host.base);
  const adminPage=await admin.call('/FundingReady/admin');let csrf=adminCsrf(adminPage.data);
  await admin.call('/FundingReady/admin',{method:'POST',form:{csrf,login:'1',email:'admin@example.test',password:'synthetic-long-password-for-tests'},redirect:'manual'});
  const panel=await admin.call('/FundingReady/admin');csrf=adminCsrf(panel.data);
  const configured=await admin.call('/FundingReady/admin',{method:'POST',form:{csrf,save_settings:'1',payeeName:'Synthetic Payee',upiId:'synthetic@upi',upiPhone:''}});assert.equal(configured.status,200);
  const bootstrap=(await applicant.call('/api/payments')).data;assert.equal(bootstrap.settings.available,true);
  const body={respondentName:'Synthetic Applicant',ngoName:'Synthetic Organisation',email:'applicant@example.test',phoneNumber:'9999999999',utr:'SYNTHETIC12345',consent:true,orderReference:bootstrap.orderReference};
  assert.equal((await applicant.call('/api/payments',{method:'POST',json:body})).status,403);
  const csrfApplicant=bootstrap.csrfToken;
  const htmlProof={...body,proof:{name:'proof.pdf',type:'application/pdf',size:22,data:'data:application/pdf;base64,'+Buffer.from('<script>alert(1)</script>').toString('base64')}};
  assert.equal((await applicant.call('/api/payments',{method:'POST',json:htmlProof,headers:{'x-csrf-token':csrfApplicant}})).status,400);
  const submitted=await applicant.call('/api/payments',{method:'POST',json:body,headers:{'x-csrf-token':csrfApplicant}});assert.equal(submitted.status,201);
  const id=submitted.data.paymentId;
  const secondBoot=(await applicant.call('/api/payments')).data;
  const goodProof={...body,orderReference:secondBoot.orderReference,utr:'SYNTHETIC67890',proof:{name:'untrusted-name.pdf',type:'application/pdf',size:20,data:'data:application/pdf;base64,'+Buffer.from('%PDF-1.4\nsynthetic proof').toString('base64')}};
  const withProof=await applicant.call('/api/payments',{method:'POST',json:goodProof,headers:{'x-csrf-token':secondBoot.csrfToken}});assert.equal(withProof.status,201);
  const protectedProof=await admin.call('/FundingReady/admin/proof/'+withProof.data.paymentId);assert.equal(protectedProof.status,200);assert.match(protectedProof.headers.get('content-disposition'),/^attachment;/);
  assert.equal((await visitor.call('/FundingReady/admin/proof/'+withProof.data.paymentId)).status,403);
  assert.equal((await applicant.call('/api/assessments',{method:'POST',json:{paymentId:id,profile:testProfile()},headers:{'x-csrf-token':csrfApplicant}})).status,403);
  assert.equal((await visitor.call('/FundingReady/admin/proof/'+id)).status,403);
  assert.equal((await applicant.call('/api/payments/status?reference='+body.orderReference)).data.status,'pending');
  const panel2=await admin.call('/FundingReady/admin');csrf=adminCsrf(panel2.data);
  assert.equal((await visitor.call('/FundingReady/admin',{method:'POST',form:{csrf,verify_payment:'1',payment_id:id},redirect:'manual'})).status,403);
  const verified=await admin.call('/FundingReady/admin',{method:'POST',form:{csrf,verify_payment:'1',payment_id:id}});assert.equal(verified.status,200);
  assert.equal((await applicant.call('/api/payments/status?reference='+body.orderReference)).data.status,'verified');
  assert.equal((await applicant.call('/api/assessments',{method:'POST',json:{paymentId:id,profile:testProfile()},headers:{'x-csrf-token':csrfApplicant}})).status,403);
 }finally{host.close();}
});

test('revoked and expired links cannot be redeemed',async()=>{
 const host=await server();try{
  const admin=client(host.base),applicant=client(host.base);let page=await admin.call('/FundingReady/admin');let csrf=adminCsrf(page.data);
  await admin.call('/FundingReady/admin',{method:'POST',form:{csrf,login:'1',email:'admin@example.test',password:'synthetic-long-password-for-tests'},redirect:'manual'});
  page=await admin.call('/FundingReady/admin');csrf=adminCsrf(page.data);
  const manual=await admin.call('/FundingReady/admin',{method:'POST',form:{csrf,create_manual:'1',manualNgoName:'Synthetic Organisation'}});
  const oldToken=tokenFromHtml(manual.data);assert.ok(oldToken);
  const paymentFile=fs.readdirSync(path.join(host.directory,'payments')).find(name=>name.endsWith('.json'));
  const payment=JSON.parse(fs.readFileSync(path.join(host.directory,'payments',paymentFile),'utf8'));
  const next=await admin.call('/FundingReady/admin',{method:'POST',form:{csrf,reissue_access:'1',payment_id:payment.id}});
  const newToken=tokenFromHtml(next.data);assert.ok(newToken);
  assert.equal((await applicant.call('/FundingReady/access/'+oldToken,{redirect:'manual'})).headers.get('location'),'/FundingReady/payment/?access=invalid');
  const hash=crypto.createHash('sha256').update(newToken).digest('hex');
  const linkFile=path.join(host.directory,'access','token-'+hash+'.json');
  const link=JSON.parse(fs.readFileSync(linkFile,'utf8'));link.expiresAt='2000-01-01T00:00:00.000Z';fs.writeFileSync(linkFile,JSON.stringify(link));
  assert.equal((await applicant.call('/FundingReady/access/'+newToken,{redirect:'manual'})).headers.get('location'),'/FundingReady/payment/?access=invalid');
 }finally{host.close();}
});
