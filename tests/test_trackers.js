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

/* --- 元数据完整性：9 动作、keys/start 均存在，新动作 seated --- */
{
  const ids = X.EXERCISES.map(e => e.id);
  console.log('[元数据] 动作数 =', ids.length, ids.join(','));
  if (ids.length !== 9) process.exit(1);
  ['headshake', 'wave', 'grasp'].forEach(id => {
    const e = X.EXERCISES.find(x => x.id === id);
    if (!e.seated || typeof e.start !== 'function' || !e.keys.length) { console.log('元数据缺项', id); process.exit(1); }
  });
  const hs = X.EXERCISES.find(x => x.id === 'headshake');
  const l = mkL();
  if (!hs.start(l)) { console.log('headshake start 应为 true'); process.exit(1); }
  if (!X.HAND_CONNS || X.HAND_CONNS.length < 20) { console.log('HAND_CONNS 缺失'); process.exit(1); }
}

console.log('\n✅ 全部离线单测通过');
