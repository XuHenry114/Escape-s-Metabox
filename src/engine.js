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

  var VERSION = '2.2.5';   // 2.2.5（问题4 定版 · 用户）: 虚空门位判定再排除"**刷新产出的那个实例**"
                           //    （`_voidDoor`）——玩家把刷新出来的 43ms/1MB 标记成 0B 后，通向虚空的
                           //    旧 0B 已被换走（变 1MB、不可达），此时退出该实例只是普通退出
                           //    （用户例：向左退出 43ms → 41ms#26，而不是虚空）。
                           // 2.2.4（问题3 定版 · 用户 方案A）: ① 刷新/重建层时**先按模板物化、再销毁旧层**
                           //    （0B 唯一性看得见"待保留的 0B UKE 盒"）；② 不再用保留盒覆盖模板在
                           //    原格物化的实例（虚空门位锚 = 该实例）；③ 虚空 = "从被保留门位空间的
                           //    0B 定位盒退出，且该帧经孪生/teleport 转移进入"（直接走进不再到虚空）。
                           // 2.2.3（问题2 · 遗留1）: 跨视图循环门（viaZeroB）"门位被盒占用"时，与
                           //    "视图内循环门"同语义 —— ① 落点命中可进入的盒 → 进入它、AC 落门位格；
                           //    ② 可推则推整链；③ 都不行 → cyclicExitBlocked（同样绝不回退通用锚退出）。
                           // 2.2.2（问题2 定版）: ① 循环嵌套 0B 改为“登记态优先”——当前视图扫不到时，
                           //    世界范围取“已登记为 0B”的同标号实例（记 0B 即登记、换 1MB 即清除），
                           //    不再依赖“当前视图里恰好有同标号 0B”（49/0B 停在 47ms 的情形）；
                           //    ② 门位 = 该登记实例实时位置 + 退出方向，落点算在**它所在的网格**里；
                           //    ③ 门位是墙/出界 → cyclicExitBlocked（此路不通），绝不回退通用锚退出
                           //    （AC 退出走 0B 定位盒分支时同样按此判定）。
                           // 2.2.1: TLE 不得有循环嵌套（同标号 0B 的穿梭/门位仅限 UKE 视图内；TLE 越界推出走普通“推不动→进入它”）；2.2.0: 递归链进入
  var WIN_SPACE = 50;
  var VOID_SPACE = 'egg1';   // 0 悖论——虚空 = egg1 地图
var INF_SPACE = 'egg2';    // ∞ 悖论——无限退出 = egg2 地图
var EPS_SPACE = 'egg3';    // ε 悖论——无限进入 = egg3 地图
  var ROOT_SPACE = 1;
  var CELLS = 49;
  var MAX_SNAPSHOTS = 60;   // 引擎级最近步快照（UI 整段撤回改用操作级 captureWorld，不依赖此轮转）
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
  var INWARD = { w: [1, 0], s: [-1, 0], a: [0, 1], d: [0, -1] };
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
        // —— 空间模板（用户定版）：最最初始（无任何操作）状态，永不再改动；
        //    每次开辟新的空间实例（刷新/重进）时用模板构建 ——
        //    用户定版：清除 16ms 初始布局 #11 的 1ms 盒（16ms 模板中指向根空间的盒卡 → 空地）
        templateCells: (rec.cells || []).map(function (c) {
          var cl = c ? { id: c.id, label: c.label, space: c.space, size: c.size } : c;
          if (cl && String(id) === '16' && type === 'TLE' && cl.id === 11 && String(cl.space) === String(ROOT_SPACE)) {
            return { id: cl.id, label: 'WA', space: 0, size: '0B' };
          }
          return cl;
        }),
        baseAc: rec.ac,
        shared: null, layers: [], layerSeq: 0,
        egg: type !== rec.type || !rec.ac
      };
    }
    this.loadIssues = validateData(this.data);
    this.reset();
    return this;
  };

  // 无参 init：Node 下读本目录的 ../data；浏览器下取 window.LEVELS_DATA
  Engine.prototype.autoLoad = function () {
    if (typeof window !== 'undefined' && window && window.LEVELS_DATA) return { SPACES: window.LEVELS_DATA };
    var fs = tryRequire('fs'), path = tryRequire('path');
    if (fs) {
      var base = '';
      try { base = path.dirname(require.main ? require.main.filename : (typeof __dirname !== 'undefined' ? __dirname : process.cwd())); }
      catch (e) { base = process.cwd(); }
      var dir = path.join(base, '..', 'data');
      if (fs.existsSync(dir)) return loadDataDir(dir).spaces;
      dir = path.join(process.cwd(), '..', 'data');   // 兜底：仓库根下运行
      if (fs.existsSync(dir)) return loadDataDir(dir).spaces;
      dir = path.join(process.cwd(), 'data');         // 兜底2：已在 src 下运行
      if (fs.existsSync(dir)) return loadDataDir(dir).spaces;
    }
    throw new Error('init() 无参数时找不到数据：Node 用 data/box-*.json（默认 ../data），浏览器用 window.LEVELS_DATA');
  };

  Engine.prototype.reset = function () {
    var self = this;
    this._booted = false;                 // 初始世界构建中：不执行 UKE 0B 唯一性翻转
    Object.keys(this.spaceMeta).forEach(function (id) {
      var m = self.spaceMeta[id];
      m.shared = null; m.layers = []; m.layerSeq = 0;
    });
    this.uidSeq = 1;
    this.events = [];
    this.snapshots = [];
    this.frames = [];
    this._portal = null;
    this.moves = 0;
    this.won = false;
    this._voidDoor = null;                  // 0 悖论——虚空：刷新盒中单独保留的 UKE 0B 盒
    this._voidLabel = null;
    this._voidParadox = false;              // 已达成虚空悖论（弹窗一次）
    this._infParadox = false;               // 已达成 ∞ 悖论——无限退出（弹窗一次）
    this._epsParadox = false;               // 已达成 ε 悖论——无限进入（弹窗一次）
    this._voidDoorSeq = 0;                  // 保留盒内部帧计数辅助（预留）
    var rootMeta = this.spaceMeta[String(ROOT_SPACE)];
    if (!rootMeta) throw new Error('缺少 1 号空间数据——引擎无法初始化根空间');
    this.root = this._buildGrid(ROOT_SPACE, rootMeta.templateCells, 'shared', 0);
    rootMeta.shared = this.root;
    this.current = this.root;
    this.pos = idToRC(rootMeta.ac);
    this._booted = true;                  // 世界构建完成：此后物化的 UKE 实例遵守 0B 唯一性
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
        // —— TLE/布局物化的 UKE 实例遵守 0B 唯一性（用户定版）：开局后若同标号已有 0B 定位实例
        //    （含本次网格已生成的前置卡），模板里为 0B 的新物化实例一律生成 1MB ——
        if (kind2 === '0B' && this._booted) {
          var ownLabel = (card.space !== undefined && card.space !== null) ? String(card.space) : String(spaceId);
          var ownMeta = this.spaceMeta[ownLabel];
          var dup0B = false;
          if (ownMeta && ownMeta.type === 'UKE') {
            var selfB = this;
            this._forEachGrid(function (pg) {
              if (dup0B) return;
              selfB._forEachBoxInGrid(pg, function (bx) {
                if (!dup0B && bx.type === '0B' && String(bx.spaceId) === ownLabel) dup0B = true;
              });
            });
            if (!dup0B) {
              for (var rB = 1; rB < rc.r; rB++) {
                for (var cB = 1; cB <= 7; cB++) {
                  var cellB = g.grid[rB] && g.grid[rB][cB];
                  if (cellB && cellB.box && cellB.box.type === '0B' && String(cellB.box.spaceId) === ownLabel) { dup0B = true; break; }
                }
                if (dup0B) break;
              }
              if (!dup0B) {
                for (var cB2 = 1; cB2 < rc.c; cB2++) {
                  var cellB2 = g.grid[rc.r] && g.grid[rc.r][cB2];
                  if (cellB2 && cellB2.box && cellB2.box.type === '0B' && String(cellB2.box.spaceId) === ownLabel) { dup0B = true; break; }
                }
              }
            }
            if (dup0B) kind2 = '1MB';
          }
        }
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
      // —— TLE（用户定版）：进入不新建层；复用"当前实例层"；直接退出时销毁并恢复初始 ——
      var alive = null;
      for (var li = meta.layers.length - 1; li >= 0; li--) {
        if (meta.layers[li].alive) { alive = meta.layers[li]; break; }
      }
      if (alive) return alive;                                     // 已有活跃实例 → 复用
      var g = this._buildGrid(spaceId, meta.templateCells, 'layer', meta.layerSeq++);
      meta.layers.push(g);
      return g;                                                    // 首次进入 → 创建当前实例
    }
    if (!meta.shared) meta.shared = this._buildGrid(spaceId, meta.templateCells, 'shared', 0);
    return meta.shared;
  };

  Engine.prototype._destroyLayer = function (g, rebuild) {
    if (!g || g.kind !== 'layer' || !g.alive) return;
    var doorKeep = null;
    if (rebuild && !this._voidDoor) doorKeep = this._scanVoidDoor(g);   /* 0 悖论：先抓取待保留的 UKE 0B */
    var meta = this.spaceMeta[g.spaceId];
    // —— TLE 退出（用户定版）：删除当前实例 + 立即开辟新的空间实例（初始状态）——
    //    删除空间实例时，其中的所有实例（盒实体）随之删除（层销毁 = 层内实体消亡）。
    if (rebuild && meta && meta.type === 'TLE') {
      // —— 问题3 定版（用户 · 方案A）：**先按模板物化新层，再销毁旧层** ——
      //    旧层在物化期间仍挂在 meta.layers 上，于是"0B 唯一性"看得见"待保留的 0B UKE 盒"，
      //    同标号模板卡按规则生成 1MB（与 _refreshTLE 的次序一致）——
      var fresh = this._buildGrid(g.spaceId, meta.templateCells, 'layer', meta.layerSeq++);
      g.alive = false;
      var idxR = meta.layers.indexOf(g);
      if (idxR >= 0) meta.layers.splice(idxR, 1);
      meta.layers.push(fresh);
      this._adoptVoidDoor(fresh, doorKeep);
      // —— 实例专属层重定向：所有盒实体 _instLayer 指向被销毁层 → 新层 ——
      var self = this;
      this._forEachGrid(function (pg) {
        self._forEachBoxInGrid(pg, function (b) {
          if (b._instLayer === g) b._instLayer = fresh;
        });
      });
      if (this._portal && this._portal.view === g) this._portal.view = fresh;
      if (this._portal && this._portal.doorGrid === g) this._portal.doorGrid = fresh;
      return;
    }
    // —— 非重建（纯销毁）——
    g.alive = false;
    var idx = meta.layers.indexOf(g);
    if (idx >= 0) meta.layers.splice(idx, 1);
  };

  // —— 0 悖论——虚空（用户定版）——
  //    · 直接退出"0B UKE 所在的刷新盒"(TLE)时,该 0B UKE 定位盒被单独保留:
  //      刷新后的新层里原位放回这个保留盒(其余按模板重建),此后层内同标号 UKE 均按
  //      0B 唯一性生成 1MB;
  //    · 经 MLE 1ms 盒等孪生转移进入该保留 0B 后再退出 → 到达虚空(egg1 图),达成虚空悖论。
  Engine.prototype._scanVoidDoor = function (g) {
    if (!g || !g.grid) return null;
    var meta = this.spaceMeta[String(g.spaceId)];
    if (!meta || meta.type !== 'TLE') return null;
    for (var r = 1; r <= 7; r++) for (var c = 1; c <= 7; c++) {
      var cell = g.grid[r] && g.grid[r][c];
      var b = cell && cell.box;
      if (b && b.type === '0B' && !b._voidRetained) {
        var m = this.spaceMeta[String(b.spaceId)];
        if (m && m.type === 'UKE') return { box: b, r: r, c: c };
      }
    }
    return null;
  };
  Engine.prototype._adoptVoidDoor = function (fresh, doorKeep) {
    if (!doorKeep || !fresh || !fresh.grid || this._voidDoor) return;
    var posR = doorKeep.r, posC = doorKeep.c;
    var cell = fresh.grid[posR] && fresh.grid[posR][posC];
    // —— 问题3 定版（用户 · 方案A）：刷新后的层**按模板重建**，不再用保留盒去覆盖模板刚物化的实例
    //    （用户例：41ms 模板 #27 是 43/1MB，却被保留的 43/0B 盖掉 → 该格显示 0B ✗）。
    //    被"单独保留"的是**虚空门位**（该空间 + 该格）：模板在此物化了实例 → 锚挂到它上面；
    //    模板此处没有实例（保留盒被推离原位等）→ 才把保留盒放回该格 ——
    var anchor = (cell && cell.box) ? cell.box : doorKeep.box;
    if (!(cell && cell.box)) {
      var b = doorKeep.box;
      b.pos = { r: posR, c: posC };
      if (cell) cell.box = b;
      else if (fresh.grid[posR]) fresh.grid[posR][posC] = { box: b, baseLabel: 'UKE' };
      else { fresh.grid[posR] = []; fresh.grid[posR][posC] = { box: b, baseLabel: 'UKE' }; }
    }
    anchor._voidRetained = true;
    this._voidDoor = anchor;
    this._voidLabel = String(anchor.spaceId);
  };

  // —— TLE 刷新（用户定版：穿梭 = 退出 A + 进入 B；A 为 TLE → 刷新）——
  //    删除当前实例并开辟新初始实例，同时把指向旧层的帧/当前视图/穿梭门重定向到新层。
  Engine.prototype._refreshTLE = function (g) {
    if (!g || g.kind !== 'layer' || !g.alive) return g;
    var meta = this.spaceMeta[g.spaceId];
    if (!meta || meta.type !== 'TLE') return g;
    var doorKeep = this._voidDoor ? null : this._scanVoidDoor(g);     /* 0 悖论：先抓保留盒 */
    var fresh = this._buildGrid(g.spaceId, meta.templateCells, 'layer', meta.layerSeq++);
    this._adoptVoidDoor(fresh, doorKeep);
    var idx = meta.layers.indexOf(g);
    if (idx >= 0) meta.layers.splice(idx, 1);
    meta.layers.push(fresh);
    g.alive = false;
    for (var i = 0; i < this.frames.length; i++) {
      var f = this.frames[i];
      if (f.view === g) f.view = fresh;
      if (f.parent === g) f.parent = fresh;
    }
    if (this.current === g) this.current = fresh;
    if (this._portal && this._portal.doorGrid === g) this._portal.doorGrid = fresh;
    if (this._portal && this._portal.view === g) this._portal.view = fresh;
    var selfR = this;
    this._forEachGrid(function (pg) {
      selfR._forEachBoxInGrid(pg, function (b) {
        if (b._instLayer === g) b._instLayer = fresh;
      });
    });
    return fresh;
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
      var mPK = this.spaceMeta[entry.meta.id];
      var lbPK = (mPK && mPK.type === 'TLE') ? mPK.layers.length : 0;
      var rv = this._spaceView(entry.meta.id, entry.meta.type);
      if (!rv) return null;
      var createdPK = (mPK && mPK.type === 'TLE' && mPK.layers.length > lbPK);
      var found = null;
      this._forEachBoxInGrid(rv, function (b) {
        if (!found && b.spaceId === String(entry.card.space) && b.type === '0B') found = b;
      });
      if (!found) { if (createdPK) this._destroyLayer(rv); return null; }
      return { box: found, grid: rv, created: createdPK ? rv : null };
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

  // —— 推盒出空间：链末越界时，若当前空间不是根且存在“所在帧”（玩家所在的当前盒实例），
  //    父空间 pg 中该盒实例同向邻格为地 → 把盒子推出到该格（仅支持单盒链）。
  Engine.prototype._canPushOut = function (box, dir) {
    if (this.current === this.root) return null;            // 根 = 最终边界
    var frame = null;
    for (var i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].view === this.current) { frame = this.frames[i]; break; }
    }
    if (!frame) return null;
    var pg = frame.parent;
    if (!pg) return null;
    var bp = this._liveBoxPos(pg, frame.boxUid) || frame.boxPos;
    var d = DIRS[dir];
    var rc = { r: bp.r + d.dr, c: bp.c + d.dc };
    if (!inGrid(rc.r, rc.c)) return null;
    var cell = pg.grid[rc.r][rc.c];
    if (!cell || cell.box) return null;                     // 墙/盒 → 不可推出
    return { pg: pg, rc: rc };
  };

  Engine.prototype._canPush = function (g, chain, dir) {
    if (!chain.length) return false;
    if (!this.options.pushOneMB) {
      for (var i = 0; i < chain.length; i++) if (chain[i].type === '1MB') return false;
    }
    var d = DIRS[dir], last = chain[chain.length - 1].pos;
    // —— box.pos 可能与网格实际位置不同步（_liveBoxPos 等路径）——
    //    从网格反查链末盒的实际位置，保证判定准确。
    var realPos = this._gridPosOfBox(g, last);
    if (realPos) last = realPos;
    var nr = last.r + d.dr, nc = last.c + d.dc;
    if (!inGrid(nr, nc)) {
      // —— ∞ 指向的视图（用户定版）：已“推出自己”的循环视图内，任何盒子从边界被推出
      //    都去“无限退出”(egg2) —— 视为可推（由 _pushChain 实际落位）——
      if (g.kind === 'shared' && g !== this.root && g.__infArmed) return true;
      // —— ∞ 指向（用户定版）：把循环视图中的“自嵌套 0B”（循环门伙伴）自身从边界推出
      //    → 被推出自己（不阻挡、不做外层级联），视图进入“无限退出”指向 ——
      if (g !== this.root && g.kind === 'shared') {
        var cpH = this._selfCycle0B(g);
        if (cpH && cpH === chain[chain.length - 1]) return true;
      }
      // —— 链末越界：链式推出（支持多盒链 + 跨空间递归）——
      //    链末盒推出到外层同向邻格（层=所属盒实时位置+方向 / 门落点=回门位）；
      //    若该格被占 → 递归判断目标盒能否沿 dir 移动 ——
      if (this.options.pushOut !== false && g !== this.root) {
        var outT = this._exitOutTarget(g, dir, last);
        if (!outT || outT.cyclicBlocked) return false;   /* 循环门被堵 = 不可推出 */
        var pr = outT.rc.r, pc = outT.rc.c;
        if (!inGrid(pr, pc)) return false;
        var pcell = outT.pg.grid[pr][pc];
        if (!pcell) return false;
        if (pcell.box === null) return true;
        // 目标被占 → 递归判断目标盒（外层空间内链）可否沿 dir 移动；
        // 外层链推不动但存在“盒进盒”落点(如 46/0B 被 47/0B 收容) → 仍视为可推（由 _pushChain 解析）
        var pChain = this._collectChain(outT.pg, { r: pr, c: pc }, dir);
        if (this._canPush(outT.pg, pChain, dir)) return true;
        var laCk = this._landAt(outT.pg, { r: pr, c: pc }, dir, 0, { exitPos: clonePos(last) });
        // —— 用户定版（31ms#21 → 34ms#15）：推出落点被“挡路的盒”占住、该盒推不动但**可进入**时，
        //    链末盒自己进入它（盒进盒）——与“AC 迎面盒推不动则进入它”同一条规则，
        //    只是这次的进入者是盒。落点按“对应位置”（退出格镜像）进入 ——
        if (laCk.type === 'boxEnter') return true;
        if (laCk.type === 'enter' && laCk.box) return true;
        return false;
      }
      return false;
    }
    var cell = g.grid[nr][nc];
    return !!cell && cell.box === null;
  };

  // —— 在网格 g 中找 box 实例的实际位置（按 uid 或对象引用） ——
  Engine.prototype._gridPosOfBox = function (g, box) {
    for (var r = 1; r <= 7; r++) {
      for (var c = 1; c <= 7; c++) {
        var cell = g.grid[r][c];
        if (cell && cell.box && (cell.box === box || cell.box.uid === box.uid)) {
          cell.box.pos = { r: r, c: c };   // 顺带校正同步
          return { r: r, c: c };
        }
      }
    }
    return null;
  };

  // —— 找到 view===g 的帧（当前盒实例所在帧；可多个取最内层）
  Engine.prototype._frameByView = function (g) {
    for (var i = this.frames.length - 1; i >= 0; i--) {
      if (this.frames[i].view === g) return this.frames[i];
    }
    return null;
  };

  // —— 层 g 的所属实例盒（owner）：实体盒 _instLayer === g 的那个盒 ——
  Engine.prototype._layerOwnerBox = function (g) {
    if (!g || g.kind !== 'layer') return null;
    var found = null;
    var self = this;
    this._forEachGrid(function (pg) {
      self._forEachBoxInGrid(pg, function (b) {
        if (b._instLayer === g) found = b;
      });
    });
    return found;
  };

  // —— 越界推出落点（用户定版语义）：
  //    层（含穿梭门进入的层）→ 锚 = 层所属盒(owner)实时位置 + 方向；但盒子恰在"穿梭门落点格"
  //    越界 → 沿门回门位（门格所在父网格）；普通共享网格 → 帧锚盒实时位置 + 方向。
  //    返回 {pg, rc}；无效返回 null ——
  Engine.prototype._exitOutTarget = function (g, dir, edgeCell) {
    var d = DIRS[dir];
    // —— UKE 循环嵌套适配（盒子被推出/越界时的落点）：
    //    在共享 UKE 视图内越界推出（含盒推出）时，若视图中存在"同标号 0B 自嵌套盒"
    //    （循环嵌套伙伴，如 49ms#27 的 49ms/0B），落点以该伙伴为锚：伙伴位置 + 方向
    //    （留在本空间内），与 AC 循环退出/弹回一致；伙伴锚格不可用才回退原逻辑 ——
    var mmG = this.spaceMeta[String(g.spaceId)];
    if (g.kind === 'shared' && mmG && mmG.type === 'UKE') {
      var cpG = null;
      for (var crG = 1; crG <= 7 && !cpG; crG++) {
        for (var ccG = 1; ccG <= 7 && !cpG; ccG++) {
          var cvG = g.grid[crG] && g.grid[crG][ccG];
          var cbG = cvG && cvG.box;
          if (cbG && String(cbG.spaceId) === String(g.spaceId) && cbG.type === '0B') cpG = cbG;
        }
      }
      if (cpG) {
        // —— 问题2 定版（用户）：门位锚定“已登记的 0B 循环实例”，落点算在
        //    **该实例所在的网格**里（它可能在别的视图，如 49/0B 停在 47ms）——
        var homeG = this._containingGrid(cpG) || g;
        var tG = { r: cpG.pos.r + d.dr, c: cpG.pos.c + d.dc };
        var cellG = homeG.grid[tG.r] && homeG.grid[tG.r][tG.c];
        if (cellG && cellG.box === null) return { pg: homeG, rc: tG, cyclic: true, partner: cpG.uid };
        // —— 用户定版（46ms #4 上推 → 落点 #27，递归把 #27 的 46ms 推到 #20，AC 进 #4）：
        //    门位被盒占用时**同样以门位为落点**（仍在循环视图内），占用盒由调用方
        //    “可推则推 / 推不动则进入”递归处理 —— 不再回退到外层通用落点 ——
        if (cellG) return { pg: homeG, rc: tG, cyclic: true, partner: cpG.uid, gateOccupied: true };
        // —— 循环门被堵（用户定版）：门位(伙伴+方向)是墙/出界（引擎墙=空槽）时，盒子
        //    不能经该循环视图越界推出 → 推无效（cyclicBlocked），由调用方转"进入判定"；
        //    绝不回退到下方的通用外层推出（否则会出现 47ms 被推到外层 48ms 的越权行为）——
        if (!cellG) return { cyclicBlocked: true };
      }
    }
    if (g.kind === 'layer') {
      var f = this._frameByView(g);
      if (f && f.entryKind === 'shuttle') {
        var atLand = !f.land || (f.land.r === edgeCell.r && f.land.c === edgeCell.c);
        var fParentOk = f.parent && f.parent.alive !== false;
        if (atLand && fParentOk) return { pg: f.parent, rc: clonePos(f.boxPos), door: true };
      }
      var oSh = this._layerOwnerBox(g);
      if (oSh && oSh.alive !== false) {
        var ogSh = this._containingGrid(oSh);
        if (ogSh) return { pg: ogSh, rc: { r: oSh.pos.r + d.dr, c: oSh.pos.c + d.dc }, owner: oSh };
      }
      return null;
    }
    var f2 = this._frameByView(g);
    if (!f2 || !f2.parent || f2.parent.alive === false) return null;
    // —— 盒子连续退出（用户定版）：落点出界 = 锚盒位于外层网格同向边界 →
    //    逐层向外推演（盒子可连退多个盒子），直到落点落进某层网格；到根/无帧则无效 ——
    var gCur = g, guardB = 0;
    for (;;) {
      var fx = this._frameByView(gCur);
      if (!fx || !fx.parent || fx.parent.alive === false) return null;
      var pgx = fx.parent;
      var bpx = this._liveBoxPos(pgx, fx.boxUid) || fx.boxPos;
      var rcX = { r: bpx.r + d.dr, c: bpx.c + d.dc };
      if (inGrid(rcX.r, rcX.c)) return { pg: pgx, rc: rcX };
      if (pgx === this.root || !this._frameByView(pgx) || ++guardB > 24) return null;
      gCur = pgx;
    }
  };

  Engine.prototype._pushChain = function (g, chain, dir) {
    var d = DIRS[dir];
    var last = chain[chain.length - 1].pos;
    if (!inGrid(last.r + d.dr, last.c + d.dc)) {
      // —— ∞ 指向的视图：任意盒子越界推出 → 落入 egg2（无限退出地图）——
      if (g.kind === 'shared' && g !== this.root && g.__infArmed) {
        return this._ejectBoxToInf(g, chain, dir);
      }
      // —— ∞ 指向：自嵌套 0B（循环门伙伴）自身被推出边界 → 被推出自己：
      //    该盒离开本视图（进入 ∞），标记视图“无限退出”指向；其余链盒正常前进一格 ——
      if (g.kind === 'shared' && g !== this.root) {
        var cpH2 = this._selfCycle0B(g);
        var tailH = chain[chain.length - 1];
        if (cpH2 && tailH === cpH2) {
          g.__infArmed = true;
          var tCellI = g.grid[tailH.pos.r] && g.grid[tailH.pos.r][tailH.pos.c];
          if (tCellI) tCellI.box = null;
          for (var iH = chain.length - 2; iH >= 0; iH--) {
            var bH = chain[iH], fH = bH.pos;
            var tH = { r: fH.r + d.dr, c: fH.c + d.dc };
            var cellF = g.grid[fH.r] && g.grid[fH.r][fH.c];
            if (cellF) cellF.box = null;
            var tcellH = g.grid[tH.r] && g.grid[tH.r][tH.c];
            if (!tcellH) { if (!g.grid[tH.r]) g.grid[tH.r] = []; g.grid[tH.r][tH.c] = { box: null, baseLabel: 'WA' }; tcellH = g.grid[tH.r][tH.c]; }
            tcellH.box = bH;
            bH.pos = tH;
          }
          return { pushedOut: true, to: null, inf: true, frame: this._frameByView(g) };
        }
      }
      // —— 链式推出（支持多盒链 + 跨空间递归）：链末盒推出到外层同向邻格；目标被占先推目标盒 ——
      var lastReal = this._gridPosOfBox(g, chain[chain.length - 1]);
      var lastCell = lastReal || last;
      var outP = this._exitOutTarget(g, dir, lastCell);
      if (outP && outP.cyclicBlocked) return { pushedOut: false };   /* 循环门被堵 → 推无效 */
      if (outP) {
        var box = chain[chain.length - 1];
        var to = outP.rc;
        var pgOut = outP.pg;
        var targetCell = pgOut.grid[to.r] && pgOut.grid[to.r][to.c];
        if (targetCell && targetCell.box) {
          // 目标被占 → 先在外层空间推目标盒链（递归）；
          // 推不动但有“盒进盒”落点(最远合法盒被前一盒进入) → 先执行盒进盒，再落位；
          // 二者皆不可 → 整次推出无效（不产生任何移动）
          var pChain = this._collectChain(pgOut, to, dir);
          if (this._canPush(pgOut, pChain, dir)) {
            this._pushChain(pgOut, pChain, dir);
          } else {
            var laOut = this._landAt(pgOut, to, dir, 0, { exitPos: clonePos(lastCell) });
            if (laOut.type === 'boxEnter') {
              this._execBoxEnter(laOut, dir, pgOut);
            } else if (laOut.type === 'enter' && laOut.box) {
              // —— 用户定版（31ms#21 → 34ms#15）：挡路的盒推不动但可进入 → 链末盒进入它 ——
              //    落点 = “对应位置”（退出格沿方向镜像；如 31ms(3,7) 向右 → 34ms(3,1)=#15），
              //    镜像不可站回退边缘正中；其余链盒仍前进一格（AC 由调用方前进）
              var enterInto = this._execBoxEnter({ prev: box, far: laOut.box, chain: chain, k: chain.length },
                dir, g, { exitPos: clonePos(lastCell) });
              if (!enterInto) return { pushedOut: false };
              this._ev('boxEnter', { dir: dir, enterer: box.uid, target: laOut.box.uid, targetSpace: +laOut.box.spaceId, viaOut: true });
              return { pushedOut: true, to: null, enteredInto: laOut.box.uid, frame: this._frameByView(g) };
            } else {
              return { pushedOut: false };
            }
          }
        }
        g.grid[box.pos.r][box.pos.c].box = null;
        var tcell = pgOut.grid[to.r][to.c];
        if (!tcell) tcell = pgOut.grid[to.r][to.c] = { box: null, baseLabel: 'WA' };
        tcell.box = box;
        box.pos = to;
        // 其余前进一格（从链末前一位往前，避免覆盖）
        for (var i = chain.length - 2; i >= 0; i--) {
          var b2 = chain[i], from = b2.pos;
          var to2 = { r: from.r + d.dr, c: from.c + d.dc };
          g.grid[from.r][from.c].box = null;
          var tcell2 = g.grid[to2.r] && g.grid[to2.r][to2.c];
          if (!tcell2) tcell2 = g.grid[to2.r][to2.c] = { box: null, baseLabel: 'WA' };
          tcell2.box = b2;
          b2.pos = to2;
        }
        return { pushedOut: true, to: to, frame: this._frameByView(g) };
      }
      return { pushedOut: false };
    }
    for (var i = chain.length - 1; i >= 0; i--) {
      var box2 = chain[i], from = box2.pos;
      var to2 = { r: from.r + d.dr, c: from.c + d.dc };
      g.grid[from.r][from.c].box = null;
      var tcell2 = g.grid[to2.r] && g.grid[to2.r][to2.c];
      if (!tcell2) tcell2 = g.grid[to2.r][to2.c] = { box: null, baseLabel: 'WA' };
      tcell2.box = box2;
      box2.pos = to2;
    }
    return { pushedOut: false };
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

  Engine.prototype._resolveLanding = function (view, meta, dir, twinEntry, extra) {
    var opts = this.options;
    var edgeRC = idToRC(DIRS[dir].edgeCell);
    // —— 穿梭（退出直面同尺寸盒进入）：落点 = 退出格沿方向轴对称镜像格 ——
    //    题解注「同等大小的盒子可以从对应位置穿梭」：普通进入只能走边缘正中
    //    （#4/#22/#28/#46），非正中进入需借助穿梭；穿梭即“对应位置（镜像）”穿梭。
    //    已验证：10ms(6,1)→11ms(6,7)、11ms(4,7)→10ms(4,1)、10ms(2,1)→11ms(2,7)、
    //    8ms(3,1)→9ms(3,7)=AC#21 —— 与题解段8-11 路径逐格吻合。
    // —— 穿梭（退出直面同尺寸盒进入）：落点 = 退出格沿方向轴对称镜像格 ——
    //    题解注「同等大小的盒子可以从对应位置穿梭」：普通进入只能走边缘正中
    //    （#4/#22/#28/#46），非正中进入需借助穿梭；穿梭即“对应位置（镜像）”穿梭。
    //    已验证：10ms(6,1)→11ms(6,7)、11ms(4,7)→10ms(4,1)、10ms(2,1)→11ms(2,7)、
    //    8ms(3,1)→9ms(3,7)=AC#21 —— 与题解段8-11 路径逐格吻合。
    if (extra && extra.tunnel && extra.exitPos) {
      var ep = extra.exitPos;
      // —— 补丁1：d-隧道·同排（穿越盒行 == 退出格行）→ 方向边心 #22(4,1) ——
      if (dir === 'd' && extra.boxPos && extra.boxPos.r === ep.r) {
        var e22 = this._checkLandingCell(view, idToRC(DIRS[dir].edgeCell), dir);
        if (e22) return e22;
      }
      var mir = (dir === 'a' || dir === 'd') ? { r: ep.r, c: 8 - ep.c } : { r: 8 - ep.r, c: ep.c };
      var m = this._checkLandingCell(view, mir, dir);
      if (m) return m;
      // 镜像格不可站（墙/盒/越界）→ 回退标准边缘逻辑
    }
    if (opts.landAt === 'twinPos' && twinEntry && twinEntry.grid && twinEntry.grid.spaceId === view.spaceId) {
      return this._checkLandingCell(view, clonePos(twinEntry.box.pos), dir);
    }
    if (opts.landAt === 'ac') return this._checkLandingCell(view, idToRC(meta.ac), dir);
    if (opts.landAt === 'edgeFallback') {
      var l = this._checkLandingCell(view, edgeRC, dir);
      if (l) return l;
      return this._checkLandingCell(view, idToRC(meta.ac), dir);
    }
    // —— 用户定版：普通进入落点 = 按进入方向的正中心（边缘正中 #4/#22/#28/#46）；
    //    正中心无空隙（墙/被占不可推）→ 无法进入（blocked），不回退 AC 位 ——
    //    （a→右边缘#28、d→左边缘#22、w→下边缘#46、s→上边缘#4）
    var l2 = this._checkLandingCell(view, edgeRC, dir);
    if (l2) return l2;
    return null;
  };

  // —— 尝试进入盒实例 box。成功 true；不可进 null
  //    ctx: {depth, noSnap} —— 递归连续进入时共享同一快照（一次操作只计一步/一次撤销）
  Engine.prototype._tryEnter = function (box, dir, extra, ctx) {
    var depth = (ctx && ctx.depth) || 0;
    if (depth > 8) return null;
    var spaceId = String(box.spaceId);
    var meta = this.spaceMeta[spaceId];
    if (!meta) return null;
    var targetType = meta.type;
    var opts = this.options;

    var twinEntry = null;
    var was1MB = (box.type === '1MB');
    // —— 目标式 UKE 实例（自身空间为 UKE）：被 AC 直接进入（含穿梭/穿入）→ 记 0B（_doMark）
    //    并直接进入该实例自身空间（锚在被进入的盒上，不孪生转移到另一同名实例）；
    //    非 UKE 的 1MB 盒则一律按 1MB-孪生语义"转移"到同标号 0B 实例（如 45ms/1MB →
    //    46ms#41 的 45ms/0B），不受进入方式（直接进入/退出受阻穿入）影响 ——
    var targetUKE = (meta.type === 'UKE');
    var twinMode = was1MB && opts.oneWayTwin && !targetUKE;
    if (twinMode) {
      twinEntry = this._pickTwinEntry(box.spaceId);
      if (!twinEntry) return null;
    }

    var layersBefore = (targetType === 'TLE') ? meta.layers.length : 0;
    var view;
    if (targetType === 'TLE' && !was1MB) {
      // —— TLE 实例独有空间（用户定版）：每个 0B 盒实例（如 14/0B）拥有自己专属的空间实例层，
      //    互不干扰；首次进入时用模板开辟，之后复用该实例自己的层 ——
      if (!box._instLayer || !box._instLayer.alive) {
        box._instLayer = this._buildGrid(spaceId, meta.templateCells, 'layer', meta.layerSeq++);
        meta.layers.push(box._instLayer);
      }
      view = box._instLayer;
    } else {
      view = this._spaceView(spaceId, targetType);
    }
    if (!view) return null;
    // 仅本次调用新建的层视为 created（复用活跃层时不得误销毁）
    var createdLayer = (targetType === 'TLE' && meta.layers.length > layersBefore) ? view : null;

    var landingEx = extra ? Object.assign({}, extra) : {};
    landingEx.boxType = box.type;
    var landing = this._resolveLanding(view, meta, dir, twinEntry, landingEx);
    var occupant = null;
    if (!landing) {
      // —— ε 悖论——无限进入（用户定版）：普通进入的落点（方向边缘正中）被占据且不可推时，
      //    若占据者与进入目标是【同一空间的 0B 循环嵌套盒】（Ams/0B 的落点仍是 Ams/0B，
      //    二者互为循环嵌套对）→ 进入将永无终点 → 直接抵达 ε(egg3) 地图 ——
      if (!(extra && (extra.tunnel || extra.ownerGrid))) {
        var ercE = idToRC(DIRS[dir].edgeCell);
        var ecE = view.grid[ercE.r] && view.grid[ercE.r][ercE.c];
        if (ecE && ecE.box && ecE.box !== box && meta.type === 'UKE') {
          var occE = ecE.box;
          if (String(box.spaceId) === String(view.spaceId) && String(occE.spaceId) === String(view.spaceId)) {
            var mvEps = this.spaceMeta[EPS_SPACE];
            if (!mvEps) this._ensureEpsMeta();
            if (this.spaceMeta[EPS_SPACE]) return this._enterToEps(dir, box, occE);
          }
        }
      }
      // —— 连续进入（用户定版）：普通进入的落点（方向边缘正中）被不可推实例占据时
      //    不视为堵死 → 递归进入该实例（AC 一次操作连续进入多层；退出同理多层）——
      if (!(extra && (extra.tunnel || extra.ownerGrid)) && this._plainLandingRule()) {
        var ercN = idToRC(DIRS[dir].edgeCell);
        var ecN = view.grid[ercN.r] && view.grid[ercN.r][ercN.c];
        if (ecN && ecN.box && ecN.box !== box && this._canEnterBoxRec(ecN.box, dir, depth + 1)) occupant = ecN.box;
      }
      if (!occupant) {
        if (createdLayer) this._destroyLayer(createdLayer);
        if (twinEntry && twinEntry.created && twinEntry.created.kind === 'layer') this._destroyLayer(twinEntry.created);
        return null;
      }
    }

    // —— 判定通过，应用（先快照；递归层共享同一快照）——
    if (!(ctx && ctx.noSnap)) this._snapshot();
    if (landing && landing.chainToPush) this._pushChain(view, landing.chainToPush, dir);

    var evs = [];
    if (this._shouldMark(box, meta, spaceId)) evs.push(this._doMark(box));

    var frame;
    if (twinMode) {
      var twin = twinEntry.box, tg = twinEntry.grid;
      var depth = tg ? this._chainDepthOf(tg) : -1;
      var selfLoop = (depth < 0 && tg === view);
      if (selfLoop) {
        // —— 循环嵌套（twin 位于目标空间自身，如 8ms/0B@8ms#17）：单 master 帧 ——
        // master = 目标空间的“空间帧”（parent=进入前所在空间；boxUid 直接绑定 0B 盒，随其动态位置退出）
        if (!this.frames.length || this.frames[this.frames.length - 1].view !== view) {
          this.frames.push({ view: view, parent: this.current, boxUid: twin.uid, boxPos: clonePos(twin.pos), spaceId: spaceId, master: true, boundGrid: view });
        } else {
          // 已在目标空间内（重复进入）：仅更新锚绑定
          this.frames[this.frames.length - 1].boundGrid = view;
          this.frames[this.frames.length - 1].boxUid = twin.uid;
          this.frames[this.frames.length - 1].boxPos = clonePos(twin.pos);
        }
        frame = null;                 // 不推 0B 帧（master 即全部）
        evs.push({ type: 'teleport', dir: dir, fromBoxUid: box.uid, fromSpaceId: +spaceId, toBoxUid: twin.uid, viewSpaceId: +spaceId, land: clonePos(landing.land) });
      } else {
        // —— 孪生传送帧处理 ——
        //  1) 同世界"退回"（UKE 0B 定位在旧分支，如第一层 39ms 的 43ms#25 的 44ms/0B）：
        //     孪生盒所在网格不在帧栈顶，但从其容器逐层上溯能在现有帧栈中找到锚点 →
        //     裁剪到该深度（**不销毁被裁层：经 UKE 盒退回绕开"直接退出"，TLE 层不应刷新**），
        //     并逐层补建容器帧（锚 = 各层 0B 定位实例）。
        //  2) 容器实例就在 AC 当前网格（向下嵌套同一世界）→ 补一帧、不裁剪。
        //  3) 其余跨分支孪生 → 维持原裁剪语义。
        if (depth < 0 && tg) {
          var chainFrames = [];            // 自外层到内层待补帧 {view, uid, pos, parent}
          var curG = tg;
          var foundDepth = -1;
          var guardT = 0;
          while (curG && guardT++ < 24) {
            var inst0T = null, inst1T = null;
            var selfT = this;
            this._forEachGrid(function (pg) {
              selfT._forEachBoxInGrid(pg, function (bx) {
                if (String(bx.spaceId) !== String(curG.spaceId)) return;
                if (bx.type === '0B' && !inst0T) inst0T = bx;
                else if (!inst1T) inst1T = bx;
              });
            });
            var instT = inst0T || inst1T;
            if (!instT) break;
            var gridT = this._containingGrid(instT);
            if (!gridT) break;
            var idxT = -1;
            for (var fiT = this.frames.length - 1; fiT >= 0; fiT--) {
              if (this.frames[fiT].view === gridT) { idxT = fiT; break; }
            }
            if (idxT >= 0) {
              foundDepth = idxT + 1;
              // 当前层（curG）自身也需要容器帧（锚=instT）
              chainFrames.unshift({ view: curG, uid: instT.uid, pos: clonePos(instT.pos), parent: gridT });
              break;
            }
            chainFrames.unshift({ view: curG, uid: instT.uid, pos: clonePos(instT.pos), parent: gridT });
            curG = gridT;
          }
          if (foundDepth >= 0) {
            // 先裁剪到锚帧之后（丢弃此前的旧分支帧，但不销毁被裁 TLE 层——UKE 退回不刷新），
            // 再逐层补建中间容器帧（外层→内层）
            this.frames.length = foundDepth;
            for (var ciT = 0; ciT < chainFrames.length; ciT++) {
              this.frames.push({ view: chainFrames[ciT].view, parent: chainFrames[ciT].parent, boxUid: chainFrames[ciT].uid, boxPos: chainFrames[ciT].pos, spaceId: String(chainFrames[ciT].view.spaceId), viaTwin: true });
            }
            depth = this.frames.length;
          } else {
            if (depth < 0) depth = 0;
            for (var i = this.frames.length - 1; i >= depth; i--) {
              var gv = this.frames[i].view;
              if (gv.kind === 'layer') this._destroyLayer(gv);
            }
            this.frames.length = depth;
          }
        } else {
          if (depth < 0) depth = 0;
          for (var i2 = this.frames.length - 1; i2 >= depth; i2--) {
            var gv2 = this.frames[i2].view;
            if (gv2.kind === 'layer') this._destroyLayer(gv2);
          }
          this.frames.length = depth;
        }
        var parentGrid = (tg !== null && tg !== undefined) ? tg : this.root;
        frame = { view: view, parent: parentGrid, boxUid: twin.uid, boxPos: clonePos(twin.pos), spaceId: spaceId, master: false, entryKind: 'teleport', viaTwin: true };
        this._twinRoute = true;      // 问题3：本段行程经孪生转移进入（供虚空判定/锚帧继承）
        evs.push({ type: 'teleport', dir: dir, fromBoxUid: box.uid, fromSpaceId: +spaceId, toBoxUid: twin.uid, viewSpaceId: +spaceId, land: clonePos(landing.land) });
      }
    } else {
      // —— 0B 盒直接进入：帧 parent = 盒所在的网格（穿梭时盒位于父网格而非当前视图）——
      frame = { view: view, parent: (extra && extra.ownerGrid) || this.current, boxUid: box.uid, boxPos: clonePos(box.pos), spaceId: spaceId };
      this._twinRoute = false;       // 问题3：普通（非孪生）进入 → 取消孪生行程标记
    }
    if (frame) this.frames.push(frame);

    this.current = view;
    if (!(ctx && ctx.noSnap)) this.moves++;
    var acLand = occupant ? occupant.pos : landing.land;
    this._ev('enter', { dir: dir, boxUid: box.uid, boxSpaceId: +spaceId, viewSpaceId: +spaceId, land: clonePos(acLand), landId: rcToId(acLand.r, acLand.c), tunnel: !!(extra && extra.tunnel) });
    for (var k = 0; k < evs.length; k++) this.events.push(evs[k]);

    if (view.spaceId === String(WIN_SPACE) && !this.won) {
      this.won = true;
      this._ev('win', { spaceId: WIN_SPACE });
    }
    if (occupant) {
      // —— 连续进入：AC 不在本层落点站定，直接递归进入占据落点的实例 ——
      var occRes = this._tryEnter(occupant, dir,
        { chainLen: 1, boxType: occupant.type, selfLoop: (occupant.type === '0B' && String(occupant.spaceId) === String(view.spaceId)) },
        { depth: depth + 1, noSnap: true });
      if (!occRes) {
        // 理论不可达（预判同构）；保守回滚整局快照
        if (this.snapshots.length) {
          var sv = this.snapshots.pop();
          this._restoreWorld(sv);
        }
        return null;
      }
      return true;
    }
    this.pos = landing.land;
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
    var was1MB = (box.type === '1MB');
    var targetUKE = (meta.type === 'UKE');
    if (was1MB && opts.oneWayTwin && !targetUKE) {
      twinEntry = this._pickTwinEntry(box.spaceId);
      if (!twinEntry) return false;
    }
    var layersBefore = (meta.type === 'TLE') ? meta.layers.length : 0;
    var view = null;
    if (meta.type === 'TLE' && box.type === '0B' && box._instLayer && box._instLayer.alive) {
      view = box._instLayer;
    } else {
      view = this._spaceView(spaceId, meta.type);
    }
    if (!view) return false;
    // 仅本次调用新建的层视为 created（复用活跃层时不得误销毁）
    var created = (meta.type === 'TLE' && meta.layers.length > layersBefore) ? view : null;
    var ok = !!this._resolveLanding(view, meta, dir, twinEntry);
    // —— 连续进入（用户定版）：落点（方向边缘正中）被不可推实例占据 → 需可递归进入该实例 ——
    if (!ok && this._plainLandingRule()) {
      var ercH = idToRC(DIRS[dir].edgeCell);
      var ecH = view.grid[ercH.r] && view.grid[ercH.r][ercH.c];
      if (ecH && ecH.box && ecH.box !== box) ok = this._canEnterBoxRec(ecH.box, dir, 1);
    }
    if (created) this._destroyLayer(created);
    if (twinEntry && twinEntry.created) this._destroyLayer(twinEntry.created);
    return ok;
  };

  // —— 是否普通落点规则（方向边缘正中；非 twinPos/ac/edgeFallback 调试选项）——
  Engine.prototype._plainLandingRule = function () {
    var la = this.options.landAt;
    return !(la === 'twinPos' || la === 'ac' || la === 'edgeFallback');
  };

  // —— 可进入性评估（递归深度版，用户定版"一次操作连续进入多层"）：
  //    目标盒落点（方向边缘正中）被不可推实例占据时，只要该实例（递归地）可进入即为可进 ——
  Engine.prototype._canEnterBoxRec = function (box, dir, depth) {
    if (depth > 8) return false;
    var spaceId = String(box.spaceId);
    var meta = this.spaceMeta[spaceId];
    if (!meta) return false;
    var opts = this.options;
    var twinEntry = null;
    var was1MB = (box.type === '1MB');
    var targetUKE = (meta.type === 'UKE');
    if (was1MB && opts.oneWayTwin && !targetUKE) {
      twinEntry = this._pickTwinEntry(box.spaceId);
      if (!twinEntry) return false;
    }
    var layersBefore = (meta.type === 'TLE') ? meta.layers.length : 0;
    var view = null;
    if (meta.type === 'TLE' && box.type === '0B' && box._instLayer && box._instLayer.alive) {
      view = box._instLayer;
    } else {
      view = this._spaceView(spaceId, meta.type);
    }
    if (!view) return false;
    var created = (meta.type === 'TLE' && meta.layers.length > layersBefore) ? view : null;
    var ok = !!this._resolveLanding(view, meta, dir, twinEntry);
    if (!ok && this._plainLandingRule()) {
      var ercR = idToRC(DIRS[dir].edgeCell);
      var ecR = view.grid[ercR.r] && view.grid[ercR.r][ercR.c];
      if (ecR && ecR.box && ecR.box !== box) ok = this._canEnterBoxRec(ecR.box, dir, depth + 1);
    }
    if (created) this._destroyLayer(created);
    if (twinEntry && twinEntry.created) this._destroyLayer(twinEntry.created);
    return ok;
  };

  // —— UKE 标记（用户定版）：
  //    · UKE 实例被 AC 直接进入（含穿梭进入）→ 该实例记 0B、其余同名实例记 1MB；
  //    · 保留居所式触发：盒位于 UKE 空间内被进入（如 1MB 入口盒在 UKE 空间 → mark+孪生进入）。
  Engine.prototype._shouldMark = function (box, meta, spaceId) {
    if (meta.type === 'UKE') return true;                  // 目标空间为 UKE（UKE 实例被进入）
    var g = this._containingGrid(box);
    var rm = g ? this.spaceMeta[g.spaceId] : null;
    return !!(rm && rm.type === 'UKE');                    // 居所为 UKE
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
    // —— UKE 0B/1MB 互换（用户终版）——
    //   进入同标号 UKE 盒 X（含 1MB → 0B / 已是 0B 的实例）：其余全部同标号 live 实例
    //   一律改为 1MB（0B 唯一；循环嵌套盒的"0B 标记位置"随之转移到 X —— 例：
    //   47ms#32 1MB 被进入 → #32 成 0B 循环盒，46ms#46 的原 47ms/0B 同步变 1MB）。
    //   仅当不存在任何其它同标号 live 实例时，才考虑把模板基卡翻为 1MB。
    var swap = null;
    var swappedAny = false;
    var cand = this._collectTwinCandidates(box.spaceId);
    for (var i = 0; i < cand.live.length; i++) {
      var li = cand.live[i];
      if (li.box === box) continue;
      var liGrid = li.grid || this._containingGrid(li.box);
      li.box.type = '1MB';
      if (liGrid) this._syncBaseCard(liGrid, li.box.pos, '1.00MB');
      if (!swap) swap = { uid: li.box.uid, grid: liGrid };
      swappedAny = true;
    }
    if (!swappedAny && cand.base.length) {
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

  // —— 跨视图循环门落点（问题2 · 遗留1）：门位在**另一个网格**（如 49/0B 停在 47ms#4）时，
  //    弹帧直到栈顶视图 = 门位所在网格，AC 落到门位格；随后按需销毁离开的层视图。
  //    调用方负责：先 _snapshot()、并已完成世界改动（推链 / 盒进入）与对应事件 ——
  Engine.prototype._cycleLandCross = function (partner, homeZ, tZ, dir) {
    var leftVZ = this.current;
    while (this.frames.length) {
      var topVZ = this.frames[this.frames.length - 1];
      if (topVZ.view === homeZ) break;
      this.frames.pop();
      if (topVZ.view && topVZ.view.kind === 'layer') this._destroyLayer(topVZ.view, true);
    }
    this.current = homeZ;
    this.pos = clonePos(tZ);
    this.moves++;
    this._ev('exit', { dir: dir, to: clonePos(tZ), boxUid: partner.box.uid, spaceId: +partner.box.spaceId, cyclic: true });
    if (leftVZ && leftVZ.kind === 'layer') this._destroyLayer(leftVZ, true);
  };

  // —— 退出/推出/穿梭（盒内站开放边缘格并向外移动）
  Engine.prototype._exitAttempt = function (dir) {
    var frame = this.frames[this.frames.length - 1];
    var d = DIRS[dir];
    // —— 绑定模式：master 帧绑定锚盒（0B 盒）后，退出=在绑定视图内移动（不弹帧）——
    var boundMode = !!(frame.master && frame.boundGrid);
    // —— 0 悖论——虚空退出（用户定版）：AC 位于"被单独保留的 UKE 0B 盒"内部
    //    （帧锚 = 保留盒）时，向外退出直达虚空(egg1 地图)，达成虚空悖论 ——
    // —— 问题3 定版（用户 · 方案A）：虚空 = "从被保留门位空间的 **0B 定位盒**退出，
    //    且该帧是经孪生/teleport 转移进入的"（与 0 悖论设计注释一致）——
    //    直接走进 0B 盒再退出**不再**到达虚空 ——
    // —— 问题4 定版（用户）：虚空门位 ≠ **刷新产出的那个实例**（`_voidDoor` = 刷新后占据门位的
    //    模板实例）。玩家把刷新出来的 43ms/1MB 标记为 0B 后，通向虚空的那个 0B（刷新前就存在的
    //    同标号实例）已变 1MB、不再可达 → 此时退出该实例只是普通退出（用户例：回 41ms#26）——
    if (!boundMode && this._voidDoor && frame.boxUid != null && (frame.viaTwin || frame.entryKind === 'teleport')) {
      var bVoid = null, selfVd = this;
      this._forEachGrid(function (gV) {
        selfVd._forEachBoxInGrid(gV, function (bV) { if (!bVoid && bV.uid === frame.boxUid) bVoid = bV; });
      });
      if (bVoid && bVoid.type === '0B' && String(bVoid.spaceId) === String(this._voidLabel) && bVoid.uid !== this._voidDoor.uid) {
        var mvVoid = this.spaceMeta[VOID_SPACE];
        if (!mvVoid) this._ensureVoidMeta();        // 数据缺 egg1 时自动合成虚空 WA 地图（视觉一致）
        if (this.spaceMeta[VOID_SPACE]) return this._exitToVoid(dir);
      }
    }
    // —— ∞ 悖论——无限退出（用户定版）：本循环视图的自嵌套 0B 已被“推出自己” →
    //    该视图进入“无限退出”指向：AC 从任意边界向外退出 → 直达 egg2(∞) 地图 ——
    if (!boundMode && !frame.entryKind && frame.view && frame.view.kind === 'shared' && frame.view.__infArmed) {
      return this._exitToInf(dir);
    }
    // —— 循环嵌套退出（用户定版）：从 S 空间内部视图向外退出时，若视图内存在
    //    同标号 0B 的"自嵌套盒"（循环对伙伴，且非本帧锚盒），AC 不离开该空间：
    //    弹回到伙伴锚格（伙伴位置 + 退出方向），即"无论多少次向外移动都仍在 Sms 内"——
    //    （例：49ms 循环下行永不离开；46ms 循环中退出弹回 #19）——
    if (!boundMode && !frame.entryKind && frame.view && frame.view.grid &&
        this.spaceMeta[String(frame.view.spaceId)] &&
        this.spaceMeta[String(frame.view.spaceId)].type === 'UKE') {
      // 仅 UKE 共享视图存在循环语境（同标号 0B 自嵌套盒 = 循环对伙伴）；TLE 实例层互不嵌套，不适用
      var cycPartner = null;
      for (var crI = 1; crI <= 7 && !cycPartner; crI++) {
        for (var ccI = 1; ccI <= 7 && !cycPartner; ccI++) {
          var cvI = frame.view.grid[crI] && frame.view.grid[crI][ccI];
          var cbI = cvI && cvI.box;
          if (cbI && cbI.uid !== frame.boxUid &&
              String(cbI.spaceId) === String(frame.view.spaceId) && cbI.type === '0B') {
            cycPartner = cbI;
          }
        }
      }
      if (cycPartner) {
        var tcCyc = { r: cycPartner.pos.r + d.dr, c: cycPartner.pos.c + d.dc };
        var cellCyc = frame.view.grid[tcCyc.r] && frame.view.grid[tcCyc.r][tcCyc.c];
        if (cellCyc && cellCyc.box === null) {
          this._snapshot();
          this.pos = tcCyc;
          this.moves++;
          this._ev('exit', { dir: dir, to: clonePos(tcCyc), boxUid: cycPartner.uid, spaceId: +frame.spaceId, cyclic: true });
          return true;
        }
        // —— 循环门出口被占（用户定版）：出口格(= 伙伴+方向)上有盒链时，如同"出口受阻"处理：
        //    可推则推整链（链末越界按循环落点）；推不动 → 走落点判定 —— 最远合法盒判定
        //    命中盒进入盒时：前面盒缩入 far 盒内部（如 49ms 被推入 46ms#46），AC 落到
        //    空出的出口格（例：47ms 内按 w → AC 落 #27）。——
        var chainCyc = this._collectChain(frame.view, tcCyc, dir);
        var laCyc = this._landAt(frame.view, tcCyc, dir, 0);
        if (laCyc.type === 'boxEnter') {
          this._snapshot();
          this._execBoxEnter(laCyc, dir, frame.view);
          this.pos = clonePos(tcCyc);
          this.moves++;
          this._ev('boxEnter', { dir: dir, enterer: laCyc.prev.uid, target: laCyc.far.uid, targetSpace: +laCyc.far.spaceId });
          this._ev('exit', { dir: dir, to: clonePos(tcCyc), boxUid: cycPartner.uid, spaceId: +frame.spaceId, cyclic: true });
          return true;
        }
        if (chainCyc.length && this._canPush(frame.view, chainCyc, dir)) {
          this._snapshot();
          this._pushChain(frame.view, chainCyc, dir);
          this.pos = clonePos(tcCyc);
          this.moves++;
          this._ev('push', { dir: dir, chain: chainCyc.length, boxUid: chainCyc[0].uid, spaceId: +chainCyc[0].spaceId });
          this._ev('exit', { dir: dir, to: clonePos(tcCyc), boxUid: cycPartner.uid, spaceId: +frame.spaceId, cyclic: true });
          return true;
        }
        // —— 循环门被堵（用户定版）：门位(伙伴+方向)是墙/出界（引擎墙=空槽）或出口链
        //    无法解决时，AC 无法经该循环视图退出 → 移动被阻挡，留在本空间；
        //    绝不回退到下方"通用外层退出/推出"的逻辑 ——
        return this._blocked('cyclicExitBlocked', dir, this.pos);
      }
    }
    // —— 穿梭帧退出：
    //    · AC 站在"门落点格"向外 → 沿门回门位（静态门位，不随 boxUid 漂移）；落点结算同普通操作。
    //    · AC 站在其他边缘格 → 按该层所属实例盒(owner)的实时位置作锚退出（非门位+方向）——
    var exitOverride = null;                 // {pg, uid, pos}：owner 影子锚
    if (!boundMode && frame.entryKind === 'shuttle') {
      var atLand = frame.land && this.pos.r === frame.land.r && this.pos.c === frame.land.c;
      if (!atLand) {
        var oShA = this._layerOwnerBox(frame.view);
        if (oShA && oShA.alive !== false) {
          var ogShA = this._containingGrid(oShA);
          if (ogShA) exitOverride = { pg: ogShA, uid: oShA.uid, pos: clonePos(oShA.pos) };
        }
      }
      if (!exitOverride) {
        this._snapshot();
        var leftViewSh = this.current;
        var doorSh = clonePos(frame.boxPos);
        this.frames.pop();
        // —— 帧残留回收：退出后若当前新栈顶为已脱离视图的 TLE 层帧 → 销毁并弹帧 ——
        while (this.frames.length) {
          var orphSh = this.frames[this.frames.length - 1];
          if (orphSh.view && orphSh.view.kind === 'layer' && orphSh.view !== frame.parent && orphSh.view !== this.current) {
            this.frames.pop();
            this._destroyLayer(orphSh.view, true);
          } else break;
        }
        this.current = frame.parent;
        this.moves++;
        this._ev('exit', { dir: dir, to: clonePos(doorSh), boxUid: frame.boxUid, spaceId: +frame.spaceId });
        this._settleLand(clonePos(doorSh), dir, 0);
        // 退出 A（TLE）→ 刷新
        this._destroyLayer(leftViewSh, true);
        return true;
      }
    }
    // —— 循环嵌套 0B 定位盒穿透退出（用户定版）：
    //    AC 位于 UKE 空间 S 的共享视图内（帧锚= S 实例），若同标号 S 实例中恰有
    //    **唯一 0B 定位盒** B，且 B 位于本视图之外（如 49ms/0B 被推入 47ms#4 后，
    //    49 内的 AC 再向下退出），则本次退出视作"经 B 退出"：
    //    弹帧至 B 所在开放网格层级，AC 落 B 位置 + 方向（例：49 退出 → 47ms#11）。
    //    仅当 B 唯一且落点格可用时生效；否则走常规锚退出（含隧道/穿入各分支）。——
    var viaZeroB = null;
    if (!boundMode && !frame.entryKind && frame.view && frame.view.kind === 'shared') {
      var mVS = this.spaceMeta[String(frame.view.spaceId)];
      // 仅当 AC 所在帧锚盒是 1MB（循环的"无门"一侧，0B 定位盒在别处）时穿透到 0B 盒退出；
      // 锚盒为 0B（AC 从 0B 门进入）时按常规锚退出（结果等价，避免误伤普通世界）
      var anchorBoxV = null;
      if (mVS && mVS.type === 'UKE' && frame.boxUid != null) {
        var selfVA = this;
        this._forEachGrid(function (pgA) {
          if (anchorBoxV) return;
          selfVA._forEachBoxInGrid(pgA, function (bA) {
            if (!anchorBoxV && bA.uid === frame.boxUid) anchorBoxV = bA;
          });
        });
      }
      if (mVS && mVS.type === 'UKE' && anchorBoxV && anchorBoxV.type === '1MB') {
        var zList = [];
        var selfV = this;
        this._forEachGrid(function (pgZ) {
          selfV._forEachBoxInGrid(pgZ, function (bz) {
            if (String(bz.spaceId) === String(frame.view.spaceId) && bz.type === '0B') zList.push({ box: bz, home: pgZ });
          });
        });
        if (zList.length === 1) {
          var zB = zList[0];
          if (zB.home !== frame.view) viaZeroB = zB;
        }
      }
    }
    if (viaZeroB) {
      var homeZ = viaZeroB.home;
      var tZ = { r: viaZeroB.box.pos.r + d.dr, c: viaZeroB.box.pos.c + d.dc };
      var cellZ = homeZ.grid[tZ.r] && homeZ.grid[tZ.r][tZ.c];
      // —— 问题2 定版（用户）：门位 = 已登记的 0B 循环实例实时位置 + 退出方向。门位是墙/出界
      //    （引擎墙 = 空槽）时，AC 不能经该循环门退出，且**绝不回退到下方的通用锚退出** ——
      //    否则表现为"从 1MB 实例(无门一侧)的老家退出"（用户例：49ms/0B 停在 47ms#4，
      //    门位 47ms#5 是墙 → 应"此路不通"，而不是落到 48ms#18）——
      if (!cellZ) return this._blocked('cyclicExitBlocked', dir, this.pos);
      if (cellZ.box === null) {
        this._snapshot();
        this._cycleLandCross(viaZeroB, homeZ, tZ, dir);
        return true;
      }
      // —— 问题2 · 遗留1（用户定版）：门位**被盒占用**时，与"视图内循环门"同语义 ——
      //    ① 落点命中可进入的盒（boxEnter）→ 进入它，AC 落门位格；
      //    ② 可推则推整链 → AC 落门位格；
      //    ③ 都不行 → 该循环门被堵（cyclicExitBlocked），同样绝不回退通用锚退出 ——
      var chainZ = this._collectChain(homeZ, tZ, dir);
      var laZ = this._landAt(homeZ, tZ, dir, 0);
      if (laZ.type === 'boxEnter') {
        this._snapshot();
        this._execBoxEnter(laZ, dir, homeZ);
        this._ev('boxEnter', { dir: dir, enterer: laZ.prev.uid, target: laZ.far.uid, targetSpace: +laZ.far.spaceId });
        this._cycleLandCross(viaZeroB, homeZ, tZ, dir);
        return true;
      }
      if (chainZ.length && this._canPush(homeZ, chainZ, dir)) {
        this._snapshot();
        this._pushChain(homeZ, chainZ, dir);
        this._ev('push', { dir: dir, chain: chainZ.length, boxUid: chainZ[0].uid, spaceId: +chainZ[0].spaceId });
        this._cycleLandCross(viaZeroB, homeZ, tZ, dir);
        return true;
      }
      return this._blocked('cyclicExitBlocked', dir, this.pos);
    }
    var pg = exitOverride ? exitOverride.pg : frame.parent;
    var anchorUid = exitOverride ? exitOverride.uid : frame.boxUid;
    var boxGrid = boundMode ? frame.boundGrid : pg;
    var boxPos = exitOverride ? clonePos(exitOverride.pos) : (this._liveBoxPos(boxGrid, frame.boxUid) || frame.boxPos);
    var t = { r: boxPos.r + d.dr, c: boxPos.c + d.dc };
    if (!inGrid(t.r, t.c)) {
      // —— 连续退出（用户定版）：AC 所在视图的锚盒位于父网格同向边界 → 落点出界，
      //    表示“从父层继续向外退”，逐层弹出直到落点在某层网格内（可连退多个盒子）——
      if (!boundMode && this.frames.length > 1) {
        var topB = this.frames[this.frames.length - 1];
        var parentAliveB = topB.parent && topB.parent.alive !== false;
        if (parentAliveB) {
          // —— bug-1b 定版：本分支先弹帧/销毁层再尝试退出；退出若最终 blocked，
          //    必须把“已弹帧/已切视图/已销毁层”整体回滚（否则表现为“此路不通却到达上一层”）——
          var preX = this.captureWorld();
          var leftB = this.current;
          this.frames.pop();
          if (leftB && leftB.kind === 'layer') this._destroyLayer(leftB, true);
          var okX = this._exitAttempt(dir);
          if (!okX) this.restoreWorld(preX);
          return okX;
        }
      }
      return this._blocked('exitBoundary', dir, this.pos);
    }
    var cell = boxGrid.grid[t.r][t.c];
    if (!cell) return this._blocked('exitWall', dir, this.pos);

    // —— 退出隧道(c) 已按用户最新规则移除：盒子边缘任意位置的开口指向的退出点
    //    与边缘正中位置相同 → 统一走“正中落点 + 可推则推”的普通退出语义，
    //    不再因“doorway 内侧同型 0B”而穿入新空间 ——

    // —— 目标格为盒（队长最终补丁：先判推链、可推则推、推不动才同型穿梭兜底）——
    if (cell.box !== null) {
      var chainC = this._collectChain(boxGrid, t, dir);
      if (this._canPush(boxGrid, chainC, dir)) {
        this._snapshot();
        this._pushChain(boxGrid, chainC, dir);
        var leftViewC = this.current;
        if (boundMode) {
          frame.boxPos = clonePos(t);
          this.current = boxGrid; this.pos = t; this.moves++;
          this._ev('push', { dir: dir, chain: chainC.length, spaceId: +frame.spaceId });
          this._ev('exit', { dir: dir, to: t, boxUid: frame.boxUid, spaceId: +frame.spaceId, master: true, bound: true });
        } else {
          this.frames.pop();
          this.current = boxGrid; this.pos = t; this.moves++;
          this._ev('push', { dir: dir, chain: chainC.length, spaceId: +frame.spaceId });
          this._ev('exit', { dir: dir, to: t, boxUid: frame.boxUid, spaceId: +frame.spaceId });
        }
        this._destroyLayer(leftViewC, true);
        return true;
      }
      var myBox0 = boxGrid.grid[boxPos.r][boxPos.c] ? boxGrid.grid[boxPos.r][boxPos.c].box : null;
      if (!myBox0) return this._blocked('exitNoBox', dir, this.pos);
      // —— 用户定版优先级：退出落点有实例 → 先推（已试）→ 推不动 → 最远可进入实例 → 进入（enter/boxEnter/shuttle）——
      var laX = this._landAt(boxGrid, t, dir, 0);
      if (laX.type === 'boxEnter') {
        // 盒进入盒：prev 按 AC 方式进入 far 专属空间，其余前进一格；AC 完成退出落 t
        this._snapshot();
        this._execBoxEnter(laX, dir, boxGrid);
        var leftViewBX = this.current;
        this.frames.pop();
        this.current = pg;
        this.pos = clonePos(t);
        this.moves++;
        this._ev('boxEnter', { dir: dir, enterer: laX.prev.uid, target: laX.far.uid, targetSpace: +laX.far.spaceId });
        this._ev('exit', { dir: dir, to: t, boxUid: frame.boxUid, spaceId: +frame.spaceId });
        this._destroyLayer(leftViewBX, true);
        return true;
      }
      if (laX.type === 'enter' || laX.type === 'shuttle') {
        // AC 进入最远可进入实例（同型隧道/穿梭）；退出 A（TLE）→ 刷新
        var leftViewT = this.current;
        var resT = this._tryEnter(laX.box, dir, { tunnel: true, ownerGrid: boxGrid, exitPos: { r: this.pos.r, c: this.pos.c }, boxPos: clonePos(laX.box.pos) });
        if (resT) this._refreshTLE(leftViewT);
        return resT;
      }
      // —— 用户定版兜底：退出受阻于单个实例（边缘正中落点不通时）→
      //    按"对应位置"（退出格镜像）穿梭进入挡住它的那个实例（0B/1MB 均可穿入自身空间）——
      if (laX.type === 'blocked' && chainC.length === 1) {
        var occX = chainC[0];
        if (occX !== myBox0) {
          var leftViewT3 = this.current;
          var resT3 = this._tryEnter(occX, dir, { tunnel: true, ownerGrid: boxGrid, exitPos: { r: this.pos.r, c: this.pos.c }, boxPos: clonePos(occX.pos) });
          if (resT3) this._refreshTLE(leftViewT3);
          return resT3;
        }
      }
      return this._blocked('exitPushBlocked', dir, this.pos);
    }

    if (cell.box === null) {
      this._snapshot();
      var leftView = this.current;
      if (boundMode) {
        // 主帧绑定框：出盒仍留在绑定视图内（不弹帧）
        frame.boxPos = clonePos(t);
        this.current = boxGrid;
        this.pos = t;
        this.moves++;
        this._ev('exit', { dir: dir, to: t, boxUid: frame.boxUid, spaceId: +frame.spaceId, master: true, bound: true });
        return true;
      }
      this.frames.pop();
      // (B) 帧残留回收：退出后若当前新栈顶为已脱离视图的 TLE 层帧（如 14 退出后其下方 13 帧）
      //     → 销毁该层并弹帧（13 层 = TLE 每次进出刷新；重进时新建层）
      while (this.frames.length) {
        var orphan = this.frames[this.frames.length - 1];
        if (orphan.view && orphan.view.kind === 'layer' && orphan.view !== pg && orphan.view !== this.current) {
          this.frames.pop();
          this._destroyLayer(orphan.view, true);
        } else break;
      }
      // 0B 帧退出后：把下方主帧绑定到该 0B 盒（动态锚——第二/三次退出仍按 0B 盒实时位置）
      if (this.frames.length) {
        var below = this.frames[this.frames.length - 1];
        if (below.master && below.view === boxGrid) {
          below.boundGrid = boxGrid;
          below.boxUid = frame.boxUid;
          below.boxPos = clonePos(boxPos);
        }
      }
      this.current = pg;
      // —— UKE 退出=回座（队长终版）：仅 1MB-teleport 帧（entryKind==='teleport'）触发；隧道穿梭帧/普通帧 = 普通退出 ——
      var fmZ = this.spaceMeta[String(frame.spaceId)];
      var huizuoFrame = fmZ && fmZ.type === 'UKE' && frame.entryKind === 'teleport' && frame.spaceId === 25;
      // —— 穿梭帧退出：回到门位（对应位置），而非盒子旁 ——（门落点分支已提前处理；此处置空）
      var shuttleExit = (!exitOverride && frame.entryKind === 'shuttle');
      var land = (huizuoFrame || shuttleExit) ? clonePos(boxPos) : t;
      this.pos = land;
      // —— 回座格局部状态（队长 token 11 堵规则）：回座格上仅"朝 s 的 0B 盒进入"有效，其余=blocked ——
      if (huizuoFrame && (land.r !== t.r || land.c !== t.c)) this._huizuo = { r: land.r, c: land.c, grid: pg };
      this.moves++;
      this._ev('exit', { dir: dir, to: land, boxUid: frame.boxUid, spaceId: +frame.spaceId });
      this._destroyLayer(leftView, true);
      return true;
    }

    var myBox = boxGrid.grid[boxPos.r][boxPos.c] ? boxGrid.grid[boxPos.r][boxPos.c].box : null;
    if (!myBox) return this._blocked('exitNoBox', dir, this.pos);
    var chain = this._collectChain(boxGrid, t, dir);
    if (myBox.type === chain[0].type) {
      var leftViewT2 = this.current;
      var resT2 = this._tryEnter(chain[0], dir, { tunnel: true, ownerGrid: boxGrid, exitPos: { r: this.pos.r, c: this.pos.c }, boxPos: clonePos(chain[0].pos) });
      if (resT2) this._refreshTLE(leftViewT2);   // 退出 A（TLE）→ 刷新
      return resT2;
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

  // —— 统一递归移动判定（AC/盒共用）：从 t 沿 dir 的落点操作 ——
  //    仅判定，不执行。返回 {type:'walk'|'push'|'enter'|'shuttle'|'pushOut'|'blocked', ...}
  Engine.prototype._landAt = function (g, t, dir, depth, opts) {
    if (depth > 8) return { type: 'blocked', reason: 'depth' };
    if (!inGrid(t.r, t.c)) return { type: 'blocked', reason: 'outside' };
    var cell = g.grid[t.r] && g.grid[t.r][t.c];
    if (!cell) return { type: 'blocked', reason: 'wall' };
    if (cell.box === null) return { type: 'walk', land: { r: t.r, c: t.c } };
    var chain = this._collectChain(g, t, dir);
    if (this._canPush(g, chain, dir)) return { type: 'push', land: { r: t.r, c: t.c }, chain: chain };
    // 链末状态：越界（退出点）/ 墙 / 空地
    var lastB0 = chain[chain.length - 1];
    var d0 = DIRS[dir];
    var nr0 = lastB0.pos.r + d0.dr, nc0 = lastB0.pos.c + d0.dc;
    var overEdge = !inGrid(nr0, nc0);
    // 推不动 → 最远合法盒（含同型穿梭）
    var bestK = -1, bestBox = null, createdViews = [];
    for (var k = chain.length - 1; k >= 0; k--) {
      var bS = chain[k];
      var mE = this.spaceMeta[String(bS.spaceId)];
      if (!mE) continue;
      var lbE = (mE.type === 'TLE') ? mE.layers.length : 0;
      var vE = null;
      if (mE.type === 'TLE' && bS.type === '0B' && bS._instLayer && bS._instLayer.alive) {
        vE = bS._instLayer;
      } else {
        vE = this._spaceView(String(bS.spaceId), mE.type);
        if (mE.type === 'TLE' && mE.layers.length > lbE) createdViews.push(vE);
      }
      if (!vE) continue;
      // —— opts.exitPos（越界推出后“进入挡路的盒”，仅迎面那一只 k=0）：
      //    进入落点按“对应位置”= 退出格沿方向镜像优先，镜像不可站再回退边缘正中 ——
      var useTun = !!(opts && opts.exitPos && k === 0);
      var lE = this._resolveLanding(vE, mE, dir, null, { boxType: bS.type, selfLoop: (bS.type === '0B' && String(bS.spaceId) === String(g.spaceId)),
        tunnel: useTun, exitPos: useTun ? clonePos(opts.exitPos) : null, boxPos: null });
      // —— 递归进入（用户定版 · 只用递归这一条逻辑）：边缘落点被“可进入的盒”占据且推不动时
      //    不算堵死 → 该盒可被递归进入 → 本盒同样“可进入”（46ms#20 → #13 → 48ms#46 → 46ms#46）——
      if (!lE && this._canEnterBoxRec(bS, dir, 1)) lE = { land: null, chainToPush: null, viaRec: true };
      if (lE) { bestK = k; bestBox = bS; break; }
    }
    // —— 纯判定：清理本次为评估而新建的 TLE 层（复用活跃层时不动）——
    var cleanLandAt = function () {
      for (var ci = 0; ci < createdViews.length; ci++) this._destroyLayer(createdViews[ci]);
    }.bind(this);
    if (bestBox) {
      // 同型另一实例（非当前空间）→ shuttle（仅链末越界/退出点场景触发；
      //   链末是墙/空地时推不动 → 不穿梭，走 enter/boxEnter）
      // —— 用户定版（TLE 不得有循环嵌套）：同标号 0B 的“穿梭 / 门位”只在 UKE 视图内成立；
      //    TLE 视图越界推出走普通规则（可推则推；推不动 → 后一盒进入它）——
      var mCurSh = this.spaceMeta[String(g.spaceId)];
      if (overEdge && bestBox.type === '0B' && mCurSh && mCurSh.type === 'UKE') {
        // —— 优先目标 = 链末越界退出落点上直接面对的同标号实例（"退出受阻 → 穿梭进挡住它的那个"）——
        var occBox = null;
        var edgeReal = this._gridPosOfBox(g, bestBox) || bestBox.pos;
        var outAt = this._exitOutTarget(g, dir, edgeReal);
        if (outAt && inGrid(outAt.rc.r, outAt.rc.c) && outAt.rc.r >= 1 && outAt.rc.c >= 1) {
          var occCell = outAt.pg.grid[outAt.rc.r] && outAt.pg.grid[outAt.rc.r][outAt.rc.c];
          if (occCell && occCell.box && occCell.box !== bestBox && occCell.box.type === '0B' &&
              String(occCell.box.spaceId) === String(bestBox.spaceId)) occBox = occCell.box;
        }
        if (occBox) { cleanLandAt(); return { type: 'shuttle', box: occBox, fromBox: bestBox, chain: chain, k: bestK }; }
        var candT = this._collectTwinCandidates(bestBox.spaceId);
        // 同型 live 实例（≠ bestBox、不在当前网格）→ shuttle；否则不 shuttle（走 enter/boxEnter）
        var shLive = null, shGrid = null;
        for (var sti = 0; sti < candT.live.length; sti++) {
          if (candT.live[sti].box !== bestBox && candT.live[sti].grid !== g && !(candT.live[sti].grid && candT.live[sti].grid.kind === 'layer')) { shLive = candT.live[sti].box; shGrid = candT.live[sti].grid; break; }
        }
        if (shLive) { cleanLandAt(); return { type: 'shuttle', box: shLive, fromBox: bestBox, chain: chain, k: bestK }; }
      }
      // 前面项目是盒 → boxEnter（盒进入盒）
      if (bestK > 0) { cleanLandAt(); return { type: 'boxEnter', prev: chain[bestK - 1], far: bestBox, chain: chain, k: bestK }; }
      cleanLandAt();
      return { type: 'enter', box: bestBox, chain: chain, k: bestK };
    }
    cleanLandAt();
    // 链末越界可推出
    if (overEdge) {
      var po = this._canPushOut(lastB0, dir);
      if (po) return { type: 'pushOut', box: lastB0, po: po, chain: chain };
    }
    // —— 连续进入（用户定版）：无可进实例时，若 AC 迎面盒（chain[0]）本身可进——
    //    （其落点被不可推实例占据 → 递归进入该实例，一次操作连续进入多层）——则进入 ——
    if (chain.length && this._canEnterBoxRec(chain[0], dir, depth + 1)) {
      return { type: 'enter', box: chain[0], chain: chain, k: 0, recDepth: depth + 1 };
    }
    // —— ε 悖论——无限进入（用户定版）：AC 面对同空间的 0B 循环嵌套盒且推不动,
    //    该盒自身进入的落点(方向边缘正中)又被同标号 Ams 盒占据且不可推 → 无限进入
    //    → 直达 egg3(ε 悖论) ——
    if (chain.length) {
      var mCurE = this.spaceMeta[String(g.spaceId)];
      var frontE = chain[0];
      if (mCurE && mCurE.type === 'UKE' && String(frontE.spaceId) === String(g.spaceId) && frontE.type === '0B') {
        var ercE = idToRC(DIRS[dir].edgeCell);
        var ecE = g.grid[ercE.r] && g.grid[ercE.r][ercE.c];
        if (ecE && ecE.box && ecE.box !== frontE && String(ecE.box.spaceId) === String(g.spaceId)) {
          var mvEps2 = this.spaceMeta[EPS_SPACE];
          if (!mvEps2) this._ensureEpsMeta();
          if (this.spaceMeta[EPS_SPACE]) return { type: 'eps', box: frontE, via: ecE.box };
        }
      }
    }
    return { type: 'blocked', reason: 'noEnter' };
  };

  Engine.prototype._step = function (dir) {
    // —— 回座格局部状态（队长 token 11 堵规则）：回座格上仅"朝 s 的 0B 盒进入"有效，其余=blocked ——
    if (this._huizuo && this.current === this._huizuo.grid && this.pos.r === this._huizuo.r && this.pos.c === this._huizuo.c) {
      var d0h = DIRS[dir];
      var tr0 = this.pos.r + d0h.dr, tc0 = this.pos.c + d0h.dc;
      var cell0 = (this.current.grid[tr0] && this.current.grid[tr0][tc0]) || null;
      var allowS = dir === 's' && cell0 && cell0.box && cell0.box.type === '0B';
      if (!allowS) return this._blocked('huizuoBlock', dir, this.pos);
    }
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


    // —— 统一落点（用户定版）：_landAt 判定 walk/push/enter/shuttle/boxEnter/pushOut ——
    var la = this._landAt(this.current, t, dir, 0);
    if (la.type === 'enter') {
      var isSelfA2 = (la.box.type === '0B' && String(la.box.spaceId) === String(this.current.spaceId));
      var resE2 = this._tryEnter(la.box, dir, { chainLen: (la.chain || []).length, boxType: la.box.type, selfLoop: isSelfA2 }, { depth: la.recDepth || 0 });
      return resE2 ? true : this._blocked('noEnter', dir, this.pos);
    }
    if (la.type === 'boxEnter') {
      // —— P=盒 缩入 far（用户规则1）：最远合法盒（对应方向边缘正中有空隙）被其前面的项目进入；
      //    前面是盒 → 盒子按 AC 相同方式进入（落 far 空间正中心，落点有实例先推）；其余项目前进一格 ——
      this._snapshot();
      this._execBoxEnter(la, dir, this.current);
      this.pos = clonePos(t);   // AC 落原移动目标格（递归执行完成，AC 继续原有移动）
      this.moves++;
      this._ev('boxEnter', { dir: dir, enterer: la.prev.uid, target: la.far.uid, targetSpace: +la.far.spaceId });
      return true;
    }
    if (la.type === 'shuttle') {
      return this._execShuttle(la, dir, 0, t);
    }
    if (la.type === 'eps') {
      return this._enterToEps(dir, la.box, la.via);
    }
    if (la.type === 'pushOut') {
      var po2 = la.po, boxOut2 = la.box;
      this._snapshot();
      var fromCellO = this.current.grid[boxOut2.pos.r] && this.current.grid[boxOut2.pos.r][boxOut2.pos.c];
      if (fromCellO) fromCellO.box = null;
      var toCellO = po2.pg.grid[po2.rc.r][po2.rc.c];
      toCellO.box = boxOut2;
      boxOut2.pos = { r: po2.rc.r, c: po2.rc.c };
      if (la.chain) {
        var dO = DIRS[dir];
        for (var qO = la.chain.length - 2; qO >= 0; qO--) {
          var qbO = la.chain[qO], qfO = clonePos(qbO.pos);
          var qtoO = { r: qfO.r + dO.dr, c: qfO.c + dO.dc };
          this.current.grid[qfO.r][qfO.c].box = null;
          var qtcO = this.current.grid[qtoO.r] && this.current.grid[qtoO.r][qtoO.c];
          if (!qtcO) { if (!this.current.grid[qtoO.r]) this.current.grid[qtoO.r] = []; this.current.grid[qtoO.r][qtoO.c] = { box: null, baseLabel: 'WA' }; qtcO = this.current.grid[qtoO.r][qtoO.c]; }
          qtcO.box = qbO;
          qbO.pos = qtoO;
        }
      }
      this.pos = t;
      this.moves++;
      this._ev('push', { dir: dir, chain: (la.chain ? la.chain.length : 1), boxUid: boxOut2.uid, spaceId: +boxOut2.spaceId, pushOut: true, toSpace: +po2.pg.spaceId, to: clonePos(boxOut2.pos) });
      return true;
    }
    return this._blocked('noEnter', dir, this.pos);
  };

  // —— boxEnter 执行（用户规则1）：P=盒 缩入 far 盒的实例专属空间（按 AC 方式进入，落正中心；
  //    落点有实例先推）；其余项目（chain[0..k-2]）正常向推动方向前进一格 ——
  // —— 递归进入落点（用户定版 · 只用递归这一条最有价值的逻辑）：
  //    实体（盒 / AC 同规则）进入 box 的空间 → 落点取方向边缘正中；
  //    落点被“可进入的盒”占据且推不动时，不视为堵死 → 继续递归进入该盒（一次操作连续进入多层），
  //    返回最深一层的落点 {view, cell}。仅执行期调用（可能推链 / 开 TLE 层）——
  Engine.prototype._deepEntryLanding = function (box, dir, depth, extra) {
    if (depth > 8) return null;
    var spaceId = String(box.spaceId), meta = this.spaceMeta[spaceId];
    if (!meta) return null;
    var was1MB = (box.type === '1MB');
    var view;
    if (meta.type === 'TLE' && !was1MB) {
      if (!box._instLayer || !box._instLayer.alive) {
        box._instLayer = this._buildGrid(spaceId, meta.templateCells, 'layer', meta.layerSeq++);
        meta.layers.push(box._instLayer);
      }
      view = box._instLayer;
    } else {
      view = this._spaceView(spaceId, meta.type);
    }
    if (!view) return null;
    var l = this._resolveLanding(view, meta, dir, null, extra || { boxType: box.type });
    if (l && l.land) {
      if (l.chainToPush) this._pushChain(view, l.chainToPush, dir);
      return { view: view, cell: l.land, spaceId: view.spaceId };
    }
    // 落点不可站 → 边缘格上的占用者可进入 → 递归进入它（落点在其内部）
    var erc = idToRC(DIRS[dir].edgeCell);
    var ec = view.grid[erc.r] && view.grid[erc.r][erc.c];
    if (ec && ec.box && ec.box !== box && this._canEnterBoxRec(ec.box, dir, 1)) {
      return this._deepEntryLanding(ec.box, dir, depth + 1, { boxType: ec.box.type });
    }
    return null;
  };

  Engine.prototype._execBoxEnter = function (la, dir, g, opts) {
    var prevBox2 = la.prev, farBox2 = la.far;
    var fromCellP2 = g.grid[prevBox2.pos.r] && g.grid[prevBox2.pos.r][prevBox2.pos.c];
    if (fromCellP2) fromCellP2.box = null;
    var mF2 = this.spaceMeta[String(farBox2.spaceId)];
    var pView2;
    if (mF2 && mF2.type === 'TLE' && farBox2.type === '0B') {
      // —— far 盒实例专属空间（用户定版：不同实例空间互不影响）——
      if (!farBox2._instLayer || !farBox2._instLayer.alive) {
        farBox2._instLayer = this._buildGrid(String(farBox2.spaceId), mF2.templateCells, 'layer', mF2.layerSeq++);
        mF2.layers.push(farBox2._instLayer);
      }
      pView2 = farBox2._instLayer;
    } else {
      pView2 = this._spaceView(String(farBox2.spaceId), mF2 ? mF2.type : 'MLE');
    }
    var lFree2 = null;
    if (pView2 && mF2) {
      // —— P 按 AC 方式进入 far 空间：落 far 空间对应方向正中心（landing）——
      //    opts.exitPos（越界推出后“进入挡路的盒”）：按“对应位置”= 退出格沿方向镜像优先，
      //    镜像不可站再回退边缘正中（与穿梭同规则；如 31ms(3,7)→34ms(3,1)=#15）。
      //    落点被“可进入的盒”占据且推不动 → 递归进入该盒（_deepEntryLanding，用户递归定版）——
      var lEx2 = (opts && opts.exitPos)
        ? { boxType: farBox2.type, tunnel: true, exitPos: clonePos(opts.exitPos), boxPos: null }
        : { boxType: farBox2.type };
      var tgt2 = this._deepEntryLanding(farBox2, dir, 1, lEx2);
      if (tgt2) {
        lFree2 = tgt2.cell;
        var pvCell = tgt2.view.grid[lFree2.r] && tgt2.view.grid[lFree2.r][lFree2.c];
        if (!pvCell) { if (!tgt2.view.grid[lFree2.r]) tgt2.view.grid[lFree2.r] = []; tgt2.view.grid[lFree2.r][lFree2.c] = { box: null, baseLabel: 'WA' }; pvCell = tgt2.view.grid[lFree2.r][lFree2.c]; }
        pvCell.box = prevBox2;
        prevBox2.pos = { r: lFree2.r, c: lFree2.c };
      }
    }
    // —— 其余项目（chain[0..k-2]）正常向推动方向前进一格（从后往前，避免覆盖）——
    if (la.chain && la.k > 0) {
      var dO2 = DIRS[dir];
      for (var qi2 = la.k - 2; qi2 >= 0; qi2--) {
        var qb2 = la.chain[qi2];
        var qto2 = { r: qb2.pos.r + dO2.dr, c: qb2.pos.c + dO2.dc };
        g.grid[qb2.pos.r][qb2.pos.c].box = null;
        var qtc2 = g.grid[qto2.r] && g.grid[qto2.r][qto2.c];
        if (!qtc2) { if (!g.grid[qto2.r]) g.grid[qto2.r] = []; g.grid[qto2.r][qto2.c] = { box: null, baseLabel: 'WA' }; qtc2 = g.grid[qto2.r][qto2.c]; }
        qtc2.box = qb2;
        qb2.pos = qto2;
      }
    }
    return lFree2 !== null;
  };

  // —— 穿梭执行（用户定版）：盒实体真实进入目标空间的【对应位置】（退出格沿方向轴对称镜像，
  //    非正中心 #4/#22/#28/#46）；AC 落原移动目标格 t。所有实例（AC/盒）同规则 ——
  //    同时记录"穿梭门"：AC 之后站在门格上按门方向 → AC 沿同一通道穿梭（同对应位置）
  Engine.prototype._execShuttle = function (la, dir, depth, t) {
    var shFrame = la.fromBox, shTarget = la.box;
    this._snapshot();
    var fCellSh = this.current.grid[shFrame.pos.r] && this.current.grid[shFrame.pos.r][shFrame.pos.c];
    if (fCellSh) fCellSh.box = null;
    // 门位：盒穿梭前的位置（AC 从门穿梭进入；AC 从目标空间退出时也回到这里）
    var shDoor = clonePos(shFrame.pos);
    var mSh2 = this.spaceMeta[String(shTarget.spaceId)];
    var vSh2;
    if (mSh2 && mSh2.type === 'TLE' && shTarget.type === '0B') {
      // —— 穿梭进入目标实例（如 b24）专属的空间实例层 ——
      if (!shTarget._instLayer || !shTarget._instLayer.alive) {
        shTarget._instLayer = this._buildGrid(String(shTarget.spaceId), mSh2.templateCells, 'layer', mSh2.layerSeq++);
        mSh2.layers.push(shTarget._instLayer);
      }
      vSh2 = shTarget._instLayer;
    } else {
      vSh2 = this._spaceView(String(shTarget.spaceId), mSh2 ? mSh2.type : 'MLE');
    }
    // —— 穿梭落点 = 对应位置（镜像）：水平方向 (r,8-c)；垂直方向 (8-r,c) ——
    var mirRC = (dir === 'a' || dir === 'd') ? { r: shDoor.r, c: 8 - shDoor.c } : { r: 8 - shDoor.r, c: shDoor.c };
    var lSh2 = this._checkLandingCell(vSh2, mirRC, dir);
    var lShRC = (lSh2 && lSh2.land) || null;
    var shPushChain = (lSh2 && lSh2.chainToPush) || null;
    if (!lShRC) {
      // 对应位置不可站 → 回退常规落点（正中心/AC 位）
      var fbSh = this._resolveLanding(vSh2, mSh2, dir, null, { boxType: shTarget.type });
      lShRC = (fbSh && fbSh.land) || { r: 4, c: 1 };
      if (fbSh && fbSh.chainToPush && lShRC) shPushChain = fbSh.chainToPush;
    }
    var vCellSh = vSh2.grid[lShRC.r] && vSh2.grid[lShRC.r][lShRC.c];
    if (!vCellSh) { if (!vSh2.grid[lShRC.r]) vSh2.grid[lShRC.r] = []; vSh2.grid[lShRC.r][lShRC.c] = { box: null, baseLabel: 'WA' }; vCellSh = vSh2.grid[lShRC.r][lShRC.c]; }
    // —— 落点有实例 → 先尝试推动（用户定版：受阻则递归处理前面实例；可推则推）——
    if (shPushChain) this._pushChain(vSh2, shPushChain, dir);
    vCellSh.box = shFrame;
    shFrame.pos = { r: lShRC.r, c: lShRC.c };
    // —— 链中其余项目（chain[0..k-1]）正常向推动方向前进一格（从后往前，避免覆盖）——
    if (la.chain && la.k > 0) {
      var dS2 = DIRS[dir];
      for (var qiS2 = la.k - 1; qiS2 >= 0; qiS2--) {
        var qbS2 = la.chain[qiS2];
        if (qbS2 === shFrame) continue;
        var qtoS2 = { r: qbS2.pos.r + dS2.dr, c: qbS2.pos.c + dS2.dc };
        this.current.grid[qbS2.pos.r][qbS2.pos.c].box = null;
        var qtcS2 = this.current.grid[qtoS2.r] && this.current.grid[qtoS2.r][qtoS2.c];
        if (!qtcS2) { if (!this.current.grid[qtoS2.r]) this.current.grid[qtoS2.r] = []; this.current.grid[qtoS2.r][qtoS2.c] = { box: null, baseLabel: 'WA' }; qtcS2 = this.current.grid[qtoS2.r][qtoS2.c]; }
        qtcS2.box = qbS2;
        qbS2.pos = qtoS2;
      }
    }
    // 记录穿梭门（AC 通道）：门格 = 盒穿梭前位置；对应落点 = 盒在目标空间的落点
    this._portal = { doorGrid: this.current, doorPos: clonePos(shDoor), dir: dir, view: vSh2, land: clonePos(lShRC), boxUid: shFrame.uid, spaceId: +shTarget.spaceId };
    this.moves++;
    this._ev('shuttle', { dir: dir, fromBoxUid: shFrame.uid, toBoxUid: shTarget.uid, spaceId: +shTarget.spaceId, land: clonePos(lShRC) });
    // —— AC 落原移动目标格（用户定版：AC 向右移动一格到 #14，不跟随进入）——
    // —— 注意：盒穿梭不算 AC 退出 → 源 TLE 不刷新（只有 AC 退出/穿梭才刷新）——
    this.pos = (t !== undefined && t !== null) ? clonePos(t) : clonePos(shDoor);
    return true;
  };

  // —— AC 走穿梭门：站在门格按门方向 → AC 穿梭进入目标空间（对应位置）——
  //    穿梭 = 退出 A（门所在网格）+ 进入 B；A 为 TLE → 刷新。落点有实例 → 先推 → 推不动 → 进入
  Engine.prototype._acShuttle = function (pt, dir) {
    this._snapshot();
    this._portal = null;
    if (!pt.view || !pt.view.alive) return this._blocked('noPortal', dir, this.pos);
    var leftGridAc = this.current;
    this.frames.push({ view: pt.view, parent: this.current, boxUid: pt.boxUid, boxPos: clonePos(pt.doorPos), land: pt.land ? clonePos(pt.land) : null, spaceId: pt.spaceId, entryKind: 'shuttle' });
    this.current = pt.view;
    this.moves++;
    this._ev('shuttle', { dir: dir, ac: true, boxUid: pt.boxUid, spaceId: pt.spaceId, land: clonePos(pt.land) });
    this._settleLand(clonePos(pt.land), dir, 0);
    this._ev('enter', { dir: dir, boxUid: pt.boxUid, boxSpaceId: pt.spaceId, viewSpaceId: pt.spaceId, land: clonePos(this.pos), landId: rcToId(this.pos.r, this.pos.c) });
    // —— 退出 A：A 为 TLE → 刷新 ——
    this._refreshTLE(leftGridAc);
    return true;
  };

  // —— AC 落点结算（当前已在 g=this.current 帧内）：让 AC 落 land ——
  //    落点有实例 → 尝试推动（含推出）→ 推不动 → 最远可进入实例 → 进入（enter/boxEnter/shuttle 递归）
  Engine.prototype._settleLand = function (land, dir, depth) {
    if (depth > 8) { this.pos = clonePos(land); return false; }
    var g = this.current;
    var cell = g.grid[land.r] && g.grid[land.r][land.c];
    if (!cell || cell.box === null) { this.pos = clonePos(land); return true; }
    var chain = this._collectChain(g, land, dir);
    if (this._canPush(g, chain, dir)) {
      this._pushChain(g, chain, dir);
      this.pos = clonePos(land);
      this._ev('push', { dir: dir, chain: chain.length, boxUid: chain[0].uid, spaceId: +chain[0].spaceId });
      return true;
    }
    var la = this._landAt(g, land, dir, depth);
    if (la.type === 'enter') {
      var isSelfA3 = (la.box.type === '0B' && String(la.box.spaceId) === String(g.spaceId));
      var resE3 = this._tryEnter(la.box, dir, { chainLen: (la.chain || []).length, boxType: la.box.type, selfLoop: isSelfA3 }, { depth: la.recDepth || 0 });
      if (resE3) return true;
    }
    if (la.type === 'boxEnter') {
      this._execBoxEnter(la, dir, g);
      this.pos = clonePos(land);
      this._ev('boxEnter', { dir: dir, enterer: la.prev.uid, target: la.far.uid, targetSpace: +la.far.spaceId });
      return true;
    }
    if (la.type === 'shuttle') {
      return this._execShuttle(la, dir, depth + 1, land);
    }
    // 推不动也进不去 → 停在原地（落点被实例堵死）
    this.pos = clonePos(land);
    return false;
  };

  // —— 边界信息（题解 6-7："从 #15(3,1) 退出" 证明【任意】开放边缘格向外移动均可退出）
  Engine.prototype._borderOf = function (p) {
    if (p.r === 1) return 'top';
    if (p.r === 7) return 'bottom';
    if (p.c === 1) return 'left';
    if (p.c === 7) return 'right';
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
    // —— 穿梭门：AC 站在门格上按门方向 → AC 穿梭（对应位置进入，非正中心）——
    var resM;
    // —— bug-1b 定版：受阻 = 整步不成立。总入口先取世界快照，失败时整体回滚，
    //    覆盖所有受阻路径（退出可能已弹帧/销毁层/切视图；interact/递归进入等亦然）——
    var preMove = this.captureWorld();
    var pt = this._portal;
    var atDoor = !!(pt && pt.doorGrid === this.current && pt.doorPos.r === this.pos.r && pt.doorPos.c === this.pos.c && pt.dir === dir);
    if (atDoor) {
      resM = this._acShuttle(pt, dir);
    } else if (this.options.exitOnMove && this.frames.length) {
      var b = this._borderOf(this.pos);
      resM = (b && OUTWARD[b] === dir) ? this._exitAttempt(dir) : this._step(dir);
    } else {
      resM = this._step(dir);
    }
    // —— 孤儿世界自动补锚（0B 定位实例）——
    if (resM) {
      this._ensureAnchor();
      return true;
    }
    // —— 兜底回滚（bug-1b 定版）：世界 / 当前视图 / 帧栈 / 步数 全部回到本步之前；
    //    事件保留，便于 UI 反馈具体受阻原因 ——
    var keepEv = (this.events || []).slice();
    this.restoreWorld(preMove);
    this.events = keepEv;
    // —— 兜底（UKE 循环嵌套适配）：退出/穿入/递归进入等路径可能静默返回 null/false
    //    而不发事件，导致 UI 无任何受阻反馈、甚至被误记为成功步。
    //    统一归一：受阻必须伴随 blocked 事件（否则补发一条）。——
    if (!this.events || !this.events.some(function (ev) { return ev && ev.type === 'blocked'; })) {
      this._ev('blocked', { reason: 'blocked', dir: dir, pos: clonePos(this.pos) });
    }
    return false;
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
        if (this._tryEnter(chain[seg[i]], dir, { chainLen: chain.length, boxType: chain[seg[i]].type })) return true;
      }
    }
    if (this.options.interactExit && this.frames.length) {
      var b = this._borderOf(this.pos);
      if (b) return this._exitAttempt(OUTWARD[b]);
    }
    return this._blocked('interactNothing', null, this.pos);
  };

  // —— 自动锚定（用户定版：0B = "定位"实例）：移动后若 AC 所在共享网格在帧栈中无对应帧
  //    （孪生传送裁剪 / 孤儿退出等路径），按该空间 0B 定位实例（无 0B 时任意实例）补建容器帧。
  // —— 虚空悖论：从保留的 UKE 0B 盒退出 → 直接抵达虚空(egg1 地图)，弹窗一次 ——
  //    数据未提供 egg1 时自动合成全 WA 开放地图（与 egg1 视觉一致），保证功能不依赖合并数据
  Engine.prototype._ensureVoidMeta = function () {
    if (this.spaceMeta[VOID_SPACE]) return;
    var cells = [];
    for (var i = 1; i <= CELLS; i++) cells.push({ id: i, label: 'WA', space: 0, size: '0B' });
    this.spaceMeta[VOID_SPACE] = {
      id: VOID_SPACE, type: 'MLE', ac: 23,
      baseCells: cells, templateCells: cells.map(function (c) { return { id: c.id, label: 'WA', space: 0, size: '0B' }; }),
      baseAc: null, shared: null, layers: [], layerSeq: 0, egg: true, __syntheticVoid: true
    };
  };
  // —— 彩蛋空间刷新（用户定版：egg1~3 视同 TLE）：AC/盒子进入后按模板重建，
  //    空间内此前的内容（如被推入的盒子）随之删除 ——
  Engine.prototype._refreshEggSpace = function (meta) {
    if (!meta || !meta.egg) return;
    meta.shared = null;
    meta.layers = [];
    meta.layerSeq = (meta.layerSeq || 0) + 1;
  };
  Engine.prototype._exitToVoid = function (dir) {
    this._snapshot();
    var metaV = this.spaceMeta[VOID_SPACE];
    this.frames = [];
    if (metaV) this._refreshEggSpace(metaV);       // 彩蛋按 TLE 语义刷新(清空内容)
    this.current = this._spaceView(VOID_SPACE, 'MLE');
    this.pos = idToRC((metaV.ac >= 1 && metaV.ac <= 49) ? metaV.ac : 23);
    this.moves++;
    this._ev('exit', { dir: dir, to: clonePos(this.pos), boxUid: (this._voidDoor ? this._voidDoor.uid : null), void: true });
    if (!this._voidParadox) {
      this._voidParadox = true;
      this._ev('winVoid', { spaceId: VOID_SPACE });
    }
    return true;
  };

  // —— 视图内找“自嵌套 0B 盒”（同标号 0B 位于其自身空间的共享视图内 = 循环嵌套伙伴）——
  // —— 循环嵌套 0B 实例（用户定版 · 登记态优先）：
  //    1) 先看当前视图内的同标号 0B（原有快速路径）；
  //    2) 否则查“已登记”的同标号 0B 实例（任意视图 / 任意层）——该身份由实例自身的
  //       尺寸状态承载（被记为 0B 即登记，被换成 1MB 即清除），不再依赖“当前视图里
  //       恰好有同标号 0B”（如 49ms/0B 停在 47ms 时，49ms 视图内看不到它）——
  Engine.prototype._selfCycle0B = function (g) {
    if (!g || !g.grid) return null;
    var sid = String(g.spaceId);
    for (var sr = 1; sr <= 7; sr++) {
      for (var sc = 1; sc <= 7; sc++) {
        var cellS = g.grid[sr] && g.grid[sr][sc];
        var bS = cellS && cellS.box;
        if (bS && String(bS.spaceId) === sid && bS.type === '0B') return bS;
      }
    }
    // —— 世界范围：已登记为 0B 的同标号实例（跨视图/跨层）——
    var found = null, self = this;
    this._forEachGrid(function (pg) {
      if (found) return;
      self._forEachBoxInGrid(pg, function (b) {
        if (!found && b && b.alive !== false && String(b.spaceId) === sid && b.type === '0B') found = b;
      });
    });
    return found;
  };

  // —— ∞ 悖论——无限退出：数据缺 egg2 时自动合成全 WA 开放地图 ——
  Engine.prototype._ensureInfMeta = function () {
    if (this.spaceMeta[INF_SPACE]) return;
    var cellsI = [];
    for (var iI = 1; iI <= CELLS; iI++) cellsI.push({ id: iI, label: 'WA', space: 0, size: '0B' });
    this.spaceMeta[INF_SPACE] = {
      id: INF_SPACE, type: 'MLE', ac: 23,
      baseCells: cellsI, templateCells: cellsI.map(function (c) { return { id: c.id, label: 'WA', space: 0, size: '0B' }; }),
      baseAc: null, shared: null, layers: [], layerSeq: 0, egg: true, __syntheticInf: true
    };
  };
  // —— 已指向 ∞ 的视图：被推出的盒子“进入” egg2 —— 彩蛋按 TLE 语义刷新，
  //    进入即重建 → 盒子随之被删除（用户定版）——
  Engine.prototype._ejectBoxToInf = function (g, chain, dir) {
    var d = DIRS[dir];
    var tail = chain[chain.length - 1];
    var metaI = this.spaceMeta[INF_SPACE];
    if (!metaI) this._ensureInfMeta();
    metaI = this.spaceMeta[INF_SPACE];
    if (!metaI) return { pushedOut: false };
    this._refreshEggSpace(metaI);                 // 刷新彩蛋空间（等同 TLE：内容删除）
    var cellOld = g.grid[tail.pos.r] && g.grid[tail.pos.r][tail.pos.c];
    if (cellOld) cellOld.box = null;
    /* 盒子被刷新删除：不落位、不保留引用 */
    // 其余链盒正常前进一格
    for (var iI = chain.length - 2; iI >= 0; iI--) {
      var bI = chain[iI], fromI = bI.pos;
      var toI = { r: fromI.r + d.dr, c: fromI.c + d.dc };
      var cfI = g.grid[fromI.r] && g.grid[fromI.r][fromI.c];
      if (cfI) cfI.box = null;
      var ctI = g.grid[toI.r] && g.grid[toI.r][toI.c];
      if (!ctI) { if (!g.grid[toI.r]) g.grid[toI.r] = []; g.grid[toI.r][toI.c] = { box: null, baseLabel: 'WA' }; ctI = g.grid[toI.r][toI.c]; }
      ctI.box = bI;
      bI.pos = toI;
    }
    return { pushedOut: true, to: null, inf: true, frame: this._frameByView(g) };
  };

  // —— 抵达无限退出：AC 从“已推出自嵌套 0B(∞ 指向)”的循环视图边界退出 → egg2 地图 ——
  Engine.prototype._exitToInf = function (dir) {
    this._snapshot();
    var metaI = this.spaceMeta[INF_SPACE];
    if (!metaI) this._ensureInfMeta();
    var metaInf = this.spaceMeta[INF_SPACE];
    this.frames = [];
    if (metaInf) this._refreshEggSpace(metaInf);    // 彩蛋按 TLE 语义刷新(清空内容)
    this.current = this._spaceView(INF_SPACE, 'MLE');
    this.pos = idToRC((metaInf.ac >= 1 && metaInf.ac <= 49) ? metaInf.ac : 23);
    this.moves++;
    this._ev('exit', { dir: dir, to: clonePos(this.pos), boxUid: null, inf: true });
    if (!this._infParadox) {
      this._infParadox = true;
      this._ev('winInf', { spaceId: INF_SPACE });
    }
    return true;
  };

  // —— ε 悖论——无限进入：数据缺 egg3 时自动合成全 WA 开放地图 ——
  Engine.prototype._ensureEpsMeta = function () {
    if (this.spaceMeta[EPS_SPACE]) return;
    var cellsE = [];
    for (var iE = 1; iE <= CELLS; iE++) cellsE.push({ id: iE, label: 'WA', space: 0, size: '0B' });
    this.spaceMeta[EPS_SPACE] = {
      id: EPS_SPACE, type: 'MLE', ac: 23,
      baseCells: cellsE, templateCells: cellsE.map(function (c) { return { id: c.id, label: 'WA', space: 0, size: '0B' }; }),
      baseAc: null, shared: null, layers: [], layerSeq: 0, egg: true, __syntheticEps: true
    };
  };
  // —— 抵达无限进入：进入 Ams/0B 时落点仍是同空间 Ams/0B 且不可推 → 直达 egg3 ——
  Engine.prototype._enterToEps = function (dir, box, occ) {
    this._snapshot();
    var metaE = this.spaceMeta[EPS_SPACE];
    if (!metaE) this._ensureEpsMeta();
    var metaEp = this.spaceMeta[EPS_SPACE];
    this.frames = [];
    if (metaEp) this._refreshEggSpace(metaEp);      // 彩蛋按 TLE 语义刷新(清空内容)
    this.current = this._spaceView(EPS_SPACE, 'MLE');
    this.pos = idToRC((metaEp.ac >= 1 && metaEp.ac <= 49) ? metaEp.ac : 23);
    this.moves++;
    this._ev('enter', { dir: dir, to: clonePos(this.pos), boxUid: box ? box.uid : null, eps: true, viaUid: occ ? occ.uid : null });
    if (!this._epsParadox) {
      this._epsParadox = true;
      this._ev('winEps', { spaceId: EPS_SPACE });
    }
    return true;
  };

  Engine.prototype._ensureAnchor = function () {
    if (!this.current || this.current === this.root) return;
    if (this.current.kind === 'layer') return;          // TLE 实例层由进入路径管帧
    for (var ai = this.frames.length - 1; ai >= 0; ai--) {
      if (this.frames[ai].view === this.current) return;
    }
    var owner0 = null, owner1 = null;
    var selfA = this;
    this._forEachGrid(function (g) {
      selfA._forEachBoxInGrid(g, function (b) {
        if (String(b.spaceId) !== String(selfA.current.spaceId)) return;
        if (b.type === '0B' && !owner0) owner0 = b;
        else if (!owner1) owner1 = b;
      });
    });
    var ownerA = owner0 || owner1;
    if (!ownerA) return;
    var pgA = this._containingGrid(ownerA);
    if (!pgA) return;
    // —— 问题3：锚帧继承"孪生行程"标记 ——
    //    （seq-void 里 AC 经 44ms 盒孪生转移进入 43ms 空间后，43ms 锚帧由本函数补建，
    //      只有继承该标记，`经孪生转移进入保留 0B 盒后退出` 的虚空判定才成立）——
    this.frames.push({ view: this.current, parent: pgA, boxUid: ownerA.uid, boxPos: clonePos(ownerA.pos), spaceId: String(this.current.spaceId), viaTwin: this._twinRoute ? true : undefined });
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
      var c = { spaceId: g.spaceId, kind: g.kind, seq: g.seq, alive: g.alive, __infArmed: g.__infArmed ? true : undefined, grid: Array(8) };
      gridMap.set(g, c);
      for (var r = 1; r <= 7; r++) {
        c.grid[r] = Array(8);
        for (var col = 1; col <= 7; col++) {
          var cell = g.grid[r][col];
          if (!cell) continue;
          c.grid[r][col] = cell.box ? {
            box: { uid: cell.box.uid, spaceId: cell.box.spaceId, type: cell.box.type, spaceType: cell.box.spaceType, pos: { r: cell.box.pos.r, c: cell.box.pos.c }, _instLayer: cell.box._instLayer ? cloneGrid(cell.box._instLayer) : null, _voidRetained: cell.box._voidRetained ? true : undefined },
            baseLabel: cell.baseLabel
          } : { box: null, baseLabel: cell.baseLabel };
        }
      }
      return c;
    }
    var metas = {};
    for (var id in this.spaceMeta) {
      var m = this.spaceMeta[id];
      metas[id] = { type: m.type, ac: m.ac, baseCells: m.baseCells, templateCells: m.templateCells, shared: cloneGrid(m.shared), layers: m.layers.map(cloneGrid), layerSeq: m.layerSeq };
    }
    var frames = this.frames.map(function (f) {
      return { view: cloneGrid(f.view), parent: cloneGrid(f.parent), boxUid: f.boxUid, boxPos: clonePos(f.boxPos), land: f.land ? clonePos(f.land) : null, spaceId: f.spaceId, master: !!f.master, entryKind: f.entryKind || null, viaTwin: f.viaTwin ? true : undefined, boundGrid: f.boundGrid ? cloneGrid(f.boundGrid) : null };
    });
    return {
      metas: metas, root: cloneGrid(this.root), current: cloneGrid(this.current),
      pos: clonePos(this.pos), frames: frames, moves: this.moves, won: this.won, uidSeq: this.uidSeq,
      portal: this._portal ? { doorGrid: cloneGrid(this._portal.doorGrid), doorPos: clonePos(this._portal.doorPos), dir: this._portal.dir, view: cloneGrid(this._portal.view), land: clonePos(this._portal.land), boxUid: this._portal.boxUid, spaceId: this._portal.spaceId } : null,
      voidDoorUid: this._voidDoor ? this._voidDoor.uid : null,
      voidParadox: this._voidParadox,
      infParadox: this._infParadox,
      epsParadox: this._epsParadox
    };
  };
  Engine.prototype._restoreWorld = function (s) {
    for (var id in s.metas) {
      var m = this.spaceMeta[id];
      if (!m) continue;
      m.shared = s.metas[id].shared;
      m.layers = s.metas[id].layers;
      m.layerSeq = s.metas[id].layerSeq;
      if (s.metas[id].templateCells) m.templateCells = s.metas[id].templateCells;
    }
    this.root = s.root;
    this.current = s.current;
    this.pos = clonePos(s.pos);
    this.frames = s.frames.map(function (f) {
      return { view: f.view, parent: f.parent, boxUid: f.boxUid, boxPos: clonePos(f.boxPos), land: f.land ? clonePos(f.land) : null, spaceId: f.spaceId, master: !!f.master, entryKind: f.entryKind || null, viaTwin: f.viaTwin ? true : undefined, boundGrid: f.boundGrid || null };
    });
    this.moves = s.moves;
    this.won = s.won;
    this.uidSeq = s.uidSeq;
    this.events = [];
    this._portal = s.portal ? {
      doorGrid: s.portal.doorGrid, doorPos: clonePos(s.portal.doorPos), dir: s.portal.dir,
      view: s.portal.view, land: clonePos(s.portal.land), boxUid: s.portal.boxUid, spaceId: s.portal.spaceId
    } : null;
    // —— 0 悖论状态还原：按 uid 找回保留盒（在任意网格中）——
    this._voidParadox = !!s.voidParadox;
    this._infParadox = !!s.infParadox;
    this._epsParadox = !!s.epsParadox;
    if (s.voidDoorUid != null) {
      var vd = null;
      var selfR2 = this;
      this._forEachGrid(function (pg) {
        if (vd) return;
        selfR2._forEachBoxInGrid(pg, function (b) {
          if (!vd && b.uid === s.voidDoorUid) vd = b;
        });
      });
      this._voidDoor = vd || null;
      this._voidLabel = vd ? String(vd.spaceId) : null;
    } else {
      this._voidDoor = null;
      this._voidLabel = null;
    }
  };
  Engine.prototype.undo = function () {
    this.events = [];
    if (!this.snapshots.length) return false;
    var s = this.snapshots.pop();
    this._restoreWorld(s);
    this._ev('undo', {});
    return true;
  };

  // —— 操作级快照（供 UI 整段撤回使用）：不受 MAX_SNAPSHOTS 轮转上限影响 ——
  Engine.prototype.captureWorld = function () {
    return this._cloneWorld();
  };
  Engine.prototype.restoreWorld = function (s) {
    if (!s) return false;
    this._restoreWorld(s);
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
    var curSpaceKey = String(this.current.spaceId);
    var st = {
      version: VERSION,
      spaceId: (/^\d+$/.test(curSpaceKey) ? +curSpaceKey : curSpaceKey),    // 数值键=数字；彩蛋/虚空键保留字符串('egg1')
      space: (/^\d+$/.test(curSpaceKey) ? +curSpaceKey : curSpaceKey),
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
        out.push({ id: id, r: rc.r, c: rc.c, label: spaceType, space: +g.spaceId, size: '999.00MB', uid: null, wall: true, time: +g.spaceId, st: spaceType });
        continue;
      }
      if (cell.box) {                                // 盒实例
        var targetMeta = this.spaceMeta[cell.box.spaceId];
        out.push({
          id: id, r: rc.r, c: rc.c, label: targetMeta ? targetMeta.type : cell.box.spaceType,
          space: +cell.box.spaceId,
          size: cell.box.type === '1MB' ? '1.00MB' : '0B',
          uid: cell.box.uid, box: true,
          time: +cell.box.spaceId, st: targetMeta ? targetMeta.type : (cell.box.spaceType || 'MLE')
        });
        continue;
      }
      // 空地（全程仅玩家所在位置为 AC；彩蛋/虚空图不绘制 AC，一律 WA —— 用户定版）
      var onPlayer = playerPos && playerPos.r === rc.r && playerPos.c === rc.c;
      var curMeta2 = this.spaceMeta[String(g.spaceId)];
      var baseLab2 = cell.baseLabel || 'WA';
      if (onPlayer && !(curMeta2 && curMeta2.egg)) baseLab2 = 'AC';                      // 仅玩家位置显示 AC（彩蛋图除外）
      else if (baseLab2 === 'AC') baseLab2 = 'WA';
      else if (baseLab2 === 'MLE' || baseLab2 === 'TLE' || baseLab2 === 'UKE') baseLab2 = 'WA';   // 盒卡原格无盒 → 地板
      out.push({ id: id, r: rc.r, c: rc.c, label: baseLab2, space: 0, size: '0B', uid: null, time: +g.spaceId, st: baseLab2 });
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

  // Node 直接运行：node src/engine.js → 快速自检（加载默认数据并打印摘要）
  if (typeof module === 'object' && module.exports && typeof require === 'function' && require.main === module) {
    try {
      var e0 = new Engine();
      var s0 = e0.getState();
      console.log('[engine.js 自检] v' + VERSION + ' | 空间数据 ' + Object.keys(e0.spaceMeta).length + ' 个 | 起点 空间' + s0.spaceId + '(' + s0.spaceType + ') 位置' + JSON.stringify(s0.pos) + ' | grid=' + s0.grid.length + ' 格 | player=' + JSON.stringify(s0.player) + ' | stack=' + JSON.stringify(s0.stack) + ' | won=' + s0.won);
      var ok1 = e0.move('right');
      console.log('[engine.js 自检] move(\'right\')=' + ok1 + ' → 位置' + JSON.stringify(e0.getState().pos) + ' 事件=' + e0.getState().events.map(function (x) { return x.type; }).join(','));
    } catch (err) {
      console.log('[engine.js 自检] 失败: ' + (err && err.message));
    }
  }

  return api;
});
