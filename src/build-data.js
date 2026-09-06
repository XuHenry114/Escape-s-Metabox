// 构建脚本：把 data/box-*.json 合并为 src/levels.data.js（浏览器全局 window.LEVELS_DATA）
// 用法: node src/build-data.js
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, '..', 'data');
const files = fs.readdirSync(dataDir).filter(f => /^box-\d+\.json$/.test(f)).sort((a, b) => {
  return parseInt(a.match(/\d+/)[0], 10) - parseInt(b.match(/\d+/)[0], 10);
});
const out = {};
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
  out[d.space] = d;
}
const eggs = fs.readdirSync(dataDir).filter(f => /^box-egg\d+\.json$/.test(f)).sort();
const eggOut = {};
for (const f of eggs) {
  const d = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8'));
  eggOut['egg' + f.match(/\d+/)[0]] = d;
}
const banner = '// 本文件由 build-data.js 自动生成，请勿手改\n';
const content = banner +
  '(function () {\n' +
  '  window.LEVELS_DATA = ' + JSON.stringify(out) + ';\n' +
  '  window.EGG_DATA = ' + JSON.stringify(eggOut) + ';\n' +
  '})();\n';
fs.writeFileSync(path.join(__dirname, 'levels.data.js'), content, 'utf8');
const n = Object.keys(out).length;
console.log(`OK: 生成 src/levels.data.js，含 ${n} 个空间（${files.length} 个文件）+ ${Object.keys(eggOut).length} 个彩蛋`);
