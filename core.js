export const categories = ['Groceries','Transport','Eating out','Shopping','Entertainment','Study','Other'];
export const money = value => new Intl.NumberFormat('en-GB',{style:'currency',currency:'GBP'}).format(value/100);
export const today = () => new Date().toLocaleDateString('en-CA');
export function pennies(value) {
  if (!/^\d+(\.\d{1,2})?$/.test(String(value).trim())) throw new Error('Enter a positive amount with up to two decimal places.');
  const result = Math.round(Number(value)*100);
  if (!Number.isSafeInteger(result) || result > 10000000000) throw new Error('This amount is too large.');
  return result;
}
export function validDate(value) {return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;}
export function allocate(total, weeks) {
  if (!Number.isSafeInteger(total)||!Number.isInteger(weeks)||weeks<1||weeks>104) throw new Error('Enter between 1 and 104 whole weeks.');
  if(total<0) return [];
  return Array.from({length:weeks},(_,i)=>Math.floor(total/weeks)+(i<total%weeks?1:0));
}
export function balance(state) {return state.opening + state.transactions.reduce((sum,t)=>sum+(t.type==='income'?t.amount:-t.amount),0);}
export function forecast(state, at = today()) {
  const days = Math.ceil((Date.parse(state.nextIncome+'T12:00:00Z')-Date.parse(at+'T12:00:00Z'))/86400000);
  const essentials = state.events.filter(e=>e.type==='bill'&&!e.paid&&(!e.date||e.date<=state.nextIncome)).reduce((s,e)=>s+e.amount,0);
  const confirmed=balance(state), flexible=confirmed-essentials-state.buffer;
  const complete=validDate(state.nextIncome)&&days>0&&state.events.every(e=>validDate(e.date));
  return {days,weeks:Math.max(1,Math.ceil(days/7)),essentials,confirmed,flexible,complete,weekly:complete?Math.floor(Math.max(0,flexible)*7/days):null,shortfall:Math.max(0,-flexible)};
}
export function weekStart(at=today()) {const d=new Date(at+'T12:00:00');d.setDate(d.getDate()-((d.getDay()+6)%7));return d.toLocaleDateString('en-CA');}
export function weekSpent(state,category,at=today()) {const start=weekStart(at);return state.transactions.filter(t=>t.type==='expense'&&t.date>=start&&t.date<=at&&(!category||t.category===category)).reduce((s,t)=>s+t.amount,0);}
export function validateTransaction(row) {
  if (!Number.isSafeInteger(row.amount)||row.amount<=0) throw new Error('Amount: enter an amount greater than £0.00.');
  if (!validDate(row.date)) throw new Error('Date: enter a valid date.');
  if (!categories.includes(row.category)) throw new Error('Category: choose a category.');
  if (!['expense','income'].includes(row.type)) throw new Error('Choose expense or income.');
}
export function parseCSV(text) {
  text=text.replace(/^\uFEFF/,'');let rows=[],row=[],field='',quoted=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(c==='"'){if(quoted&&text[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){row.push(field);field='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(field);if(row.some(x=>x.trim()))rows.push(row);row=[];field='';}else field+=c;}
  if(quoted)throw new Error('The CSV contains an unclosed quoted field.');
  row.push(field);if(row.some(x=>x.trim()))rows.push(row);
  if(rows.length<2)throw new Error('Include a header row and at least one transaction.');
  const headers=rows.shift().map(x=>x.trim().toLowerCase());
  if(new Set(headers).size!==headers.length)throw new Error('Column headers must be unique.');
  if(rows.length>5000)throw new Error('Choose a file with 5,000 rows or fewer.');
  return {headers,rows};
}
export function previewCSV(parsed,mapping,existing=[]) {
  const seen=new Set(existing.map(t=>[t.date,t.description.trim().toLowerCase(),t.amount,t.category.toLowerCase()].join('|')));
  return parsed.rows.map((row,index)=>{
    let t={date:row[mapping.date]?.trim(),description:row[mapping.description]?.trim()||'',category:row[mapping.category]?.trim(),type:'expense'};
    try{t.amount=pennies(row[mapping.amount]?.trim());const c=categories.find(c=>c.toLowerCase()===t.category?.toLowerCase());if(c)t.category=c;validateTransaction(t);
      const ci=parsed.headers.indexOf('currency');if(ci>=0&&row[ci]?.trim().toUpperCase()!=='GBP')throw new Error('Unsupported currency: use GBP.');
      const ti=parsed.headers.indexOf('type');if(ti>=0&&row[ti]?.trim().toLowerCase()!=='expense')throw new Error('This preview supports expense rows only. Record income manually.');
      const key=[t.date,t.description.toLowerCase(),t.amount,t.category.toLowerCase()].join('|');if(seen.has(key))return {...t,index,status:'Duplicate',error:'Matches an existing or earlier row.'};seen.add(key);return {...t,index,status:'Ready'};
    }catch(e){return {...t,index,status:'Error',error:e.message};}
  });
}
export function splitBill(amount,people,method,values=[]) {
  if(!people.length)throw new Error('Select at least one participant.');
  if(method==='equal')return allocate(amount,people.length);
  if(method==='percentage'){
    const units=values.map(v=>pennies(v));if(units.reduce((a,b)=>a+b,0)!==10000)throw new Error('Percentages must add up to 100%.');
    const shares=units.map(v=>Math.floor(amount*v/10000));let rest=amount-shares.reduce((a,b)=>a+b,0);for(let i=0;rest>0;i++,rest--)shares[i%shares.length]++;return shares;
  }
  const shares=values.map(pennies);if(shares.reduce((a,b)=>a+b,0)!==amount)throw new Error('Custom shares must add up to the bill total.');return shares;
}
