/*!
 * Escape's Metabox — 游戏引擎（engine.js）v2.0 — UI 对齐版
 * =====================================================
 * 纯 JS，无 DOM 依赖；Node / 浏览器通用（UMD）。
 *
 * 浏览器侧使用约定（与 index.html 接口一致）:
 *   window.NetsGame.init(data?)   —— data = {SPACES:{1:{type,cells,ac},...}} 或 {1:{...},...}；
 *                                    无参: Node 下读 ../data/box-*.json，浏览器下取 window.LEVELS_DATA
 *   .reset() / .move(dir)('up/down/left/right' 或 'w/a/s/d') / .interact() / .undo() / .jump(spaceId) / .getState()
 *
 * getState() 公约:
 *   spaceId/space、spaceType/type（别名）; player:{r,c} 0-based（UI 单独绘制玩家）;
 *   grid: 49 格行主序实时视图 [{id,label,space,size,uid?}] ——
 *     墙:   label=该空间类型, space=空间编号, size='999.00MB'
 *     空地: label='WA'(AC 原格保留 'AC'；玩家脚下=WA), space=0, size='0B'
 *     盒:   label=所属空间类型(目标空间), space=所属编号, size='0B'|'1.00MB', uid=实例id
 *   stack:[1,...]（底层=1 号空间）; moves; won; enterable;
 *   events: 每次动作前清空、动作后填充（UI 每步读取即“本步事件”，type∈walk/push/enter/exit/teleport/blocked/mark/win…）
 *
 * 机制（已按题解验证）:
 *   进入落点: d→左缘正中#22 / a→右缘正中#28 / w→下缘正中#46 / s→上缘正中#4；
 *            推动失败 且 落点格非墙才可进入，墙→原地不动（事件 blocked）。
 *   1MB 转移: 进入 1.00MB 盒 → 同编号 0B 盒（含未访问空间基础布局）的内部视图 → 同方向落点。
 *   UKE: 居所式标记（盒所在空间为 UKE → 该实例记 0B 并交换同名 0B→1MB；markBy='residence' 默认）。
 *   TLE: 每次进入新建层（基础布局拷贝），直接退出该层即销毁（下次全新）。
 *   退出: 仅盒内部空间“开放边缘正中格”向外移动触发 → 父空间该盒实例同方向邻格（帧盒实时定位）。
 *   胜利: 进入 50 号空间。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); }
  else if (typeof define === 'function' && define.amd) { define([], factory); }
  else {
    var api = factory();
    root.NetsGame = api;          // UI 约定入口
    root.MetaboxEngine = api;     // 兼容别名
  }
})(typeof globalThis !== 'undefined' ? globalThis
    : (typeof self !== 'undefined' ? self : this), function () {
  'use strict';

  var VERSION = '2.0.0';
  var WIN_SPACE = 50;
  var ROOT_SPACE = 1;
  var CELLS = 49;
  var MAX_SNAPSHOTS = 400;
  var DIR_ALIAS = { up: 'w', down: 's', left: 'a', right: 'd' };

  // 方向表：edgeCell = 该方向进入时的“落点”边缘正中卡号
  //   d(右)→左缘正中#22；a(左)→右缘正中#28；w(上)→下缘正中#46；s(下)→上缘正中#4
  var DIRS = {
    w: { dr: -1, dc: 0, name: '上', edgeCell: 46 },
    a: { dr: 0, dc: -1, name: '左', edgeCell: 28 },
    s: { dr: 1, dc: 0, name: '下', edgeCell: 4 },
    d: { dr: 0, dc: 1, name: '右', edgeCell: 22 }
  };
  var DIR_ORDER = ['d', 'a', 's', 'w'];
  var OUTWARD = { top: 'w', bottom: 's', left: 'a', right: 'd' };
  var VALID_SIZES = { '0B': '0B', '1.00MB': '1MB', '999.00MB': 'WALL', '999MB': 'WALL' };

  function idToRC(id) { return { r: Math.floor((id - 1) / 7) + 1, c: ((id - 1) % 7) + 1 }; }
  function rcToId(r, c) { return (r - 1) * 7 + c; }
  function inGrid(r, c) { return r >= 1 && r <= 7 && c >= 1 && c <= 7; }
  function clonePos(p) { return { r: p.r, c: p.c }; }

  // ---------------------------------------------------------------- 数据规范化
  // 接受: {SPACES:{n:rec}} | {spaces:{n:rec}} | {n:rec} | [rec,...]（rec={type,cells,ac}）
  function normalizeData(data) {
    if (!data) return {};
    if (Array.isArray(data)) {
      var m = {};
      for (var i = 0; i < data.length; i++) {
        var r = data[i];
        if (r && typeof r === 'object' && (r.space !== undefined || r.cells)) {
          m[String(r.space !== undefined ? r.space : (i + 1))] = r;
        }
      }
      return m;
    }
    if (data.SPACES && typeof data.SPACES === 'object') return normalizeData(data.SPACES);
    if (data.spaces && typeof data.spaces === 'object' && !data.cells) return normalizeData(data.spaces);
    return data;
  }

  function validateData(data) {
    var spaces = normalizeData(data), issues = [];
    var ids = Object.keys(spaces).sort(function (a, b) { return (+a) - (+b); });
    if (!ids.length) { issues.push({ msg: '数据为空' }); return issues; }
    for (var k = 0; k < ids.length; k++) {
      var id = ids[k], rec = spaces[id];
      if (!rec || typeof rec !== 'object') { issues.push({ space: id, msg: '记录不是对象' }); continue; }
      if (!rec.cells || !rec.cells.length) { issues.push({ space: id, msg: '缺少 cells' }); continue; }
      if (rec.cells.length !== CELLS) issues.push({ space: id, msg: 'cells 长度 ' + rec.cells.length + ' ≠ 49' });
      if (rec.type && ['MLE', 'TLE', 'UKE'].indexOf(rec.type) < 0)
        issues.push({ space: id, msg: 'type 非标准: ' + rec.type });
      if (!rec.ac || rec.ac < 1 || rec.ac > 49)
        issues.push({ space: id, msg: 'ac 缺失或越界: ' + rec.ac + '（彩蛋关可为 null）' });
      for (var i = 0; i < rec.cells.length; i++) {
        var c = rec.cells[i];
        if (!c) { issues.push({ space: id, msg: 'cells[' + i + '] 为空' }); continue; }
        if (c.id !== i + 1) issues.push({ space: id, msg: '卡 ' + i + ' id=' + c.id + ' 与下标不一致' });
        if (['MLE', 'TLE', 'UKE', 'WA', 'AC'].indexOf(c.label) < 0)
          issues.push({ space: id, msg: '卡 ' + (i + 1) + ' label 非法: ' + c.label });
      }
    }
    return issues;
  }

  function tryRequire(name) {
    try { return typeof require === 'function' ? require(name) : null; } catch (e) { return null; }
  }
  function loadDataDir(dir) {
    var fs = tryRequire('fs'), path = tryRequire('path');
    if (!fs) throw new Error('loadDataDir 仅在 Node 环境可用（浏览器请用 window.LEVELS_DATA 或传 init(data)）');
    var files = fs.readdirSync(dir).filter(function (f) { return /^box[-_]?[\w\u4e00-\u9fff]*\.json$/i.test(f); }).sort();
    var out = { spaces: {}, files: files, raw: [], skipped: [] };
    for (var i = 0; i < files.length; i++) {
      var fp = path.join(dir, files[i]);
      try {
        var j = JSON.parse(fs.readFileSync(fp, 'utf8'));
        var key = String((j.space !== undefined && j.space !== null) ? j.space : files[i]);
        out.raw.push(j);
        if (out.spaces[key]) {
          out.skipped.push({ file: files[i], error: 'space=' + key + ' 已被占用，跳过' });
          continue;
        }
        j.__file = files[i];
        out.spaces[key] = j;
      } catch (e) {
        out.skipped.push({ file: files[i], error: 'JSON 解析失败: ' + e.message });
      }
    }
    return out;
  }

  // ================================================================ 引擎
  // options: landAt:'edge'|'ac'|'edgeFallback'|'twinPos'  exitOnMove  chainOrder  interactDirs  interactExit
  //          pushOneMB  oneWayTwin  twinPref  markBy:'residence'|'target'
  function Engine(data, options) {
    this.options = this._defaultOptions(options);
    this.init(data);
  }

  Engine.prototype._defaultOptions = function (o) {
    var d = {
      landAt: 'edge', exitOnMove: true, legalCheck: 'target', chainOrder: 'far',
      interactDirs: ['d', 'a', 's', 'w'], interactExit: true, pushOneMB: true,
      oneWayTwin: true, twinPref: 'current', markBy: 'residence'
    };
    if (o) { for (var k in o) if (o[k] !== undefined) d[k] = o[k]; }
    return d;
  };

  Engine.prototype.init = function (data) {
    if (!data) data = this.autoLoad();
    this.data = normalizeData(data);
    this.spaceMeta = {};
    this.uidSeq = 1;
    this.snapshots = [];
    this.events = [];
    this.loadIssues = [];
    var ids = Object.keys(this.data);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i], rec = this.data[id];
      if (!rec || typeof rec !== 'object' || !rec.cells) continue;
      var type = rec.type || 'MLE';
      if (['MLE', 'TLE', 'UKE'].indexOf(type) < 0) type = 'MLE';
      var ac = (rec.ac >= 1 && rec.ac <= 49) ? rec.ac : 23;
      this.spaceMeta[id] = {
        id: id, type: type, ac: ac,
        baseCells: rec.cells,
        baseAc: rec.ac,
        shared: null, layers: [], layerSeq: 0,
        egg: type !== rec.type || !rec.ac
      };
    }
    this.loadIssues = validateData(this.data);
    this.reset();
    return this;
  };

  // 无参 init：Node 下读 ../data；浏览器下取 window.LEVELS_DATA
  Engine.prototype.autoLoad = function () {
    if (typeof window !== 'undefined' && window && window.LEVELS_DATA) return { SPACES: window.LEVELS_DATA };
    var fs = tryRequire('fs'), path = tryRequire('path');
    if (fs) {
      var here = tryRequire('module');
      var base = here && here.filename ? path.dirname(here.filename) : process.cwd();
      var dir = path.join(base, '..', 'data');
      if (fs.existsSync(dir)) return loadDataDir(dir).spaces;
    }
    throw new Error('init() 无参数时找不到数据：Node 用 data/box-*.json（默认 ../data），浏览器用 window.LEVELS_DATA');
  };

  Engine.prototype.reset = function () {
    var self = this;
    Object.keys(this.spaceMeta).forEach(function (id) {
      var m = self.spaceMeta[id];
      m.shared = null; m.layers = []; m.layerSeq = 0;
    });
    this.uidSeq = 1;
    this.events = [];
    this.snapshots = [];
    this.frames = [];
    this.moves = 0;
    this.won = false;
    var rootMeta = this.spaceMeta[String(ROOT_SPACE)];
    if (!rootMeta) throw new Error('缺少 1 号空间数据——引擎无法初始化根空间');
    this.root = this._buildGrid(ROOT_SPACE, rootMeta.baseCells, 'shared', 0);
    rootMeta.shared = this.root;
    this.current = this.root;
    this.pos = idToRC(rootMeta.ac);
    return this;
  };

  // —— 网格构建：基础布局 -> 7x7（null=墙；{box:null|实例, baseLabel}）
  Engine.prototype._buildGrid = function (spaceId, cells, kind, seq) {
    var g = { spaceId: String(spaceId), kind: kind, seq: seq, alive: true, grid: Array(8) };
    for (var r = 1; r <= 7; r++) g.grid[r] = Array(8);
    for (var id = 1; id <= CELLS; id++) {
      var rc = idToRC(id), card = cells[id - 1] || {};
      var label = card.label, size = card.size;
      if (label === 'WA' || label === 'AC') { g.grid[rc.r][rc.c] = { box: null, baseLabel: label }; continue; }
      if (VALID_SIZES[size] === 'WALL') { g.grid[rc.r][rc.c] = null; continue; }
      var kind2 = VALID_SIZES[size];
      if (kind2 === '1MB' || kind2 === '0B') {
        g.grid[rc.r][rc.c] = { box: this._makeBox(card, spaceId, rc, kind2), baseLabel: label };
        continue;
      }
      if (label === 'MLE' || label === 'TLE' || label === 'UKE') {
        g.grid[rc.r][rc.c] = { box: this._makeBox(card, spaceId, rc, '0B'), baseLabel: label };
        continue;
      }
      g.grid[rc.r][rc.c] = { box: null, baseLabel: 'WA' };
    }
    return g;
  };
  Engine.prototype._makeBox = function (card, spaceId, rc, type) {
    return {
      uid: 'b' + (this.uidSeq++),
      spaceId: String((card.space !== undefined && card.space !== null) ? card.space : spaceId),
      type: type,
      spaceType: card.label || 'MLE',
      pos: { r: rc.r, c: rc.c }
    };
  };

  Engine.prototype._spaceView = function (spaceId, type) {
    var meta = this.spaceMeta[spaceId];
    if (!meta) return null;
    if (type === 'TLE') {
      var g = this._buildGrid(spaceId, meta.baseCells, 'layer', meta.layerSeq++);
      meta.layers.push(g);
      return g;
    }
    if (!meta.shared) meta.shared = this._buildGrid(spaceId, meta.baseCells, 'shared', 0);
    return meta.shared;
  };

  Engine.prototype._destroyLayer = function (g) {
    if (!g || g.kind !== 'layer' || !g.alive) return;
    g.alive = false;
    var meta = this.spaceMeta[g.spaceId];
    var idx = meta.layers.indexOf(g);
    if (idx >= 0) meta.layers.splice(idx, 1);
  };

  Engine.prototype._forEachGrid = function (cb) {
    var metas = this.spaceMeta;
    for (var id in metas) {
      var m = metas[id];
      if (m.shared) { var stop = cb(m.shared); if (stop === true) return; }
      for (var i = 0; i < m.layers.length; i++) { var st = cb(m.layers[i]); if (st === true) return; }
    }
  };

  Engine.prototype._forEachBoxInGrid = function (g, cb) {
    for (var r = 1; r <= 7; r++) for (var c = 1; c <= 7; c++) {
      var cell = g.grid[r][c];
      if (cell && cell.box) { if (cb(cell.box) === true) return; }
    }
  };

  Engine.prototype._containingGrid = function (box) {
    var found = null;
    this._forEachGrid(function (g) {
      var hit = false;
      for (var r = 1; r <= 7 && !hit; r++) for (var c = 1; c <= 7; c++) {
        var cell = g.grid[r][c];
        if (cell && cell.box === box) { found = g; hit = true; break; }
      }
      return hit ? true : undefined;
    });
    return found;
  };

  // —— 同名 0B 实例收集（1MB 转移 & UKE 交换）：live(物化网格) + base(未访问空间基础布局)
  Engine.prototype._collectTwinCandidates = function (spaceId) {
    var self = this, live = [], base = [], seenResidence = {};
    this._forEachGrid(function (g) {
      seenResidence[g.spaceId] = true;
      self._forEachBoxInGrid(g, function (box) {
        if (box.spaceId === String(spaceId) && box.type === '0B') live.push({ box: box, grid: g });
      });
    });
    var ids = Object.keys(this.spaceMeta).sort(function (a, b) { return (+a) - (+b); });
    for (var k = 0; k < ids.length; k++) {
      var mm = this.spaceMeta[ids[k]];
      if (seenResidence[mm.id]) continue;
      for (var ci = 0; ci < mm.baseCells.length; ci++) {
        var card = mm.baseCells[ci];
        if (!card || (card.label !== 'MLE' && card.label !== 'TLE' && card.label !== 'UKE')) continue;
        if (card.size === '0B' && String(card.space) === String(spaceId)) base.push({ card: card, meta: mm });
      }
    }
    return { live: live, base: base };
  };

  Engine.prototype._pickTwinEntry = function (spaceId) {
    var self = this;
    var cand = this._collectTwinCandidates(spaceId);
    if (cand.live.length) {
      for (var i = 0; i < cand.live.length; i++) if (cand.live[i].grid === this.current) return { box: cand.live[i].box, grid: cand.live[i].grid, created: null };
      if (cand.live.length === 1) return { box: cand.live[0].box, grid: cand.live[0].grid, created: null };
      if (this.options.twinPref === 'first') return { box: cand.live[0].box, grid: cand.live[0].grid, created: null };
      return null;
    }
    if (cand.base.length === 1) {
      var entry = cand.base[0];
      var rv = this._spaceView(entry.meta.id, entry.meta.type);
      if (!rv) return null;
      var found = null;
      this._forEachBoxInGrid(rv, function (b) {
        if (!found && b.spaceId === String(entry.card.space) && b.type === '0B') found = b;
      });
      return found ? { box: found, grid: rv, created: rv } : null;
    }
    return null;
  };

  Engine.prototype._chainDepthOf = function (g) {
    if (g === this.root) return 0;
    for (var i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].view === g) return i + 1;
    }
    return -1;
  };

  Engine.prototype._collectChain = function (g, start, dir) {
    var d = DIRS[dir], chain = [], cur = { r: start.r, c: start.c };
    for (;;) {
      var cell = g.grid[cur.r] && g.grid[cur.r][cur.c];
      if (!cell || !cell.box) break;
      chain.push(cell.box);
      cur = { r: cur.r + d.dr, c: cur.c + d.dc };
      if (!inGrid(cur.r, cur.c)) break;
    }
    return chain;
  };

  Engine.prototype._canPush = function (g, chain, dir) {
    if (!chain.length) return false;
    if (!this.options.pushOneMB) {
      for (var i = 0; i < chain.length; i++) if (chain[i].type === '1MB') return false;
    }
    var d = DIRS[dir], last = chain[chain.length - 1].pos;
    var nr = last.r + d.dr, nc = last.c + d.dc;
    if (!inGrid(nr, nc)) return false;
    var cell = g.grid[nr][nc];
    return !!cell && cell.box === null;
  };

  Engine.prototype._pushChain = function (g, chain, dir) {
    var d = DIRS[dir];
    for (var i = chain.length - 1; i >= 0; i--) {
      var box = chain[i], from = box.pos;
      var to = { r: from.r + d.dr, c: from.c + d.dc };
      g.grid[from.r][from.c].box = null;
      var tcell = g.grid[to.r][to.c];
      if (!tcell) tcell = g.grid[to.r][to.c] = { box: null, baseLabel: 'WA' };
      tcell.box = box;
      box.pos = to;
    }
  };

  Engine.prototype._checkLandingCell = function (g, rc, dir) {
    var cell = g.grid[rc.r][rc.c];
    if (!cell) return null;
    if (cell.box === null) return { land: rc, chainToPush: null };
    var chain = this._collectChain(g, rc, dir);
    if (!chain.length) return null;
    if (this._canPush(g, chain, dir)) return { land: rc, chainToPush: chain };
    return null;
  };

  Engine.prototype._resolveLanding = function (view, meta, dir, twinEntry) {
    var opts = this.options;
    var edgeRC = idToRC(DIRS[dir].edgeCell);
    if (opts.landAt === 'twinPos' && twinEntry && twinEntry.grid && twinEntry.grid.spaceId === view.spaceId) {
      return this._checkLandingCell(view, clonePos(twinEntry.box.pos), dir);
    }
    if (opts.landAt === 'ac') return this._checkLandingCell(view, idToRC(meta.ac), dir);
    if (opts.landAt === 'edgeFallback') {
      var l = this._checkLandingCell(view, edgeRC, dir);
      if (l) return l;
      return this._checkLandingCell(view, idToRC(meta.ac), dir);
    }
    return this._checkLandingCell(view, edgeRC, dir);
  };

  // —— 尝试进入盒实例 box。成功 true；不可进 null
  Engine.prototype._tryEnter = function (box, dir, extra) {
    var spaceId = String(box.spaceId);
    var meta = this.spaceMeta[spaceId];
    if (!meta) return null;
    var targetType = meta.type;
    var opts = this.options;

    var twinEntry = null;
    if (box.type === '1MB' && opts.oneWayTwin) {
      twinEntry = this._pickTwinEntry(box.spaceId);
      if (!twinEntry) return null;
    }

    var view = this._spaceView(spaceId, targetType);
    if (!view) return null;
    var createdLayer = (targetType === 'TLE') ? view : null;

    var landing = this._resolveLanding(view, meta, dir, twinEntry);
    if (!landing) {
      if (createdLayer) this._destroyLayer(createdLayer);
      if (twinEntry && twinEntry.created && twinEntry.created.kind === 'layer') this._destroyLayer(twinEntry.created);
      return null;
    }

    // —— 判定通过，应用（先快照）——
    this._snapshot();
    if (landing.chainToPush) this._pushChain(view, landing.chainToPush, dir);

    var evs = [];
    if (this._shouldMark(box, meta, spaceId)) evs.push(this._doMark(box));

    var frame;
    if (box.type === '1MB' && this.options.oneWayTwin) {
      var twin = twinEntry.box, tg = twinEntry.grid;
      var depth = tg ? this._chainDepthOf(tg) : -1;
      var selfLoop = (depth < 0 && tg === view);
      if (selfLoop) depth = this.frames.length;
      if (depth < 0) depth = 0;
      for (var i = this.frames.length - 1; i >= depth; i--) {
        var gv = this.frames[i].view;
        if (gv.kind === 'layer') this._destroyLayer(gv);
      }
      this.frames.length = depth;
      var parentGrid = (tg !== null && tg !== undefined) ? tg : this.root;
      frame = { view: view, parent: parentGrid, boxUid: twin.uid, boxPos: clonePos(twin.pos), spaceId: spaceId, master: !!selfLoop };
      evs.push({ type: 'teleport', dir: dir, fromBoxUid: box.uid, fromSpaceId: +spaceId, toBoxUid: twin.uid, viewSpaceId: +spaceId, land: clonePos(landing.land) });
    } else {
      frame = { view: view, parent: this.current, boxUid: box.uid, boxPos: clonePos(box.pos), spaceId: spaceId };
    }
    this.frames.push(frame);

    this.current = view;
    this.pos = landing.land;
    this.moves++;
    this._ev('enter', { dir: dir, boxUid: box.uid, boxSpaceId: +spaceId, viewSpaceId: +spaceId, land: clonePos(this.pos), landId: rcToId(this.pos.r, this.pos.c), tunnel: !!(extra && extra.tunnel) });
    for (var k = 0; k < evs.length; k++) this.events.push(evs[k]);

    if (view.spaceId === String(WIN_SPACE) && !this.won) {
      this.won = true;
      this._ev('win', { spaceId: WIN_SPACE });
    }
    return true;
  };

  // —— 可进入性评估（纯检查，供 UI enterable 提示）
  Engine.prototype._canEnterAny = function () {
    var dirs = this.options.interactDirs;
    for (var k = 0; k < dirs.length; k++) {
      var dir = dirs[k], d = DIRS[dir];
      var t = { r: this.pos.r + d.dr, c: this.pos.c + d.dc };
      if (!inGrid(t.r, t.c)) continue;
      var cell = this.current.grid[t.r][t.c];
      if (!cell || !cell.box) continue;
      var chain = this._collectChain(this.current, t, dir);
      for (var i = chain.length - 1; i >= 0; i--) {
        if (this._canEnterBox(chain[i], dir)) return true;
      }
    }
    return false;
  };
  Engine.prototype._canEnterBox = function (box, dir) {
    var spaceId = String(box.spaceId);
    var meta = this.spaceMeta[spaceId];
    if (!meta) return false;
    var opts = this.options;
    var twinEntry = null;
    if (box.type === '1MB' && opts.oneWayTwin) {
      twinEntry = this._pickTwinEntry(box.spaceId);
      if (!twinEntry) return false;
    }
    var view = this._spaceView(spaceId, meta.type);
    if (!view) return false;
    var created = (meta.type === 'TLE') ? view : null;
    var ok = !!this._resolveLanding(view, meta, dir, twinEntry);
    if (created) this._destroyLayer(created);
    return ok;
  };

  // —— UKE 标记：markBy='residence'(默认, 所在空间为 UKE) | 'target'(目标空间为 UKE)
  Engine.prototype._shouldMark = function (box, meta, spaceId) {
    if (this.options.markBy === 'target') return meta.type === 'UKE';
    var g = this._containingGrid(box);
    var rm = g ? this.spaceMeta[g.spaceId] : null;
    return !!(rm && rm.type === 'UKE');
  };

  Engine.prototype._syncBaseCard = function (grid, pos, newSize) {
    var meta = this.spaceMeta[grid.spaceId];
    if (!meta || meta.type === 'TLE') return;
    var card = meta.baseCells[rcToId(pos.r, pos.c) - 1];
    if (card && (card.label === 'MLE' || card.label === 'TLE' || card.label === 'UKE')) card.size = newSize;
  };

  Engine.prototype._doMark = function (box) {
    var was = box.type;
    box.type = '0B';
    var home = this._containingGrid(box);
    if (home) this._syncBaseCard(home, box.pos, '0B');
    var swap = null;
    var cand = this._collectTwinCandidates(box.spaceId);
    var bestLive = null;
    for (var i = 0; i < cand.live.length; i++) {
      var li = cand.live[i];
      if (li.box === box) continue;
      if (!bestLive || (li.grid === this.current && bestLive.grid !== this.current)) bestLive = li;
    }
    if (bestLive) {
      swap = bestLive.box; swap.type = '1MB';
      if (bestLive.grid) this._syncBaseCard(bestLive.grid, swap.pos, '1.00MB');
    } else if (cand.base.length) {
      var bc = null;
      for (var j = 0; j < cand.base.length; j++) {
        var bj = cand.base[j];
        if (home && bj.meta === this.spaceMeta[home.spaceId]) {
          var cardId = (bj.card.id >= 1 && bj.card.id <= 49) ? bj.card.id : 0;
          if (cardId === rcToId(box.pos.r, box.pos.c)) continue;
        }
        bc = bj; break;
      }
      if (bc) {
        bc.card.size = '1.00MB';
        swap = { uid: 'base:' + bc.meta.id + '#' + bc.card.id, type: '0B' };
      }
    }
    var ev = { type: 'mark', spaceId: +box.spaceId, boxUid: box.uid, from: was, to: '0B' };
    if (swap) { ev.swappedUid = swap.uid; ev.swappedFrom = '0B'; ev.swappedTo = '1MB'; }
    return ev;
  };

  // —— 退出/推出/穿梭（盒内站开放边缘正中格并向外移动）
  Engine.prototype._exitAttempt = function (dir) {
    var frame = this.frames[this.frames.length - 1];
    var pg = frame.parent;
    var d = DIRS[dir];
    var boxPos = this._liveBoxPos(pg, frame.boxUid);
    if (!boxPos) boxPos = frame.boxPos;
    var t = { r: boxPos.r + d.dr, c: boxPos.c + d.dc };
    if (!inGrid(t.r, t.c)) return this._blocked('exitBoundary', dir, this.pos);
    var cell = pg.grid[t.r][t.c];
    if (!cell) return this._blocked('exitWall', dir, this.pos);

    if (cell.box === null) {
      this._snapshot();
      var leftView = this.current;
      this.frames.pop();
      this.current = pg;
      this.pos = t;
      this.moves++;
      this._ev('exit', { dir: dir, to: t, boxUid: frame.boxUid, spaceId: +frame.spaceId });
      this._destroyLayer(leftView);
      return true;
    }

    var chain = this._collectChain(pg, t, dir);
    if (this._canPush(pg, chain, dir)) {
      this._snapshot();
      this._pushChain(pg, chain, dir);
      var leftView2 = this.current;
      this.frames.pop();
      this.current = pg;
      this.pos = t;
      this.moves++;
      this._ev('push', { dir: dir, chain: chain.length, spaceId: +frame.spaceId });
      this._ev('exit', { dir: dir, to: t, boxUid: frame.boxUid, spaceId: +frame.spaceId });
      this._destroyLayer(leftView2);
      return true;
    }

    var myBox = pg.grid[boxPos.r][boxPos.c] ? pg.grid[boxPos.r][boxPos.c].box : null;
    if (!myBox) return this._blocked('exitNoBox', dir, this.pos);
    if (myBox.type === chain[0].type) {
      return this._tryEnter(chain[0], dir, { tunnel: true });
    }
    return this._blocked('exitPushBlocked', dir, this.pos);
  };

  Engine.prototype._liveBoxPos = function (pg, boxUid) {
    if (!boxUid) return null;
    for (var r = 1; r <= 7; r++) for (var c = 1; c <= 7; c++) {
      var cell = pg.grid[r][c];
      if (cell && cell.box && cell.box.uid === boxUid) return { r: r, c: c };
    }
    return null;
  };

  Engine.prototype._step = function (dir) {
    var d = DIRS[dir];
    var t = { r: this.pos.r + d.dr, c: this.pos.c + d.dc };
    if (!inGrid(t.r, t.c)) return this._blocked('outside', dir, this.pos);
    var g = this.current.grid;
    var cell = g[t.r][t.c];
    if (!cell) return this._blocked('wall', dir, this.pos);

    if (cell.box === null) {
      this._snapshot();
      this.pos = t;
      this.moves++;
      this._ev('walk', { dir: dir, from: clonePos(this.pos), to: t });
      return true;
    }

    var chain = this._collectChain(this.current, t, dir);
    if (this._canPush(this.current, chain, dir)) {
      this._snapshot();
      this._pushChain(this.current, chain, dir);
      this.pos = t;
      this.moves++;
      this._ev('push', { dir: dir, chain: chain.length, boxUid: chain[0].uid, spaceId: +chain[0].spaceId });
      return true;
    }

    var order = this.options.chainOrder === 'near'
      ? [0, 1, 2, 3, 4, 5, 6].slice(0, chain.length)
      : [0, 1, 2, 3, 4, 5, 6].slice(0, chain.length).reverse();
    for (var k2 = 0; k2 < order.length; k2++) {
      var res = this._tryEnter(chain[order[k2]], dir);
      if (res) return true;
    }
    return this._blocked('noEnter', dir, this.pos);
  };

  // —— 边界信息（约定：仅“开放边缘正中格” #4/#22/#28/#46 触发退出）
  Engine.prototype._borderOf = function (p) {
    if (p.r === 1 && p.c === 4) return 'top';
    if (p.r === 7 && p.c === 4) return 'bottom';
    if (p.r === 4 && p.c === 1) return 'left';
    if (p.r === 4 && p.c === 7) return 'right';
    return null;
  };

  // ================================================================ 公开 API
  Engine.prototype.normDir = function (dir) {
    if (!dir) return null;
    if (DIR_ALIAS[dir]) return DIR_ALIAS[dir];
    return DIRS[dir] ? dir : null;
  };

  Engine.prototype.move = function (dir) {
    dir = this.normDir(dir);
    if (!dir) return this._blocked('badDir', dir, this.pos);
    this.events = [];                                  // UI 约定：每步动作前清空事件
    if (this.options.exitOnMove && this.frames.length) {
      var b = this._borderOf(this.pos);
      if (b && OUTWARD[b] === dir) return this._exitAttempt(dir);
    }
    return this._step(dir);
  };

  Engine.prototype.interact = function () {
    this.events = [];
    var dirs = this.options.interactDirs;
    for (var k = 0; k < dirs.length; k++) {
      var dir = dirs[k], d = DIRS[dir];
      var t = { r: this.pos.r + d.dr, c: this.pos.c + d.dc };
      if (!inGrid(t.r, t.c)) continue;
      var cell = this.current.grid[t.r][t.c];
      if (!cell || !cell.box) continue;
      var chain = this._collectChain(this.current, t, dir);
      var seg = [0, 1, 2, 3, 4, 5, 6].slice(0, chain.length);
      if (this.options.chainOrder === 'far') seg = seg.slice().reverse();
      for (var i = 0; i < seg.length; i++) {
        if (this._tryEnter(chain[seg[i]], dir)) return true;
      }
    }
    if (this.options.interactExit && this.frames.length) {
      var b = this._borderOf(this.pos);
      if (b) return this._exitAttempt(OUTWARD[b]);
    }
    return this._blocked('interactNothing', null, this.pos);
  };

  Engine.prototype._snapshot = function () {
    this.snapshots.push(this._cloneWorld());
    if (this.snapshots.length > MAX_SNAPSHOTS) this.snapshots.shift();
  };
  Engine.prototype._cloneWorld = function () {
    var gridMap = new Map();
    function cloneGrid(g) {
      if (!g) return null;
      if (gridMap.has(g)) return gridMap.get(g);
      var c = { spaceId: g.spaceId, kind: g.kind, seq: g.seq, alive: g.alive, grid: Array(8) };
      gridMap.set(g, c);
      for (var r = 1; r <= 7; r++) {
        c.grid[r] = Array(8);
        for (var col = 1; col <= 7; col++) {
          var cell = g.grid[r][col];
          if (!cell) continue;
          c.grid[r][col] = cell.box ? {
            box: { uid: cell.box.uid, spaceId: cell.box.spaceId, type: cell.box.type, spaceType: cell.box.spaceType, pos: { r: cell.box.pos.r, c: cell.box.pos.c } },
            baseLabel: cell.baseLabel
          } : { box: null, baseLabel: cell.baseLabel };
        }
      }
      return c;
    }
    var metas = {};
    for (var id in this.spaceMeta) {
      var m = this.spaceMeta[id];
      metas[id] = { type: m.type, ac: m.ac, baseCells: m.baseCells, shared: cloneGrid(m.shared), layers: m.layers.map(cloneGrid), layerSeq: m.layerSeq };
    }
    var frames = this.frames.map(function (f) {
      return { view: cloneGrid(f.view), parent: cloneGrid(f.parent), boxUid: f.boxUid, boxPos: clonePos(f.boxPos), spaceId: f.spaceId, master: !!f.master };
    });
    return {
      metas: metas, root: cloneGrid(this.root), current: cloneGrid(this.current),
      pos: clonePos(this.pos), frames: frames, moves: this.moves, won: this.won, uidSeq: this.uidSeq
    };
  };
  Engine.prototype._restoreWorld = function (s) {
    for (var id in s.metas) {
      var m = this.spaceMeta[id];
      if (!m) continue;
      m.shared = s.metas[id].shared;
      m.layers = s.metas[id].layers;
      m.layerSeq = s.metas[id].layerSeq;
    }
    this.root = s.root;
    this.current = s.current;
    this.pos = clonePos(s.pos);
    this.frames = s.frames.map(function (f) {
      return { view: f.view, parent: f.parent, boxUid: f.boxUid, boxPos: clonePos(f.boxPos), spaceId: f.spaceId, master: !!f.master };
    });
    this.moves = s.moves;
    this.won = s.won;
    this.uidSeq = s.uidSeq;
    this.events = [];
  };
  Engine.prototype.undo = function () {
    this.events = [];
    if (!this.snapshots.length) return false;
    var s = this.snapshots.pop();
    this._restoreWorld(s);
    this._ev('undo', {});
    return true;
  };

  Engine.prototype.jump = function (spaceId) {
    this.events = [];
    var meta = this.spaceMeta[String(spaceId)];
    if (!meta) return false;
    this._snapshot();
    var view = this._spaceView(String(spaceId), meta.type);
    if (!view) return false;
    this.frames = [];
    this.current = view;
    this.pos = idToRC(meta.ac);
    if (view.spaceId === String(WIN_SPACE)) this.won = true;
    this._ev('jump', { spaceId: spaceId });
    return true;
  };

  Engine.prototype._ev = function (type, payload) {
    var e = payload || {};
    e.type = type;
    this.events.push(e);
  };
  Engine.prototype._blocked = function (reason, dir, pos) {
    this._ev('blocked', { reason: reason, dir: dir, pos: clonePos(pos) });
    return false;
  };

  // —— 渲染状态（UI 公约：grid=49 格实时视图、player=0-based、events=本步事件）
  Engine.prototype.getState = function (opts) {
    opts = opts || {};
    var cells = this._displayCells(this.current, this.pos);
    var boxStack = this._boxStack().map(function (f) { return +f.spaceId; });
    var st = {
      version: VERSION,
      spaceId: +this.current.spaceId,
      space: +this.current.spaceId,
      spaceType: this.spaceMeta[this.current.spaceId] ? this.spaceMeta[this.current.spaceId].type : 'MLE',
      type: this.spaceMeta[this.current.spaceId] ? this.spaceMeta[this.current.spaceId].type : 'MLE',
      layer: this.current.kind === 'layer'
        ? { index: (this.spaceMeta[this.current.spaceId] || {}).layers.indexOf(this.current), total: ((this.spaceMeta[this.current.spaceId] || {}).layers || []).length }
        : null,
      pos: clonePos(this.pos),
      posId: rcToId(this.pos.r, this.pos.c),
      player: { r: this.pos.r - 1, c: this.pos.c - 1 },
      moves: this.moves,
      won: this.won,
      enterable: this._canEnterAny(),
      stack: boxStack,
      stackDetail: this._boxStack(),
      boxStack: boxStack,
      currentBox: boxStack[boxStack.length - 1],
      events: this.events,
      grid: cells,
      rootStart: { spaceId: ROOT_SPACE, pos: idToRC(this.spaceMeta[String(ROOT_SPACE)] ? this.spaceMeta[String(ROOT_SPACE)].ac : 23) }
    };
    return st;
  };

  Engine.prototype._boxStack = function () {
    var arr = [{ spaceId: String(ROOT_SPACE), boxUid: null, parent: true }];
    for (var i = 0; i < this.frames.length; i++) {
      arr.push({ spaceId: this.frames[i].spaceId, boxUid: this.frames[i].boxUid, parent: false });
    }
    return arr;
  };

  // —— 49 格行主序实时视图（UI 公约）
  Engine.prototype._displayCells = function (g, playerPos) {
    var out = [];
    var spaceType = this.spaceMeta[g.spaceId] ? this.spaceMeta[g.spaceId].type : 'MLE';
    for (var id = 1; id <= CELLS; id++) {
      var rc = idToRC(id), cell = g.grid[rc.r][rc.c];
      if (!cell) {                                   // 墙
        out.push({ id: id, label: spaceType, space: +g.spaceId, size: '999.00MB', uid: null, wall: true });
        continue;
      }
      if (cell.box) {                                // 盒实例
        var targetMeta = this.spaceMeta[cell.box.spaceId];
        out.push({
          id: id, label: targetMeta ? targetMeta.type : cell.box.spaceType,
          space: +cell.box.spaceId,
          size: cell.box.type === '1MB' ? '1.00MB' : '0B',
          uid: cell.box.uid, box: true
        });
        continue;
      }
      // 空地（AC 原格保留 'AC'；玩家脚下统一 'WA'）
      var onPlayer = playerPos && playerPos.r === rc.r && playerPos.c === rc.c;
      out.push({ id: id, label: onPlayer ? 'WA' : (cell.baseLabel || 'WA'), space: 0, size: '0B', uid: null });
    }
    return out;
  };

  // —— 任意空间视图（调试/验证）
  Engine.prototype.getSpaceState = function (spaceId, opts) {
    opts = opts || {};
    var meta = this.spaceMeta[String(spaceId)];
    if (!meta) return null;
    var out = {
      spaceId: +spaceId, type: meta.type, ac: meta.ac,
      base: meta.baseCells.map(function (c) { return { id: c.id, label: c.label, space: (c.space === undefined ? 0 : c.space), size: c.size }; })
    };
    if (meta.shared) out.shared = this._displayCells(meta.shared, null);
    if (opts.withLayers !== false) out.layers = meta.layers.map(function (l, i) { return { index: i, grid: l.alive ? this._displayCells(l, null) : null }; }, this);
    return out;
  };

  // ================================================================ 导出
  function createEngine(data, options) { return new Engine(data, options); }

  var api = {
    Engine: Engine,
    createEngine: createEngine,
    loadDataDir: loadDataDir,
    validateData: validateData,
    normalizeData: normalizeData,
    VERSION: VERSION,
    WIN_SPACE: WIN_SPACE,
    ROOT_SPACE: ROOT_SPACE,
    DIRS: DIRS,
    idToRC: idToRC,
    rcToId: rcToId
  };

  // 默认单例（UI: window.NetsGame.init(...) / .move(...) ...）
  var _instance = null;
  function defaultEngine() {
    if (!_instance) _instance = new Engine();
    return _instance;
  }
  api.init = function (data) { return defaultEngine().init(data); };
  api.reset = function () { return defaultEngine().reset(); };
  api.move = function (dir) { return defaultEngine().move(dir); };
  api.interact = function () { return defaultEngine().interact(); };
  api.undo = function () { return defaultEngine().undo(); };
  api.jump = function (spaceId) { return defaultEngine().jump(spaceId); };
  api.getState = function () { return defaultEngine().getState(); };
  api.instanceOrNull = function () { return _instance; };

  return api;
});
