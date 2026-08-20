const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEV_DATA_FILE = path.join(__dirname, 'appointments.dev.json');
const DEV_QBO_FILE = path.join(__dirname, 'qbo-connection.dev.json');
const DEPOSIT_PERCENT = Math.min(100, Math.max(1, Number(process.env.DEPOSIT_PERCENT || 50)));
const HOLD_MINUTES = Math.max(10, Number(process.env.PAYMENT_HOLD_MINUTES || 30));
const QBO_MINOR_VERSION = String(process.env.QBO_MINOR_VERSION || '75');

const BARBERS = ['Dani', 'Joviel'];
const SERVICES = [
  { id: 'haircut', name: 'Haircut', priceCents: 5000, duration: '45 min' },
  { id: 'haircut-beard', name: 'Haircut + Beard', priceCents: 5500, duration: '60 min' },
  { id: 'line-up', name: 'Line Up', priceCents: 2000, duration: '20 min' }
];
const TIMES = ['9:00 AM','10:00 AM','11:00 AM','12:00 PM','1:00 PM','2:00 PM','3:00 PM','4:00 PM','5:00 PM','6:00 PM'];
const STATUSES = ['Awaiting Payment','Pending','Confirmed','Completed','Canceled'];
const OWNERS = {
  [String(process.env.DANI_USERNAME || 'dani').toLowerCase()]: { name: 'Dani', password: process.env.DANI_PASSWORD || 'DaniPrestige2026!' },
  [String(process.env.JOVIEL_USERNAME || 'joviel').toLowerCase()]: { name: 'Joviel', password: process.env.JOVIEL_PASSWORD || 'JovielPrestige2026!' }
};

const sessions = new Map();
const oauthStates = new Map();
let pool = null;
let storageMode = 'local-json';

const clean = (v, n=250) => String(v ?? '').trim().slice(0,n);
const cents = v => Math.round(Number(v || 0) * 100);
const dollars = c => (Number(c || 0) / 100).toFixed(2);
const serviceById = id => SERVICES.find(s => s.id === id);
const validDate = v => /^\d{4}-\d{2}-\d{2}$/.test(v);

function todayLocal() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset()*60000).toISOString().slice(0,10);
}
function sendJson(res, status, data) {
  res.writeHead(status, {'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});
  res.end(JSON.stringify(data));
}
function redirect(res, url) { res.writeHead(302, {Location:url, 'Cache-Control':'no-store'}); res.end(); }
function safeEqual(a,b) {
  const aa=Buffer.from(String(a)), bb=Buffer.from(String(b));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function readRaw(req) {
  return new Promise((resolve,reject)=>{
    const chunks=[]; let total=0;
    req.on('data',c=>{ total+=c.length; if(total>1e6){reject(new Error('Body too large')); req.destroy(); return;} chunks.push(c); });
    req.on('end',()=>resolve(Buffer.concat(chunks))); req.on('error',reject);
  });
}
async function readJson(req) { const b=await readRaw(req); return b.length ? JSON.parse(b.toString('utf8')) : {}; }
function tokenFrom(req) { const a=req.headers.authorization||''; return a.startsWith('Bearer ') ? a.slice(7) : ''; }
function getSession(req) {
  const token=tokenFrom(req), s=sessions.get(token); if(!s) return null;
  if(Date.now()-s.createdAt>12*60*60*1000){ sessions.delete(token); return null; }
  return s;
}
function baseUrl(req) {
  const configured=clean(process.env.PUBLIC_BASE_URL,300); if(configured) return configured.replace(/\/+$/,'');
  const proto=clean(req.headers['x-forwarded-proto']||'http',20);
  const host=clean(req.headers['x-forwarded-host']||req.headers.host||`localhost:${PORT}`,200);
  return `${proto}://${host}`.replace(/\/+$/,'');
}
function qboRedirect(req){ return clean(process.env.QBO_REDIRECT_URI,500) || `${baseUrl(req)}/api/qbo/callback`; }
function qboConfigured(){ return Boolean(process.env.QBO_CLIENT_ID && process.env.QBO_CLIENT_SECRET && process.env.TOKEN_ENCRYPTION_KEY); }
function qboBase(){ return String(process.env.QBO_ENVIRONMENT||'production').toLowerCase()==='sandbox' ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com'; }
function key(){ if(!process.env.TOKEN_ENCRYPTION_KEY) throw new Error('TOKEN_ENCRYPTION_KEY is not configured.'); return crypto.createHash('sha256').update(process.env.TOKEN_ENCRYPTION_KEY).digest(); }
function enc(text){ const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',key(),iv); const body=Buffer.concat([c.update(String(text),'utf8'),c.final()]); return [iv.toString('base64url'),c.getAuthTag().toString('base64url'),body.toString('base64url')].join('.'); }
function dec(text){ const [i,t,b]=String(text||'').split('.'); const d=crypto.createDecipheriv('aes-256-gcm',key(),Buffer.from(i,'base64url')); d.setAuthTag(Buffer.from(t,'base64url')); return Buffer.concat([d.update(Buffer.from(b,'base64url')),d.final()]).toString('utf8'); }
function readFile(file,fallback){ try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return fallback;} }
function writeFile(file,value){ const tmp=file+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(value,null,2)); fs.renameSync(tmp,file); }

async function initStorage(){
  if(process.env.DATABASE_URL){
    const {Pool}=require('pg');
    pool=new Pool({connectionString:process.env.DATABASE_URL,ssl:process.env.PGSSLMODE==='disable'?false:{rejectUnauthorized:false}});
    await pool.query(`CREATE TABLE IF NOT EXISTS appointments (
      id UUID PRIMARY KEY, customer_name VARCHAR(100) NOT NULL, email VARCHAR(180) NOT NULL DEFAULT '', phone VARCHAR(40) NOT NULL,
      service_id VARCHAR(40) NOT NULL, service VARCHAR(100) NOT NULL, barber VARCHAR(30) NOT NULL, appointment_date DATE NOT NULL,
      appointment_time VARCHAR(30) NOT NULL, notes VARCHAR(500) NOT NULL DEFAULT '', status VARCHAR(30) NOT NULL DEFAULT 'Awaiting Payment',
      price_cents INTEGER NOT NULL, amount_paid_cents INTEGER NOT NULL DEFAULT 0, payment_status VARCHAR(30) NOT NULL DEFAULT 'Unpaid',
      initial_payment_choice VARCHAR(20) NOT NULL DEFAULT 'deposit', payment_expires_at TIMESTAMPTZ, qbo_customer_id TEXT,
      initial_invoice_id TEXT, initial_invoice_link TEXT, initial_invoice_amount_cents INTEGER NOT NULL DEFAULT 0,
      initial_invoice_balance_cents INTEGER NOT NULL DEFAULT 0, balance_invoice_id TEXT, balance_invoice_link TEXT,
      balance_invoice_amount_cents INTEGER NOT NULL DEFAULT 0, balance_invoice_balance_cents INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    const cols=[['email',"VARCHAR(180) NOT NULL DEFAULT ''"],['qbo_customer_id','TEXT'],['initial_invoice_id','TEXT'],['initial_invoice_link','TEXT'],['initial_invoice_amount_cents','INTEGER NOT NULL DEFAULT 0'],['initial_invoice_balance_cents','INTEGER NOT NULL DEFAULT 0'],['balance_invoice_id','TEXT'],['balance_invoice_link','TEXT'],['balance_invoice_amount_cents','INTEGER NOT NULL DEFAULT 0'],['balance_invoice_balance_cents','INTEGER NOT NULL DEFAULT 0'],['payment_expires_at','TIMESTAMPTZ']];
    for(const [n,t] of cols) await pool.query(`ALTER TABLE appointments ADD COLUMN IF NOT EXISTS ${n} ${t}`);
    await pool.query(`CREATE TABLE IF NOT EXISTS qbo_connection (id INTEGER PRIMARY KEY CHECK(id=1), realm_id TEXT NOT NULL, access_token_enc TEXT NOT NULL, refresh_token_enc TEXT NOT NULL, access_expires_at TIMESTAMPTZ NOT NULL, refresh_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_active_barber_slot ON appointments(barber,appointment_date,appointment_time) WHERE status <> 'Canceled'`);
    storageMode='postgres';
  } else {
    if(!fs.existsSync(DEV_DATA_FILE)) writeFile(DEV_DATA_FILE,[]);
    if(!fs.existsSync(DEV_QBO_FILE)) writeFile(DEV_QBO_FILE,null);
  }
}

async function saveQbo(c){
  const stored={realmId:c.realmId,accessTokenEnc:enc(c.accessToken),refreshTokenEnc:enc(c.refreshToken),accessExpiresAt:new Date(Date.now()+Number(c.expiresIn||3600)*1000).toISOString(),refreshExpiresAt:c.refreshExpiresIn?new Date(Date.now()+Number(c.refreshExpiresIn)*1000).toISOString():null};
  if(pool) await pool.query(`INSERT INTO qbo_connection(id,realm_id,access_token_enc,refresh_token_enc,access_expires_at,refresh_expires_at,updated_at) VALUES(1,$1,$2,$3,$4,$5,NOW()) ON CONFLICT(id) DO UPDATE SET realm_id=EXCLUDED.realm_id,access_token_enc=EXCLUDED.access_token_enc,refresh_token_enc=EXCLUDED.refresh_token_enc,access_expires_at=EXCLUDED.access_expires_at,refresh_expires_at=EXCLUDED.refresh_expires_at,updated_at=NOW()`,[stored.realmId,stored.accessTokenEnc,stored.refreshTokenEnc,stored.accessExpiresAt,stored.refreshExpiresAt]);
  else writeFile(DEV_QBO_FILE,stored);
}
async function loadQbo(){
  let s;
  if(pool){ const r=await pool.query('SELECT * FROM qbo_connection WHERE id=1'); if(!r.rowCount) return null; const x=r.rows[0]; s={realmId:x.realm_id,accessTokenEnc:x.access_token_enc,refreshTokenEnc:x.refresh_token_enc,accessExpiresAt:new Date(x.access_expires_at).toISOString(),refreshExpiresAt:x.refresh_expires_at?new Date(x.refresh_expires_at).toISOString():null}; }
  else s=readFile(DEV_QBO_FILE,null);
  if(!s) return null;
  return {realmId:s.realmId,accessToken:dec(s.accessTokenEnc),refreshToken:dec(s.refreshTokenEnc),accessExpiresAt:s.accessExpiresAt,refreshExpiresAt:s.refreshExpiresAt};
}
async function disconnectQbo(){ if(pool) await pool.query('DELETE FROM qbo_connection WHERE id=1'); else writeFile(DEV_QBO_FILE,null); }
async function tokenExchange(params){
  const basic=Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
  const r=await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer',{method:'POST',headers:{Authorization:`Basic ${basic}`,Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params)});
  const d=await r.json(); if(!r.ok) throw new Error(d.error_description||d.error||'QuickBooks token request failed.');
  return {accessToken:d.access_token,refreshToken:d.refresh_token,expiresIn:d.expires_in,refreshExpiresIn:d.x_refresh_token_expires_in};
}
async function validQbo(){
  const c=await loadQbo(); if(!c){const e=new Error('QuickBooks is not connected.');e.code='QBO_NOT_CONNECTED';throw e;}
  if(new Date(c.accessExpiresAt).getTime()>Date.now()+120000) return c;
  const t=await tokenExchange({grant_type:'refresh_token',refresh_token:c.refreshToken}); await saveQbo({realmId:c.realmId,...t}); return {realmId:c.realmId,...t,accessExpiresAt:new Date(Date.now()+Number(t.expiresIn||3600)*1000).toISOString()};
}
async function qboRequest(resource, options={}){
  let c=await validQbo();
  const run=()=>{ const sep=resource.includes('?')?'&':'?'; return fetch(`${qboBase()}/v3/company/${encodeURIComponent(c.realmId)}${resource}${sep}minorversion=${encodeURIComponent(QBO_MINOR_VERSION)}`,{...options,headers:{Authorization:`Bearer ${c.accessToken}`,Accept:'application/json',...(options.body?{'Content-Type':'application/json'}:{}),...(options.headers||{})}}); };
  let r=await run();
  if(r.status===401){ const old=await loadQbo(); const t=await tokenExchange({grant_type:'refresh_token',refresh_token:old.refreshToken}); await saveQbo({realmId:old.realmId,...t}); c={realmId:old.realmId,...t}; r=await run(); }
  const text=await r.text(); let d={}; try{d=text?JSON.parse(text):{};}catch{d={raw:text};}
  if(!r.ok){ const msg=d?.Fault?.Error?.[0]?.Detail||d?.Fault?.Error?.[0]?.Message||d?.error_description||`QuickBooks API error (${r.status})`; const e=new Error(msg);e.qbo=d;throw e; }
  return d;
}
async function qboQuery(q){ return qboRequest(`/query?query=${encodeURIComponent(q)}`); }
async function ensureServiceItem(){
  const name='JD Prestige Barber Services', escaped=name.replace(/'/g,"\\'");
  let r=await qboQuery(`select * from Item where Name = '${escaped}' maxresults 1`); let item=r?.QueryResponse?.Item?.[0]; if(item) return item.Id;
  r=await qboQuery("select * from Account where AccountType = 'Income' maxresults 1"); const acct=r?.QueryResponse?.Account?.[0]; if(!acct) throw new Error('QuickBooks needs an Income account before creating service invoices.');
  r=await qboRequest('/item',{method:'POST',body:JSON.stringify({Name:name,Type:'Service',IncomeAccountRef:{value:acct.Id}})}); return r?.Item?.Id;
}
async function createCustomer(a){
  const display=`${a.name} - JD Prestige ${a.id.replace(/-/g,'').slice(0,8)}`.slice(0,100);
  const r=await qboRequest('/customer',{method:'POST',body:JSON.stringify({DisplayName:display,GivenName:a.name.slice(0,25),PrimaryEmailAddr:{Address:a.email},PrimaryPhone:{FreeFormNumber:a.phone}})});
  if(!r?.Customer?.Id) throw new Error('QuickBooks customer could not be created.'); return r.Customer.Id;
}
async function createInvoice(a, amountCents, kind){
  const itemId=await ensureServiceItem(); const customerId=a.qboCustomerId||await createCustomer(a); if(!a.qboCustomerId){await updateFields(a.id,{qboCustomerId:customerId});a.qboCustomerId=customerId;}
  const label=kind==='deposit'?'Deposit':kind==='balance'?'Remaining Balance':'Full Payment';
  const r=await qboRequest('/invoice',{method:'POST',body:JSON.stringify({CustomerRef:{value:customerId},BillEmail:{Address:a.email},AllowOnlinePayment:true,AllowOnlineCreditCardPayment:true,AllowOnlineACHPayment:true,PrivateNote:`JD Prestige booking ${a.id}`,CustomerMemo:{value:`${a.barber} — ${a.date} at ${a.time}`},Line:[{Amount:Number(dollars(amountCents)),DetailType:'SalesItemLineDetail',Description:`JD Prestige ${label}: ${a.service} with ${a.barber} on ${a.date} at ${a.time}`,SalesItemLineDetail:{ItemRef:{value:itemId},Qty:1,UnitPrice:Number(dollars(amountCents))}}]})});
  const id=r?.Invoice?.Id; if(!id) throw new Error('QuickBooks invoice could not be created.');
  let invoice=null; for(let i=0;i<4;i++){ const f=await qboRequest(`/invoice/${encodeURIComponent(id)}?include=invoiceLink`); invoice=f?.Invoice; if(invoice?.InvoiceLink) break; await new Promise(x=>setTimeout(x,350*(i+1))); }
  if(!invoice?.InvoiceLink) throw new Error('QuickBooks did not return an online payment link. Make sure QuickBooks Payments and online invoice payments are enabled.');
  return {invoiceId:id,invoiceLink:invoice.InvoiceLink,invoiceAmountCents:cents(invoice.TotalAmt??amountCents/100),invoiceBalanceCents:cents(invoice.Balance??amountCents/100)};
}
async function fetchInvoice(id){ if(!id) return null; return (await qboRequest(`/invoice/${encodeURIComponent(id)}?include=invoiceLink`))?.Invoice||null; }
async function deleteInvoice(id){ if(!id) return; try{ const inv=await fetchInvoice(id); if(inv) await qboRequest('/invoice?operation=delete',{method:'POST',body:JSON.stringify({Id:inv.Id,SyncToken:inv.SyncToken})}); }catch(e){console.warn('Could not delete QuickBooks invoice:',e.message);} }

async function rawAppointments(){
  if(pool){ const r=await pool.query(`SELECT id,customer_name AS name,email,phone,service_id AS "serviceId",service,barber,TO_CHAR(appointment_date,'YYYY-MM-DD') AS date,appointment_time AS time,notes,status,price_cents AS "priceCents",amount_paid_cents AS "amountPaidCents",payment_status AS "paymentStatus",initial_payment_choice AS "initialPaymentChoice",payment_expires_at AS "paymentExpiresAt",qbo_customer_id AS "qboCustomerId",initial_invoice_id AS "initialInvoiceId",initial_invoice_link AS "initialInvoiceLink",initial_invoice_amount_cents AS "initialInvoiceAmountCents",initial_invoice_balance_cents AS "initialInvoiceBalanceCents",balance_invoice_id AS "balanceInvoiceId",balance_invoice_link AS "balanceInvoiceLink",balance_invoice_amount_cents AS "balanceInvoiceAmountCents",balance_invoice_balance_cents AS "balanceInvoiceBalanceCents",created_at AS "createdAt" FROM appointments ORDER BY appointment_date,appointment_time,created_at`); return r.rows; }
  return readFile(DEV_DATA_FILE,[]);
}
async function listAppointments(){ return (await rawAppointments()).map(a=>({...a,amountDueCents:Math.max(0,a.priceCents-(a.amountPaidCents||0))})); }
async function getAppointment(id){ return (await listAppointments()).find(x=>x.id===id)||null; }
async function updateFields(id,fields){
  const map={status:'status',amountPaidCents:'amount_paid_cents',paymentStatus:'payment_status',qboCustomerId:'qbo_customer_id',initialInvoiceId:'initial_invoice_id',initialInvoiceLink:'initial_invoice_link',initialInvoiceAmountCents:'initial_invoice_amount_cents',initialInvoiceBalanceCents:'initial_invoice_balance_cents',balanceInvoiceId:'balance_invoice_id',balanceInvoiceLink:'balance_invoice_link',balanceInvoiceAmountCents:'balance_invoice_amount_cents',balanceInvoiceBalanceCents:'balance_invoice_balance_cents'};
  if(pool){ const e=Object.entries(fields).filter(([k])=>map[k]); if(!e.length)return; const sets=e.map(([k],i)=>`${map[k]}=$${i+1}`), vals=e.map(([,v])=>v); vals.push(id); await pool.query(`UPDATE appointments SET ${sets.join(',')} WHERE id=$${vals.length}`,vals); }
  else { const items=readFile(DEV_DATA_FILE,[]), a=items.find(x=>x.id===id); if(a){Object.assign(a,fields);writeFile(DEV_DATA_FILE,items);} }
}
async function createAppointment(a){
  if(pool){ try{await pool.query(`INSERT INTO appointments(id,customer_name,email,phone,service_id,service,barber,appointment_date,appointment_time,notes,status,price_cents,amount_paid_cents,payment_status,initial_payment_choice,payment_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Awaiting Payment',$11,0,'Unpaid',$12,$13)`,[a.id,a.name,a.email,a.phone,a.serviceId,a.service,a.barber,a.date,a.time,a.notes,a.priceCents,a.initialPaymentChoice,a.paymentExpiresAt]);}catch(e){if(e.code==='23505'){const x=new Error('That time is already booked with this barber.');x.code='SLOT_TAKEN';throw x;}throw e;} }
  else { const items=readFile(DEV_DATA_FILE,[]); if(items.some(x=>x.barber===a.barber&&x.date===a.date&&x.time===a.time&&x.status!=='Canceled')){const e=new Error('That time is already booked with this barber.');e.code='SLOT_TAKEN';throw e;} items.push(a); writeFile(DEV_DATA_FILE,items); }
}
async function syncAppointment(a){
  let ia=Number(a.initialInvoiceAmountCents||0), ib=Number(a.initialInvoiceBalanceCents||0), ba=Number(a.balanceInvoiceAmountCents||0), bb=Number(a.balanceInvoiceBalanceCents||0), il=a.initialInvoiceLink||null, bl=a.balanceInvoiceLink||null;
  if(a.initialInvoiceId){const x=await fetchInvoice(a.initialInvoiceId);if(x){ia=cents(x.TotalAmt);ib=cents(x.Balance);il=x.InvoiceLink||il;}}
  if(a.balanceInvoiceId){const x=await fetchInvoice(a.balanceInvoiceId);if(x){ba=cents(x.TotalAmt);bb=cents(x.Balance);bl=x.InvoiceLink||bl;}}
  const paid=Math.max(0,Math.min(a.priceCents,(ia-ib)+(ba-bb))), due=Math.max(0,a.priceCents-paid), pstatus=due===0?'Paid':paid>0?'Partially Paid':'Unpaid'; let status=a.status; if(paid>0&&status==='Awaiting Payment')status='Pending';
  await updateFields(a.id,{amountPaidCents:paid,paymentStatus:pstatus,status,initialInvoiceLink:il,initialInvoiceAmountCents:ia,initialInvoiceBalanceCents:ib,balanceInvoiceLink:bl,balanceInvoiceAmountCents:ba,balanceInvoiceBalanceCents:bb});
  return {...a,amountPaidCents:paid,amountDueCents:due,paymentStatus:pstatus,status,initialInvoiceLink:il,initialInvoiceAmountCents:ia,initialInvoiceBalanceCents:ib,balanceInvoiceLink:bl,balanceInvoiceAmountCents:ba,balanceInvoiceBalanceCents:bb};
}
async function syncAll(){ for(const a of await listAppointments()){ if(a.initialInvoiceId||a.balanceInvoiceId){ try{await syncAppointment(a);}catch(e){console.warn('Sync failed',a.id,e.message);} } } }
async function expireOld(){
  for(const a of await rawAppointments()){
    if(a.status==='Awaiting Payment'&&Number(a.amountPaidCents||0)===0&&a.paymentExpiresAt&&new Date(a.paymentExpiresAt).getTime()<Date.now()){
      let latest=a; try{if(a.initialInvoiceId) latest=await syncAppointment(a);}catch{}
      if(Number(latest.amountPaidCents||0)===0){await deleteInvoice(a.initialInvoiceId);await updateFields(a.id,{status:'Canceled'});}
    }
  }
}
async function bookedTimes(barber,date){ await expireOld(); return (await listAppointments()).filter(a=>a.barber===barber&&a.date===date&&a.status!=='Canceled').map(a=>a.time); }
async function changeStatus(id,status){ const a=await getAppointment(id); if(!a)return false; if(status==='Canceled'&&Number(a.amountPaidCents||0)===0){await deleteInvoice(a.initialInvoiceId);await deleteInvoice(a.balanceInvoiceId);} await updateFields(id,{status}); return true; }
async function deleteAppointment(id){ const a=await getAppointment(id); if(!a)return false; if(Number(a.amountPaidCents||0)===0){await deleteInvoice(a.initialInvoiceId);await deleteInvoice(a.balanceInvoiceId);} if(pool){const r=await pool.query('DELETE FROM appointments WHERE id=$1 RETURNING id',[id]);return !!r.rowCount;} const items=readFile(DEV_DATA_FILE,[]),next=items.filter(x=>x.id!==id);writeFile(DEV_DATA_FILE,next);return true; }

function serveStatic(res,pathname){ const rel=(pathname==='/'?'index.html':pathname.replace(/^\/+/,'')); const file=path.resolve(PUBLIC_DIR,rel); if(!file.startsWith(PUBLIC_DIR+path.sep)){res.writeHead(403);return res.end('Forbidden');} fs.stat(file,(e,s)=>{if(e||!s.isFile()){res.writeHead(404);return res.end('Not found');} const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8'};res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':pathname.endsWith('.html')||pathname==='/'?'no-cache':'public, max-age=3600'});fs.createReadStream(file).pipe(res);}); }

const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,`http://${req.headers.host||'localhost'}`), p=url.pathname;
  try{
    if(req.method==='GET'&&p==='/health'){const c=qboConfigured()?await loadQbo().catch(()=>null):null;return sendJson(res,200,{ok:true,storage:storageMode,quickbooksConfigured:qboConfigured(),quickbooksConnected:!!c});}
    if(req.method==='GET'&&p==='/api/config'){const c=qboConfigured()?await loadQbo().catch(()=>null):null;return sendJson(res,200,{barbers:BARBERS,services:SERVICES.map(s=>({...s,depositCents:Math.round(s.priceCents*DEPOSIT_PERCENT/100)})),times:TIMES,depositPercent:DEPOSIT_PERCENT,paymentsReady:qboConfigured()&&!!c});}
    if(req.method==='GET'&&p==='/api/availability'){const barber=clean(url.searchParams.get('barber'),30),date=clean(url.searchParams.get('date'),20);if(!BARBERS.includes(barber)||!validDate(date))return sendJson(res,400,{error:'Choose a valid barber and date.'});const unavailable=await bookedTimes(barber,date);return sendJson(res,200,{barber,date,availableTimes:TIMES.filter(t=>!unavailable.includes(t))});}
    if(req.method==='POST'&&p==='/api/book'){
      if(!qboConfigured())return sendJson(res,503,{error:'QuickBooks has not been configured by the owner yet.'}); if(!(await loadQbo()))return sendJson(res,503,{error:'QuickBooks is not connected yet. Please contact JD Prestige.'});
      const b=await readJson(req), service=serviceById(clean(b.serviceId,40)), choice=clean(b.paymentChoice,20);
      const a={id:crypto.randomUUID(),name:clean(b.name,100),email:clean(b.email,180),phone:clean(b.phone,40),serviceId:service?.id||'',service:service?.name||'',barber:clean(b.barber,30),date:clean(b.date,20),time:clean(b.time,30),notes:clean(b.notes,500),priceCents:Number(service?.priceCents||0),amountPaidCents:0,paymentStatus:'Unpaid',initialPaymentChoice:choice,status:'Awaiting Payment',paymentExpiresAt:new Date(Date.now()+HOLD_MINUTES*60000).toISOString(),createdAt:new Date().toISOString()};
      if(!a.name||!a.phone||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email)||!service||!BARBERS.includes(a.barber)||!TIMES.includes(a.time)||!['deposit','full'].includes(choice)||!validDate(a.date)||a.date<todayLocal())return sendJson(res,400,{error:'Please complete all required fields with valid information.'});
      await expireOld(); try{await createAppointment(a);}catch(e){if(e.code==='SLOT_TAKEN')return sendJson(res,409,{error:e.message});throw e;}
      const amount=choice==='deposit'?Math.round(a.priceCents*DEPOSIT_PERCENT/100):a.priceCents;
      try{const inv=await createInvoice(a,amount,choice);await updateFields(a.id,{initialInvoiceId:inv.invoiceId,initialInvoiceLink:inv.invoiceLink,initialInvoiceAmountCents:inv.invoiceAmountCents,initialInvoiceBalanceCents:inv.invoiceBalanceCents});return sendJson(res,201,{success:true,paymentUrl:inv.invoiceLink,totalCents:a.priceCents,amountToPayCents:amount,provider:'QuickBooks'});}catch(e){console.error(e);await updateFields(a.id,{status:'Canceled'});return sendJson(res,502,{error:e.message||'Could not create the QuickBooks payment request.'});}
    }
    if(req.method==='POST'&&p==='/api/admin/login'){const b=await readJson(req),u=clean(b.username,100).toLowerCase(),o=OWNERS[u];if(!o||!safeEqual(b.password||'',o.password))return sendJson(res,401,{error:'Incorrect username or password.'});const token=crypto.randomBytes(32).toString('hex');sessions.set(token,{createdAt:Date.now(),username:u,ownerName:o.name});return sendJson(res,200,{token,username:u,ownerName:o.name});}
    if(req.method==='GET'&&p==='/api/admin/me'){const s=getSession(req);if(!s)return sendJson(res,401,{error:'Unauthorized.'});return sendJson(res,200,{username:s.username,ownerName:s.ownerName});}
    if(req.method==='GET'&&p==='/api/admin/qbo/status'){if(!getSession(req))return sendJson(res,401,{error:'Unauthorized.'});const c=qboConfigured()?await loadQbo().catch(()=>null):null;return sendJson(res,200,{configured:qboConfigured(),connected:!!c,environment:String(process.env.QBO_ENVIRONMENT||'production').toLowerCase(),realmId:c?.realmId||null});}
    if(req.method==='POST'&&p==='/api/admin/qbo/connect'){const s=getSession(req);if(!s)return sendJson(res,401,{error:'Unauthorized.'});if(!qboConfigured())return sendJson(res,400,{error:'Add QBO_CLIENT_ID, QBO_CLIENT_SECRET, and TOKEN_ENCRYPTION_KEY first.'});const state=crypto.randomBytes(24).toString('hex'),redirectUri=qboRedirect(req);oauthStates.set(state,{createdAt:Date.now(),redirectUri});const a=new URL('https://appcenter.intuit.com/connect/oauth2');a.searchParams.set('client_id',process.env.QBO_CLIENT_ID);a.searchParams.set('response_type','code');a.searchParams.set('scope','com.intuit.quickbooks.accounting');a.searchParams.set('redirect_uri',redirectUri);a.searchParams.set('state',state);return sendJson(res,200,{authorizationUrl:a.toString()});}
    if(req.method==='GET'&&p==='/api/qbo/callback'){const state=clean(url.searchParams.get('state'),100),code=clean(url.searchParams.get('code'),1000),realmId=clean(url.searchParams.get('realmId'),100),st=oauthStates.get(state);if(!st||Date.now()-st.createdAt>600000||!code||!realmId)return redirect(res,'/owner.html?qb=error');oauthStates.delete(state);try{const t=await tokenExchange({grant_type:'authorization_code',code,redirect_uri:st.redirectUri});await saveQbo({realmId,...t});return redirect(res,'/owner.html?qb=connected');}catch(e){console.error(e);return redirect(res,'/owner.html?qb=error');}}
    if(req.method==='POST'&&p==='/api/admin/qbo/disconnect'){if(!getSession(req))return sendJson(res,401,{error:'Unauthorized.'});await disconnectQbo();return sendJson(res,200,{success:true});}
    if(req.method==='POST'&&p==='/api/admin/sync-payments'){if(!getSession(req))return sendJson(res,401,{error:'Unauthorized.'});if(!(await loadQbo()))return sendJson(res,400,{error:'QuickBooks is not connected.'});await syncAll();return sendJson(res,200,{success:true});}
    if(req.method==='GET'&&p==='/api/admin/bookings'){if(!getSession(req))return sendJson(res,401,{error:'Unauthorized.'});await expireOld();return sendJson(res,200,await listAppointments());}
    const bm=p.match(/^\/api\/admin\/bookings\/([a-f0-9-]+)$/i), lm=p.match(/^\/api\/admin\/bookings\/([a-f0-9-]+)\/balance-link$/i);
    if(lm&&req.method==='POST'){if(!getSession(req))return sendJson(res,401,{error:'Unauthorized.'});let a=await getAppointment(lm[1]);if(!a)return sendJson(res,404,{error:'Appointment not found.'});a=await syncAppointment(a);if(a.balanceInvoiceId&&a.balanceInvoiceLink)return sendJson(res,200,{paymentUrl:a.balanceInvoiceLink,amountDueCents:a.balanceInvoiceBalanceCents,existing:true});if(a.initialInvoiceBalanceCents>0)return sendJson(res,400,{error:'The first QuickBooks invoice still has a balance. Use its existing payment link first.'});const due=Math.max(0,a.priceCents-a.amountPaidCents);if(due<=0)return sendJson(res,400,{error:'This appointment is already paid in full.'});const inv=await createInvoice(a,due,'balance');await updateFields(a.id,{balanceInvoiceId:inv.invoiceId,balanceInvoiceLink:inv.invoiceLink,balanceInvoiceAmountCents:inv.invoiceAmountCents,balanceInvoiceBalanceCents:inv.invoiceBalanceCents});return sendJson(res,200,{paymentUrl:inv.invoiceLink,amountDueCents:due,existing:false});}
    if(bm&&req.method==='PATCH'){if(!getSession(req))return sendJson(res,401,{error:'Unauthorized.'});const b=await readJson(req),status=clean(b.status,30);if(!STATUSES.includes(status))return sendJson(res,400,{error:'Invalid appointment status.'});if(!(await changeStatus(bm[1],status)))return sendJson(res,404,{error:'Appointment not found.'});return sendJson(res,200,{success:true});}
    if(bm&&req.method==='DELETE'){if(!getSession(req))return sendJson(res,401,{error:'Unauthorized.'});if(!(await deleteAppointment(bm[1])))return sendJson(res,404,{error:'Appointment not found.'});return sendJson(res,200,{success:true});}
    serveStatic(res,p);
  }catch(e){console.error(e);if(e.code==='QBO_NOT_CONNECTED')return sendJson(res,503,{error:'QuickBooks is not connected.'});return sendJson(res,500,{error:e.message||'Server error. Please try again.'});}
});

initStorage().then(()=>server.listen(PORT,HOST,()=>console.log(`JD Prestige running on http://${HOST}:${PORT}`))).catch(e=>{console.error(e);process.exit(1);});
async function shutdown(){if(pool)await pool.end();process.exit(0);} process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
