import test from 'node:test';
import assert from 'node:assert/strict';
import {planReset} from '../core.js';
const fixture=()=>({opening:100000,transactions:[{id:'past',amount:2000,type:'expense'}],buffer:0,nextIncome:'2026-12-24',events:[{id:'rent',type:'bill',amount:39000,date:'2026-12-01'}],budgets:{Groceries:6000,Entertainment:4000},allocation:{startDate:'2026-11-09',amounts:[10000,10000,10000,10000]}});
test('S19: a £20 recovery preserves past weeks and gives future weeks £93.34, £93.33 and £93.33',()=>{
  const s=fixture(),original=structuredClone(s);
  const p=planReset(s,{amount:2000,selected:['Groceries','Entertainment'],at:'2026-11-12'});
  assert.deepEqual(p.allocation.amounts,[10000,9334,9333,9333]);
  assert.equal(p.rows.reduce((sum,r)=>sum+r.value-r.after,0),2000);
  assert.deepEqual(s,original);
  for(const row of p.rows)assert.equal(Object.values(row.cuts).reduce((a,b)=>a+b,0),row.value-row.after);
});
test('S20: only selected categories can be reduced',()=>{
  const s=fixture();const p=planReset(s,{amount:2000,selected:['Groceries'],at:'2026-11-12'});
  for(const budgets of Object.values(p.futureBudgets))assert.equal(budgets.Entertainment,4000);
  assert.throws(()=>planReset(s,{amount:2000,selected:[],at:'2026-11-12'}));
  assert.throws(()=>planReset(s,{amount:20000,selected:['Groceries'],at:'2026-11-12'}));
});
test('S21: protected shortfalls are reported without changing bills',()=>{
  const s=fixture();s.opening=22000;s.events=[{id:'protected',type:'bill',amount:25000,date:'2026-11-20'}];
  assert.throws(()=>planReset(s,{amount:1000,selected:['Groceries'],at:'2026-11-12'}),/£50.00/);
  assert.equal(s.events[0].amount,25000);
});
test('S19: reject exhausted plans and never create negative future weeks',()=>{
  const s=fixture();assert.throws(()=>planReset(s,{amount:2000,selected:['Groceries'],at:'2027-01-01'}),/no future weeks/);
  const p=planReset(s,{amount:18000,selected:['Groceries'],at:'2026-11-12'});
  assert.deepEqual(p.allocation.amounts,[10000,4000,4000,4000]);
});
