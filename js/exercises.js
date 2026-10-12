/* 动镜 DongJing · 动作引擎（纯内联数据，file:// 可运行，无 fetch）
 * 输出 window.DJX：关键点索引、几何工具、问题字典、六个动作 tracker、体态评估。
 * 约定：tracker.feed(l, tMs, dt) 中 l 为像素坐标 33 点数组 [{x,y,v}]。
 * 返回 {phase, live:[issueKey], rep:null|{valid, issues:[], seconds?}}
 */
(function () {
  'use strict';

  /* ---------- MediaPipe Pose 33 关键点索引（只用得到的） ---------- */
  const LAND = {
    NOSE: 0, L_EAR: 7, R_EAR: 8,
    L_SHO: 11, R_SHO: 12, L_ELB: 13, R_ELB: 14, L_WRI: 15, R_WRI: 16,
    L_HIP: 23, R_HIP: 24, L_KNEE: 25, R_KNEE: 26, L_AN: 27, R_AN: 28
  };

  /* ---------- 几何工具 ---------- */
  function ang(a, b, c) { // 顶点在 b 的夹角（度）
    const x1 = a.x - b.x, y1 = a.y - b.y, x2 = c.x - b.x, y2 = c.y - b.y;
    const d1 = Math.hypot(x1, y1), d2 = Math.hypot(x2, y2);
    if (d1 < 1e-6 || d2 < 1e-6) return 180;
    let co = (x1 * x2 + y1 * y2) / (d1 * d2);
    co = Math.max(-1, Math.min(1, co));
    return Math.acos(co) * 180 / Math.PI;
  }
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const vis = (l, idx) => l[idx] && l[idx].v > 0.5;
  function visAll(l, idxs) { return idxs.every(i => vis(l, i)); }
  /* 左右侧择优：侧面机位常只拍到单侧 */
  function pickSide(l, li, ri) {
    const a = l[li], b = l[ri];
    if (!a || !b) return a || b;
    return (a.v >= b.v) ? a : b;
  }
  /* 躯干高（肩中点→髋中点），用作尺度归一 */
  function torsoH(l) {
    const s = mid(l[LAND.L_SHO], l[LAND.R_SHO]), h = mid(l[LAND.L_HIP], l[LAND.R_HIP]);
    return Math.max(40, s.y >= h.y ? 40 : h.y - s.y);
  }

  /* ---------- 问题字典（severe=该次不计） ---------- */
  const ISSUES = {
    sqShallow: { msg: '蹲得太浅，本次不计', severe: true },
    sqValgus:  { msg: '膝盖内扣，向外打开', severe: false },
    sqLean:    { msg: '身体过度前倾，挺胸直背', severe: false },
    puShallow: { msg: '下放不够，本次不计', severe: true },
    puSag:     { msg: '塌腰了，身体保持一条直线', severe: true },
    puPike:    { msg: '撅臀了，腰往下压', severe: true },
    jkArms:    { msg: '手臂要举过头顶', severe: true },
    jkLegs:    { msg: '双脚要分得更开', severe: true },
    lnShallow: { msg: '蹲得不够低，本次不计', severe: true },
    lnAsym:    { msg: '左右腿交替来', severe: false },
    hkLow:     { msg: '膝盖抬得再高些，过髋部', severe: false },
    hkAlt:     { msg: '左右交替抬腿，本次不计', severe: true },
    pkSlump:   { msg: '坚持住，腰别塌', severe: false },
    pkPike:    { msg: '屁股别撅太高', severe: false },
    wvUp:      { msg: '把手举过肩再挥', severe: false },
    hsSmall:   { msg: '摇头幅度再大一点', severe: false },
    sgLow:     { msg: '肩膀往耳朵方向耸得更高', severe: false },
    grFind:    { msg: '把手举进画面（胸前到头顶之间）', severe: false },
    grHalf:    { msg: '手指要完全张开', severe: false }
  };

  /* ================= trackers ================= */

  function squatTracker() {
    const L = LAND;
    let phase = 'up', minKnee = 180, cyc = [];
    return {
      feed(l) {
        const hl = l[L.L_HIP], hr = l[L.R_HIP];
        const kl = l[L.L_KNEE], kr = l[L.R_KNEE];
        const al = l[L.L_AN], ar = l[L.R_AN];
        const kneeL = ang(hl, kl, al), kneeR = ang(hr, kr, ar);
        const deep = Math.min(kneeL, kneeR);
        const live = [];
        if (phase === 'up') {
          if (deep < 115) { phase = 'down'; minKnee = deep; cyc = []; }
          return { phase: '站立准备', live, rep: null };
        }
        minKnee = Math.min(minKnee, deep);
        if (deep < 145) {
          /* 膝内扣：膝距明显小于踝距（需双侧踝可见） */
          if (vis(l, L.L_AN) && vis(l, L.R_AN)) {
            const kW = Math.abs(kl.x - kr.x), aW = Math.abs(al.x - ar.x);
            if (aW > 24 && kW < aW * 0.8) live.push('sqValgus');
          }
          /* 躯干侧偏/过度前倾（正面近似） */
          const s = mid(l[L.L_SHO], l[L.R_SHO]), h = mid(hl, hr);
          if (Math.abs(s.x - h.x) > 0.45 * torsoH(l)) live.push('sqLean');
        }
        let rep = null;
        if (deep > 150) { // 完全站起 → 结算
          const valid = minKnee <= 118;
          const issues = valid ? cyc.slice() : cyc.concat(['sqShallow']);
          rep = { valid, issues };
          phase = 'up';
        }
        return { phase: phase === 'down' ? '下蹲中…' : '起身', live: uniq(live), rep };
      }
    };
  }

  function pushupTracker() {
    const L = LAND;
    let phase = 'up', minElb = 180, cyc = [];
    return {
      feed(l) {
        const sh = pickSide(l, L.L_SHO, L.R_SHO), el = pickSide(l, L.L_ELB, L.R_ELB), wr = pickSide(l, L.L_WRI, L.R_WRI);
        const hip = mid(l[L.L_HIP], l[L.R_HIP]);
        const elb = ang(sh, el, wr);
        const live = [];
        const lineIssue = () => {
          if (!vis(l, L.L_AN) && !vis(l, L.R_AN)) return null;
          const an = mid(l[L.L_AN], l[L.R_AN]);
          const sMid = mid(l[L.L_SHO], l[L.R_SHO]);
          const dev = 180 - ang(sMid, hip, an);
          if (dev <= 18) return null;
          const lineY = (sMid.y + an.y) / 2;
          return hip.y > lineY ? 'puSag' : 'puPike';
        };
        if (phase === 'up') {
          if (elb < 95) { phase = 'down'; minElb = elb; cyc = []; }
          return { phase: '支撑准备', live, rep: null };
        }
        minElb = Math.min(minElb, elb);
        const li = lineIssue();
        if (li) { live.push(li); if (!cyc.includes(li)) cyc.push(li); }
        let rep = null;
        if (elb > 160) {
          const severe = cyc.length > 0 || minElb > 100;
          const issues = cyc.slice();
          if (minElb > 100 && !issues.includes('puShallow')) issues.push('puShallow');
          rep = { valid: !severe, issues };
          phase = 'up';
        }
        return { phase: phase === 'down' ? '下放…' : '撑起', live: uniq(live), rep };
      }
    };
  }

  function jackTracker() {
    const L = LAND;
    let flags = [], downStable = 0, upStable = 0, open = false;
    return {
      feed(l) {
        const sMid = mid(l[L.L_SHO], l[L.R_SHO]);
        const sw = Math.max(30, Math.abs(l[L.L_SHO].x - l[L.R_SHO].x));
        const nose = l[L.NOSE];
        const wristHi = Math.min(l[L.L_WRI].y, l[L.R_WRI].y);
        const armsOver = wristHi < nose.y - 0.08 * sw;
        const aSep = Math.abs(l[L.L_AN].x - l[L.R_AN].x);
        const legsOpen = aSep > sw * 1.35;
        const live = [];
        if (legsOpen && !armsOver) live.push('jkArms');
        if (armsOver && !legsOpen) live.push('jkLegs');
        if (armsOver && legsOpen) {
          upStable++; downStable = 0;
          if (!open && upStable >= 2) open = true;
        } else if (!armsOver && aSep < sw * 1.1 && wristHi > sMid.y) {
          downStable++; upStable = 0;
          if (open && downStable >= 3) { // 完成一次 合→开→合
            open = false;
            const issues = uniq(live.concat(flags));
            const rep = { valid: issues.length === 0, issues };
            flags = [];
            return { phase: '开合跳', live, rep };
          }
        } else { // 半开状态：只有一处到位
          if (!armsOver && legsOpen && !flags.includes('jkArms')) flags.push('jkArms');
          if (armsOver && !legsOpen && !flags.includes('jkLegs')) flags.push('jkLegs');
        }
        return { phase: open ? '并拢！' : '跳开，手举过头', live: uniq(live), rep: null };
      }
    };
  }

  function lungeTracker() {
    const L = LAND;
    let phase = 'up', minKnee = 180, side = '', streak = 0, lastSide = '';
    return {
      feed(l) {
        const kneeL = ang(l[L.L_HIP], l[L.L_KNEE], l[L.L_AN]);
        const kneeR = ang(l[L.R_HIP], l[L.R_KNEE], l[L.R_AN]);
        const deep = Math.min(kneeL, kneeR);
        const live = [];
        if (phase === 'up') {
          if (deep < 130) { phase = 'down'; minKnee = deep; }
          return { phase: '站立，下一步迈出', live, rep: null };
        }
        minKnee = Math.min(minKnee, deep);
        let rep = null;
        if (kneeL > 150 && kneeR > 150) {
          side = kneeL <= kneeR ? 'L' : 'R';
          streak = (side === lastSide) ? streak + 1 : 1;
          lastSide = side;
          const issues = [];
          if (minKnee > 120) issues.push('lnShallow');
          if (streak >= 2) issues.push('lnAsym');
          rep = { valid: minKnee <= 120, issues };
          phase = 'up';
        }
        return { phase: phase === 'down' ? '下沉…' : '起身', live: uniq(live), rep };
      }
    };
  }

  function highkneesTracker() {
    const L = LAND;
    let armed = { L: true, R: true }, lastSide = '', idleT = 0;
    return {
      feed(l, t, dt) {
        const hipY = mid(l[L.L_HIP], l[L.R_HIP]).y;
        const th = 0.06 * torsoH(l);
        const live = [];
        let rep = null;
        for (const [key, knee] of [['L', l[L.L_KNEE]], ['R', l[L.R_KNEE]]]) {
          if (!vis(l, key === 'L' ? L.L_KNEE : L.R_KNEE)) continue;
          if (knee.y > hipY + 0.04 * torsoH(l)) { armed[key] = true; continue; }
          if (armed[key] && knee.y < hipY - th) {
            armed[key] = false;
            if (key === lastSide) rep = { valid: false, issues: ['hkAlt'] };
            else { rep = { valid: true, issues: [] }; idleT = 0; }
            lastSide = key;
          }
        }
        idleT += dt || 0;
        if (!rep && idleT > 3000) { live.push('hkLow'); if (idleT > 5000) idleT = 0; }
        return { phase: '原地高抬腿！', live, rep };
      }
    };
  }

  function plankTracker() {
    const L = LAND;
    return {
      feed(l, t, dt) {
        const sh = pickSide(l, L.L_SHO, L.R_SHO), el = pickSide(l, L.L_ELB, L.R_ELB), wr = pickSide(l, L.L_WRI, L.R_WRI);
        const hip = mid(l[L.L_HIP], l[L.R_HIP]);
        const elb = ang(sh, el, wr);
        const supporting = elb > 55 && elb < 179;
        const live = [];
        let lineOK = supporting;
        if (vis(l, L.L_AN) || vis(l, L.R_AN)) {
          const an = mid(l[L.L_AN], l[L.R_AN]);
          const sMid = mid(l[L.L_SHO], l[L.R_SHO]);
          const dev = 180 - ang(sMid, hip, an);
          if (dev > 18) {
            lineOK = false;
            live.push(hip.y > (sMid.y + an.y) / 2 ? 'pkSlump' : 'pkPike');
          }
        }
        const sec = dt ? dt / 1000 : 0;
        return { phase: supporting ? '平板保持中' : '俯身撑好准备',
          live, rep: supporting ? { valid: lineOK, seconds: sec, issues: lineOK ? [] : live.slice() } : null };
      }
    };
  }

  /* 通用：水平摆动方向翻转计数（摇头/挥手共用）
   * getX(): 当前 x；sw(): 参考幅度尺度（肩宽 px）；ampK: 触发一次翻转所需行程/尺度 */
  function swingCounter(getX, sw, ampK, noiseK) {
    let trend = 0, run = 0, last = null, peakAbs = 0;
    return function () {
      const x = getX();
      if (x == null) { trend = 0; run = 0; last = null; return null; }
      const s = Math.max(20, sw());
      const noise = noiseK * s, amp = ampK * s;
      peakAbs = Math.max(peakAbs, Math.abs(x));
      let rep = null;
      if (last != null) {
        const d = x - last;
        if (Math.abs(d) > noise) {
          const sgn = d > 0 ? 1 : -1;
          if (trend === 0 || trend === sgn) { trend = sgn; run += Math.abs(d); }
          else {                      // 方向翻转：行程够一个 amp 算一次
            if (run >= amp) { rep = { valid: true, issues: [] }; peakAbs = Math.abs(x); }
            trend = sgn; run = Math.abs(d);
          }
          last = x;
        } else last = x;
      } else last = x;
      return { rep, peakAbs: peakAbs, s };
    };
  }

  function headshakeTracker() {
    const L = LAND;
    let offX = null, sw = 30;   // 逐帧更新的可变持有量，避免闭包捕获旧帧 landmarks
    const counter = swingCounter(() => offX, () => sw, 0.30, 0.045);
    return {
      feed(l) {
        const sMid = mid(l[L.L_SHO], l[L.R_SHO]);
        sw = Math.max(30, Math.abs(l[L.L_SHO].x - l[L.R_SHO].x));
        offX = l[L.NOSE].x - sMid.x;
        const r = counter();
        if (!r) return { phase: '目视前方，放松', live: [], rep: null };
        const live = r.peakAbs < 0.14 * r.s ? ['hsSmall'] : [];
        return { phase: '左右缓慢摇头', live, rep: r.rep };
      }
    };
  }

  function waveTracker() {
    const L = LAND;
    let wx = null, sw = 30;
    const counter = swingCounter(() => wx, () => sw, 0.5, 0.07);
    return {
      feed(l) {
        const sL = l[L.L_SHO], sR = l[L.R_SHO];
        const sMid = mid(sL, sR);
        sw = Math.max(30, Math.abs(sL.x - sR.x));
        const th = sMid.y - 0.18 * torsoH(l);   // 举过肩线
        const wL = l[L.L_WRI], wR = l[L.R_WRI];
        if (wL.y < th && wR.y < th) wx = (wL.y <= wR.y ? wL.x : wR.x);
        else if (wL.y < th) wx = wL.x;
        else if (wR.y < th) wx = wR.x;
        else wx = null;
        if (wx == null) { counter(); return { phase: '举起一只手，左右挥动', live: ['wvUp'], rep: null }; }
        const r = counter();
        return { phase: '挥手！左右摆满', live: [], rep: r && r.rep };
      }
    };
  }

  /* 手掌抓握：需要 HandLandmarker 的 21 点（由 app 层传入 hands） */
  const HAND_CONNS = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  function graspTracker() {
    const hist = {};  // label -> {open, fist}
    const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return {
      feed(l, t, dt, hands) {
        if (!hands || !hands.length) return { phase: '举起双手，先张开五指', live: ['grFind'], rep: null };
        let rep = null; const live = [];
        hands.forEach(h => {
          const p = h.lm, w = p[0];
          const palm = Math.max(12, dist(p[5], p[17]));
          const meanT = (dist(p[8], w) + dist(p[12], w) + dist(p[16], w) + dist(p[20], w)) / 4 / palm;
          const s = hist[h.label] || (hist[h.label] = { open: false, fist: false });
          if (meanT > 1.7) s.open = true;                       // 完全张开
          else if (meanT < 1.15) { if (s.open) s.fist = true; } // 握拳
          if (s.open && s.fist && meanT > 1.7) {                // 张→握→张 = 1 次
            rep = { valid: true, issues: [] };
            s.open = false; s.fist = false;
          }
          s.t = (s.t || 0) + dt;                                // 手离景过久重置周期
          if (s.t > 1200 && !s.open && !s.fist) s.t = 0;
        });
        if (rep === null && hands.length === 1) live.push('grFind');
        return { phase: '张开 → 握拳 → 张开', live, rep };
      }
    };
  }

  /* 耸肩放松：肩中心相对头部上提 → 回落 = 1 次；基准线慢速追踪，自适应机位高度 */
  function shrugTracker() {
    const L = LAND;
    let base = null, up = false, maxLift = 0, goodAt = 0;
    return {
      feed(l, t, dt) {
        const sMid = mid(l[L.L_SHO], l[L.R_SHO]);
        const hMid = mid(l[L.L_EAR], l[L.R_EAR]);
        const sw = Math.max(30, Math.abs(l[L.L_SHO].x - l[L.R_SHO].x));
        const d = sMid.y - hMid.y;                    // 肩到头的距离：耸肩时变小
        base = (base == null) ? d : Math.max(d, base - sw * 0.00002 * dt);   // 松弛位最高点缓慢追踪（随坐姿/机位漂移）
        const lift = base - d;
        maxLift = Math.max(maxLift, lift / sw);
        const live = [];
        if (t - goodAt > 6000 && maxLift < 0.08) live.push('sgLow');   // 6s 内幅度一直接不足 → 提示
        let rep = null;
        if (!up && lift > 0.12 * sw) { up = true; }
        else if (up && lift < 0.04 * sw) {          // 耸起后完全放松回落才算一次
          up = false; goodAt = t; maxLift = 0;
          rep = { valid: true, issues: [] };
        }
        return { phase: up ? '保持一下…放松回落' : '耸肩 → 放松', live, rep };
      }
    };
  }

  function uniq(arr) { return [...new Set(arr)]; }

  /* ================= 动作元数据 ================= */
  const EXERCISES = [
    {
      id: 'squat', name: '深蹲', ico: '🏋️', view: 'front', free: true, diff: 2,
      mode: 'reps', target: 12, sets: 3, met: 5.0,
      desc: '下肢力量之王，燃脂提代谢',
      setup: '摄像头放在正前方约 2 米处，头顶到脚踝都要在画面里。',
      tips: ['双脚与肩同宽，脚尖微朝外', '下蹲到髋低于膝（大腿平行地面）', '膝盖对准脚尖方向，不要内扣', '挺胸直背，起身发力脚跟'],
      keys: [11, 12, 23, 24, 25, 26],
      start: l => Math.min(ang(l[23], l[25], l[27]), ang(l[24], l[26], l[28])) > 150
    },
    {
      id: 'jack', name: '开合跳', ico: '⭐', view: 'front', free: true, diff: 1,
      mode: 'reps', target: 30, sets: 3, met: 8.0,
      desc: '30 秒心率拉满，办公室回血首选',
      setup: '摄像头正前方 2-3 米，留出全身+头顶空间。',
      tips: ['跳开时双臂经体侧举过头顶', '并拢时双手回到体侧', '落地屈膝缓冲，前脚掌着地', '保持节奏均匀呼吸'],
      keys: [0, 11, 12, 15, 16, 25, 26, 27, 28],
      start: l => Math.abs(l[27].x - l[28].x) < Math.abs(l[11].x - l[12].x) * 1.2
    },
    {
      id: 'highknees', name: '高抬腿', ico: '🏃', view: 'front', free: true, diff: 1,
      mode: 'reps', target: 40, sets: 3, met: 8.0,
      desc: '左右交替抬膝过髋，有氧+核心',
      setup: '摄像头正前方约 2 米，画面包含全身。',
      tips: ['膝盖抬高超过髋部水平线', '左右腿交替进行', '摆臂配合，核心收紧', '前脚掌着地，节奏轻快'],
      keys: [11, 12, 23, 24, 25, 26],
      start: l => l[25].y > l[23].y + 20 && l[26].y > l[24].y + 20
    },
    {
      id: 'headshake', name: '摇头放松', ico: '🔄', view: 'front', seated: true, free: true, diff: 1,
      mode: 'reps', target: 20, sets: 2, met: 2.0,
      desc: '颈椎侧向活动度，久坐办公族刚需',
      setup: '坐着即可，只需上半身入镜：摄像头正对脸部到肩部，头顶留白。',
      tips: ['缓慢左右摇头，幅度尽量大', '眼随头部自然平视转动', '肩部放松不要耸肩', '幅度不够不计入次数'],
      keys: [0, 11, 12],
      start: () => true
    },
    {
      id: 'wave', name: '挥臂激活', ico: '🙋', view: 'front', seated: true, free: true, diff: 1,
      mode: 'reps', target: 30, sets: 2, met: 2.5,
      desc: '举过肩左右挥，肩部血流回春',
      setup: '坐着即可，上半身+双手都要在画面内，举起来不超出顶部。',
      tips: ['手举过肩线以上再挥', '左右摆动幅度要大（超过一个肩宽）', '左右手都可，鼓励交替', '手放下不计次，重新举起'],
      keys: [0, 11, 12, 15, 16],
      start: l => l[15].y > l[11].y && l[16].y > l[12].y
    },
    {
      id: 'shrug', name: '耸肩放松', ico: '🤸', view: 'front', seated: true, free: true, diff: 1,
      mode: 'reps', target: 15, sets: 2, met: 1.8,
      desc: '斜方肌解压，一分钟肩颈回春',
      setup: '坐着即可，头部到肩膀完整入镜，光线照在脸上。',
      tips: ['双肩缓缓往耳朵方向耸起', '顶部停一拍再完全放松落下', '落下时肩膀落到最低点', '呼吸自然，不要憋气'],
      keys: [0, 11, 12],
      start: () => true
    },
    {
      id: 'grasp', name: '手掌抓握', ico: '✊', view: 'front', seated: true, free: false, diff: 1,
      mode: 'reps', target: 30, sets: 2, met: 1.5, hands: true,
      desc: '手指级精细检测，腕管/腱鞘救星',
      setup: '坐着，双手举到胸前至头顶之间，五指张开让摄像头看清。',
      tips: ['完全张开五指 → 用力握拳 → 再张开', '双手同时进行，各算各的', '指尖没张开到位不算一次', '需要额外下载手部模型（约 8MB）'],
      keys: [11, 12],
      start: (l, hands) => !!hands && hands.length > 0
    },
    {
      id: 'pushup', name: '俯卧撑', ico: '💪', view: 'side', free: false, diff: 3,
      mode: 'reps', target: 10, sets: 3, met: 6.0,
      desc: '上肢推力核心，标准比数量重要',
      setup: '请把摄像头放在身体侧面（垫子旁 2 米），拍到肩、髋、脚一条线。',
      tips: ['肩-髋-踝保持一条直线', '下放至肘角小于 90°', '撑起时手臂接近伸直', '塌腰或撅臀都不计入次数'],
      keys: [11, 12, 13, 14, 23, 24],
      start: l => {
        const elb = ang(pickSide(l, 13, 14), pickSide(l, 11, 12), pickSide(l, 15, 16));
        return elb > 140;
      }
    },
    {
      id: 'lunge', name: '弓步蹲', ico: '🦵', view: 'front', free: false, diff: 2,
      mode: 'reps', target: 16, sets: 3, met: 5.5,
      desc: '单侧下肢稳定，左右交替塑形',
      setup: '摄像头正前方约 2 米，全身入镜。',
      tips: ['大步迈出，前膝弯曲约 90°', '后膝下沉接近地面', '躯干保持竖直', '左右腿交替，各计 1 次'],
      keys: [11, 12, 23, 24, 25, 26],
      start: l => Math.min(ang(l[23], l[25], l[27]), ang(l[24], l[26], l[28])) > 150
    },
    {
      id: 'plank', name: '平板支撑', ico: '🧘', view: 'side', free: false, diff: 2,
      mode: 'time', target: 30, sets: 3, met: 3.5,
      desc: '核心稳定，姿势歪了计时会暂停',
      setup: '请把摄像头放在身体侧面，能拍到头顶到脚踝。',
      tips: ['肘在肩正下方，或直臂支撑', '肩-髋-踝一条直线', '塌腰/撅臀时计时暂停', '均匀呼吸不憋气'],
      keys: [11, 12, 13, 14, 23, 24],
      start: l => {
        const elb = ang(pickSide(l, 13, 14), pickSide(l, 11, 12), pickSide(l, 15, 16));
        return elb > 55;
      }
    }
  ];

  /* ================= 体态评估（正面近似，v1） ================= */
  function analyzePosture(samples) {
    if (!samples || !samples.length) return null;
    const avg = i => {
      let x = 0, y = 0, v = 0, n = 0;
      samples.forEach(s => { const p = s[i]; if (p && p.v > 0.4) { x += p.x; y += p.y; v += p.v; n++; } });
      return n ? { x: x / n, y: y / n, v: v / n } : null;
    };
    const nose = avg(0), earL = avg(7), earR = avg(8), sL = avg(11), sR = avg(12),
          hL = avg(23), hR = avg(24), aL = avg(27), aR = avg(28), knL = avg(25), knR = avg(26);
    if (!sL || !sR || !hL || !hR) return null;
    const top = nose || mid(earL || sL, earR || sR);
    const anMid = (aL && aR) ? mid(aL, aR) : null;
    const bodyH = anMid ? Math.max(60, anMid.y - top.y) : Math.max(60, hR.y - top.y);
    const sMid = mid(sL, sR), hMid = mid(hL, hR);
    const eMid = (earL && earR) ? mid(earL, earR) : nose;

    const mk = (name, px, goodT, mildT, goodTxt, mildTxt, badTxt, adviceGood, adviceMild, adviceBad) => {
      const pct = Math.abs(px) / bodyH * 100;
      let level, cls, advice;
      if (pct <= goodT) { level = '良好'; cls = 'a'; advice = adviceGood; }
      else if (pct <= mildT) { level = '轻度偏差'; cls = 'b'; advice = adviceMild; }
      else { level = '明显偏差'; cls = 'c'; advice = adviceBad; }
      return { name, pct: +pct.toFixed(1), level, cls, advice };
    };
    const items = [
      mk('头颈侧移 / 头前倾代偿', eMid ? (eMid.x - sMid.x) : 0, 1.2, 2.6,
        '头颈位置正', '注意用眼疲劳与单肩背包，做颈部侧向拉伸', '建议靠墙站立训练（后脑贴墙收下巴）+ 胸锁乳突肌放松',
        '保持现状，多做颈侧拉伸', '每工作 1 小时做 30 秒收下巴训练', '每天贴墙站立 5 分钟，严重建议就医排查'),
      mk('高低肩', Math.abs(sL.y - sR.y), 0.8, 1.8,
        '双肩均衡', '轻微不等高，放松上斜方肌（提肩拉伸）', '高低肩明显，避免单侧负重，加强中下斜方肌（YTW 伸展）',
        '保持匀称发力', '每天做耸肩-放松 10 次×2 组', '训练时避免单侧背包，建议面诊评估脊柱'),
      mk('骨盆侧倾 / 髋不稳', Math.abs(hL.y - hR.y), 0.9, 2.0,
        '骨盆水平', '轻微侧倾，注意站立别总压一条腿', '骨盆侧倾明显，做髂腰肌与臀中肌放松强化',
        '保持中立站位', '有意识双腿均分体重', '每天侧卧抬腿强化臀中肌，持续疼痛请就医'),
      mk('躯干侧偏', Math.abs(hMid.x - sMid.x), 1.5, 3.2,
        '躯干竖直', '躯干略侧偏，收紧核心再站立', '躯干侧偏明显，检查脊柱侧弯风险（Adam 前屈测试）',
        '体态对称性好', '平板支撑加强核心抗侧屈', '建议专业评估脊柱，避免大重量单侧训练')
    ];
    let score = 100;
    items.forEach(it => { if (it.cls === 'b') score -= 9; else if (it.cls === 'c') score -= 20; });
    score = Math.max(40, Math.round(score));
    return { score, items, note: 'v1 为正面单视角近似评估，侧面位增强版（骨盆前倾/圆肩精确量化）在 P1 提供。' };
  }

  /* ================= 一句话编排（AI 计划）=================
   * 纯函数：自然语言 → 循环跟练动作序列。不依赖任何 DOM，便于 Node 单测。
   * 思路：关键词命中场景/部位标签 → 标签对应动作候选池 → 按时长决定动作个数。 */
  const PLAN_TAG = [
    { re: /(办公室|久坐|久站|上班|工位|中午|午休|出差|酒店|空间小|没地方|椅子|坐着)/, pool: ['headshake', 'wave', 'shrug'], why: '场地有限：以坐姿上肢动作为主', seat: true },
    { re: /(肩颈|脖子|颈椎|肩膀|酸痛|僵硬|放松|舒缓|拉伸)/, pool: ['shrug', 'headshake', 'wave'], why: '肩颈发紧：耸肩 + 摇头放松优先' },
    { re: /(腿|臀|下肢|膝|深蹲|弓步|跑)/, pool: ['squat', 'lunge', 'highknees'], why: '下肢塑形：深蹲与弓步蹲' },
    { re: /(减脂|燃脂|汗|心肺|体能|体力|烈|累|瘦)/, pool: ['jack', 'highknees', 'squat'], why: '拉心率燃脂：开合跳 + 高抬腿' },
    { re: /(腹|核心|腰|平板|支撑|背)/, pool: ['plank', 'pushup', 'squat'], why: '核心稳定：平板支撑' },
    { re: /(胸|臂|上肢|手|撑|俯卧撑)/, pool: ['pushup', 'wave', 'shrug'], why: '上肢力量：俯卧撑与挥臂' },
    { re: /(睡前|晚上|晚间|睡不着|安神)/, pool: ['headshake', 'shrug', 'wave'], why: '睡前低强度：只做活动度不做冲击', easy: true }
  ];
  const PLAN_BALANCE = ['squat', 'jack', 'headshake', 'plank'];   // 没命中关键词时的均衡套餐
  function planFromText(text, opts) {
    const o = opts || {};
    const s = String(text || '').toLowerCase();
    const allowPro = !!o.pro;
    const ok = id => {
      const e = EXERCISES.find(x => x.id === id);
      return !!e && (allowPro || e.free);
    };
    /* 时长：支持“5分钟 / 8 min / 半小”等，默认 8 分钟，限定 3–30 */
    let min = o.minutes || 8;
    const hm = s.match(/(\d+)\s*(分钟|分|min)/);
    const hh = s.match(/(\d+)\s*(小时|h\b)/);
    if (hh) min = (+hh[1]) * 60;
    else if (hm) min = +hm[1];
    else if (/半小/.test(s)) min = 30;
    min = Math.min(30, Math.max(3, min));

    const hits = PLAN_TAG.filter(t => t.re.test(s));
    let why = hits.map(t => t.why);
    if (!why.length) why = ['没识别到具体目标：给你一套均衡全身的标准套餐'];

    /* 逐标签收集候选（先收集意向，再区分可用/被 Pro 拦住）；无命中用均衡套餐 */
    const wanted = [];
    let pool = [];
    (hits.length ? hits : [{ pool: PLAN_BALANCE }]).forEach(t => t.pool.forEach(id => { if (!wanted.includes(id)) wanted.push(id); }));
    wanted.forEach(id => { if (ok(id)) pool.push(id); });
    const locked = wanted.filter(id => !ok(id)).map(id => EXERCISES.find(x => x.id === id).name);   // 命中但需 Pro
    if (pool.length < 2) pool = PLAN_BALANCE.filter(ok);

    /* 坐姿场景（命中 seat 标签且池内坐姿动作够 2 个）则全坐姿，不安排跳跃类动作 */
    const seated = id => !!(EXERCISES.find(x => x.id === id) || {}).seated;
    const seatOnly = hits.some(t => t.seat) && pool.filter(seated).length >= 2;
    if (seatOnly) {
      const keep = pool.filter(seated);
      PLAN_TAG[0].pool.forEach(id => { if (ok(id) && !keep.includes(id)) keep.push(id); });
      pool = keep;
    }

    /* 一轮里放几个动作：按时长算（每动作一轮 ≈ 40–100s），睡前低强度不拉长 */
    const easy = hits.some(t => t.easy);
    let n = Math.round(min / 1.5);
    n = Math.min(6, Math.max(3, Math.min(n, pool.length)));
    if (easy) n = Math.min(n, 4);
    const base = pool.slice(0, n);
    const legSec = id => {
      const e = EXERCISES.find(x => x.id === id);
      return e.mode === 'time' ? e.target + 5 : Math.min(120, Math.round(e.target * 2.4 + 8));
    };
    const roundSec = base.reduce((a, id) => a + legSec(id) + 10, 0);
    /* 时长不够填满就整轮重复：按需求时长算轮数，最多 3 轮且总段数不超 8 */
    let rounds = Math.floor(min * 60 / roundSec);
    rounds = Math.max(1, Math.min(3, rounds));
    rounds = Math.min(rounds, Math.max(1, Math.floor(8 / base.length)));
    const ids = [];
    for (let r = 0; r < rounds; r++) base.forEach(id => ids.push(id));
    return {
      ids, rounds, minutes: min, estMin: +(roundSec * rounds / 60).toFixed(1),
      names: ids.map(id => EXERCISES.find(x => x.id === id).name),
      seatedOnly: seatOnly, easy, why, locked
    };
  }

  window.DJX = {
    LAND, ang, mid, vis, visAll, pickSide, torsoH, uniq, HAND_CONNS,
    ISSUES, EXERCISES, analyzePosture, planFromText,
    makeTracker(id) {
      return { squat: squatTracker, jack: jackTracker, highknees: highkneesTracker,
               pushup: pushupTracker, lunge: lungeTracker, plank: plankTracker,
               headshake: headshakeTracker, wave: waveTracker, grasp: graspTracker,
               shrug: shrugTracker }[id]();
    }
  };
})();
