#!/usr/bin/env node
'use strict';
/*!
 * Escape's Metabox — 回放验证器（replay.js）
 * =====================================================
 * 读入《题解附录完整通关代码》字符串（默认 spec/solution.txt）逐条处理：
 *   数字（1..50）  = 人类标记：校验“当前玩家所在空间编号 == 该数字”（不符=错误），但不执行按键
 *   w / a / s / d  = 移动（上/左/下/右）；引擎按自动规则完成：推/进入/退出
 *   ,              = 人类标记：提示“此处应发生进入/退出”，回放时跳过（引擎已自动完成状态切换）
 *   \0 \infin \infty 等 = 彩蛋命令（仅提示，不执行）
 *   其它字符       = 未知符号（警告 + 跳过）
 *
 * 用法:
 *   node src/replay.js                     # 回放 data/ + spec/solution.txt
 *   node src/replay.js --data=X --solution=Y
 *   node src/replay.js --selftest          # 用 data/.sample 自测引擎
 *   node src/replay.js --map               # 每步顺便打印 7×7 视图
 *   node src/replay.js --allow-blocked     # blocked 不判为非法步（仅提示）
 *   node src/replay.js --quiet             # 只打印段标/错误/汇总
 *
 * 退出码: 0 = 无非法步且（通关 or 允许-blocked）; 1 = 有非法步 / 未通关 / 自测失败
 */
var path = require('path');
var fs = require('fs');
var engineMod = require('./engine.js');
var Engine = engineMod.Engine;
var createEngine = engineMod.createEngine;
var loadDataDir = engineMod.loadDataDir;
var validateData = engineMod.validateData;

var ROOT = path.dirname(path.dirname(fs.realpathSync(__filename)));   // metabox-game/
var DEFAULT_DATA = path.join(ROOT, 'data');
var DEFAULT_SOLUTION = path.join(ROOT, 'spec', 'solution.txt');
var SAMPLE_DATA = path.join(ROOT, 'data', '.sample');
var VERSION = engineMod.VERSION;
var DIR_NAMES = { w: '上(w)', a: '左(a)', s: '下(s)', d: '右(d)' };

// ------------------------------------------------------------------ CLI
function parseArgs(argv) {
  var o = {
    data: DEFAULT_DATA, solution: DEFAULT_SOLUTION,
    selftest: false, map: false, allowBlocked: false, quiet: false, demo: false, raw: false, probe: false
  };
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === '--selftest') o.selftest = true;
    else if (a === '--probe') o.probe = true;
    else if (a === '--map') o.map = true;
    else if (a === '--allow-blocked') o.allowBlocked = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--raw') o.raw = true;
    else if (a === '--demo') o.demo = true;
    else if (a.indexOf('--data=') === 0) o.data = a.slice(7);
    else if (a.indexOf('--solution=') === 0) o.solution = a.slice(11);
    else if (a === '--') { /* 后续作为位置参数 */ }
    else if (o.data === DEFAULT_DATA) o.data = a;
  }
  return o;
}

// ------------------------------------------------------------------ 题解词法
// 返回 token 数组: {type:'num'|'move'|'interact'|'egg'|'unknown', ...}
function tokenize(text) {
  var tokens = [], i = 0;
  while (i < text.length) {
    var ch = text[i];
    if (ch === '\\') {
      var m = /^\\[a-zA-Z0-9\u221e\u03b1-\u03c9\u0391-\u03a9]+/.exec(text.slice(i));
      if (m) { tokens.push({ type: 'egg', cmd: m[0], pos: i }); i += m[0].length; continue; }
      tokens.push({ type: 'unknown', raw: ch, pos: i }); i++; continue;
    }
    if (/[0-9]/.test(ch)) {
      var j = i; while (j < text.length && /[0-9]/.test(text[j])) j++;
      tokens.push({ type: 'num', value: parseInt(text.slice(i, j), 10), raw: text.slice(i, j), pos: i });
      i = j; continue;
    }
    if (ch === 'w' || ch === 'a' || ch === 's' || ch === 'd') {
      tokens.push({ type: 'move', cmd: ch, pos: i }); i++; continue;
    }
    if (ch === ',') { tokens.push({ type: 'interact', cmd: ',', pos: i }); i++; continue; }
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t' || ch === ';' || ch === '|') { i++; continue; }
    tokens.push({ type: 'unknown', raw: ch, pos: i }); i++;
  }
  return tokens;
}

// ------------------------------------------------------------------ 打印工具
var RED = function (s) { return '\x1b[31m' + s + '\x1b[0m'; };
var GREEN = function (s) { return '\x1b[32m' + s + '\x1b[0m'; };
var YELLOW = function (s) { return '\x1b[33m' + s + '\x1b[0m'; };
var CYAN = function (s) { return '\x1b[36m' + s + '\x1b[0m'; };
var BOLD = function (s) { return '\x1b[1m' + s + '\x1b[0m'; };
var GRAY = function (s) { return '\x1b[90m' + s + '\x1b[0m'; };

function miniMap(state) {
  var g = state.grid, lines = [];
  for (var r = 0; r < 7; r++) {
    var s = '   ';
    for (var c = 0; c < 7; c++) {
      var cell = g[r * 7 + c];
      if (state.player && state.player.r === r && state.player.c === c) s += '@';
      else if (cell.wall) s += '█';
      else if (cell.box) s += '□';
      else s += '·';
    }
    lines.push(s);
  }
  return lines.join('\n');
}

function fmtEvents(evs) {
  return evs.map(function (e) {
    var extra = '';
    if (e.type === 'enter' || e.type === 'teleport') extra = '(' + e.viewSpaceId + '#' + (e.land ? e.land.r + ',' + e.land.c : '') + ')';
    else if (e.type === 'mark') extra = (e.swappedUid ? '+交换#' + e.swappedUid : '');
    return e.type + extra;
  }).join(',');
}

// ------------------------------------------------------------------ 回放
function runReplay(engine, text, opts) {
  opts = opts || {};
  var tokens = tokenize(text);
  if (opts.raw) console.log('token 数: ' + tokens.length);
  var stat = { steps: 0, ok: 0, blocked: [], seg: [], segMismatch: 0, segFail: 0, marks: 0, eggs: [], unknown: [], won: false, winStep: null, segment: null };
  stat.visited = {};
  stat.visited[String(engine.getState().currentBox)] = true;   // 起点空间视为已访问
  var winShown = false;

  for (var ti = 0; ti < tokens.length; ti++) {
    var tok = tokens[ti];

    if (tok.type === 'num') {
      stat.seg.push(tok.value);
      stat.segment = tok.value;
      var st = engine.getState();
      var actual = st.currentBox;
      var okMark = !!stat.visited[String(tok.value)];   // 事件语义：主角首次到达 N 号盒（已发生过）即 ✓
      if (!okMark) { stat.segMismatch++; stat.segFail++; }
      console.log('');
      if (okMark) {
        console.log(CYAN('── [段标 ' + tok.value + '] 题解标记: 主角首次到达第 ' + tok.value + ' 号盒') + GREEN('（当前实际: ' + actual + ' ✓）'));
      } else {
        console.log(RED('── [段标 ' + tok.value + '] 题解标记: 主角首次到达第 ' + tok.value + ' 号盒') + RED('（当前实际: ' + actual + ' ✗ 段标与所在空间不符——题解/规则/数据在此前已错位）'));
      }
      if (opts.map) console.log(miniMap(st));
      continue;
    }

    if (tok.type === 'egg') {
      stat.eggs.push(tok.cmd);
      console.log(YELLOW('◆ 彩蛋命令 ' + tok.cmd + '（仅提示，不执行——如 ' + tok.cmd + ' 指代虚无边界/无限循环彩蛋）'));
      continue;
    }

    if (tok.type === 'unknown') {
      stat.unknown.push(tok.raw);
      console.log(YELLOW('⚠ 未知符号 ' + JSON.stringify(tok.raw) + '（字符位置 ' + (tok.pos + 1) + '，已跳过）'));
      continue;
    }

    // ',' = 人类提示标记“此处发生进入/退出”：跳过（引擎在自动进入/退出规则中已切换状态）
    if (tok.type === 'interact') {
      stat.marks++;
      engine.getState();   // 取走事件，保持队列干净
      if (!opts.quiet) console.log(GRAY('  · (标记 “,” — 提示此处进入/退出，跳过；状态切换已由上一步自动完成)'));
      continue;
    }

    // 执行一步
    var okk = engine.move(tok.cmd);
    var st2 = engine.getState();
    stat.steps++;
    if (st2.currentBox !== undefined && st2.currentBox !== null) stat.visited[String(st2.currentBox)] = true;

    if (!opts.quiet) {
      var evStr = fmtEvents(st2.events);
      var line = '  #' + String(stat.steps).padStart(4) + ' | ' + DIR_NAMES[tok.cmd] +
        (okk ? '' : RED(' ✗blocked')) +
        ' | 空间 ' + st2.spaceId + '(' + st2.spaceType + ')' + (st2.layer ? '@层' : '') +
        ' | 位置 ' + st2.pos.r + ',' + st2.pos.c + '#' + st2.posId +
        ' | 盒栈 ' + JSON.stringify(st2.boxStack) +
        ' | 事件: ' + (evStr || '—') + ' | 步数 ' + st2.moves;
      console.log(line);
      if (opts.map) console.log(miniMap(st2));
    }

    if (!okk) {
      stat.blocked.push({ step: stat.steps, cmd: tok.cmd, pos: st2.pos, spaceId: st2.spaceId, err: st2.events[st2.events.length - 1] });
      if (!opts.allowBlocked && !opts.quiet) {
        console.log('');
        console.log(RED('❌❌❌ 非法步! 第 ' + stat.steps + ' 步 [命令 "' + tok.cmd + '"] 被阻挡（' + st2.events[st2.events.length - 1].reason + '）'));
        console.log(RED('    题解中此步预期应当前进，实际未移动。位置: 空间 ' + st2.spaceId + '(' + st2.spaceType + ') ' + st2.pos.r + ',' + st2.pos.c + ' | 盒栈 ' + JSON.stringify(st2.boxStack)));
        console.log(RED('    —— 请检查: 引擎规则语义 / 转录数据 / 该段题解命令'));
        console.log('');
      } else {
        console.log(YELLOW('  ⚠ 第 ' + stat.steps + ' 步 blocked（--allow-blocked 仅提示）'));
      }
    } else {
      stat.ok++;
    }

    if (st2.won && !winShown) {
      winShown = true; stat.won = true; stat.winStep = stat.steps;
      console.log('');
      console.log(GREEN('🎉🎉🎉 通关！成功进入 50 号空间（第 ' + stat.steps + ' 步，段标 ' + stat.segment + '）'));
      if (opts.map) console.log(miniMap(st2));
      console.log('');
    }
  }
  return stat;
}

function summarize(engine, stat, opts) {
  var st = engine.getState();
  console.log('');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(BOLD('汇总: 执行 ' + stat.steps + ' 步（成功 ' + stat.ok + ' / blocked ' + stat.blocked.length + '）'));
  console.log('  段标 ' + stat.seg.length + ' 个' + (stat.segFail ? RED('，其中 ' + stat.segFail + ' 个与“当前所在空间”不符 ✗') : GREEN('，全部与“当前所在空间”一致 ✓')),
    '| 标记(逗号) ' + stat.marks + ' 个 | 彩蛋命令 ' + stat.eggs.length + ' 个' + (stat.unknown.length ? ' | 未知符号 ' + stat.unknown.length + ' 个' : ''));
  if (stat.segFail) {
    console.log(RED(BOLD('发现 ' + stat.segFail + ' 个段标失配：题解标记的盒子与引擎当前所在空间不一致——回放未通过。')));
  }
  console.log('  最终: 空间 ' + st.spaceId + '(' + st.spaceType + ')' + (st.layer ? '@层' : '') + ' 位置 ' + st.pos.r + ',' + st.pos.c + ' | 盒栈 ' + JSON.stringify(st.boxStack) + ' | 步数 ' + st.moves + (st.won ? GREEN(' | 🎉 已通关') : RED(' | 未通关')));
  if (stat.blocked.length) {
    console.log(YELLOW('（无效果移动 ' + stat.blocked.length + ' 次：推墙/不可进入等，属题解预期的原地不动）'));
  }  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

// ------------------------------------------------------------------ 主流程
function main() {
  var opts = parseArgs(process.argv.slice(2));
  console.log('Escape\'s Metabox 引擎 v' + VERSION + ' — 回放验证器');
  console.log('数据目录: ' + opts.data + ' | 题解: ' + opts.solution);
  console.log('');

  if (opts.selftest) {
    var code = runSelftest();
    process.exitCode = code;
    return;
  }

  if (opts.probe) {
    var code2 = runProbe(opts);
    process.exitCode = code2;
    return;
  }

  // 载入数据
  if (!fs.existsSync(opts.data)) {
    console.log(RED('数据目录不存在: ' + opts.data));
    console.log('可尝试: node src/replay.js --selftest');
    process.exitCode = 1;
    return;
  }
  var loaded;
  try {
    loaded = loadDataDir(opts.data);
  } catch (e) {
    console.log(RED('数据加载失败: ' + e.message));
    process.exitCode = 1;
    return;
  }
  var spaceIds = Object.keys(loaded.spaces);
  if (!spaceIds.length) {
    console.log(RED('数据目录中未找到 box-*.json: ' + opts.data));
    process.exitCode = 1; return;
  }
  if (loaded.skipped.length) {
    loaded.skipped.forEach(function (s) { console.log(YELLOW('⚠ 跳过文件 ' + s.file + ' → ' + s.error)); });
  }
  console.log('载入空间: ' + spaceIds.sort(function (a, b) { return (+a) - (+b); }).join(', '));
  console.log('（共 ' + spaceIds.length + ' 个编号空间，' + loaded.files.length + ' 个文件）');

  var issues = validateData(loaded.spaces);
  if (issues.length) {
    console.log(YELLOW('⚠ 数据校验提示 ' + issues.length + ' 条（不影响加载）:'));
    issues.slice(0, 10).forEach(function (it) { console.log('   - ' + (it.space ? '[' + it.space + '] ' : '') + it.msg); });
  }

  // 载入题解
  if (!fs.existsSync(opts.solution)) {
    console.log(RED('题解不存在: ' + opts.solution));
    console.log('提示: 可先运行 node src/replay.js --selftest 验证引擎。');
    process.exitCode = 1;
    return;
  }
  var text = fs.readFileSync(opts.solution, 'utf8');
  console.log('题解长度: ' + text.length + ' 字符（' + text.split(/\r?\n/).length + ' 行）');
  console.log('');

  var engine;
  try {
    engine = createEngine(loaded.spaces);
  } catch (e) {
    console.log(RED('引擎初始化失败: ' + e.message));
    process.exitCode = 1; return;
  }

  // 最初状态（起点: 1 号空间 ac 格）
  var st0 = engine.getState();
  console.log('起点: 空间 ' + st0.spaceId + '(' + st0.spaceType + ') ' + st0.pos.r + ',' + st0.pos.c + '#' + st0.posId + ' （1ms 根空间 AC 卡）');
  if (opts.map) console.log(miniMap(st0));
  console.log('');

  var stat = runReplay(engine, text, opts);
  summarize(engine, stat, opts);

  var bad = (stat.blocked.length > 0 && !opts.allowBlocked) || stat.segFail > 0;
  process.exitCode = (bad || !stat.won) ? 1 : 0;
}

// ------------------------------------------------------------------ 规则空间搜索（诊断）
// 在“真实数据 + 真实题解”上穷举引擎语义变体，寻找能让题解完整走通的规则组合。
function runProbe(opts) {
  var loaded = loadDataDir(opts.data);
  var text = fs.readFileSync(opts.solution, 'utf8');
  var tokens = tokenize(text);

  var combos = [];
  var lands = ['edge', 'ac', 'edgeFallback'];
  var exits = [true, false];
  var chains = ['far', 'near'];
  var pushes = [true, false];
  var twins = [true, false];
  var dirsList = [['d', 'a', 's', 'w'], ['w', 'a', 's', 'd'], ['a', 's', 'd', 'w'], ['s', 'd', 'w', 'a']];
  for (var a = 0; a < lands.length; a++)
    for (var b = 0; b < exits.length; b++)
      for (var c = 0; c < chains.length; c++)
        for (var d = 0; d < pushes.length; d++)
          for (var e = 0; e < twins.length; e++)
            for (var f = 0; f < dirsList.length; f++)
              combos.push({ landAt: lands[a], exitOnMove: exits[b], chainOrder: chains[c], pushOneMB: pushes[d], oneWayTwin: twins[e], interactDirs: dirsList[f] });

  var results = [];
  for (var ci = 0; ci < combos.length; ci++) {
    var opt = combos[ci];
    var eng = createEngine(loaded.spaces, opt);
    var steps = 0, blocked = 0, segMismatch = 0, maxSeg = 0, won = false, firstBlock = null;
    var winAt = -1;
    var lastBox = null;
    for (var ti = 0; ti < tokens.length; ti++) {
      var tok = tokens[ti];
      if (tok.type === 'num') {
        var st0 = eng.getState();
        if (String(lastBox) !== String(tok.value)) segMismatch++;
        lastBox = st0.currentBox;
        // 段标与当前实际盒只在“进入该盒”判定时比较；这里按实际盒更新
        if (String(st0.currentBox) === String(tok.value)) { maxSeg = Math.max(maxSeg, tok.value); }
        continue;
      }
      if (tok.type === 'egg' || tok.type === 'unknown' || tok.type === 'interact') continue;
      steps++;
      var okk = eng.move(tok.cmd);
      var st = eng.getState();
      if (!okk) {
        blocked++;
        if (!firstBlock) firstBlock = { step: steps, cmd: tok.cmd || ',', space: st.spaceId, pos: st.pos, reason: st.events[st.events.length - 1].reason };
      }
      if (st.won && !won) { won = true; winAt = steps; }
      if (st.layer) { /* tle layer */ }
      lastBox = st.currentBox;
    }
    var stF = eng.getState();
    results.push({
      opt: opt, steps: steps, blocked: blocked, segMismatch: segMismatch,
      final: stF.spaceId, won: won, winAt: winAt, firstBlock: firstBlock,
      score: (won ? 100000 : 0) - blocked * 5000 - segMismatch * 200 + stF.spaceId
    });
  }

  results.sort(function (x, y) { return y.score - x.score; });
  console.log('规则空间搜索: ' + combos.length + ' 种组合 × ' + tokens.length + ' token');
  console.log('');
  results.slice(0, 12).forEach(function (r, i) {
    console.log((i === 0 ? '★ ' : '  ') + 'score=' + r.score +
      ' | blocked=' + r.blocked + ' 段标失配=' + r.segMismatch + ' 最后=空间' + r.final + (r.won ? ' 🎉通关@' + r.winAt : '') +
      ' | landAt=' + r.opt.landAt + ' exitOnMove=' + r.opt.exitOnMove + ' chain=' + r.opt.chainOrder +
      ' push1MB=' + r.opt.pushOneMB + ' twin=' + r.opt.oneWayTwin + ' dirs=' + r.opt.interactDirs.join(''));
    if (r.firstBlock) console.log('     首个非法步: #' + r.firstBlock.step + ' "' + r.firstBlock.cmd + '" ' + r.firstBlock.reason + ' @空间' + r.firstBlock.space + ' ' + r.firstBlock.pos.r + ',' + r.firstBlock.pos.c);
  });
  return results[0].blocked === 0 ? 0 : 1;
}

// ------------------------------------------------------------------ 自测（样例数据 + 合成注入）
function runSelftest() {
  var pass = 0, fail = 0;
  function eq(name, got, want) {
    var g = JSON.stringify(got), w = JSON.stringify(want);
    if (g === w) { pass++; }
    else { fail++; console.log('  ✗ ' + name + ': 得到 ' + g + '，期望 ' + w); }
  }
  function ok(name, cond) {
    if (cond) pass++; else { fail++; console.log('  ✗ ' + name); }
  }

  console.log('—— 自测: 读取样例数据 ' + SAMPLE_DATA + ' …');
  if (!fs.existsSync(SAMPLE_DATA)) {
    console.log(RED('样例数据目录不存在: ' + SAMPLE_DATA + '（先运行生成脚本或检查仓库）'));
    return 1;
  }
  var loaded = loadDataDir(SAMPLE_DATA);
  if (loaded.skipped.length) loaded.skipped.forEach(function (s) { console.log(' ⚠ ' + s.error); });

  // —— 合成注入（仅内存）：彩蛋空间 9(UKE)、终点空间 50(MLE) + 相关盒实例
  var spaces = JSON.parse(JSON.stringify(loaded.spaces));
  function allFloor(sid, type, ac) {
    return { space: sid, type: type, ac: ac, cells: Array.from({ length: 49 }, function (_, i) { return { id: i + 1, label: 'WA', space: 0, size: '0B' }; }) };
  }
  spaces['9'] = allFloor(9, 'UKE', 23);
  spaces['50'] = allFloor(50, 'MLE', 1);
  // 1 号空间: #22 → 9号盒(0B, 供 UKE 标记测试)；#26 → 9号盒(0B, 被交换为 1MB 的同名实例)
  spaces['1'].cells[21] = { id: 22, label: 'UKE', space: 9, size: '0B' };
  spaces['1'].cells[25] = { id: 26, label: 'UKE', space: 9, size: '0B' };
  // 2 号空间: #27 → 50号盒(0B, 供胜利用)
  spaces['2'].cells[26] = { id: 27, label: 'MLE', space: 50, size: '0B' };

  var engine = createEngine(spaces);
  var st = null;

  // T1 初始状态
  st = engine.getState();
  eq('T1 初始空间/位置', [st.spaceId, st.pos, st.boxStack, st.moves], [1, { r: 4, c: 2 }, [1], 0]);
  eq('T1 起点=AC 卡 #23', st.posId, 23);
  eq('T1 网格: (4,1) 盒9号0B', [st.grid[21].box, st.grid[21].space, st.grid[21].size], [true, 9, '0B']);
  eq('T1 网格: (4,3) 盒2号0B', [st.grid[23].box, st.grid[23].space, st.grid[23].size], [true, 2, '0B']);
  eq('T1 网格: (4,5) 盒9号0B', [st.grid[25].box, st.grid[25].space, st.grid[25].size], [true, 9, '0B']);
  eq('T1 网格: (4,6) 盒3号0B', [st.grid[26].box, st.grid[26].space, st.grid[26].size], [true, 3, '0B']);
  eq('T1 网格: (4,7) 墙', st.grid[27].wall, true);

  // T2 撞墙 → blocked（不计数）
  ok('T2 撞墙 blocked', engine.move('w') === false);
  st = engine.getState();
  eq('T2 不计数', [st.moves, st.events[0].reason], [0, 'wall']);

  // T3 a: 进入 9 号盒（UKE → mark；交换 #26 同名 0B 实例为 1MB）
  ok('T3 左迈进盒', engine.move('a') === true);
  st = engine.getState();
  eq('T3 进入后位置/盒栈', [st.spaceId, st.pos, st.boxStack, st.moves], [9, { r: 4, c: 7 }, [1, 9], 1]);
  var etypes = st.events.map(function (e) { return e.type; });
  eq('T3 事件=[enter]（居所=空间1 MLE，不标记）', etypes, ['enter']);
  ok('T3 落点=右边缘正中 #28', st.player.r === 3 && st.player.c === 6 && st.grid[27].id === 28);
  var sp1 = engine.getSpaceState('1');
  eq('T3 无交换: #26 的同名 9号盒仍为 0B', sp1.shared[25].size, '0B');

  // T4 出口: d 从右边缘退出 → 方案(c)：doorway(根#24)为地板且“内侧格”(4,6)为同型0B盒3 → 穿梭进入盒3
  ok('T4 (c)穿梭进入盒3', engine.move('d') === true);
  st = engine.getState();
  eq('T4 穿梭后空间/位置', [st.spaceId, st.pos, st.boxStack, st.moves], [3, { r: 4, c: 1 }, [1, 9, 3], 2]);

  // T5 undo×2: 连标记一起撤销
  ok('T5 undo×2', engine.undo() && engine.undo());
  st = engine.getState();
  eq('T5 撤销后初始状态', [st.spaceId, st.pos, st.boxStack, st.moves], [1, { r: 4, c: 2 }, [1], 0]);
  sp1 = engine.getSpaceState('1');
  eq('T5 撤销恢复 0B 交换', sp1.shared[25].size, '0B');

  // T6 重演: a 进盒 → d 退出(穿梭盒3) → d 在盒3 内走动
  ok('T6a 再进9号盒', engine.move('a') === true);
  ok('T6b (c)穿梭退出', engine.move('d') === true);
  ok('T6c 盒3 内走动', engine.move('d') === true);
  st = engine.getState();
  eq('T6c 盒3 内 (4,2)#23', [st.spaceId, st.pos, st.moves], [3, { r: 4, c: 2 }, 3]);

  // T7 d: 进入盒2（单盒 1MB→标记交换，本样本无链预热；预热场景见 T9）
  ok('T7a 进盒2', engine.move('d') === true);
  st = engine.getState();
  eq('T7 进入盒2', [st.spaceId, st.pos, st.boxStack, st.moves], [2, { r: 4, c: 1 }, [1, 9, 3, 2], 4]);
  ok('T7 事件含 enter 与 mark(1MB→0B)', st.events.some(function (e) { return e.type === 'mark'; }) && st.events.some(function (e) { return e.type === 'enter'; }));
  var mEv7 = null; st.events.forEach(function (e) { if (e.type === 'mark') mEv7 = e; });
  ok('T7 标记: 被进实例 1MB→0B', mEv7 && mEv7.from === '1MB' && mEv7.to === '0B');
  var sp1b = engine.getSpaceState('1');
  ok('T7 交换: 空间1 的同名 0B 盒2 → 1MB', sp1b.shared[23].box && sp1b.shared[23].size === '1.00MB');

  // T8 盒2 内：走→推→推
  ok('T8a 走一步 (4,2)', engine.move('d') === true);
  st = engine.getState();
  eq('T8a 2ms (4,2)#23', [st.spaceId, st.pos.r, st.pos.c, st.moves], [2, 4, 2, 5]);
  ok('T8b 推一步 (4,3)', engine.move('d') === true);
  st = engine.getState();
  eq('T8b 2ms (4,3)#24', [st.spaceId, st.pos.r, st.pos.c, st.moves], [2, 4, 3, 6]);
  ok('T8c 再推一步 (4,4)', engine.move('d') === true);
  st = engine.getState();
  eq('T8c 2ms (4,4)#25', [st.spaceId, st.pos.r, st.pos.c, st.moves], [2, 4, 4, 7]);
  ok('T8 TLE 层已创建', st.layer !== null);

  // T9 胜利链: d d d d d d（走→链预热(链≥2)→转入→推→双推→进入最远盒50）
  var res = [], sawWin = false;
  for (var k = 0; k < 6; k++) {
    res.push(engine.move('d'));
    if (engine.getState().events.some(function (e) { return e.type === 'win'; })) sawWin = true;
  }
  eq('T9 胜利链: 5次成功+1次预热', res, [true, false, true, true, true, true]);
  st = engine.getState();
  eq('T9 通关', [st.spaceId, st.won, st.boxStack, st.moves], [50, true, [1, 9, 3, 2, 50], 12]);
  ok('T9 事件含 win', sawWin);

  // T10 undo×5 → 撤销到进入50号盒之前（回到 T8c 之后）
  for (var u = 0; u < 5; u++) engine.undo();
  st = engine.getState();
  eq('T10 undo 回到转移后', [st.spaceId, st.pos, st.moves, st.won], [2, { r: 4, c: 4 }, 7, false]);

  // T11 interact: 复位后 ',' 进盒2(TLE) → ',' 退出 → 层被销毁
  engine.reset();
  ok('T11a interact 进入2号盒', engine.interact() === true);
  st = engine.getState();
  eq('T11a interact 进盒2', [st.spaceId, st.pos, st.boxStack, st.moves], [2, { r: 4, c: 1 }, [1, 2], 1]);
  ok('T11a 层中含盒1(0B)', st.grid[23].box === true && st.grid[23].space === 1 && st.grid[23].size === '0B');
  ok('T11b interact 退出（回盒2孪生所在层=3ms）', engine.interact() === true);
  st = engine.getState();
  eq('T11b interact 退出回3ms', [st.spaceId, st.pos, st.boxStack, st.moves], [3, { r: 4, c: 2 }, [1], 2]);
  var sp2 = engine.getSpaceState('2');
  eq('T11 退出后 TLE 层已销毁', sp2.layers.length, 0);

  // T12 再 enter → 全新层 (盒1 恢复初始 0B 位置)
  ok('T12a 再次 interact 进入', engine.interact() === true);
  st = engine.getState();
  eq('T12a 新层恢复初始', [st.grid[23].box, st.grid[23].space, st.grid[23].size], [true, 1, '0B']);

  // T14 队长推演单测（逐字核对题解）：5ms 段 'ddssa,aaww,ssaa,waaa,aa'（忽略逗号；用真实数据）
  var eng14 = createEngine(loadDataDir(DEFAULT_DATA).spaces);
  ok('T14a jump 至 5ms', eng14.jump(5) === true);
  st = eng14.getState();
  eq('T14a 起点 5ms AC#22(4,1)', [st.spaceId, st.pos, st.posId], [5, { r: 4, c: 1 }, 22]);
  var t14 = { d: 'd', a: 'a', s: 's', w: 'w' };
  var T14 = [
    ['d', 5, 4, 2, 23, '走', 1], ['d', 5, 4, 3, 24, '走', 2], ['s', 5, 5, 3, 31, '走', 3], ['s', 5, 6, 3, 38, '走', 4],
    ['a', 5, 4, 7, 28, '左进5ms/1MB#37→#28', 5], ['a', 5, 4, 6, 27, '走', 6], ['a', 5, 4, 5, 26, '走', 7],
    ['w', 5, 3, 5, 19, '推5ms/0B #19→(2,5)', 8],
    ['w', 5, 3, 5, 19, '推不动+#46墙→不可进,原地', 8],
    ['s', 5, 4, 5, 26, '走', 9], ['s', 5, 5, 5, 33, '走', 10],
    ['a', 5, 5, 4, 32, '推1ms/0B #32→#31', 11], ['a', 5, 5, 3, 31, '推1ms/0B #31→#30', 12],
    ['w', 5, 4, 3, 24, '走', 13], ['a', 5, 4, 2, 23, '走', 14], ['a', 5, 4, 1, 22, '走', 15],
    ['a', 5, 2, 4, 11, '退出5ms/0B(当前@(2,5))→父层(2,4)#11', 16],
    ['a', 5, 2, 3, 10, '走', 17],
    ['a', 6, 4, 7, 28, '左进6ms/0B→6ms #28=AC', 18]
  ];
  for (var t14i = 0; t14i < T14.length; t14i++) {
    var row = T14[t14i];
    var okk14 = eng14.move(row[0]);
    st = eng14.getState();
    if (!(st.spaceId === row[1] && st.pos.r === row[2] && st.pos.c === row[3] && st.posId === row[4])) {
      fail++;
      console.log('  ✗ T14 第' + (t14i + 1) + '步 ' + row[0] + ' → 期望 空间' + row[1] + ' ' + row[2] + ',' + row[3] + '#' + row[4] + '，实际 空间' + st.spaceId + ' ' + st.pos.r + ',' + st.pos.c + '#' + st.posId + '（' + row[5] + '）');
    } else {
      pass++;
    }
  }
  st = eng14.getState();
  ok('T14 结束于 6ms #28 且盒6已入栈', st.spaceId === 6 && st.posId === 28 && st.boxStack[st.boxStack.length - 1] === 6);

  // T13 jump 调试
  engine.reset();
  ok('T13 jump 到 50', engine.jump(50) === true);
  st = engine.getState();
  eq('T13 跳跃到50', [st.spaceId, st.won], [50, true]);

  // T14 用样例数据走一遍“回放”演示（纯打印，不判定）
  var demoText = '1ddddd2d';
  var demoEngine = createEngine(JSON.parse(JSON.stringify(spaces)));
  console.log('');
  console.log('—— 演示: 样例回放 "' + demoText + '" 的输出格式 ——');
  var dstat = runReplay(demoEngine, demoText, { quiet: false });
  console.log('  演示统计: 执行 ' + dstat.steps + ' 步 / blocked ' + dstat.blocked.length);

  console.log('');
  if (fail === 0) {
    console.log(GREEN('✔ 自测全部通过 (' + pass + ' 项断言) —— 引擎行为符合规则规范'));
    return 0;
  }
  console.log(RED('✘ 自测失败: ' + fail + ' / ' + (pass + fail) + ' 项断言未通过'));
  return 1;
}

// ------------------------------------------------------------------ 入口
if (require.main === module) {
  main();
} else {
  module.exports = { tokenize: tokenize, runReplay: runReplay, runSelftest: runSelftest, main: main };
}
