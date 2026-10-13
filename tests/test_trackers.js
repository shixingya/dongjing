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
