/* 回归单测：合成坐标帧驱动 headshake / wave / grasp tracker，验证有效次数逻辑。运行：node tests/test_trackers.js */
const fs = require('fs');
global.window = {};
eval(fs.readFileSync(__dirname + '/../js/exercises.js', 'utf8'));
const X = global.window.DJX;

/* 33 点空骨架 */
function mkL() { return Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 1 })); }

/* --- 摇头：肩 x=300/400 (sw=100)，鼻绕 350 左右摆，amp=0.3*sw=30 --- */
{
  const t = X.makeTracker('headshake');
  const seq = [350, 370, 395, 360, 320, 285, 320, 360, 395, 360, 330, 360]; // 大幅左右各 2 次往返
  let reps = 0, phase = '';
  seq.forEach(nx => {
    const l = mkL();
    l[0] = { x: nx, y: 100, v: 1 }; l[11] = { x: 300, y: 200, v: 1 }; l[12] = { x: 400, y: 200, v: 1 };
    const r = t.feed(l);
    if (r.rep) { if (!r.rep.valid) console.log('HS invalid', r.issues); reps++; }
    phase = r.phase;
  });
  console.log('[摇头] reps =', reps, '(期望 >=2) phase:', phase);
  if (reps < 2) process.exit(1);
}

/* --- 摇头：小幅抖动（±10px）应 0 次并提示幅度 --- */
{
  const t = X.makeTracker('headshake');
  let reps = 0, warned = false;
  for (let i = 0; i < 40; i++) {
    const nx = 350 + (i % 2 ? 10 : -10);
    const l = mkL();
    l[0] = { x: nx, y: 100, v: 1 }; l[11] = { x: 300, y: 200, v: 1 }; l[12] = { x: 400, y: 200, v: 1 };
    const r = t.feed(l);
    if (r.rep) reps++;
    if (r.live.includes('hsSmall')) warned = true;
  }
  console.log('[摇头小幅] reps =', reps, '(期望 0) 幅度提示 =', warned);
  if (reps !== 0 || !warned) process.exit(1);
}

/* --- 挥手：肩 y=300，torsoH 需髋 y=500 → th=300-0.18*200≈... 手举到 y=150，x 摆动 amp=0.5*sw --- */
{
  const t = X.makeTracker('wave');
  let reps = 0;
  const l0 = mkL(); l0[11] = { x: 300, y: 300, v: 1 }; l0[12] = { x: 400, y: 300, v: 1 }; l0[23] = { x: 320, y: 500, v: 1 }; l0[24] = { x: 380, y: 500, v: 1 };
  const th = (300 - 0.18 * (500 - 300));
  if (150 >= th) { console.log('阈值检查异常 th=', th); process.exit(1); }
  [330, 390, 460, 390, 320, 250, 320, 390, 460].forEach(wx => {
    const l = mkL();
    l[11] = { x: 300, y: 300, v: 1 }; l[12] = { x: 400, y: 300, v: 1 };
    l[23] = { x: 320, y: 500, v: 1 }; l[24] = { x: 380, y: 500, v: 1 };
    l[15] = { x: wx, y: 150, v: 1 }; l[16] = { x: wx, y: 160, v: 1 };
    const r = t.feed(l);
    if (r.rep) reps++;
  });
  console.log('[挥手] reps =', reps, '(期望 2：序列含 2 次足幅翻转)');
  if (reps !== 2) process.exit(1);
}

/* --- 挥手：手未举过肩 → 0 次 + wvUp 提示 --- */
{
  const t = X.makeTracker('wave');
  let reps = 0, warned = false;
  for (let i = 0; i < 20; i++) {
    const l = mkL();
    l[11] = { x: 300, y: 300, v: 1 }; l[12] = { x: 400, y: 300, v: 1 };
    l[23] = { x: 320, y: 500, v: 1 }; l[24] = { x: 380, y: 500, v: 1 };
    l[15] = { x: 300 + (i % 2 ? 60 : -60), y: 450, v: 1 }; l[16] = { x: 400, y: 450, v: 1 };
    const r = t.feed(l);
    if (r.rep) reps++;
    if (r.live.includes('wvUp')) warned = true;
  }
  console.log('[挥手低位] reps =', reps, '(期望 0) 举高提示 =', warned);
  if (reps !== 0 || !warned) process.exit(1);
}

/* --- 抓握：构造 21 点手，palm=|p5-p17|=100；open 指尖距腕 200(ratio 2.0)，fist 距 100(ratio 1.0) --- */
function mkHand(tipDist) {
  const p = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));
  p[0] = { x: 0, y: 0 };
  p[5] = { x: 60, y: 50 }; p[17] = { x: -40, y: 50 }; // palm dist = 100
  [8, 12, 16, 20].forEach(i => { p[i] = { x: 0, y: tipDist }; });
  return p;
}
{
  const t = X.makeTracker('grasp');
  let reps = 0;
  const cycle = [];
  // 手在画面中：open(200) 数帧 → fist(100) 数帧 → open 数帧
  for (let i = 0; i < 4; i++) cycle.push(mkHand(220));
  for (let i = 0; i < 4; i++) cycle.push(mkHand(95));
  for (let i = 0; i < 4; i++) cycle.push(mkHand(220));
  cycle.forEach(lm => {
    const l = mkL();
    const r = t.feed(l, 0, 33, [{ label: 'Right', lm }]);
    if (r.rep) reps++;
  });
  console.log('[抓握] 1 张一握 reps =', reps, '(期望 1)');
  if (reps !== 1) process.exit(1);
  // 半张不张（ratio 1.4）不应计
  const t2 = X.makeTracker('grasp');
  let reps2 = 0;
  for (let i = 0; i < 8; i++) {
    const r = t2.feed(mkL(), 0, 33, [{ label: 'Left', lm: mkHand(150) }]);
    if (r.rep) reps2++;
  }
  console.log('[抓握半张] reps =', reps2, '(期望 0)');
  if (reps2 !== 0) process.exit(1);
}

/* --- 耸肩：耳 y=100，肩基线 y=200，sw=100；耸到 183（lift=17>12）→ 回 206 = 1 次 --- */
{
  let reps = 0, tt = 0;
  const t = X.makeTracker('shrug');
  const feed = (sy) => { tt += 100; const l = mkL();
    l[7] = { x: 340, y: 100, v: 1 }; l[8] = { x: 360, y: 100, v: 1 };
    l[11] = { x: 300, y: sy, v: 1 }; l[12] = { x: 400, y: sy, v: 1 };
    const r = t.feed(l, tt, 100); if (r.rep) reps++; return r; };
  for (let i = 0; i < 3; i++) { feed(200); feed(200); feed(183); feed(183); feed(206); feed(206); }
  console.log('[耸肩] reps =', reps, '(期望 3)');
  if (reps !== 3) process.exit(1);
}

/* --- 耸肩小幅（lift≈6 < 12）：0 次 + sgLow 提示 --- */
{
  let reps = 0, warned = false, tt = 6000;
  const t = X.makeTracker('shrug');
  for (let i = 0; i < 40; i++) {
    tt += 100;
    const l = mkL();
    l[7] = { x: 340, y: 100, v: 1 }; l[8] = { x: 360, y: 100, v: 1 };
    const sy = i % 4 < 2 ? 200 : 194;
    l[11] = { x: 300, y: sy, v: 1 }; l[12] = { x: 400, y: sy, v: 1 };
    const r = t.feed(l, tt, 100);
    if (r.rep) reps++;
    if (r.live.includes('sgLow')) warned = true;
  }
  console.log('[耸肩小幅] reps =', reps, '(期望 0) 幅度提示 =', warned);
  if (reps !== 0 || !warned) process.exit(1);
}

/* --- 一句话编排 planFromText（纯函数）：场景识别 / 时长 / Pro 过滤 --- */
{
  const seatedSet = ['headshake', 'wave', 'shrug'];
  const p1 = X.planFromText('我在办公室久坐，肩膀很酸，来个 5 分钟');
  const allSeated = p1.ids.every(id => seatedSet.includes(id));
  console.log('[编排-办公室] ids =', p1.ids.join(','), '全坐姿 =', allSeated, '时长 =', p1.minutes, '预计 =', p1.estMin);
  if (!allSeated || !p1.seatedOnly || p1.minutes !== 5 || p1.ids.length < 3) process.exit(1);

  const p2 = X.planFromText('想瘦腿出汗 10 分钟');
  console.log('[编排-腿燃脂] ids =', p2.ids.join(','), '含深蹲 =', p2.ids.includes('squat'), '预计 =', p2.estMin);
  if (!p2.ids.includes('squat') || !p2.ids.includes('jack') || p2.estMin > 13) process.exit(1);

  const p3 = X.planFromText('练核心腹肌');
  console.log('[编排-核心免费版] ids =', p3.ids.join(','), 'locked =', p3.locked.join('/'));
  if (!p3.locked.includes('平板支撑') || p3.ids.includes('plank')) process.exit(1);

  const p4 = X.planFromText('练核心腹肌 15 分钟', { pro: true });
  console.log('[编排-核心Pro] ids =', p4.ids.join(','), '轮数 =', p4.rounds, 'locked =', p4.locked.length);
  if (!p4.ids.includes('plank') || p4.locked.length !== 0 || p4.ids.length > 8) process.exit(1);

  const p5 = X.planFromText('');
  console.log('[编排-空输入] ids =', p5.ids.join(','), 'why =', p5.why[0]);
  if (p5.ids.length < 3 || !/均衡/.test(p5.why[0])) process.exit(1);
}

/* --- 体感关卡：三种关卡的判定与生命周期 --- */
{
  const dt = 33;
  const rnd = (seed => () => (seed = seed * 9301 % 49297) / 49297)(12345);

  /* 收集：追着星星跑能接到；星星落地不扣命 */
  const g1 = X.makeGame('collect', { duration: 20, rnd });
  let ev1 = { catch: 0, miss: 0 };
  for (let i = 0; i < 700; i++) {
    const S = g1.S;
    const st = S.objs.find(q => q.type === 'star') || S.objs.find(q => q.type === 'starHi');
    const inp = { x: st ? st.x : 0.5, armsUp: !!S.objs.find(q => q.type === 'starHi'), squat: false };
    g1.step(inp, dt).forEach(e => { if (ev1[e.ev] != null) ev1[e.ev]++; });
  }
  console.log('[关卡-收集] 接到 =', ev1.catch, '落地 =', ev1.miss, '分数 =', g1.S.score, '剩余时间 =', Math.round(g1.left()));
  if (ev1.catch < 3 || g1.S.hp !== g1.S.hpMax || g1.S.over !== true) process.exit(1);

  /* 闪避：站在一侧不动，同侧激光判 hurt，3 命耗尽即结束 */
  const g2 = X.makeGame('dodge', { duration: 60, rnd });
  let over2 = null;
  for (let i = 0; i < 1200 && !over2; i++) {
    const evs = g2.step({ x: 0.25 }, dt);
    over2 = evs.find(e => e.ev === 'over');
  }
  console.log('[关卡-闪避] 得分 =', g2.S.score, '生命 =', g2.S.hp, '结束原因 =', over2 && over2.why);
  if (!over2 || over2.why !== 'hp' || g2.S.hp !== 0 || g2.S.score < 1) process.exit(1);

  /* 深蹲护盾：蹲下只出 shield，不蹲必 hurt；both 对比 */
  const run = squat => { const g = X.makeGame('guard', { duration: 25, rnd }); const c = { shield: 0, hurt: 0 };
    for (let i = 0; i < 800; i++) g.step({ x: 0.5, squat }, dt).forEach(e => { if (c[e.ev] != null) c[e.ev]++; });
    return { c, S: g.S }; };
  const a = run(true), b = run(false);
  console.log('[关卡-护盾] 蹲：', JSON.stringify(a.c), '分数', a.S.score, '/ 不蹲：', JSON.stringify(b.c), '结束', b.S.over);
  if (a.c.shield < 3 || a.c.hurt !== 0 || b.c.hurt < 3 || b.S.over !== true) process.exit(1);

  /* 难度递进 + 时长收口 */
  const g5 = X.makeGame('collect', { duration: 34, rnd });
  let lvSeen = 1, why = null, hi = 0;
  for (let i = 0; i < 1100; i++) g5.step({ x: 0.5 }, dt).forEach(e => {
    if (e.ev === 'level') lvSeen = e.level;
    if (e.ev === 'catch' && e.hi) hi++;
    if (e.ev === 'over') why = e.why;
  });
  console.log('[关卡-递进] level =', g5.S.level, '末次档位 =', lvSeen, '高星加分 =', hi, '结束 =', why);
  if (g5.S.level < 3 || why !== 'time') process.exit(1);
  if (!X.GAME_KINDS || Object.keys(X.GAME_KINDS).length !== 3) process.exit(1);
}

/* --- 周课表：空历史 + 免费版（只能排免费动作，周日休息）--- */
{
  const MON = new Date(2026, 9, 12, 12, 0, 0).getTime();      // 2026-10-12 周一
  const WED = new Date(2026, 9, 14, 8, 30, 0).getTime();       // 今天 = 周三 → todayI = 2
  const rec = (off, id, mode, valid, score) => ({ ts: MON + off * 864e5 + 36e5, ex: id, name: id, mode,
    target: 10, valid, attempts: valid + 1, secs: 60, cal: 5, score, issues: {} });
  const freeIds = new Set(X.EXERCISES.filter(e => e.free).map(e => e.id));

  const p = X.makeWeekPlan([], { today: WED });
  console.log('[课表-空历史] days =', p.days.length, 'todayI =', p.todayI, '今日 =', p.days[2].theme, '/', p.days[2].names.join(','));
  if (p.days.length !== 7 || p.todayI !== 2) process.exit(1);
  if (p.days[6].kind !== 'rest' || p.days[6].targetPts !== 0) { console.log('周日应为休息日'); process.exit(1); }
  if (p.days[2].ids.some(id => !freeIds.has(id))) { console.log('免费版排进了 Pro 动作'); process.exit(1); }
  if (p.days[2].ids.length < 2 || p.next.type !== 'circuit') { console.log('今日应有可开练的循环'); process.exit(1); }
  /* 时长估算必须带出（曾有 day 对象漏返 estMin 导致界面显示“约 undefined 分钟”）*/
  if (!(p.days[2].estMin > 0) || !/约 [\d.]+ 分钟/.test(p.tip) || /undefined|NaN/.test(p.tip)) {
    console.log('estMin/tip 异常', p.days[2].estMin, p.tip); process.exit(1); }
  if (p.days[5].estMin !== 1 || p.days[6].estMin !== 0) { console.log('关卡日应 1 分钟、休息日 0', p.days[5].estMin, p.days[6].estMin); process.exit(1); }
  if (p.days[0].status !== 'missed' || p.days[3].status !== 'upcoming') { console.log('状态机错', p.days[0].status, p.days[3].status); process.exit(1); }
  if (p.missed !== 2) { console.log('周一周二应算漏练', p.missed); process.exit(1); }

  /* Pro 专属动作：核心日（周四）在 Pro 下才能排进 plank/pushup */
  const pro = X.makeWeekPlan([], { today: WED, pro: true });
  const corePro = pro.days[3].ids.filter(id => id === 'plank' || id === 'pushup');
  const coreFree = p.days[3].ids.filter(id => id === 'plank' || id === 'pushup');
  console.log('[课表-Pro] 核心日 Pro =', pro.days[3].names.join(','), '/ 免费 =', p.days[3].names.join(','));
  if (!corePro.length || coreFree.length) process.exit(1);

  /* 弱项优先：深蹲均分 50、其他动作均分 90+ → 心肺日（周三）应把深蹲排在最前 */
  const weak = X.makeWeekPlan([
    rec(0, 'squat', 'reps', 12, 48), rec(1, 'squat', 'reps', 10, 52),
    rec(0, 'jack', 'reps', 20, 92), rec(1, 'jack', 'reps', 22, 88),
    rec(0, 'highknees', 'reps', 20, 96), rec(1, 'highknees', 'reps', 22, 94),
    rec(0, 'wave', 'reps', 20, 99), rec(1, 'wave', 'reps', 22, 97)
  ], { today: WED, pro: true });
  const ci = weak.days[2].ids;
  console.log('[课表-弱项] 心肺日顺序 =', ci.join(','), '弱项 =', weak.weak.join(' / '));
  if (ci.indexOf('squat') < 0 || ci.indexOf('squat') > ci.indexOf('jack')) { console.log('弱项应优先'); process.exit(1); }
  if (!weak.weak.length || !/深蹲/.test(weak.weak[0])) { console.log('weak 应报深蹲', weak.weak); process.exit(1); }

  /* 额度排完自动降级为关卡日（关卡不扣额度） */
  const q = X.makeWeekPlan([], { today: WED, quotaLeft: 2 });
  const down = q.days.filter(d => d.note);
  console.log('[课表-额度] planned =', q.plannedSessions, '降级日 =', down.map(d => d.theme + ':' + d.game).join(','));
  if (q.plannedSessions !== 2 || down.length < 2 || down.some(d => d.kind !== 'game' || d.ids.length)) process.exit(1);

  /* 今日完成口径：计时/关卡折点 + tip 文案 */
  const d1 = X.makeWeekPlan([rec(2, 'squat', 'reps', 40, 88)], { today: WED, dailyGoal: 30 });
  const d2 = X.makeWeekPlan([rec(2, 'squat', 'reps', 10, 88)], { today: WED, dailyGoal: 30 });
  const d3 = X.makeWeekPlan([rec(2, 'plank', 'time', 45, 90), rec(2, 'collect', 'game', 21, 70)], { today: WED, dailyGoal: 30, pro: true });
  console.log('[课表-完成] 达标 =', d1.tip, '\n         未达 =', d2.tip, '\n         折点 =', d3.days[2].donePts, d3.tip);
  if (!d1.days[2].met || !/已完成/.test(d1.tip)) process.exit(1);
  if (d2.days[2].met !== false || !/还差 20 点/.test(d2.tip)) process.exit(1);
  if (d3.days[2].donePts !== 12) { console.log('折点应为 45/10 + 21/3 = 12', d3.days[2].donePts); process.exit(1); }

  /* 周日：无推荐开练动作，tip 指向明天 */
  const SUN = new Date(2026, 9, 18, 9, 0, 0).getTime();
  const r = X.makeWeekPlan([], { today: SUN });
  console.log('[课表-周日] todayI =', r.todayI, 'next =', r.next, 'tip =', r.tip);
  if (r.todayI !== 6 || r.next !== null || !/休息日/.test(r.tip)) process.exit(1);

  /* 关卡日（周六）next 直接指向一局游戏 */
  const g = X.makeWeekPlan([], { today: new Date(2026, 9, 17, 10, 0, 0).getTime() });
  console.log('[课表-关卡日] kind =', g.days[5].kind, 'next =', JSON.stringify(g.next));
  if (g.days[5].kind !== 'game' || g.next.type !== 'game' || !X.GAME_KINDS[g.next.kind]) process.exit(1);
}

/* --- 元数据完整性：10 动作、keys/start 均存在，坐姿系标记 --- */
{
  const ids = X.EXERCISES.map(e => e.id);
  console.log('[元数据] 动作数 =', ids.length, ids.join(','));
  if (ids.length !== 10) process.exit(1);
  ['headshake', 'wave', 'grasp', 'shrug'].forEach(id => {
    const e = X.EXERCISES.find(x => x.id === id);
    if (!e.seated || typeof e.start !== 'function' || !e.keys.length) { console.log('元数据缺项', id); process.exit(1); }
  });
  const hs = X.EXERCISES.find(x => x.id === 'headshake');
  const l = mkL();
  if (!hs.start(l)) { console.log('headshake start 应为 true'); process.exit(1); }
  if (!X.HAND_CONNS || X.HAND_CONNS.length < 20) { console.log('HAND_CONNS 缺失'); process.exit(1); }
}

console.log('\n✅ 全部离线单测通过');
