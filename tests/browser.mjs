import {chromium} from 'playwright';
import {PGlite} from '@electric-sql/pglite';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';

const port=5189,origin=`http://127.0.0.1:${port}`;
const server=spawn(process.execPath,['server.mjs'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),SUPABASE_URL:'',SUPABASE_PUBLISHABLE_KEY:''},stdio:'pipe'});
const users={alice:{id:'11111111-1111-4111-8111-111111111111',email:'alice@example.com'},bob:{id:'22222222-2222-4222-8222-222222222222',email:'bob@example.com'}};
let browser,db,queue=Promise.resolve();const pageErrors=[];
const token=u=>[Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url'),Buffer.from(JSON.stringify({sub:u.id,email:u.email,role:'authenticated',aud:'authenticated',exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'test-signature'].join('.');
async function intercept(context){
 await context.route('**/config.js',r=>r.fulfill({contentType:'text/javascript',body:'export default {supabaseUrl:"https://termwise-test.supabase.co",supabaseKey:"sb_publishable_testing"};'}));
 await context.route('https://termwise-test.supabase.co/**',r=>{
  const operation=async()=>{
   const req=r.request(),url=new URL(req.url());let status=200,result;
   try{
    if(url.pathname.startsWith('/auth/v1/token')){
     const body=req.postDataJSON(),user=Object.values(users).find(u=>u.email===body.email);if(!user)throw new Error('Invalid credentials');
     result={access_token:token(user),refresh_token:'test-refresh',expires_in:3600,token_type:'bearer',user:{...user,aud:'authenticated',role:'authenticated',user_metadata:{display_name:user===users.alice?'Alice':'Bob'}}};
    }else if(url.pathname==='/auth/v1/logout')result={};
    else{
     const bearer=req.headers().authorization?.split(' ')[1],payload=JSON.parse(Buffer.from(bearer.split('.')[1],'base64url').toString());
     await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.email',$2,false)",[payload.sub,payload.email]);await db.exec('set role authenticated');
     if(url.pathname.includes('/rpc/')){
      const name=url.pathname.split('/').pop(),params=req.postDataJSON()||{},keys=Object.keys(params);
      if(!/^[a-z_]+$/.test(name)||keys.some(k=>!/^p_[a-z_]+$/.test(k)))throw new Error('Invalid request');
      const values=keys.map(k=>typeof params[k]==='object'&&!Array.isArray(params[k])?JSON.stringify(params[k]):params[k]);
      result=(await db.query(`select public.${name}(${keys.map((k,i)=>`${k} => $${i+1}`).join(',')}) as value`,values)).rows[0].value;
     }else{
      const table=url.pathname.split('/').pop();if(!['budget_accounts','households','household_members','household_bills','support_snapshots'].includes(table))throw new Error('Unexpected table');
      const values=[],conditions=[];for(const key of ['owner_id','household_id','id'])if(url.searchParams.has(key)){values.push(url.searchParams.get(key).replace(/^eq\./,''));conditions.push(`${key}=$${values.length}`);}
      result=(await db.query(`select * from public.${table}${conditions.length?' where '+conditions.join(' and '):''}`,values)).rows;
     }
    }
   }catch(e){status=400;result={message:e.message,code:'TEST_DATABASE_ERROR',details:null};}
   await r.fulfill({status,contentType:'application/json',body:JSON.stringify(result)});
  };
  queue=queue.then(operation,operation);return queue;
 });
}
async function login(context,user,hash='account'){
 const page=await context.newPage();page.on('pageerror',e=>pageErrors.push(e.message));await page.goto(origin+'/#'+hash);
 await page.getByRole('textbox',{name:'Email',exact:true}).fill(user.email);
 await page.getByRole('textbox',{name:'Password',exact:true}).fill('test-password');
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('button',{name:'Sync now'}).waitFor();
 await page.waitForFunction(()=>document.querySelector('[data-sync-status]')?.textContent==='Cloud up to date');
 return page;
}
async function sync(page){await page.goto(origin+'/#account');await page.getByRole('button',{name:'Sync now'}).click();await page.waitForFunction(()=>document.querySelector('[data-sync-status]')?.textContent==='Cloud up to date');}
try{
 await new Promise((resolve,reject)=>{server.stdout.on('data',d=>{if(d.toString().includes('ready at'))resolve();});server.on('exit',code=>reject(new Error('Test server exited '+code)));server.stderr.on('data',d=>process.stderr.write(d));});
 browser=await chromium.launch({headless:true,channel:'chromium'});
 const guest=await browser.newContext();const local=await guest.newPage();await local.goto(origin+'/#import');
 await local.locator('#csv-file').setInputFiles({name:'records.csv',mimeType:'text/csv',buffer:Buffer.from('date,description,amount,category\n2026-11-12,Import food,18.75,Groceries\n2026-11-12,Import food,18.75,Groceries\n2026-11-13,Bad,0,Other')});
 await local.getByRole('button',{name:'Preview rows'}).click();assert.equal(await local.evaluate(()=>localStorage.getItem('termwise-mvp-v1')),null);
 await local.getByRole('button',{name:'Import 1 transaction',exact:true}).click();await local.getByRole('button',{name:'Keep reviewing'}).click();
 assert.equal(await local.evaluate(()=>localStorage.getItem('termwise-mvp-v1')),null);
 await local.getByRole('button',{name:'Import 1 transaction',exact:true}).click();await local.getByRole('button',{name:'Confirm import',exact:true}).click();
 assert.ok(await local.getByRole('button',{name:'Import 0 transactions',exact:true}).isDisabled());
 await local.goto(origin+'/#reset');await local.getByRole('spinbutton',{name:'Amount to recover (£)'}).fill('20');await local.getByRole('button',{name:'Preview recovery plan'}).click();await local.getByRole('button',{name:'Confirm reset'}).click();
 let saved=await local.evaluate(()=>JSON.parse(localStorage.getItem('termwise-mvp-v1')));const records=JSON.stringify(saved.transactions);assert.equal(saved.allocation.amounts.reduce((a,b)=>a+b,0),88000);
 await local.reload();await local.getByRole('button',{name:'Undo last reset'}).click();saved=await local.evaluate(()=>JSON.parse(localStorage.getItem('termwise-mvp-v1')));assert.equal(saved.allocation.amounts.reduce((a,b)=>a+b,0),90000);assert.equal(JSON.stringify(saved.transactions),records);
 console.log('Passed: CSV confirmation/repeat protection and future-only reset/undo.');

 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key,email text);
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function auth.jwt() returns jsonb language sql stable as $$select jsonb_build_object('email',current_setting('request.jwt.claim.email',true))$$;
 grant usage on schema auth to authenticated;grant execute on all functions in schema auth to authenticated;
 insert into auth.users values('${users.alice.id}','${users.alice.email}'),('${users.bob.id}','${users.bob.email}');`);
 await db.exec(await fs.readFile('supabase/schema.sql','utf8'));
 const aliceContext=await browser.newContext(),bobContext=await browser.newContext();await intercept(aliceContext);await intercept(bobContext);
 const alice=await login(aliceContext,users.alice);
 await alice.goto(origin+'/#plan');await alice.getByRole('spinbutton',{name:'Opening balance (£)',exact:true}).fill('200');
 const next=new Date();next.setDate(next.getDate()+42);await alice.getByRole('textbox',{name:'Next payment date',exact:true}).fill(next.toLocaleDateString('en-CA'));
 await alice.getByRole('button',{name:'Save & refresh forecast'}).click();
 await alice.goto(origin+'/#home');await alice.getByRole('button',{name:'Add transaction',exact:true}).click();await alice.getByRole('spinbutton',{name:'Amount in pounds'}).fill('18.75');await alice.getByRole('combobox',{name:'Category',exact:true}).selectOption('Groceries');await alice.getByRole('textbox',{name:'Note · optional'}).fill('PRIVATE ALICE NOTE');await alice.getByRole('button',{name:'Save transaction',exact:true}).click();await sync(alice);
 const bob=await login(bobContext,users.bob);
 await bob.goto(origin+'/#transactions');assert.ok(!(await bob.locator('main').innerText()).includes('PRIVATE ALICE NOTE'));
 await alice.goto(origin+'/#shared');await alice.getByRole('button',{name:'Create household',exact:true}).click();await alice.getByRole('textbox',{name:'Household name'}).fill('Test Flat');await alice.getByRole('textbox',{name:'Your display name'}).fill('Alice');await alice.getByRole('dialog').getByRole('button',{name:'Create household',exact:true}).click();await alice.getByRole('button',{name:'Invite a housemate',exact:true}).click();
 await alice.getByRole('textbox',{name:'Housemate email'}).fill(users.bob.email);await alice.getByRole('button',{name:'Create invitation link'}).click();
 const inviteLink=await alice.getByRole('textbox',{name:'Invitation link'}).inputValue();await alice.getByRole('button',{name:'Close dialog'}).click();
 await bob.goto(inviteLink);await bob.getByRole('textbox',{name:'Your household display name'}).fill('Bob');await bob.getByRole('button',{name:'Accept invitation'}).click();
 await alice.getByRole('button',{name:'Refresh',exact:true}).click();await alice.getByRole('button',{name:'Record a shared bill',exact:true}).click();await alice.getByRole('textbox',{name:'Bill name',exact:true}).fill('Internet');await alice.getByRole('spinbutton',{name:'Amount (£)',exact:true}).fill('100');await alice.getByRole('button',{name:'Save household bill'}).click();
 await bob.getByRole('button',{name:'Refresh',exact:true}).click();await bob.getByRole('button',{name:'Settle my share'}).click();await bob.getByRole('button',{name:'Mark my share unpaid'}).waitFor();
 console.log('Passed: sign-in, cloud persistence, account isolation, invitations and household settlement.');
 await alice.goto(origin+'/#support');await alice.getByRole('textbox',{name:'Recipient email',exact:true}).fill(users.bob.email);await alice.getByRole('button',{name:'Preview selected summary'}).click();
 await alice.getByRole('checkbox',{name:'I agree to share these totals with this recipient.'}).check();await alice.getByRole('button',{name:'Confirm sharing'}).click();
 const linkAction=await alice.locator('[data-cloud-action^="copy-snapshot:"]').getAttribute('data-cloud-action'),snapshotId=linkAction.slice(14);
 await bob.goto(origin+'/#snapshot='+snapshotId);await bob.getByRole('heading',{name:'Summary shared with you'}).waitFor();assert.ok(!(await bob.locator('main').innerText()).includes('PRIVATE ALICE NOTE'));
 await alice.getByRole('button',{name:'Revoke access'}).click();await bob.getByRole('button',{name:'Refresh',exact:true}).click();await bob.getByText('This summary is unavailable, expired, revoked, or intended for another email.').waitFor();
 assert.deepEqual(pageErrors,[]);console.log('Passed: summary scope/consent, recipient access and revocation.');
 const secondAliceContext=await browser.newContext();await intercept(secondAliceContext);const secondAlice=await login(secondAliceContext,users.alice);
 await alice.goto(origin+'/#settings');await alice.getByRole('textbox',{name:'Your name',exact:true}).fill('Alice current cloud');await alice.getByRole('button',{name:'Save details'}).click();await sync(alice);
 await secondAlice.goto(origin+'/#settings');await secondAlice.getByRole('textbox',{name:'Your name',exact:true}).fill('Alice stale device');await secondAlice.getByRole('button',{name:'Save details'}).click();await secondAlice.goto(origin+'/#account');
 await secondAlice.waitForFunction(()=>document.querySelector('[data-sync-status]')?.textContent.includes('Cloud conflict'));
 await secondAlice.getByRole('button',{name:'Sign out',exact:true}).click();await secondAlice.getByRole('button',{name:'Sign out now'}).click();await secondAlice.getByRole('button',{name:'Sign in',exact:true}).waitFor();
 assert.equal(await secondAlice.evaluate(()=>JSON.parse(localStorage.getItem('termwise-mvp-v1:11111111-1111-4111-8111-111111111111')).name),'Alice stale device');
 console.log('Passed: concurrent cloud edits are blocked, and unsynced sign-out preserves a recovery copy.');
}finally{await browser?.close();await db?.close();server.kill();}
