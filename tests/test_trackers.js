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
  const seatedSet = ['headshake', 'wave', 'shrug', 'sidestretch'];   // 办公室场景允许项（体侧伸展只要求肩髋可见）
  const needSpace = ['squat', 'lunge', 'jack', 'highknees', 'pushup', 'plank', 'wallsit'];   // 要腾地方/全身入镜的
  const p1 = X.planFromText('我在办公室久坐，肩膀很酸，来个 5 分钟');
  const allSeated = p1.ids.every(id => seatedSet.includes(id));
  console.log('[编排-办公室] ids =', p1.ids.join(','), '不占地方 =', allSeated, '时长 =', p1.minutes, '预计 =', p1.estMin);
  if (!allSeated || p1.ids.some(id => needSpace.includes(id)) || !p1.seatedOnly || p1.minutes !== 5 || p1.ids.length < 3) process.exit(1);

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

  /* v1.8 新增动作得“说人话就能命中”，不能只活在动作库里 */
  const p6 = X.planFromText('坐一天侧腰好紧，想拉伸一下');
  console.log('[编排-拉伸] ids =', p6.ids.join(','), 'why =', p6.why.join(' / '));
  if (!p6.ids.includes('sidestretch') || p6.ids[0] !== 'sidestretch') { console.log('拉伸诉求应把体侧伸展排第'); process.exit(1); }
  const p7 = X.planFromText('膝盖不太行，就想靠墙蹲一会', { pro: true });
  console.log('[编排-靠墙蹲 Pro] ids =', p7.ids.join(','));
  if (!p7.ids.includes('wallsit')) { console.log('靠墙/蹲应命中靠墙静蹲'); process.exit(1); }
  const p8 = X.planFromText('练手臂', { pro: true });
  console.log('[编排-手臂 Pro] ids =', p8.ids.join(','));
  if (!p8.ids.includes('sidraise')) { console.log('练手臂应含侧平举'); process.exit(1); }

  /* 膝盖敏感：不能一听“腿”就排跳跃，等长的靠墙静蹲得排第（浏览器冒烟实测到这一步之前是自相矛盾的）*/
  const p9 = X.planFromText('膝盖不太行，就想靠墙蹲一会', { pro: true });
  console.log('[编排-护膝 Pro] ids =', p9.ids.join(','), 'why =', p9.why[0]);
  if (p9.ids[0] !== 'wallsit' || p9.ids.includes('jack') || p9.ids.includes('highknees')) {
    console.log('膝盖敏感不应安排冲击类，且靠墙静蹲应排第'); process.exit(1);
  }
  if (!/膝盖敏感/.test(p9.why[0])) { console.log('why 应说明护膝理由'); process.exit(1); }
  const p10 = X.planFromText('膝盖不太行');                       // 免费版：靠墙静蹲被锁，不能退化成单动作
  console.log('[编排-护膝免费] ids =', p10.ids.join(','), 'locked =', p10.locked.join('/'));
  if (p10.ids.length < 3 || p10.ids.includes('highknees') || !p10.locked.includes('靠墙静蹲')) {
    console.log('免费版护膝编排也该凑满 3 个，并告知靠墙静蹲需 Pro'); process.exit(1);
  }
  /* 不能承诺免费版根本排不进去的动作 */
  console.log('[编排-护膝免费] why =', p10.why[0]);
  if (/优先靠墙静蹲/.test(p10.why[0]) || !/低冲击/.test(p10.why[0])) { console.log('无 wallsit 权限时 why 不应承诺靠墙静蹲'); process.exit(1); }
  const p11 = X.planFromText('想瘦腿出汗', { pro: true });   // 没提膝盖就不能误伤：冲击类照旧
  if (!p11.ids.length || p11.why.some(w => /膝盖敏感/.test(w))) { console.log('未提膝盖时不应触发护膝逻辑'); process.exit(1); }
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

  /* v1.8 按周轮换：新动作不能永远排在池尾进不了课表 */
  {
    const seen = new Set(), firsts = [];
    for (let w = 0; w < 5; w++) {
      const mon = new Date(2026, 9, 12 + w * 7, 12, 0, 0).getTime();
      const pp = X.makeWeekPlan([], { today: mon, pro: true });
      pp.days.forEach(d => (d.ids || []).forEach(id => seen.add(id)));
      firsts.push(pp.days[0].ids.join(','));
    }
    console.log('[课表-轮换] 5 周出现动作 =', [...seen].sort().join(','));
    console.log('           下肢日序列 =', firsts.join(' | '));
    ['wallsit', 'sidraise', 'sidestretch'].forEach(id => {
      if (!seen.has(id)) { console.log('新动作从来没被排进课表', id); process.exit(1); }
    });
    if (new Set(firsts).size < 3) { console.log('跨周应换口味，不能五周一张课表'); process.exit(1); }
    /* 轮换不能破弱项优先：深蹲分再低也得排第（记录必须落在该周的近 14 天窗口内）*/
    const recW = (mon, id, score) => ({ ts: mon + 36e5, ex: id, name: id,
      mode: 'reps', target: 10, valid: 10, attempts: 11, secs: 60, score, issues: {} });
    for (let w = 0; w < 4; w++) {
      const mon = new Date(2026, 9, 12 + w * 7, 12, 0, 0).getTime();
      const wp = X.makeWeekPlan([recW(mon, 'squat', 42), recW(mon, 'jack', 95), recW(mon, 'lunge', 93), recW(mon, 'wallsit', 96)], { today: mon, pro: true });
      if (wp.days[0].ids[0] !== 'squat') { console.log('弱项应优先于轮换', w, wp.days[0].ids.join(',')); process.exit(1); }
    }
    console.log('           弱项优先在 4 个轮换周均成立 = true');
  }

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

/* --- 侧面体态：合成矢状面链条，验证分级/方向文案/可见性兼容/正侧合并 --- */
{
  /* bodyH = 踝(580) - 鼻(100) = 480px → 1% = 4.8px */
  const mkSide = o => {
    const l = mkL();
    const put = (i, x, y) => { l[i] = { x, y, v: 1 }; };
    put(0, o.head, 100); put(7, o.ear, 110); put(8, o.ear, 110);
    put(11, o.sh, 220); put(12, o.sh, 220);
    put(23, o.hip, 360); put(24, o.hip, 360);
    put(25, o.knee, 470); put(26, o.knee, 470);
    put(27, o.an, 580); put(28, o.an, 580);
    if (o.leftOnly) [12, 24, 26, 28, 8].forEach(i => { l[i] = { x: 0, y: 0, v: 0 }; });
    if (o.noAnkle) [27, 28].forEach(i => { l[i] = { x: 0, y: 0, v: 0 }; });
    return l;
  };
  const frames = (o, n) => Array.from({ length: n || 5 }, () => mkSide(o));
  const lv = r => r.items.map(it => it.name.slice(0, 3) + ':' + it.cls).join(' ');

  const good = X.analyzePostureSide(frames({ head: 300, ear: 300, sh: 300, hip: 300, knee: 300, an: 300 }));
  console.log('[侧面-对齐] score =', good.score, lv(good));
  if (good.score !== 100 || good.items.length !== 4 || good.items.some(it => it.cls !== 'a')) process.exit(1);

  const bad = X.analyzePostureSide(frames({ head: 300, ear: 360, sh: 330, hip: 312, knee: 312, an: 300 }));
  console.log('[侧面-全偏差] score =', bad.score, lv(bad), '|', bad.items.map(it => it.dir).filter(Boolean).join(' / '));
  if (bad.items.length !== 4 || bad.items.some(it => it.cls !== 'c') || bad.score !== 40) process.exit(1);
  if (!/耳在肩前方/.test(bad.items[0].dir) || !/肩在髋前方/.test(bad.items[1].dir)) { console.log('方向文案错'); process.exit(1); }

  const mild = X.analyzePostureSide(frames({ head: 300, ear: 322, sh: 314, hip: 308, knee: 306, an: 300 }));
  console.log('[侧面-轻度] score =', mild.score, lv(mild));
  if (mild.items.length !== 4 || mild.items.some(it => it.cls !== 'b') || mild.score !== 64) process.exit(1);

  /* 远侧被躯干挡住：只要单侧可见也得出 4 项 */
  const one = X.analyzePostureSide(frames({ head: 300, ear: 300, sh: 300, hip: 300, knee: 300, an: 300, leftOnly: true }));
  console.log('[侧面-单侧] items =', one ? one.items.length : null, 'score =', one && one.score);
  if (!one || one.items.length !== 4) process.exit(1);

  /* 踝不可见 → 算不了骨盆/膝，只给上两项，不能崩 */
  const noAn = X.analyzePostureSide(frames({ head: 300, ear: 360, sh: 330, hip: 312, knee: 312, an: 300, noAnkle: true }));
  console.log('[侧面-无踝] items =', noAn.items.length, lv(noAn));
  if (noAn.items.length !== 2) process.exit(1);
  if (X.analyzePostureSide([]) !== null || X.analyzePostureSide(null) !== null) process.exit(1);

  /* 正面 + 侧面合并：分分取均值，条目带 view 标签 */
  const mkFront = () => { const l = mkL();
    const put = (i, x, y) => { l[i] = { x, y, v: 1 }; };
    put(0, 300, 100); put(7, 290, 120); put(8, 310, 120);
    put(11, 270, 220); put(12, 330, 220); put(23, 285, 360); put(24, 315, 360);
    put(25, 285, 470); put(26, 315, 470); put(27, 285, 580); put(28, 315, 580);
    return l; };
  const front = X.analyzePosture(Array.from({ length: 5 }, mkFront));
  if (!front || front.score !== 100) { console.log('正面基准异常', front && front.score); process.exit(1); }
  const m2 = X.mergePosture(front, bad);
  const m1 = X.mergePosture(front, null);
  console.log('[合并] 正+侧 =', m2.score, 'items =', m2.items.length, 'twoView =', m2.twoView,
    '| 仅正面 =', m1.score, m1.items.length, m1.twoView);
  if (m2.score !== 70 || m2.items.length !== 8 || m2.twoView !== true) process.exit(1);
  if (m2.items.filter(it => it.view === '正面').length !== 4 || m2.items.filter(it => it.view === '侧面').length !== 4) process.exit(1);
  if (m1.score !== 100 || m1.items.length !== 4 || m1.twoView !== false) process.exit(1);
  if (X.mergePosture(null, null) !== null) process.exit(1);
}

/* --- 侧平举（v1.8）：双臂同起同落不能亏数；弯臂版本不计 --- */
{
  const frame = (wrY, elX, elY, wX) => {
    const l = mkL();
    l[11] = { x: 300, y: 300, v: 1 }; l[12] = { x: 400, y: 300, v: 1 };   // sw = 100
    l[13] = { x: elX, y: elY, v: 1 }; l[15] = { x: wX == null ? 292 : wX, y: wrY, v: 1 };
    l[14] = { x: 700 - elX, y: elY, v: 1 }; l[16] = { x: 700 - (wX == null ? 292 : wX), y: wrY, v: 1 };
    return l;
  };
  const down = () => frame(520, 296, 410);          // 垂体侧（腕 y 520 ≥ 300+1.15*100）
  const upStraight = () => frame(300, 296, 300);    // 抬到肩线（300 ≤ 300+0.25*100），肘角≈180
  const upBent = () => frame(300, 300, 400, 340);   // 小臂往上掀：肘角≈ 22°
  const run = (seq) => {
    const t = X.makeTracker('sidraise');
    let reps = 0, valid = 0, iss = [];
    seq.forEach((f, i) => {
      const r = t.feed(f(), 1000 + i * 250, 250);
      if (r.rep) { reps++; if (r.rep.valid) valid++; iss = iss.concat(r.rep.issues); }
    });
    return { reps, valid, iss };
  };
  const ok = run([down, down, upStraight, upStraight, down, down, down]);
  console.log('[侧平举-标准] reps =', ok.reps, 'valid =', ok.valid);
  if (ok.reps !== 2 || ok.valid !== 2) { console.log('双臂一轮应计 2 次'); process.exit(1); }
  const bad = run([down, down, upBent, upBent, down, down, down]);
  console.log('[侧平举-弯臂] reps =', bad.reps, 'valid =', bad.valid, 'issues =', bad.iss.join(','));
  if (bad.reps !== 2 || bad.valid !== 0 || !bad.iss.includes('srBent')) { console.log('弯臂应不计次'); process.exit(1); }
}

/* --- 体侧伸展（v1.8）：幅度 + 停留都达标才算，回正才结算 --- */
{
  const lean = deg => {
    const l = mkL();
    const hMidX = 350, dy = 200, dx = Math.tan(deg * Math.PI / 180) * dy;
    l[23] = { x: hMidX - 10, y: 500, v: 1 }; l[24] = { x: hMidX + 10, y: 500, v: 1 };
    l[11] = { x: hMidX + dx - 50, y: 300, v: 1 }; l[12] = { x: hMidX + dx + 50, y: 300, v: 1 };
    l[0] = { x: hMidX + dx, y: 200, v: 1 };
    return l;
  };
  const up = () => lean(0);
  const run = (seq) => {
    const t = X.makeTracker('sidestretch');
    let reps = 0, res = [];
    seq.forEach((f, i) => { const r = t.feed(f(), 1000 + i * 250, 250); if (r.rep) { reps++; res.push(r.rep.valid + ':' + r.rep.issues.join('/')); } });
    return { reps, res };
  };
  const good = run([up, () => lean(20), () => lean(21), () => lean(20), () => lean(20), () => lean(20), up]);
  console.log('[体侧伸展-达标] reps =', good.reps, good.res.join(' | '));
  if (good.reps !== 1 || good.res[0] !== 'true:') { console.log('侧弯 20° 停 1s 应计 1 次有效'); process.exit(1); }
  const rush = run([up, () => lean(20), () => lean(20), () => lean(20), up]);
  console.log('[体侧伸展-未停留] reps =', rush.reps, rush.res.join(' | '));
  if (rush.reps !== 1 || rush.res[0] !== 'false:ssHold') { console.log('停不够 0.6s 应判 ssHold'); process.exit(1); }
  const small = run([up, () => lean(8), () => lean(8), () => lean(8), up]);
  console.log('[体侧伸展-幅度不足] reps =', small.reps);
  if (small.reps !== 0) { console.log('8° 不该进入侧弯周期'); process.exit(1); }
}

/* --- 靠墙静蹲（v1.8）：膝角 80–118° 且躯干不后仰才累计计时 --- */
{
  const pose = (kneeDeg, leanOff) => {
    const l = mkL();
    const ky = 560, kx = 400, shin = 120;
    const th = 120, dy = Math.cos(kneeDeg * Math.PI / 180) * th, dx = Math.sqrt(th * th - dy * dy);
    l[23] = { x: kx - dx - 10, y: ky + dy, v: 1 }; l[24] = { x: kx - dx + 12, y: ky + dy, v: 1 };
    l[25] = { x: kx, y: ky, v: 1 }; l[26] = { x: kx + 12, y: ky, v: 1 };
    l[27] = { x: kx, y: ky + shin, v: 1 }; l[28] = { x: kx + 12, y: ky + shin, v: 1 };
    const hipMidX = kx - dx + 1, hipMidY = ky + dy;
    const off = (leanOff || 0) * 140;
    l[11] = { x: hipMidX - 50 + off, y: hipMidY - 140, v: 1 }; l[12] = { x: hipMidX + 50 + off, y: hipMidY - 140, v: 1 };
    l[0] = { x: hipMidX + off, y: hipMidY - 220, v: 1 };
    return l;
  };
  const run = (mk, n) => {
    const t = X.makeTracker('wallsit');
    let secs = 0, valid = 0, invalid = 0, live = [];
    for (let i = 0; i < n; i++) {
      const r = t.feed(mk(), 1000 + i * 250, 250);
      live = live.concat(r.live);
      if (r.rep) { secs += r.rep.seconds; if (r.rep.valid) valid++; else invalid++; }
    }
    return { secs: +secs.toFixed(2), valid, invalid, live };
  };
  const hold = run(() => pose(100), 40);
  console.log('[静蹲-标准] secs =', hold.secs, 'valid帧 =', hold.valid);
  if (Math.abs(hold.secs - 10) > 0.01 || hold.valid !== 40) { console.log('40×250ms 应累计 10s'); process.exit(1); }
  const high = run(() => pose(150), 20);
  console.log('[静蹲-没蹲下] secs =', high.secs, 'live =', high.live.join(','));
  if (high.secs !== 0 || !high.live.includes('wsUp')) { console.log('站直不该计时且要提示蹲低'); process.exit(1); }
  const slump = run(() => pose(100, 0.35), 20);
  console.log('[静蹲-躯干前塌] secs =', slump.secs, 'valid帧 =', slump.valid, 'invalid帧 =', slump.invalid, 'live =', slump.live.join(','));
  if (slump.valid !== 0 || slump.invalid !== 20 || !slump.live.includes('wsLean')) { console.log('后仰应暂停计时'); process.exit(1); }
}

/* --- 抓握：同一帧双手同时完成不能只计 1 次（一帧只能上报一个 rep，多余的排队） --- */
{
  const t = X.makeTracker('grasp');
  const hands = dist => [0, 1].map(g => ({ label: g, lm: mkHand(dist) }));
  const seq = [];
  for (let c = 0; c < 2; c++) {                    // 每只手 2 个「张开→握拳→张开」周期
    for (let i = 0; i < 3; i++) seq.push(220);
    for (let i = 0; i < 3; i++) seq.push(95);
    seq.push(220);                                 // 这一帧两只手同时结算
  }
  for (let i = 0; i < 4; i++) seq.push(220);       // 维持张开，把队列剩下的排空
  let reps = 0, maxPerFrame = 0;
  seq.forEach(d => {
    const r = t.feed(mkL(), 0, 33, hands(d));
    const n = r.rep ? 1 : 0;
    maxPerFrame = Math.max(maxPerFrame, n);
    reps += n;
  });
  console.log('[抓握-双手同帧] reps =', reps, '(期望 4：两只手各 2 次) 单帧最多上报 =', maxPerFrame);
  if (reps !== 4 || maxPerFrame > 1) { console.log('双手同时完成时不应丢计数，也不应一帧塞两个'); process.exit(1); }
}

/* --- 元数据完整性：13 动作、keys/start 均存在，坐姿系标记 --- */
{
  const ids = X.EXERCISES.map(e => e.id);
  console.log('[元数据] 动作数 =', ids.length, ids.join(','));
  if (ids.length !== 13) process.exit(1);
  const freeN = X.EXERCISES.filter(e => e.free).length;
  console.log('[元数据] 免费 =', freeN, '/ Pro =', ids.length - freeN, '/ 纠错规则 =', Object.keys(X.ISSUES).length);
  if (freeN !== 7 || Object.keys(X.ISSUES).length !== 26) { console.log('免费/Pro 或规则口径变了，记得同步 README/PRD'); process.exit(1); }
  ['sidraise', 'sidestretch', 'wallsit'].forEach(id => {
    const e = X.EXERCISES.find(x => x.id === id);
    if (!e || !e.keys.length || typeof e.start !== 'function' || typeof X.makeTracker(id).feed !== 'function') {
      console.log('新动作接入不完整', id); process.exit(1);
    }
  });
  ['headshake', 'wave', 'grasp', 'shrug'].forEach(id => {
    const e = X.EXERCISES.find(x => x.id === id);
    if (!e.seated || typeof e.start !== 'function' || !e.keys.length) { console.log('元数据缺项', id); process.exit(1); }
  });
  const hs = X.EXERCISES.find(x => x.id === 'headshake');
  const l = mkL();
  if (!hs.start(l)) { console.log('headshake start 应为 true'); process.exit(1); }
  if (!X.HAND_CONNS || X.HAND_CONNS.length < 20) { console.log('HAND_CONNS 缺失'); process.exit(1); }
}

/* --- v1.9 训练模板：templateOf / tplAdd / tplSafe / tplEstimate --- */
{
  /* templateOf：合法 ids（去重、过滤无效 id） */
  const t1 = X.templateOf(['squat', 'squat', 'jack', 'bogus'], null, 1000);
  console.log('[tpl-templateOf 去重] ids =', t1 && t1.ids.join(','), 'name =', t1 && t1.name);
  if (!t1 || t1.ids.join(',') !== 'squat,jack') process.exit(1);
  if (t1.name !== '深蹲+开合跳') { console.log('fallback 名异常', t1.name); process.exit(1); }

  /* 少于 2 个有效 id → null */
  if (X.templateOf(['squat'], 'x') !== null) { console.log('单动作应为 null'); process.exit(1); }
  if (X.templateOf(null) !== null) process.exit(1);

  /* HTML 标签字符过滤 + 截断 */
  const t2 = X.templateOf(['headshake', 'wave'], '<script>alert("x")</script>这是超长的课程名字测试截断功能');
  console.log('[tpl-templateOf 过滤] name =', t2.name);
  if (/</.test(t2.name) || t2.name.length > X.TPL_MAX * 0 + 20) { console.log('名字应无 HTML 且 <=20'); process.exit(1); }

  /* tplAdd 正常 */
  const add1 = X.tplAdd([], t1);
  console.log('[tpl-add] ok =', add1.ok, 'len =', add1.list.length);
  if (!add1.ok || add1.list.length !== 1) process.exit(1);

  /* dup 检测（不同顺序也算重复） */
  const dupT = X.templateOf(['jack', 'squat'], '换位重复');
  const add2 = X.tplAdd(add1.list, dupT);
  console.log('[tpl-dup] why =', add2.why);
  if (add2.ok || add2.why !== 'dup') process.exit(1);

  /* bad：ids 不足 / name 空 */
  const addBad = X.tplAdd([], { id: 'bx', name: '', ids: ['squat'] });
  if (addBad.ok || addBad.why !== 'bad') { console.log('bad tpl 应拒绝'); process.exit(1); }

  /* full：塞到上限 */
  let full = [];
  const pairs = [['squat', 'jack'], ['squat', 'lunge'], ['jack', 'lunge'], ['headshake', 'wave'],
    ['headshake', 'shrug'], ['wave', 'shrug'], ['squat', 'highknees'], ['jack', 'highknees'],
    ['lunge', 'highknees'], ['headshake', 'grasp'], ['wave', 'grasp'], ['shrug', 'grasp']];
  pairs.forEach((ids, i) => { const t = X.templateOf(ids, '课' + i, 2000 + i); full.push(t); });
  const overflow = X.tplAdd(full, X.templateOf(['squat', 'plank'], '溢出'));
  console.log('[tpl-full] why =', overflow.why, '已有 =', overflow.list.length);
  if (overflow.why !== 'full') process.exit(1);

  /* tplRemove */
  const removed = X.tplRemove(full, full[3].id);
  if (removed.length !== full.length - 1 || removed.some(t => t.id === full[3].id)) { console.log('remove 异常'); process.exit(1); }
  console.log('[tpl-remove] 剩余 =', removed.length);

  /* tplSafe：脏数据过滤 */
  const dirty = [
    { id: 'ok1', name: 'Good', ids: ['squat', 'jack'] },
    null,
    { id: 'x', name: '', ids: ['squat', 'jack'] },          // 空 name
    { id: 'y', name: 'Y', ids: ['squat'] },                  // 只 1 个
    { id: 'z', name: 'Z', ids: ['nope', 'jack'] },          // 无效 id
    { id: 'w', name: 'W', ids: 'not array' },
  ];
  const safe = X.tplSafe(dirty);
  console.log('[tpl-safe] 合法保留 =', safe.length, safe.map(t => t.id));
  if (safe.length !== 1 || safe[0].id !== 'ok1') process.exit(1);

  /* tplEstimate */
  const est = X.tplEstimate(t1);   // squat + jack
  console.log('[tpl-est] segs =', est.segs, 'estMin =', est.estMin, 'names =', est.names.join(','));
  if (est.segs !== 2 || !(est.estMin > 0) || /NaN|undefined/.test(JSON.stringify(est))) process.exit(1);
  if (!est.names.includes('深蹲') || !est.names.includes('开合跳')) process.exit(1);
  /* 含 Pro 动作 */
  const estPro = X.tplEstimate({ ids: ['plank', 'squat'] });
  console.log('[tpl-est Pro] locked =', estPro.locked.join(','));
  if (!estPro.locked.includes('平板支撑')) process.exit(1);
  /* 全坐姿 */
  const estSeated = X.tplEstimate({ ids: ['headshake', 'wave', 'shrug'] });
  console.log('[tpl-est 坐姿] seatedOnly =', estSeated.seatedOnly);
  if (estSeated.seatedOnly !== true) process.exit(1);
  /* 非全坐姿 */
  const estMixed = X.tplEstimate({ ids: ['headshake', 'squat'] });
  if (estMixed.seatedOnly !== false) { console.log('squat 不是 seated'); process.exit(1); }

  console.log('[tpl] 全部断言通过');
}

/* --- v2.0 数据备份：exportPayload / sanitizeRecords / mergeRecords / parseImport --- */
{
  /* exportPayload：只导白名单字段 + set 补默认 */
  const db = {
    records: [{ ts: 1000, ex: 'squat', name: '深蹲', mode: 'reps', target: 10, valid: 8, attempts: 10, secs: 60, cal: 5.43, score: 80, issues: { sqShallow: 2 } }],
    posture: [], quota: { month: '2026-10', used: 3 }, set: { voice: false }, pro: true,
    templates: [{ id: 't1', name: '课', ids: ['squat', 'jack'] }], __runtime: 'should be dropped'
  };
  const p = X.exportPayload(db, 9999);
  console.log('[bk-export] keys =', Object.keys(p).sort().join(','));
  if (p.app !== 'dongjing' || p.ver !== 1 || p.exportedAt !== 9999) { console.log('导出头部错'); process.exit(1); }
  if ('__runtime' in p) { console.log('白名单外字段不应被导出'); process.exit(1); }
  if (p.set.sfx !== true || p.set.voice !== false || p.set.weight !== 60) { console.log('set 默认补齐错', JSON.stringify(p.set)); process.exit(1); }
  if (p.pro !== true || p.quota.used !== 3 || p.templates.length !== 1) process.exit(1);

  /* sanitizeRecords：脏项丢弃、类型纠正 */
  const dirtyRecs = [
    { ts: 1, ex: 'squat', mode: 'reps', valid: 5 },                       // 合法
    { ts: 'not-num', mode: 'reps', valid: 5 },                          // ts 非数 → 丢
    { ts: 2, mode: 'fly', valid: 1 },                                     // mode 非法 → 丢
    null, { }, 42,                                                        // 丢
    { ts: 3, ex: 'game-collect', mode: 'game', valid: 21, game: 'collect' }  // 合法且带 game
  ];
  const clean = X.sanitizeRecords(dirtyRecs);
  console.log('[bk-sanitize] 保留 =', clean.length, clean.map(r => r.ts));
  if (clean.length !== 2 || clean[0].ts !== 1 || clean[1].game !== 'collect') { console.log('记录清洗错'); process.exit(1); }
  if (typeof clean[0].score !== 'number' || clean[0].attempts !== 5) { console.log('缺省 attempts/score 纠正错'); process.exit(1); }

  /* mergeRecords：同 ts+ex 去重，不翻倍 */
  const merged = X.mergeRecords(
    [{ ts: 1, ex: 'squat', mode: 'reps', valid: 5 }, { ts: 2, ex: 'jack', mode: 'reps', valid: 6 }],
    [{ ts: 1, ex: 'squat', mode: 'reps', valid: 5 }, { ts: 3, ex: 'wave', mode: 'reps', valid: 7 }]);
  console.log('[bk-merge] 合并后 =', merged.length, merged.map(r => r.ts).join(','));
  if (merged.length !== 3 || merged.map(r => r.ts).join(',') !== '1,2,3') { console.log('合并去重错'); process.exit(1); }

  /* parseImport：json 错 / 非动镜 / 形状不对 / 正常 */
  if (X.parseImport('{bad json').ok || X.parseImport('{bad json').why !== 'json') { console.log('json 错分支'); process.exit(1); }
  if (X.parseImport(JSON.stringify({ app: 'other', records: [] })).why !== 'app') { console.log('app 错分支'); process.exit(1); }
  if (X.parseImport(JSON.stringify({ app: 'dongjing', records: 'nope' })).why !== 'shape') { console.log('shape 错分支'); process.exit(1); }
  const round = X.parseImport(JSON.stringify(p));
  console.log('[bk-roundtrip] ok =', round.ok, 'records =', round.payload.records.length, 'templates =', round.payload.templates.length);
  if (!round.ok || round.payload.records.length !== 1 || round.payload.pro !== true) process.exit(1);

  /* ts 必须保留完整精度（13 位毫秒时间戳 >2^31，|0 会截成负数，曾真实发生）*/
  const bigTs = 1700000000123;
  const tp = X.exportPayload({ records: [{ ts: bigTs, ex: 'squat', mode: 'reps', valid: 3 }] });
  console.log('[bk-ts] 导出 ts =', tp.records[0].ts, '期望 =', bigTs);
  if (tp.records[0].ts !== bigTs) { console.log('ts 被截断/溢出'); process.exit(1); }
  const tp2 = X.parseImport(JSON.stringify(tp));
  if (tp2.payload.records[0].ts !== bigTs) { console.log('round-trip 后 ts 变了'); process.exit(1); }

  console.log('[bk] 全部断言通过');
}

/* ================= v2.1 训练热力图 recPoints / buildHeatmap ================= */
{
  const D = 864e5;
  const fail = m => { console.log('[heat] FAIL:', m); process.exit(1); };

  /* --- recPoints 四路口径：计次直取 / 计时每 10s / 关卡÷3 / 非法→0 --- */
  if (X.recPoints({ mode: 'reps', valid: 12 }) !== 12) fail('reps 12');
  if (X.recPoints({ mode: 'time', valid: 45 }) !== 5) fail('time 45→5');
  if (X.recPoints({ mode: 'game', valid: 21 }) !== 7) fail('game 21→7');
  if (X.recPoints(null) !== 0) fail('null→0');
  if (X.recPoints({}) !== 0) fail('无 mode→0');
  console.log('[heat] recPoints 四路口径 OK');

  /* --- 空历史：结构完整、全 0 --- */
  const todayNoon = new Date(2026, 9, 14, 12).getTime();   // 周三（2026-10-12 为周一）
  const empty = X.buildHeatmap([], { today: todayNoon, weeks: 12 });
  if (empty.weeks.length !== 12) fail('空历史 weeks 数');
  if (!empty.weeks.every(c => c.days.length === 7)) fail('每周非 7 天');
  if (empty.total !== 0 || empty.active !== 0 || empty.streak !== 0) fail('空历史应有 total/active/streak=0');
  if (typeof empty.weeks[0].month !== 'number') fail('首列应标月份 number');
  console.log('[heat] 空历史结构 OK, weeks[0].month =', empty.weeks[0].month);

  /* --- 有记录分桶：无 goal 走绝对阈值 [5,10,15] 铺满 L1..L4 --- */
  const day0 = new Date(2026, 9, 14).getTime();            // 今天 00:00（周三）
  const mk = (off, mode, valid) => ({ ts: day0 - off * D, mode, valid });
  const recs = [mk(0, 'reps', 15), mk(1, 'reps', 10), mk(2, 'reps', 6), mk(20, 'time', 30)];
  const hm = X.buildHeatmap(recs, { today: todayNoon, weeks: 12 });
  if (hm.total !== 34) fail('total 期望 34 实际 ' + hm.total);
  if (hm.active !== 4) fail('active 期望 4 实际 ' + hm.active);
  if (hm.streak !== 3) fail('streak 期望 3（周三/二/一连续）实际 ' + hm.streak);
  /* 末列 = 本周（周一开头），周三 index=2，之后 Thu/Fri/Sat/Sun = 4 个 future 格 */
  const lastCol = hm.weeks[hm.weeks.length - 1];
  const nFuture = lastCol.days.filter(d => d.future).length;
  if (nFuture !== 4) fail('末列 future 天数期望 4 实际 ' + nFuture);
  /* 等级正确：15→L4, 10→L3, 6→L2, 3(时 30s)→L1 */
  const lv = ts => { for (const c of hm.weeks) for (const d of c.days) if (d.ts === ts) return d.level; return null; };
  if (lv(day0) !== 4) fail('今天 15 点应 L4, 实际 ' + lv(day0));
  if (lv(day0 - D) !== 3) fail('昨天 10 点应 L3, 实际 ' + lv(day0 - D));
  if (lv(day0 - 2 * D) !== 2) fail('前天 6 点应 L2, 实际 ' + lv(day0 - 2 * D));
  if (lv(day0 - 20 * D) !== 1) fail('20 天前 3 点应 L1, 实际 ' + lv(day0 - 20 * D));
  if (!hm.weeks.every(c => c.days.every(d => Number.isInteger(d.level) && d.level >= 0 && d.level <= 4))) fail('level 越界');
  const todayCell = lastCol.days.find(d => d.isToday);
  if (!todayCell || todayCell.ts !== day0) fail('isToday 应落在今天');
  console.log('[heat] 分桶/等级/未来格/连续 OK, total/streak =', hm.total, hm.streak);

  /* --- 有 goal：阈值随每日目标缩放，不得 NaN，等级仍 0..4 --- */
  const hmg = X.buildHeatmap(recs, { today: todayNoon, weeks: 12, dailyGoal: 30 });
  if (hmg.goal !== 30) fail('goal 未透传');
  if (!Number.isFinite(hmg.total) || hmg.total !== 34) fail('goal 模式 total 变了');
  if (!hmg.weeks.every(c => c.days.every(d => d.level >= 0 && d.level <= 4))) fail('goal 模式 level 越界');
  console.log('[heat] goal 缩放阈值 OK');

  console.log('[heat] 全部断言通过');
}

/* ================= v2.2 成就徽章 achStreaks / computeAchievements ================= */
{
  const D = 864e5;
  const fail = m => { console.log('[ach] FAIL:', m); process.exit(1); };
  const t0 = new Date(2026, 9, 14).getTime();               // 周三 00:00
  const nowNoon = t0 + 12 * 3600e3;
  const mk = (off, ex, mode, valid) => ({ ts: t0 - off * D, ex, mode, valid });

  /* --- 空数据：全未解锁、total=9 --- */
  const zero = X.computeAchievements({ records: [], posture: [] }, { now: nowNoon });
  if (zero.total !== 9) fail('徽章数期望 9 实际 ' + zero.total);
  if (zero.earned !== 0) fail('空数据不应有解锁');
  if (zero.list[0].id !== 'first' || zero.list[0].earned) fail('first 应未解锁');
  console.log('[ach] 空数据 OK, total =', zero.total);

  /* --- 混合数据：口径与 streak 自洽 --- */
  const recs = [mk(0, 'squat', 'reps', 12), mk(1, 'jack', 'reps', 8), mk(2, 'plank', 'time', 60),
    mk(3, 'game-collect', 'game', 18), mk(4, 'circuit', 'reps', 0)];
  const res = X.computeAchievements({ records: recs, posture: [{ ts: t0 }] }, { now: nowNoon });
  const g = id => res.list.find(b => b.id === id);
  if (!g('first').earned) fail('first 应解锁');
  if (g('collector').cur !== 3 || g('collector').earned) fail('不同动作 3 个 squat/jack/plank（game-/circuit 不算）');
  if (g('points').cur !== 32) fail('训练点期望 32(12+8+6+6+0) 实际 ' + g('points').cur);
  if (g('streak7').cur !== 5 || g('streak7').earned) fail('连续 5 天未达 7');
  if (g('streak7').longest !== 5) fail('longest 期望 5 实际 ' + g('streak7').longest);
  if (!g('circuit').earned || !g('gamer').earned || !g('posture').earned) fail('circuit/game/posture 应解锁');
  if (res.earned !== 4) fail('解锁数期望 4 实际 ' + res.earned);
  console.log('[ach] 混合数据 OK, earned =', res.earned, '/ streak cur/longest =', g('streak7').cur, g('streak7').longest);

  /* --- 探索家动态描述用真实动作数；pct 不超 1 --- */
  if (g('explorer').target !== X.EXERCISES.length) fail('explorer 目标应 = 动作库数');
  if (!/全部 \d+ 个动作/.test(g('explorer').desc)) fail('explorer desc 应含动态动作数: ' + g('explorer').desc);
  if (!res.list.every(b => b.pct >= 0 && b.pct <= 1 && b.cur <= b.target)) fail('pct/cur 越界');

  /* --- 全部 13 动作都练过 → explorer 解锁 --- */
  const allEx = X.EXERCISES.map((e, i) => mk(i, e.id, 'reps', 1));
  const full = X.computeAchievements({ records: allEx, posture: [] }, { now: nowNoon });
  if (!full.list.find(b => b.id === 'explorer').earned) fail('练过全部动作应解锁 explorer');
  console.log('[ach] explorer 全解锁 OK (target=' + X.EXERCISES.length + ')');

  console.log('[ach] 全部断言通过');
}

/* ================= v2.3 周环比小结 weekCompare ================= */
{
  const D = 864e5;
  const fail = m => { console.log('[wow] FAIL:', m); process.exit(1); };
  const today = new Date(2026, 9, 14, 12).getTime();      // 周三（2026-10-12 为周一）
  const t0 = new Date(2026, 9, 14).getTime();
  const mk = (o, mode, valid) => ({ ts: t0 - o * D, mode, valid });

  /* 空数据 */
  const e = X.weekCompare([], { today });
  if (e.cur.points !== 0 || e.prev.points !== 0 || e.dPct !== 0) fail('空数据应全 0');
  if (!/两周都还没练/.test(e.verdict)) fail('空数据 verdict 不对: ' + e.verdict);

  /* 本周有、上周无 → +100% 好开头 */
  const up = X.weekCompare([mk(0, 'reps', 20), mk(1, 'reps', 15)], { today });
  if (up.cur.points !== 35 || up.prev.points !== 0 || up.dPct !== 100) fail('UP 数据 ' + up.cur.points + '/' + up.prev.points + '/' + up.dPct);
  if (!/上周空缺/.test(up.verdict)) fail('UP verdict: ' + up.verdict);

  /* 本周少、上周多 → ≤ -15% 建议补 */
  const down = X.weekCompare([mk(0, 'reps', 5), mk(8, 'reps', 30), mk(9, 'reps', 20)], { today });
  if (down.cur.points !== 5 || down.prev.points !== 50 || down.dPct !== -90) fail('DOWN 数据 ' + down.cur.points + '/' + down.prev.points + '/' + down.dPct);
  if (!/比上周少 90%/.test(down.verdict)) fail('DOWN verdict: ' + down.verdict);

  /* 持平（±15% 内） */
  const flat = X.weekCompare([mk(0, 'reps', 20), mk(8, 'reps', 20)], { today });
  if (flat.dPct !== 0 || !/基本持平/.test(flat.verdict)) fail('FLAT: ' + flat.dPct + ' / ' + flat.verdict);

  /* 本周零、上周有 → 破零文案 */
  const noStart = X.weekCompare([mk(8, 'reps', 20), mk(9, 'reps', 10)], { today });
  if (noStart.cur.points !== 0 || noStart.prev.points !== 30 || !/这周还没开始/.test(noStart.verdict)) fail('CUREMPTY: ' + noStart.verdict);

  /* sessions/days 口径：关卡计入节数但不因 points>0 就算活跃天（valid/3），且同天不重复计天 */
  const same = X.weekCompare([mk(0, 'reps', 10), mk(0, 'reps', 8)], { today });   // 同一天两条
  if (same.cur.sessions !== 2) fail('同天应计 2 节实际 ' + same.cur.sessions);
  if (same.cur.days !== 1) fail('同天应只算 1 个活跃天实际 ' + same.cur.days);

  /* 上周之前的记录不计入 */
  const old = X.weekCompare([mk(15, 'reps', 50)], { today });                    // 15 天前→上上周
  if (old.cur.points !== 0 || old.prev.points !== 0) fail('超出两周窗口不应计入');

  console.log('[wow] 全部断言通过, up/down/flat/空/窗口 均 OK');
}

/* ================= v2.4 训练时段分布 daypartStats ================= */
{
  const fail = m => { console.log('[dp] FAIL:', m); process.exit(1); };
  if (X.DAYPARTS.length !== 4) fail('时段数应为 4');

  /* 空数据 */
  const e = X.daypartStats([]);
  if (e.total !== 0 || e.busiestKey !== null) fail('空数据应 total=0/busiestKey=null');

  /* 混合数据：按小时分桶 */
  const at = h => new Date(2026, 9, 14, h, 30).getTime();
  const recs = [
    { ts: at(6), mode: 'reps', valid: 20, score: 90 }, { ts: at(7), mode: 'reps', valid: 10, score: 80 },
    { ts: at(12), mode: 'time', valid: 100, score: 70 }, { ts: at(18), mode: 'reps', valid: 15, score: 60 },
    { ts: at(23), mode: 'game', valid: 30, score: 50 }, { ts: at(2), mode: 'reps', valid: 5, score: 40 }
  ];
  const r = X.daypartStats(recs);
  const by = k => r.parts.find(p => p.key === k);
  if (r.total !== 6) fail('total 期望 6 实际 ' + r.total);
  if (by('morn').sessions !== 2 || by('morn').points !== 30) fail('清晨 2 节 30 点: ' + by('morn').sessions + '/' + by('morn').points);
  if (by('morn').avgScore !== 85) fail('清晨均分期望 85 实际 ' + by('morn').avgScore);
  if (by('day').sessions !== 1 || by('day').points !== 10) fail('日间 1 节 time100s→10 点: ' + by('day').sessions + '/' + by('day').points);
  if (by('eve').sessions !== 1) fail('傍晚 1 节');
  if (by('night').sessions !== 2 || by('night').points !== 15) fail('夜间 game30→10 + reps5→5 = 2 节 15 点: ' + by('night').sessions + '/' + by('night').points);
  if (r.busiestKey !== 'morn') fail('清晨/夜间各 2 节平手→按点数取胜应为清晨, 实际 ' + r.busiestKey);
  console.log('[dp] 分桶/均分/平手按点数 busiest =', r.busiestName, '(' + r.busiestKey + ')');

  /* 纯按节数优先：某时段节数最多就当选，与点数无关 */
  const r2 = X.daypartStats([{ ts: at(18), mode: 'reps', valid: 1 }, { ts: at(19), mode: 'reps', valid: 1 }, { ts: at(6), mode: 'reps', valid: 50 }]);
  if (r2.busiestKey !== 'eve') fail('傍晚 2 节应多于清晨 1 节当选, 实际 ' + r2.busiestKey);

  /* 非法记录丢弃不崩 */
  const r3 = X.daypartStats([null, { ts: NaN }, { ts: at(9) }]);
  if (r3.total !== 1) fail('非法记录应丢弃, 实际 total=' + r3.total);

  console.log('[dp] 全部断言通过');
}

console.log('\n✅ 全部离线单测通过');
