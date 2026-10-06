import assert from 'node:assert/strict';
import { describe,it } from 'node:test';
import { analyzeSpending } from './personalAgentFinance';

describe('OpenMuse transaction analysis',()=>{
  it('calculates source-currency totals from real rows and handles quoted descriptions',()=>{
    const data=analyzeSpending('date,description,amount,category\n2024-02-29,"Food, cafe",12.10,Food\n2024-03-01,Salary,-1000.05,Income\n2024-03-02,Groceries,2.20,Food\n2024-03-03,Bus,3.50,Travel');
    assert.equal(data.income,1000.05);assert.equal(data.spending,17.8);assert.equal(data.saved,982.25);assert.equal(data.count,4);
    assert.deepEqual(data.categories,[{ name:'Food',amount:14.3 },{ name:'Travel',amount:3.5 }]);
    assert.equal(data.transactions[0].description,'Food, cafe');assert.deepEqual(data.period,{from:'2024-02-29',to:'2024-03-03'});
  });
  it('rejects invalid dates, ambiguous amounts and malformed CSV instead of inventing rows',()=>{
    for(const csv of ['date,amount\n2024-01-01,1','date,description,amount,category\n2023-02-29,Food,3,Food','date,description,amount,category\n2024-01-01,Food,$3,Food','date,description,amount,category\n2024-01-01,"unclosed,3,Food','date,description,amount,category\n2024-01-01,Food,1.234,Food'])assert.throws(()=>analyzeSpending(csv));
  });
});
