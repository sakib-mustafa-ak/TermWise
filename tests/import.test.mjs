import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCSV,prepareCSVImport,previewCSV,balance} from '../core.js';
const mapping={date:0,description:1,amount:2,category:3};
const file=parseCSV('date,description,amount,category,currency\n2026-11-12,Food,18.75,Groceries,GBP\n2026-11-12,Food,18.75,Groceries,GBP\n2026-11-13,Travel,4.20,Transport,GBP\n2026-11-13,Invalid,-1,Other,GBP');
test('S17: import prepares only valid unique records without changing saved inputs',()=>{
  const existing=[];let id=0;const result=prepareCSVImport(file,mapping,existing,()=>String(++id));
  assert.equal(result.transactions.length,2);assert.equal(result.duplicates,1);assert.equal(result.errors,1);
  assert.deepEqual(existing,[]);assert.equal(balance({opening:20000,transactions:result.transactions}),17705);
  assert.deepEqual(result.transactions.map(t=>t.id),['1','2']);
});
test('S17: repeat confirmation and re-import add no duplicate expenses',()=>{
  const first=prepareCSVImport(file,mapping,[]).transactions;
  const second=prepareCSVImport(file,mapping,first);
  assert.deepEqual(second.transactions,[]);assert.equal(second.duplicates,3);
});
test('S17: revalidation catches records added since the preview',()=>{
  assert.equal(previewCSV(file,mapping,[]).filter(r=>r.status==='Ready').length,2);
  const existing=[{id:'manual',date:'2026-11-12',description:'Food',amount:1875,category:'Groceries',type:'expense'}];
  assert.equal(prepareCSVImport(file,mapping,existing).transactions.length,1);
});
test('S17: reject invalid mappings and malformed field counts',()=>{
  assert.throws(()=>prepareCSVImport(file,{...mapping,amount:0},[]));
  assert.throws(()=>prepareCSVImport(file,{...mapping,amount:-1},[]));
  const malformed=parseCSV('date,description,amount,category\n2026-11-12,Food,1.00,Groceries,Unexpected');
  assert.equal(prepareCSVImport(malformed,mapping,[]).errors,1);
});
