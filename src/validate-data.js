const fs = require('fs');
const path = require('path');
// 校验 data/box-*.json 数据的完整性（转录质量门禁）
// 规则：box-NN.json 严格校验；box-egg*.json 为彩蛋关（允许 无AC/特殊size/type=WA/space=0）
const dir = process.argv[2] || path.join(__dirname, '..', 'data');
const files = fs.readdirSync(dir).filter(f => /^box-/.test(f) && f.endsWith('.json')).sort();
let errors = [];
for (const f of files) {
  const isEgg = /^box-egg/.test(f);
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
  catch (e) { errors.push(`${f}: JSON 解析失败 ${e.message}`); continue; }
  if (!Number.isInteger(d.space)) errors.push(`${f}: space 缺失`);
  if (!d.cells) { errors.push(`${f}: cells 缺失`); continue; }
  if (d.cells.length !== 49) errors.push(`${f}: cells 数量 ${d.cells.length} != 49`);
  const ids = d.cells.map((c, i) => c.id).join(',');
  if (ids !== Array.from({ length: 49 }, (_, i) => i + 1).join(',')) errors.push(`${f}: id 顺序错误`);
  for (let i = 0; i < d.cells.length; i++) {
    const c = d.cells[i];
    if (!['MLE', 'TLE', 'UKE', 'WA', 'AC'].includes(c.label)) errors.push(`${f} #${c.id}: label '${c.label}'`);
    if (!isEgg && !['0B', '1.00MB', '999.00MB'].includes(c.size)) errors.push(`${f} #${c.id}: size '${c.size}'`);
    if (!Number.isInteger(c.space)) errors.push(`${f} #${c.id}: space 非整数`);
  }
  const acs = d.cells.filter(c => c.label === 'AC');
  if (isEgg) {
    if (acs.length !== 0) errors.push(`${f}: 彩蛋不应有 AC，实际 ${acs.length}`);
  } else {
    if (acs.length !== 1) errors.push(`${f}: AC 数量 ${acs.length} != 1`);
    else if (d.ac !== acs[0].id) errors.push(`${f}: ac 字段 ${d.ac} != 实际 AC 卡 ${acs[0].id}`);
  }
  if (!isEgg && d.type && !['MLE', 'TLE', 'UKE'].includes(d.type)) errors.push(`${f}: type '${d.type}'`);
}
if (errors.length) { console.log('FAILED:\n' + errors.join('\n')); process.exit(1); }
console.log(`OK: ${files.length} 个文件全部通过校验`);
