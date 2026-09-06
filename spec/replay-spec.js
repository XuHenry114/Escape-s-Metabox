// 回放分段校验配置：数字段出现在通关码中时，校验玩家所在空间编号
// 注意：题解通关码里数字标注既非按键也非严格“段结束即到该盒”，
// 而是“主角第一次到达此盒子的这一部分”标记；因此数字出现时只做软校验（warn）：
// 玩家应已在对应的空间，或者该数字之后几步内进入该空间（容差由 replay 的 warn 处理）。
// 用法：replay.js 读取本文件，把数字段 → 期望空间记录，用于输出进度与告警。
'use strict';
const fs = require('fs');
const path = require('path');
const sol = fs.readFileSync(path.join(__dirname, 'solution.txt'), 'utf8').trim();

// 解析：数字(1..50)或 0/∞/ε/err 与字母序列
function parse() {
  const steps = [];
  let i = 0;
  while (i < sol.length) {
    const ch = sol[i];
    if (/[0-9]/.test(ch)) {
      let num = ch;
      while (i + 1 < sol.length && /[0-9]/.test(sol[i + 1])) { num += sol[i + 1]; i++; }
      steps.push({ mark: 'box', value: +num });
      i++;
      continue;
    }
    if (ch === ',' || ch === '\\') { steps.push({ mark: 'note', value: ch }); i++; continue; }
    if (/[wasd]/.test(ch)) { steps.push({ type: ch }); i++; continue; }
    steps.push({ mark: 'unknown', value: ch }); i++;
  }
  return steps;
}

module.exports = { parse, steps: parse(), count: (() => { const p = parse(); return { moves: p.filter(s => s.type).length, boxes: p.filter(s => s.mark === 'box').length }; })() };

if (require.main === module) {
  const r = module.exports;
  console.log('通关码字符数:', sol.length);
  console.log('解析步数:', r.steps.length, ' 移动命令数:', r.count.moves, ' 盒数字标记数:', r.count.boxes);
  // 找到 "50" 段前的最后盒标记序列，打印每段命令摘要
  let seg = 1, buf = [], first = null;
  const segs = [];
  for (const s of r.steps) {
    if (s.mark === 'box') { if (first === null) first = s.value; buf = []; segs.push({ box: s.value, commands: [] }); continue; }
    if (segs.length) segs[segs.length - 1].commands.push(s);
  }
  console.log('分段预览:', segs.slice(0, 8).map(s => s.box + '[' + s.commands.length + 'cmds]').join(' '));
}
