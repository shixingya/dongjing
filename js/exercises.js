/* 动镜 DongJing · 动作引擎（纯内联数据，file:// 可运行，无 fetch）
 * 输出 window.DJX：关键点索引、几何工具、问题字典、十三个动作 tracker、26 条纠错规则、体态评估（正面/侧面/合并）。
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
    grHalf:    { msg: '手指要完全张开', severe: false },
    srUp:      { msg: '把手举到与肩同高', severe: false },
    srBent:    { msg: '手肘弯太多，手臂尽量伸直，本次不计', severe: true },
    ssTry:     { msg: '双手贴裤缝，往侧面慢慢弯下去', severe: false },
    ssSmall:   { msg: '侧弯幅度不够（至少 15°），本次不计', severe: true },
    ssHold:    { msg: '侧弯后要停 1 秒再回正，本次不计', severe: true },
    wsUp:      { msg: '再蹲低一点，大腿接近平放', severe: false },
    wsLean:    { msg: '背往墙上靠，胸别往前塌', severe: false }
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
    const pend = [];  // 两只手常在同一帧完成一个周期，而一次只能上报一个 rep：排队而不是丢计数
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
            pend.push({ valid: true, issues: [] });
            s.open = false; s.fist = false;
          }
          s.t = (s.t || 0) + dt;                                // 手离景过久重置周期
          if (s.t > 1200 && !s.open && !s.fist) s.t = 0;
        });
        rep = pend.length ? pend.shift() : null;
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

  /* 侧平举（v1.8）：每只手各自「垂体侧 → 抬到肩高 → 回落」= 1 次；抬的过程中肘关节弯太厉害则不计。
   * 尺度用肩宽不用躯干高，因为这是个坐姿也能练的动作（髋可能根本不入镜）。 */
  function sidRaiseTracker() {
    const L = LAND;
    const SIDE = [['L', L.L_SHO, L.L_ELB, L.L_WRI], ['R', L.R_SHO, L.R_ELB, L.R_WRI]];
    const st = { L: 'down', R: 'down' }, minElb = { L: 180, R: 180 };
    const pend = [];      // 双臂同时上下是侧平举的常规做法：同一帧出的两个 rep 排队上报，不丢数
    let hintAt = 0;
    return {
      feed(l, t) {
        const sw = Math.max(30, Math.abs(l[L.L_SHO].x - l[L.R_SHO].x));
        const live = [];
        for (const [k, si, ei, wi] of SIDE) {
          if (!vis(l, si) || !vis(l, wi)) { st[k] = 'down'; continue; }
          const sh = l[si], wr = l[wi], el = vis(l, ei) ? l[ei] : null;
          const raised = wr.y <= sh.y + 0.25 * sw;        // 手到肩线（允许略低）
          const down = wr.y >= sh.y + 1.15 * sw;          // 自然垂回体侧
          if (st[k] === 'down') {
            if (raised) { st[k] = 'up'; minElb[k] = el ? ang(sh, el, wr) : 180; }
          } else {
            if (el) minElb[k] = Math.min(minElb[k], ang(sh, el, wr));
            if (down) {
              st[k] = 'down';
              const straight = minElb[k] >= 135;           // 上举全程手臂基本伸直
              pend.push({ valid: straight, issues: straight ? [] : ['srBent'] });
            }
          }
        }
        if (t - hintAt > 6000 && st.L === 'down' && st.R === 'down') { live.push('srUp'); hintAt = t; }
        return { phase: (st.L === 'up' || st.R === 'up') ? '举到肩高，慢点放下来' : '双臂垂在体侧，拿两瓶水',
          live, rep: pend.length ? pend.shift() : null };
      }
    };
  }

  /* 体侧伸展（v1.8）：肩髋连线偏离竖直 ≥ 14° 并停住 ≥ 0.6s → 回正 = 1 次。
   * 只算幅度不算时间的话，用户会“刷”两下就计一次，对这个拉伸动作没意义。 */
  function sideStretchTracker() {
    const L = LAND;
    let side = '', maxAng = 0, holdMs = 0, hintAt = 0;
    return {
      feed(l, t, dt) {
        const ok = vis(l, L.L_SHO) && vis(l, L.R_SHO) && vis(l, L.L_HIP) && vis(l, L.R_HIP);
        const sMid = mid(l[L.L_SHO], l[L.R_SHO]), hMid = mid(l[L.L_HIP], l[L.R_HIP]);
        const lean = ok ? Math.atan2(sMid.x - hMid.x, Math.max(1, hMid.y - sMid.y)) * 180 / Math.PI : 0;
        const live = [];
        let rep = null;
        if (!side) {
          if (ok && Math.abs(lean) >= 14) { side = lean > 0 ? 'R' : 'L'; maxAng = Math.abs(lean); holdMs = 0; }
          else if (t - hintAt > 6000) { live.push('ssTry'); hintAt = t; }   // 一直直挺挺地站着 → 提醒
        } else {
          maxAng = Math.max(maxAng, Math.abs(lean));
          if (Math.abs(lean) >= 12) holdMs += (dt || 0);
          if (Math.abs(lean) < 6) {                       // 回正 → 结算
            const ampOK = maxAng >= 14, pass = ampOK && holdMs >= 600;
            rep = { valid: pass, issues: pass ? [] : (ampOK ? ['ssHold'] : ['ssSmall']) };
            side = ''; maxAng = 0; holdMs = 0;
          }
        }
        return { phase: side ? (side === 'R' ? '向右侧弯，停一秒…' : '向左侧弯，停一秒…') : '站直，双手贴裤缝', live: uniq(live), rep };
      }
    };
  }

  /* 靠墙静蹲（v1.8）：膝角 80–118° 且躯干不后仰时累计计时，其他情况暂停（同平板支撑的 time 口径） */
  function wallSitTracker() {
    const L = LAND;
    return {
      feed(l, t, dt) {
        const hl = l[L.L_HIP], hr = l[L.R_HIP], sMid = mid(l[L.L_SHO], l[L.R_SHO]);
        const kneeL = ang(hl, l[L.L_KNEE], l[L.L_AN]), kneeR = ang(hr, l[L.R_KNEE], l[L.R_AN]);
        const legsOn = (vis(l, L.L_AN) ? 1 : 0) + (vis(l, L.R_AN) ? 1 : 0) + (vis(l, L.L_KNEE) ? 1 : 0) + (vis(l, L.R_KNEE) ? 1 : 0);
        const deep = Math.min(vis(l, L.L_AN) ? kneeL : 180, vis(l, L.R_AN) ? kneeR : 180);
        const holding = legsOn >= 3 && deep >= 75 && deep <= 118;
        const leanOff = Math.abs(sMid.x - mid(hl, hr).x) / torsoH(l);
        const upright = leanOff <= 0.22;
        const live = [];
        if (legsOn >= 3 && !holding && deep > 118) live.push('wsUp');
        if (holding && !upright) live.push('wsLean');
        const sec = dt ? dt / 1000 : 0;
        return { phase: holding ? (upright ? '静蹲保持中' : '背往墙上靠…') : '下蹲到大腿接近平放',
          live, rep: holding ? { valid: upright, seconds: sec, issues: upright ? [] : ['wsLean'] } : null };
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
    },
    {
      id: 'sidraise', name: '侧平举', ico: '🤲', view: 'front', seated: true, free: false, diff: 2,
      mode: 'reps', target: 12, sets: 3, met: 3.5,
      desc: '三角肌塑形，拿两瓶水就能练（Pro）',
      setup: '正面约 2 米，头到腰入镜即可，坐着也能做；双手举起后不要超出画面上沿。',
      tips: ['双臂自然垂在体侧起手', '手抬到与肩同高就好，不必举过头', '手臂尽量伸直，别用手肘借力', '下放要慢，不靠惯性甩'],
      keys: [11, 12, 13, 14, 15, 16],
      start: l => {
        const sw = Math.max(30, Math.abs(l[11].x - l[12].x));
        return l[15].y > l[11].y + 1.0 * sw && l[16].y > l[12].y + 1.0 * sw;
      }
    },
    {
      id: 'sidestretch', name: '体侧伸展', ico: '🌗', view: 'front', free: true, diff: 1,
      mode: 'reps', target: 10, sets: 2, met: 2.0,
      desc: '拉开腰侧链，久坐腰酸的解药',
      setup: '摄像头正前方约 2 米，至少拍到肩到髋部；双手自然下垂。',
      tips: ['双手贴裤缝，只往侧面弯', '侧弯到极限停 1 秒', '左右交替，各算 1 次', '身体不要往前倾或转体'],
      keys: [11, 12, 23, 24],
      start: l => Math.abs(mid(l[11], l[12]).x - mid(l[23], l[24]).x) < 0.08 * torsoH(l)
    },
    {
      id: 'wallsit', name: '靠墙静蹲', ico: '🧱', view: 'front', free: false, diff: 2,
      mode: 'time', target: 30, sets: 3, met: 3.0,
      desc: '对膝盖友好的下肢等长力量，背靠墙就行（Pro）',
      setup: '背靠墙站好，摄像头在正前方 2–3 米，头顶到脚踝全部入镜。',
      tips: ['下蹲到膝盖约 90°，大腿接近平放', '膝不要超过脚尖', '背贴墙，胸不要往前塌', '姿势垮了计时会自动暂停'],
      keys: [11, 12, 23, 24, 25, 26, 27, 28],
      start: l => Math.min(ang(l[23], l[25], l[27]), ang(l[24], l[26], l[28])) < 130
    }
  ];

  /* ================= 体态评估（正面：左右偏差，v1）================= */
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
    return { score, items, note: '正面 4 项评估；侧面位（骨盆前倾/圆肩）需侧身再采一次。' };
  }

  /* ================= 体态评估（侧面位，v1.7）=================
   * 侧面才能看到矢状面的东西：头前倾、圆肩、骨盆前倾、膝过伸。
   * 口径：以踝-髋-肩-耳四个关键点的**前后偏移**除以身高归一，不依赖绝对像素；
   * 侧面只要求单侧可见（远侧肢体被躯干挡住是正常事）。 */
  function analyzePostureSide(samples) {
    if (!samples || !samples.length) return null;
    const avg = i => {
      let x = 0, y = 0, n = 0;
      samples.forEach(s => { const p = s[i]; if (p && p.v > 0.4) { x += p.x; y += p.y; n++; } });
      return n >= samples.length * 0.3 ? { x: x / n, y: y / n, n } : null;
    };
    const any = (...idx) => { for (const i of idx) { const a = avg(i); if (a) return a; } return null; };
    const ear = any(7, 8), sh = any(11, 12), hip = any(23, 24), kn = any(25, 26), an = any(27, 28);
    if (!sh || !hip) return null;
    const head = any(0, 7, 8) || sh;
    const anPt = an || kn || hip;
    const bodyH = Math.max(60, anPt.y - head.y);

    /* dx > 0 表示前一个点在画面右侧；侧面拍摄时左右朝向取决于用户面向，所以取绝对值评分，方向只用于建议文案 */
    const mk = (name, dx, goodT, mildT, labels, advice) => {
      const pct = Math.abs(dx) / bodyH * 100;
      const cls = pct <= goodT ? 'a' : pct <= mildT ? 'b' : 'c';
      const level = cls === 'a' ? '良好' : cls === 'b' ? '轻度偏差' : '明显偏差';
      return { name, view: '侧面', pct: +pct.toFixed(1), level, cls,
        advice: cls === 'a' ? advice[0] : cls === 'b' ? advice[1] : advice[2],
        dir: Math.abs(dx) < 1 || cls === 'a' ? '' : labels[dx > 0 ? 0 : 1] };
    };
    const items = [];
    if (ear) items.push(mk('头前倾（耳-肩前后偏移）', ear.x - sh.x, 1.0, 2.2, ['耳在肩前方', '耳在肩后方'],
        ['头颈在肩正上方，侧面看一条线很好',
          '下巴微收（像把头顶往天花板拔），每小时做 10 次收下巴；注意屏幕高度',
          '头前倾明显：靠墙站立（后脑贴墙收下巴）5 分钟×2，加强深颈屈肌；长时间看手机是主因，先改工位屏高']));
    items.push(mk('圆肩 / 肩前移（肩-髋偏移）', sh.x - hip.x, 0.9, 2.0, ['肩在髋前方（圆肩）', '肩在髋后方'],
      ['肩在髋正上方，胸腔位置正确',
        '轻度圆肩：每天做扩胸与 YTW 各 10 次×2，减少前侧抱紧类动作',
        '圆肩明显：放松胸小肌/胸大肌（门框拉伸 30 秒×3），强化中下斜方肌与菱形肌；别再做太多俯卧撑']));
    if (an) items.push(mk('骨盆前倾代偿（髋-踝偏移）', hip.x - an.x, 1.1, 2.4, ['髋在踝前方（常见于骨盆前倾/顶胯）', '髋在踝后方'],
      ['髋在踝正上方，矢状面中立',
        '轻度前移：收紧腹部（微收尾骨）再站立，放松髂腰肌与股四头肌',
        '髋前移明显：典型骨盆前倾代偿——每天臀桥 15 次×3 + 髂腰肌拉伸 30 秒×3；腰疼请停止跳跃类动作']))
    if (an && kn) items.push(mk('膝过伸（膝-踝偏移）', kn.x - an.x, 1.0, 2.0, ['膝在踝前方（膝过伸）', '膝在踝后方'],
      ['膝在踝上方微屈，不锁死',
        '轻度锁膝：站立时有意识保持膝微屈，深蹲时不要“把膝顶死”',
        '膝过伸明显：先重建股四头肌与腘绳肌平衡（靠墙静蹲 30 秒×3），建议就医排查膝关节问题']))
    let score = 100;
    items.forEach(it => { if (it.cls === 'b') score -= 9; else if (it.cls === 'c') score -= 20; });
    score = Math.max(40, Math.round(score));
    return { score, items, view: 'side', note: '侧面位为单视角矢状面近似评估（以关键点前后偏移归一），不代替医生诊断。' };
  }

  /* 合并正面 + 侧面：评分取两边均值（没有侧面就是原正面分），条目拼接供 UI 直接渲染 */
  function mergePosture(front, side) {
    const parts = [front, side].filter(Boolean);
    if (!parts.length) return null;
    const items = [];
    parts.forEach(p => p.items.forEach(it => items.push(Object.assign({}, it, { view: p === front ? '正面' : '侧面' }))));
    const score = Math.round(parts.reduce((a, p) => a + p.score, 0) / parts.length);
    return { score, items, twoView: parts.length === 2, note: parts[parts.length - 1].note };
  }

  /* ================= 一句话编排（AI 计划）=================
   * 纯函数：自然语言 → 循环跟练动作序列。不依赖任何 DOM，便于 Node 单测。
   * 思路：关键词命中场景/部位标签 → 标签对应动作候选池 → 按时长决定动作个数。 */
  const OFFICE_POOL = ['headshake', 'wave', 'shrug', 'sidestretch'];   // 空间受限首选（体侧伸展只要求肩髋可见，贴着桌子也能做）
  const PLAN_TAG = [
    { re: /(办公室|久坐|久站|上班|工位|中午|午休|出差|酒店|空间小|没地方|椅子|坐着)/, pool: OFFICE_POOL, why: '场地有限：以坐姿上肢与侧链伸展为主', seat: true },
    { re: /(肩颈|脖子|颈椎|肩膀|酸痛|僵硬|放松|舒缓)/, pool: ['shrug', 'headshake', 'wave'], why: '肩颈发紧：耸肩 + 摇头放松优先' },
    { re: /(拉伸|柔韧|舒展|松开|弯腰|侧腰|腰紧|筋)/, pool: ['sidestretch', 'shrug', 'headshake'], why: '拉伸放松：体侧伸展 + 肩颈活动度' },
    { re: /(腿|臀|下肢|膝|蹲|弓步|跑|靠墙)/, pool: ['squat', 'lunge', 'highknees', 'wallsit'], why: '下肢力量：深蹲、弓步与靠墙静蹲' },
    { re: /(减脂|燃脂|汗|心肺|体能|体力|烈|累|瘦)/, pool: ['jack', 'highknees', 'squat'], why: '拉心率燃脂：开合跳 + 高抬腿' },
    { re: /(腹|核心|腰|平板|支撑|背)/, pool: ['plank', 'pushup', 'squat'], why: '核心稳定：平板支撑' },
    { re: /(胸|臂|上肢|手|撑|俯卧撑|肩|肩胛)/, pool: ['pushup', 'wave', 'shrug', 'sidraise'], why: '上肢力量：俯卧撑与侧平举' },
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
      OFFICE_POOL.forEach(id => { if (ok(id) && !keep.includes(id)) keep.push(id); });
      pool = keep;
    }

    /* 膝盖敏感：不能一听“腿”就排跳跃与高频抬腿——冲击类移出，等长负荷的靠墙静蹲顶到最前（v1.8）。
     * 不这样处理会出现“用户说膝盖不行，结果第一个动作是深蹲”的自相矛盾编排 */
    const kneeWorry = /膝.{0,6}(不行|不太行|痛|疼|伤|弱|敏感|不适|怕)|护膝|怕伤膝/.test(s);
    if (kneeWorry) {
      const IMPACT = { jack: 3, highknees: 3, squat: 2, lunge: 2, wallsit: 0 };
      const rank = id => IMPACT[id] != null ? IMPACT[id] : 1;
      pool = pool.filter(id => rank(id) < 3);
      if (ok('wallsit') && !pool.includes('wallsit')) pool.unshift('wallsit');
      /* 免费版靠墙静蹲被锁，筛完可能只剩一个动作：用活度类兼住，不能排出单人套餐 */
      if (pool.length < 2) ['sidestretch', 'headshake', 'wave', 'shrug'].forEach(id => { if (ok(id) && !pool.includes(id)) pool.push(id); });
      pool = pool.slice().sort((a, b) => rank(a) - rank(b));
      // 不能承诺一个免费版根本排不进去的动作：靠墙静蹲被锁时改说“不磨膝的活度与等长动作”
      why.unshift(ok('wallsit')
        ? '膝盖敏感：避开跳跃与快频抬腿，优先靠墙静蹲这类不磨膝的等长负荷'
        : '膝盖敏感：避开跳跃与快频抬腿，以不磨膝的活动度与低冲击动作为主');
    }

    /* 一轮里放几个动作：按时长算（每动作一轮 ≈ 40–100s），睡前低强度不拉长 */
    const easy = hits.some(t => t.easy);
    let n = Math.round(min / 1.5);
    n = Math.min(6, Math.max(3, Math.min(n, pool.length)));
    if (easy) n = Math.min(n, 4);
    const base = pool.slice(0, n);
    const legSec = id => exRoundSec(EXERCISES.find(x => x.id === id));
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

  /* ================= 周课表（7 天计划）=================
   * 纯函数：把“这周该练什么”排成 7 天课表，并根据本机历史记录自动重算。
   * 约束全部来自真实产品逻辑：Pro 动作只有订阅者能排、免费额度排完就自动改成
   * 不扣额度的体感关卡、周日固定休息。不用随机数，所以可测、可复现。 */
  const WEEK_PLAN = [
    { name: '下肢力量', pool: ['squat', 'lunge', 'highknees', 'jack', 'wallsit'], game: 'guard', why: '大肌群先练，代谢收益最高' },
    { name: '肩颈放松', pool: ['shrug', 'headshake', 'wave'], game: null, why: '久坐一天的头肩颈，只要活动度不要力竭' },
    { name: '心肺燃脂', pool: ['jack', 'highknees', 'squat', 'wave'], game: 'dodge', why: '拉心率的一天，动作节奏要快' },
    { name: '核心稳定', pool: ['plank', 'pushup', 'squat', 'shrug'], game: null, why: '躯干稳了体态评分才会涨' },
    { name: '久坐激活', pool: ['headshake', 'wave', 'shrug', 'sidestretch', 'sidraise', 'grasp'], game: null, why: '办公室随时能做，不需要场地' },
    { name: '体感关卡', pool: [], game: 'collect', why: '玩着把幅度拉开，而且不占训练额度' },
    { name: '休息日', pool: [], game: null, why: '肌肉在休息时才长，别硬撑' }
  ];
  const WEEK_FILL = ['squat', 'jack', 'headshake', 'wave', 'shrug', 'highknees'];   // 权限/额度受限时的补位（全部免费）

  /* 一个动作做一组的估算秒数（含准备），编排与课表共用同一口径 */
  function exRoundSec(e) {
    if (!e) return 60;
    return e.mode === 'time' ? e.target + 5 : Math.min(120, Math.round(e.target * 2.4 + 8));
  }

  function makeWeekPlan(records, opts) {
    const o = opts || {};
    const rs = Array.isArray(records) ? records : [];
    const allowPro = !!o.pro;
    const goal = (o.dailyGoal | 0) > 0 ? (o.dailyGoal | 0) : 30;      // 没设每日目标时课表按 30 点排
    const hasQuota = typeof o.quotaLeft === 'number';
    const quotaLeft = hasQuota ? Math.max(0, o.quotaLeft | 0) : Infinity;
    const exOf = id => EXERCISES.find(x => x.id === id);
    const nmOf = id => (exOf(id) || { name: id }).name;

    /* 一周从周一开始 */
    const t0 = new Date(o.today || Date.now()); t0.setHours(0, 0, 0, 0);
    const monday = t0.getTime() - ((t0.getDay() + 6) % 7) * 864e5;
    const startOf = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
    const todayI = Math.round((startOf(o.today || Date.now()) - monday) / 864e5);
    /* 训练点口径与 app.js 今日目标一致：计次动作 1 次=1 点，计时每 10s=1 点，关卡得分÷3 */
    const ptsOf = r => r.mode === 'game' ? Math.round(r.valid / 3) : r.mode === 'time' ? Math.round(r.valid / 10) : r.valid;

    const bucket = [[], [], [], [], [], [], []];
    rs.forEach(r => { const i = Math.round((startOf(r.ts) - monday) / 864e5); if (i >= 0 && i <= 6) bucket[i].push(r); });

    /* 近 14 天各动作平均分：分低的先排进课表（弱项优先），没练过的给中性 75 分 */
    const since = monday - 7 * 864e5;
    const agg = {};
    rs.forEach(r => {
      if (r.ts >= since && r.mode !== 'game') { const a = agg[r.ex] || (agg[r.ex] = { n: 0, s: 0 }); a.n++; a.s += (r.score || 0); }
    });
    const scoreOf = id => { const a = agg[id]; return a ? Math.round(a.s / a.n) : 75; };
    const avail = id => { const e = exOf(id); return !!e && (allowPro || e.free); };

    let quotaSpent = 0;
    const days = WEEK_PLAN.map((th, i) => {
      const d0 = monday + i * 864e5, dd = new Date(d0);
      let kind = th.pool.length ? 'train' : (th.game ? 'game' : 'rest');
      const recs = bucket[i];
      const donePts = recs.reduce((a, r) => a + ptsOf(r), 0);
      let note = '';
      /* 动作选择：可用的 + 弱项优先，最多 3 个；不够 2 个就从免费补位池凑。
       * 先按周轮换起点再按评分排：评分低者仍然优先（弱项硬约束），但没历史时大家同分，
       * 若不轮换就永远是池首那几个老动作霸位、新加的动作一辈子排不进来。周序号单调递增，同周内确定可复现 */
      let ids = [];
      if (kind === 'train') {
        const pool = th.pool.filter(avail);
        if (pool.length) {
          const wk = Math.floor(monday / 6048e5);
          const rot = pool.map((_, k) => pool[(wk + k) % pool.length]);
          ids = rot.sort((a, b) => scoreOf(a) - scoreOf(b)).slice(0, 3);
        }
        if (ids.length < 2) WEEK_FILL.forEach(id => { if (ids.length < 3 && avail(id) && !ids.includes(id)) ids.push(id); });
      }
      /* 一个训练日 = 1 次循环跟练 = 1 次额度；免费额度排完自动降级成关卡日 */
      if (kind === 'train') {
        if (hasQuota && quotaSpent >= quotaLeft) {
          kind = 'game'; ids = []; note = '本月训练额度已排满：改为不扣额度的体感关卡';
        } else quotaSpent++;
      }
      const gk = kind === 'game' ? (th.game || 'collect') : null;
      const estMin = kind === 'train'
        ? +(ids.reduce((a, id) => a + exRoundSec(exOf(id)) + 10, 0) / 60).toFixed(1)
        : kind === 'game' ? 1 : 0;
      const done = recs.length > 0;
      return {
        i, date: (dd.getMonth() + 1) + '/' + dd.getDate(), wd: ['日', '一', '二', '三', '四', '五', '六'][dd.getDay()],
        theme: th.name, why: th.why, kind, ids, names: ids.map(nmOf), game: gk, estMin,
        targetPts: kind === 'rest' ? 0 : goal, donePts, done, met: done && donePts >= goal,
        status: i === todayI ? 'today' : i < todayI ? (done ? 'done' : 'missed') : 'upcoming',
        sessions: recs.length, note
      };
    });

    const td = days[Math.max(0, Math.min(6, todayI))];
    const tmr = days[(td.i + 1) % 7];
    const exNames = td.names.length ? td.names.join(' / ') : (td.game ? GAME_KINDS[td.game].name : '');
    let tip;
    if (td.kind === 'rest') tip = '今天是休息日 😴 明天排的是「' + tmr.theme + '」；实在想动就做一局体感关卡，不扣额度';
    else if (td.kind === 'game') tip = '今天是关卡日：' + GAME_KINDS[td.game].name + '，60 秒一局不扣额度';
    else if (td.met) tip = '今日「' + td.theme + '」已完成 ✓ ' + td.donePts + '/' + td.targetPts + ' 点，明天是「' + tmr.theme + '」';
    else if (td.done) tip = '今日「' + td.theme + '」已拿 ' + td.donePts + ' 点，还差 ' + Math.max(0, td.targetPts - td.donePts) + ' 点：补做 ' + exNames;
    else tip = '今日该练「' + td.theme + '」：' + exNames + '，约 ' + td.estMin + ' 分钟' + (td.note ? '（' + td.note + '）' : '');
    const missed = days.filter(d => d.status === 'missed').length;

    return {
      days, todayI: td.i, tip,
      tipMore: td.kind === 'rest' ? '' : td.done ? '' : ' · ' + td.why,
      weekPts: days.reduce((a, d) => a + d.donePts, 0),
      weekTarget: days.filter(d => d.kind !== 'rest').reduce((a, d) => a + d.targetPts, 0),
      missed, plannedSessions: quotaSpent, goal,
      weak: Object.entries(agg).filter(([, a]) => a.n >= 2).sort((x, y) => x[1].s / x[1].n - y[1].s / y[1].n)
        .slice(0, 2).map(([id, a]) => nmOf(id) + '（均分 ' + Math.round(a.s / a.n) + '）'),
      next: td.kind === 'game' ? { type: 'game', kind: td.game }
        : td.kind === 'train' && td.ids.length ? { type: 'circuit', ids: td.ids } : null
    };
  }

  /* ================= 体感关卡（游戏化）=================
   * 纯逻辑、无 DOM：输入只有身体中心 x / 是否举臂 / 是否蹲下，输出事件数组，
   * 渲染与音效在 app.js。三个关卡分别逼出三种动作：跨步移动 / 举手挥臂 / 深蹲。 */
  const GAME_KINDS = {
    collect: { name: '星星收集', ico: '⭐', met: 6.5, desc: '左右跨步接星星，高星要举手', need: 'arms' },
    dodge:   { name: '激光闪避', ico: '⚡', met: 7.5, desc: '身体待在空的一侧，别碰激光', need: 'step' },
    guard:   { name: '深蹲护盾', ico: '🛡', met: 5.5, desc: '横梁压下时蹲下去护住自己', need: 'squat' }
  };
  function makeGame(kind, opts) {
    const o = opts || {};
    const dur = o.duration || 60, hpMax = o.hp || 3;
    const S = { kind: GAME_KINDS[kind] ? kind : 'collect', t: 0, score: 0, combo: 0, best: 0,
      hp: hpMax, hpMax, level: 1, over: false, objs: [], next: 0.6, spawn: 1.4, shield: false, events: [] };
    const rnd = o.rnd || Math.random;
    function spawn() {
      const k = S.kind;
      if (k === 'guard') {
        S.objs.push({ type: 'bar', x: 0.5, y: -0.2, vy: 0.34 + S.level * 0.035, done: false });
        S.spawn = Math.max(1.6, 3.4 - S.level * 0.2);
      } else if (k === 'dodge') {
        const side = rnd() < 0.5 ? 0.25 : 0.75;
        S.objs.push({ type: 'laser', x: side, y: -0.15, vy: 0.42 + S.level * 0.05, done: false });
        S.spawn = Math.max(0.75, 1.7 - S.level * 0.12);
      } else {
        const high = S.level >= 2 && rnd() < 0.34;
        S.objs.push(high
          ? { type: 'starHi', x: 0.12 + rnd() * 0.76, y: 0.4, vy: 0, life: 2.2, done: false }   /* 挂在上方：必须举手 */
          : { type: 'star', x: 0.1 + rnd() * 0.8, y: -0.1, vy: 0.36 + S.level * 0.045, done: false });
        S.spawn = Math.max(0.55, 1.25 - S.level * 0.1);
      }
    }
    function hit(ev, extra) { S.events.push(Object.assign({ ev }, extra || {})); }
    return {
      S,
      step(input, dtMs) {
        const dt = Math.min(120, dtMs || 16) / 1000;
        S.events = [];
        if (S.over) return S.events;
        S.t += dt;
        const lv = 1 + Math.floor(S.t / 15);
        if (lv !== S.level) { S.level = lv; hit('level', { level: lv }); }
        const px = Math.max(0, Math.min(1, input && input.x != null ? input.x : 0.5));
        S.shield = !!(input && input.squat) && S.kind === 'guard';
        S.next -= dt;
        if (S.next <= 0) { spawn(); S.next = S.spawn; }
        for (let i = S.objs.length - 1; i >= 0; i--) {
          const q = S.objs[i];
          q.y += q.vy * dt;
          if (S.kind === 'guard') {                       /* 横梁到胸部高度时判定护盾 */
            if (!q.done && q.y >= 0.42) {
              q.done = true;
              if (S.shield) { S.score += 2; S.combo++; hit('shield', { score: S.score, combo: S.combo }); }
              else { S.hp--; S.combo = 0; hit('hurt', { hp: S.hp, combo: 0 }); }
            }
          } else if (S.kind === 'dodge') {
            if (!q.done && q.y >= 0.62) {
              q.done = true;
              const sameSide = (q.x < 0.5) === (px < 0.5);
              if (Math.abs(q.x - px) < 0.28 && sameSide) { S.hp--; S.combo = 0; hit('hurt', { hp: S.hp }); }
              else { S.score += 1; S.combo++; hit('dodge', { score: S.score, combo: S.combo }); }
            }
          } else if (q.type === 'starHi') {              /* 高星不下落，限时 2.2s：举手 + 走到下方才接得到 */
            q.life -= dt;
            if (input && input.armsUp && Math.abs(q.x - px) < 0.15) {
              q.done = true; S.score += 3; S.combo++;
              hit('catch', { score: S.score, combo: S.combo, hi: true });
            } else if (q.life <= 0) { q.done = true; hit('near', {}); }
            if (q.done || q.life <= 0) S.objs.splice(i, 1);
            continue;
          } else if (!q.done && q.y >= 0.7 && q.y <= 0.99 && Math.abs(q.x - px) < 0.12) {
            q.done = true; S.score++; S.combo++;
            hit('catch', { score: S.score, combo: S.combo, hi: false });
          }
          if (q.done || q.y > 1.2) {
            if (!q.done && S.kind === 'collect') { S.combo = 0; hit('miss', {}); }   /* 星星落地：只断连击，不扣命 */
            S.objs.splice(i, 1);
          }
        }
        if (S.combo > S.best) S.best = S.combo;
        if (S.hp <= 0) { S.hp = 0; S.over = true; hit('over', { why: 'hp', score: S.score }); }
        else if (S.t >= dur) { S.over = true; hit('over', { why: 'time', score: S.score }); }
        return S.events;
      },
      left() { return S.over ? 0 : Math.max(0, dur - S.t); }
    };
  }

  /* ================= 我的课程（训练模板，v1.9）=================
   * 把一次循环跟练的选片或一句话编排存成常用课。这里只做纯数据逻辑：校验、去重、
   * 命名、时长估都能在 Node 里测；存储与渲染交给 app.js。 */
  const TPL_MAX = 12;          // 首页卡片放不下更多：满了就明确拒绝，而不是静默丢弃或无限堆
  const TPL_NAME_MAX = 20;
  const findEx = id => EXERCISES.find(e => e.id === id);

  /* 名字可以不给（默认用动作名拼），但存进去的东西得能看能改：去控制字符、限长 */
  function tplName(raw, ids) {
    const fallback = (ids || []).map(id => (findEx(id) || { name: id }).name).join('+');
    const s = String(raw == null ? '' : raw).replace(/[\r\n\t]/g, ' ').trim();
    return (s || fallback).replace(/[<>"']/g, '').trim().slice(0, TPL_NAME_MAX);
  }

  function templateOf(ids, name, ts) {
    const clean = [];
    (Array.isArray(ids) ? ids : []).forEach(id => { if (findEx(id) && !clean.includes(id)) clean.push(id); });
    if (clean.length < 2) return null;      // 循环跟练至少 2 个动作：单个直接练就好，不值得占一张卡
    const nm = tplName(name, clean);
    if (!nm) return null;
    return { id: 't' + (Number(ts) || Date.now()).toString(36), name: nm, ids: clean };
  }

  /* 存课：查重、限长都在此返回明确原因，让 UI 能说清“为什么没存进去” */
  function tplAdd(list, tpl) {
    const arr = tplSafe(list);
    if (!tpl || !Array.isArray(tpl.ids) || tpl.ids.length < 2 || !tplName(tpl.name)) return { ok: false, why: 'bad', list: arr };
    const key = a => a.slice().sort().join(',');    // 动作顺序不同也算同一门课：用户很容易存出一堆微差别重复项
    const dup = arr.find(t => key(t.ids) === key(tpl.ids));
    if (dup) return { ok: false, why: 'dup', list: arr, tpl: dup };
    if (arr.length >= TPL_MAX) return { ok: false, why: 'full', list: arr };
    return { ok: true, list: [tpl].concat(arr), tpl };
  }
  function tplRemove(list, id) { return tplSafe(list).filter(t => t.id !== id); }

  /* 从 localStorage 读回来的数据可能缺字段或被手改过：只认结构合法的，不把脏项渲染出去 */
  function tplSafe(list) {
    return (Array.isArray(list) ? list : [])
      .filter(t => t && typeof t.id === 'string' && typeof t.name === 'string' && t.name.trim()
        && Array.isArray(t.ids) && t.ids.length >= 2 && t.ids.every(id => !!findEx(id)))
      .slice(0, TPL_MAX)
      .map(t => ({ id: t.id, name: t.name.trim().slice(0, TPL_NAME_MAX), ids: t.ids.slice() }));
  }

  /* 时长与名单：与周课表共用 exRoundSec 口径，不能两套算法估出两个分钟数 */
  function tplEstimate(t) {
    const ids = (t && Array.isArray(t.ids)) ? t.ids.filter(id => !!findEx(id)) : [];
    const estSec = ids.reduce((a, id) => a + exRoundSec(findEx(id)) + 10, 0);
    return {
      segs: ids.length, names: ids.map(id => findEx(id).name),
      estMin: +(estSec / 60).toFixed(1),
      locked: ids.map(findEx).filter(e => !e.free).map(e => e.name),
      seatedOnly: ids.length > 0 && ids.every(id => !!findEx(id).seated)   // 全坐姿 = 办公室可直接开练
    };
  }

  /* ================= 数据备份（导出 / 导入，v2.0）=================
   * 本地无后端：用户清浏览器缓存 = 全部训练记录、体态评估、我的课程一起丢，而且没有任何
   * 补救。这里提供可单测的纯序列化/校验函数，把 localStorage 变成一份能存走、能换机器的 JSON。
   * 关键：外部文件一律不信任——先白名单取字段、逐条校类型，再把脏项丢弃。 */
  const BACKUP_APP = 'dongjing';
  const BACKUP_VER = 1;

  /* 训练记录字段校验：缺关键字段或类型不对的直接丢，不把脏项灌回统计 */
  function sanitizeRecords(list) {
    const MODES = { reps: 1, time: 1, game: 1 };
    return (Array.isArray(list) ? list : [])
      .filter(r => r && typeof r === 'object' && Number.isFinite(r.ts) && Number.isFinite(r.valid) && MODES[r.mode])
      .map(r => ({
        ts: Math.trunc(r.ts), ex: String(r.ex || ''), name: String(r.name || ''), mode: r.mode,
        target: r.target | 0, valid: r.valid | 0,
        attempts: Number.isFinite(r.attempts) ? r.attempts | 0 : (r.valid | 0),
        secs: r.secs | 0, cal: +((+r.cal || 0).toFixed(1)),
        score: Math.max(0, Math.min(100, r.score | 0)),
        issues: (r.issues && typeof r.issues === 'object') ? r.issues : {},
        game: r.game ? String(r.game) : undefined
      }));
  }

  /* 只导出白名单字段，避免把运行时临时态写进备份；set 补齐默认值防旧版本缺字段 */
  function exportPayload(db, now) {
    const d = db || {};
    return {
      app: BACKUP_APP, ver: BACKUP_VER, exportedAt: Number(now) || Date.now(),
      records: sanitizeRecords(d.records),
      posture: Array.isArray(d.posture) ? d.posture.slice(-120) : [],
      quota: (d.quota && typeof d.quota === 'object')
        ? { month: String(d.quota.month || ''), used: Math.max(0, d.quota.used | 0) }
        : { month: '', used: 0 },
      set: Object.assign({ voice: true, sfx: true, mirror: true, weight: 60, dailyGoal: 30 }, d.set || {}),
      pro: !!d.pro,
      templates: tplSafe(d.templates)
    };
  }

  /* 合并去重：同一 ts+动作视为同一次（重复导入不会让记录翻倍），按时间升序 */
  function mergeRecords(a, b) {
    const map = {};
    sanitizeRecords(a).concat(sanitizeRecords(b)).forEach(r => { map[r.ts + ':' + r.ex] = r; });
    return Object.keys(map).map(k => map[k]).sort((x, y) => x.ts - y.ts);
  }

  /* 解析导入文本：JSON + 结构校验，返回 {ok, why, payload}。why: json/app/shape */
  function parseImport(raw) {
    let obj;
    try { obj = (typeof raw === 'string') ? JSON.parse(raw) : raw; }
    catch (e) { return { ok: false, why: 'json' }; }
    if (!obj || typeof obj !== 'object' || obj.app !== BACKUP_APP) return { ok: false, why: 'app' };
    if (!Array.isArray(obj.records)) return { ok: false, why: 'shape' };
    return { ok: true, payload: exportPayload(obj) };
  }

  /* ================= 训练热力图（v2.1）=================
   * GitHub 风贡献图：把每天训练点分桶、按周排成列。与每日目标环共用同一套“训练点”
   * 口径（recPoints）：计次 1 有效=1 点、计时每 10s=1 点、关卡得分÷3。 */
  function recPoints(r) {
    if (!r || !r.mode) return 0;
    const v = Number(r.valid) || 0;
    return r.mode === 'game' ? Math.round(v / 3) : r.mode === 'time' ? Math.round(v / 10) : v;
  }

  function buildHeatmap(records, opts) {
    const o = opts || {};
    const ds = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
    const mondayStart = t => { const s = ds(t); const wd = (new Date(s).getDay() + 6) % 7; return s - wd * 864e5; };
    const now = Number(o.today) || Date.now();
    const weeks = Math.max(1, Math.min(53, (o.weeks || 12) | 0));
    const goal = (o.dailyGoal | 0) > 0 ? (o.dailyGoal | 0) : 0;
    const thr = goal > 0 ? [goal * 0.34, goal * 0.67, goal] : [5, 10, 15];   // level 1..4 边界（只需三个上界）
    const rs = Array.isArray(records) ? records : [];
    const ptsByDay = {};
    rs.forEach(r => { if (!r || !Number.isFinite(r.ts)) return; const k = ds(r.ts); ptsByDay[k] = (ptsByDay[k] || 0) + recPoints(r); });
    const firstMonday = mondayStart(now - (weeks - 1) * 7 * 864e5);
    const todayS = ds(now);
    const cols = [];
    let prevMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const colStart = firstMonday + w * 7 * 864e5;
      const days = [];
      for (let d = 0; d < 7; d++) {
        const ts = colStart + d * 864e5;
        const points = ptsByDay[ts] || 0;
        const level = points <= 0 ? 0 : points >= thr[2] ? 4 : points >= thr[1] ? 3 : points >= thr[0] ? 2 : 1;
        days.push({ ts, points, level, future: ts > todayS, isToday: ts === todayS });
      }
      const m = new Date(colStart).getMonth();
      const month = (m !== prevMonth) ? (m + 1) : null;    // 只在跨入新月的首列标月份
      prevMonth = m;
      cols.push({ days, month, startTs: colStart });
    }
    let total = 0, active = 0;
    cols.forEach(c => c.days.forEach(dy => { if (dy.future) return; total += dy.points; if (dy.points > 0) active++; }));
    let streak = 0, cursor = todayS;                       // 今天未练则从昨天起算，往回数连续
    if ((ptsByDay[cursor] || 0) === 0) cursor -= 864e5;
    while (cursor >= firstMonday && (ptsByDay[cursor] || 0) > 0) { streak++; cursor -= 864e5; }
    return { weeks: cols, total, active, streak, windowDays: weeks * 7, goal };
  }

  /* ================= 成就徽章（v2.2）=================
   * 从本机数据提炼“里程碑”，全部纯函数可离线单测；渲染交给 app.js。
   * 训练点口径继续复用 recPoints，与目标环 / 热力图一套算法。 */
  function achStreaks(records, now) {
    const D = 864e5;
    const ds = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
    const days = new Set();
    (Array.isArray(records) ? records : []).forEach(r => { if (r && Number.isFinite(r.ts)) days.add(ds(r.ts)); });
    const arr = [...days].sort((a, b) => a - b);
    let longest = 0, run = 0, prev = null;
    arr.forEach(d => { run = (prev !== null && d === prev + D) ? run + 1 : 1; if (run > longest) longest = run; prev = d; });
    let cur = 0, c = ds(Number(now) || Date.now());
    if (!days.has(c)) c -= D;                          // 今天未练则从昨天起算
    while (days.has(c)) { cur++; c -= D; }
    return { cur, longest };
  }

  function computeAchievements(db, opts) {
    const o = opts || {};
    const d = (db && typeof db === 'object') ? db : {};
    const records = Array.isArray(d.records) ? d.records : [];
    const posture = Array.isArray(d.posture) ? d.posture : [];
    const now = Number(o.now || o.today) || Date.now();
    const exTotal = EXERCISES.length;
    const exIds = new Set(EXERCISES.map(e => e.id));
    let points = 0, hasCircuit = false, hasGame = false;
    const exSeen = new Set();
    records.forEach(r => {
      if (!r) return;
      points += recPoints(r);
      if (r.ex && exIds.has(r.ex)) exSeen.add(r.ex);
      if (r.ex === 'circuit') hasCircuit = true;
      if (r.mode === 'game' || (r.ex && String(r.ex).indexOf('game-') === 0)) hasGame = true;
    });
    const st = achStreaks(records, now);
    const cur = {
      count: records.length, ex: exSeen.size, streak: st.cur,
      points: Math.round(points), circuit: hasCircuit ? 1 : 0, game: hasGame ? 1 : 0, posture: posture.length
    };
    const defs = [
      { id: 'first',     ico: '\ud83c\udf31', name: '开始出发',   desc: '完成第一次训练',        kind: 'count',   target: 1 },
      { id: 'collector', ico: '\ud83c\udfb2', name: '尝鲜家',     desc: '练过 5 个不同动作',        kind: 'ex',      target: 5 },
      { id: 'explorer',  ico: '\ud83e\udded', name: '动作收藏家', desc: '练过全部 ' + exTotal + ' 个动作', kind: 'ex', target: exTotal },
      { id: 'streak7',   ico: '\ud83d\udd25', name: '七日之约',   desc: '连续打卡 7 天',            kind: 'streak',  target: 7 },
      { id: 'streak30',  ico: '\u26a1', name: '月度铁人',   desc: '连续打卡 30 天',           kind: 'streak',  target: 30 },
      { id: 'points',    ico: '\ud83d\udcaf', name: '千点俱乐部', desc: '累计 1000 训练点',        kind: 'points',  target: 1000 },
      { id: 'circuit',   ico: '\ud83d\udd01', name: '循环达人',   desc: '完成一次循环跟练',      kind: 'circuit', target: 1 },
      { id: 'gamer',     ico: '\ud83c\udfae', name: '玩家上线',   desc: '玩过一次体感关卡',        kind: 'game',    target: 1 },
      { id: 'posture',   ico: '\ud83e\uddcd', name: '体态初评',   desc: '做过一次体态评估',        kind: 'posture', target: 1 }
    ];
    const list = defs.map(b => {
      const c = cur[b.kind] || 0;
      return {
        id: b.id, ico: b.ico, name: b.name, desc: b.desc, kind: b.kind,
        cur: Math.min(c, b.target), target: b.target, pct: b.target ? Math.min(1, c / b.target) : 0,
        earned: c >= b.target,
        longest: b.kind === 'streak' ? st.longest : undefined
      };
    });
    return { list, earned: list.filter(b => b.earned).length, total: list.length };
  }

  /* ================= 周环比小结（v2.3）=================
   * 本周（周一起） vs 上周同一周天数，用 recPoints 口径对训练点/节数/活跃天环比，
   * 输出一句结论。与热力图/目标环共用同一口径，不另起一套算法。 */
  function weekCompare(records, opts) {
    const o = opts || {};
    const D = 864e5;
    const ds = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
    const mondayStart = t => { const s = ds(t); const wd = (new Date(s).getDay() + 6) % 7; return s - wd * D; };
    const now = Number(o.today) || Date.now();
    const curMon = mondayStart(now);
    const prevMon = curMon - 7 * D;
    const rs = Array.isArray(records) ? records : [];
    const blank = () => ({ points: 0, sessions: 0, days: new Set() });
    const cur = blank(), prev = blank();
    rs.forEach(r => {
      if (!r || !Number.isFinite(r.ts)) return;
      const dayS = ds(r.ts);
      const bucket = dayS >= curMon ? cur : (dayS >= prevMon && dayS < curMon ? prev : null);
      if (!bucket) return;
      const p = recPoints(r);
      bucket.points += p; bucket.sessions++;
      if (p > 0) bucket.days.add(dayS);
    });
    cur.days = cur.days.size; prev.days = prev.days.size;
    const dPoints = cur.points - prev.points;
    const dPct = prev.points > 0 ? Math.round(dPoints / prev.points * 100) : (cur.points > 0 ? 100 : 0);
    let verdict;
    if (prev.points === 0 && cur.points === 0) verdict = '两周都还没练，从今天的动作开始 ✦';
    else if (prev.points === 0) verdict = '上周空缺，这周已攒 ' + cur.points + ' 点，好开头！';
    else if (cur.points === 0) verdict = '这周还没开始，上周有 ' + prev.points + ' 点，先练一组破零';
    else if (dPct >= 15) verdict = '比上周多 ' + dPct + '%，继续保持 🔥';
    else if (dPct <= -15) verdict = '比上周少 ' + (-dPct) + '%，安排一次循环跟练补回来';
    else verdict = '和上周基本持平（' + cur.points + ' vs ' + prev.points + ' 点）';
    return { cur, prev, dPoints, dPct, verdict };
  }

  /* ================= 训练时段分布（v2.4）=================
   * 按小时把记录分入四个时段（夜间跨 0 点），统计节数/训练点/平均评分，
   * 找出最常训练的时段。口径同样复用 recPoints。 */
  const DAYPARTS = [
    { key: 'morn',  name: '清晨', hour: '5–11',  from: 5,  to: 11 },
    { key: 'day',   name: '日间', hour: '11–17', from: 11, to: 17 },
    { key: 'eve',   name: '傍晚', hour: '17–22', from: 17, to: 22 },
    { key: 'night', name: '夜间', hour: '22–5',  from: 22, to: 5 }
  ];
  function daypartClassify(h) {
    return (h >= 5 && h < 11) ? 'morn' : (h >= 11 && h < 17) ? 'day' : (h >= 17 && h < 22) ? 'eve' : 'night';
  }
  function daypartStats(records) {
    const rs = Array.isArray(records) ? records : [];
    const acc = { morn: b(), day: b(), eve: b(), night: b() };
    function b() { return { sessions: 0, points: 0, scoreSum: 0, scoreN: 0 }; }
    rs.forEach(r => {
      if (!r || !Number.isFinite(r.ts)) return;
      const p = acc[daypartClassify(new Date(r.ts).getHours())];
      p.sessions++; p.points += recPoints(r);
      if (Number.isFinite(r.score)) { p.scoreSum += r.score; p.scoreN++; }
    });
    const parts = DAYPARTS.map(d => {
      const a = acc[d.key];
      return { key: d.key, name: d.name, hour: d.hour, sessions: a.sessions, points: a.points, avgScore: a.scoreN ? Math.round(a.scoreSum / a.scoreN) : 0 };
    });
    const total = parts.reduce((s, p) => s + p.sessions, 0);
    let busiest = parts[0];
    parts.forEach(p => { if (p.sessions > busiest.sessions || (p.sessions === busiest.sessions && p.points > busiest.points)) busiest = p; });
    return { parts, total, busiestKey: total ? busiest.key : null, busiestName: total ? busiest.name : '' };
  }

  /* ================= 动作个人最佳榜（v2.5）=================
   * 按动作聚合训练节数 / 单次最佳成绩（计次取最多下、计时取最长秒、
   * 关卡取最高分）/ 平均评分 / 累计点数 / 最近一次，按节数降序。 */
  function personalBests(records) {
    const rs = Array.isArray(records) ? records : [];
    const meta = {};
    EXERCISES.forEach(e => { meta[e.id] = e; });
    const byId = {};
    rs.forEach(r => {
      if (!r || !r.ex || !meta[r.ex]) return;
      const e = byId[r.ex] || (byId[r.ex] = { id: r.ex, sessions: 0, best: 0, bestScore: 0, scoreSum: 0, total: 0, points: 0, last: 0 });
      e.sessions++;
      const v = Number(r.valid) || 0;
      if (v > e.best) e.best = v;                       // reps → 次数 / time → 秒 / game → 得分
      e.total += v;
      const sc = Number(r.score) || 0;
      if (sc > e.bestScore) e.bestScore = sc;
      e.scoreSum += sc;
      e.points += recPoints(r);
      if (Number.isFinite(r.ts) && r.ts > e.last) e.last = r.ts;
    });
    return Object.keys(byId).map(id => {
      const e = byId[id], m = meta[id];
      return { id, name: m.name, ico: m.ico, mode: m.mode, target: m.target,
        sessions: e.sessions, best: e.best, bestScore: e.bestScore, total: e.total, points: e.points,
        avgScore: e.sessions ? Math.round(e.scoreSum / e.sessions) : 0, last: e.last };
    }).sort((a, b) => b.sessions - a.sessions || b.points - a.points);
  }

  /* ================= 每周星期训练节奏（v2.6）=================
   * 与 v2.4 时段分布互补：那个看“一天里什么时候练”，这个看“一周里星期几练”。
   * 把记录按星期（周一为一周起点）分桶统计节数/训练点/平均评分，找出最勤的一天，
   * 并拆工作日 vs 周末占比。口径继续复用 recPoints。 */
  const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  function weekdayIndex(ts) { return (new Date(ts).getDay() + 6) % 7; }   // JS 0=周日 → 转成周一为 0
  function weekdayRhythm(records) {
    const rs = Array.isArray(records) ? records : [];
    const acc = WEEKDAY_NAMES.map(() => ({ sessions: 0, points: 0, scoreSum: 0, scoreN: 0 }));
    rs.forEach(r => {
      if (!r || !Number.isFinite(r.ts)) return;
      const a = acc[weekdayIndex(r.ts)];
      a.sessions++; a.points += recPoints(r);
      if (Number.isFinite(r.score)) { a.scoreSum += r.score; a.scoreN++; }
    });
    const days = acc.map((a, i) => ({
      idx: i, name: WEEKDAY_NAMES[i], sessions: a.sessions, points: a.points,
      avgScore: a.scoreN ? Math.round(a.scoreSum / a.scoreN) : 0
    }));
    const total = days.reduce((s, d) => s + d.sessions, 0);
    let busiest = days[0];
    days.forEach(d => { if (d.sessions > busiest.sessions || (d.sessions === busiest.sessions && d.points > busiest.points)) busiest = d; });
    const weekend = days[5].sessions + days[6].sessions, weekday = total - weekend;
    return {
      days, total, busiestIdx: total ? busiest.idx : null, busiestName: total ? busiest.name : '',
      busiestSessions: total ? busiest.sessions : 0,
      weekdaySessions: weekday, weekendSessions: weekend,
      weekendPct: total ? Math.round(weekend / total * 100) : 0
    };
  }

  /* ================= 部位覆盖度（v2.7）=================
   * 把 13 个动作按主要锻炼部位归入五大块（下肢/核心/上肢/颈肩/侧链），
   * 统计每块练过的节数/训练点/命中动作数，看哪几块长期空白。口径仍复用 recPoints，
   * 关卡（game-）/循环（circuit）等非真动作 id 不计。 */
  const BODY_REGIONS = [
    { key: 'lower',   name: '下肢', ico: '\ud83e\uddb5', ids: ['squat', 'lunge', 'wallsit', 'highknees', 'jack'] },
    { key: 'core',    name: '核心', ico: '\ud83c\udfaf', ids: ['plank'] },
    { key: 'upper',   name: '上肢', ico: '\ud83d\udcaa', ids: ['pushup', 'sidraise', 'grasp'] },
    { key: 'neck',    name: '颈肩', ico: '\ud83e\uddd8', ids: ['headshake', 'wave', 'shrug'] },
    { key: 'lateral', name: '侧链', ico: '\ud83c\udf17', ids: ['sidestretch'] }
  ];
  function bodyCoverage(records) {
    const rs = Array.isArray(records) ? records : [];
    const R2 = {};
    BODY_REGIONS.forEach(r => r.ids.forEach(id => { R2[id] = r.key; }));
    const acc = {};
    BODY_REGIONS.forEach(r => { acc[r.key] = { sessions: 0, points: 0, ex: new Set() }; });
    rs.forEach(rec => {
      if (!rec || !rec.ex || !R2[rec.ex]) return;
      const a = acc[R2[rec.ex]];
      a.sessions++; a.points += recPoints(rec); a.ex.add(rec.ex);
    });
    const regions = BODY_REGIONS.map(r => ({
      key: r.key, name: r.name, ico: r.ico, poolSize: r.ids.length,
      sessions: acc[r.key].sessions, points: acc[r.key].points,
      exCovered: acc[r.key].ex.size, covered: acc[r.key].sessions > 0
    }));
    const regionCount = regions.length;
    const coveredCount = regions.filter(r => r.covered).length;
    const totalSessions = regions.reduce((s, r) => s + r.sessions, 0);
    const gaps = regions.filter(r => !r.covered).map(r => r.name);
    let weakest = null;
    regions.filter(r => r.covered).forEach(r => { if (!weakest || r.sessions < weakest.sessions) weakest = r; });
    return {
      regions, regionCount, coveredCount, totalSessions,
      coveragePct: Math.round(coveredCount / regionCount * 100),
      gaps, weakestName: weakest ? weakest.name : ''
    };
  }

  /* ================= 生涯总览（v2.8）=================
   * 跨全部记录累加节数/训练点/卡路里/时长，统计活跃天数/涵盖动作/首末训练日与最活跃的月份。
   * 点数口径仍复用 recPoints；涵盖动作只数真实动作库（关卡/循环不计）。 */
  function lifetimeStats(records) {
    const rs = Array.isArray(records) ? records : [];
    const exIds = new Set(EXERCISES.map(e => e.id));
    const ds = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
    let sessions = 0, points = 0, calories = 0, secs = 0, firstTs = Infinity, lastTs = 0;
    const daySet = new Set(), monthAcc = {}, exSeen = new Set();
    rs.forEach(r => {
      if (!r || !Number.isFinite(r.ts)) return;
      sessions++;
      points += recPoints(r);
      calories += Number(r.cal) || 0;
      secs += Number(r.secs) || 0;
      if (r.ts < firstTs) firstTs = r.ts;
      if (r.ts > lastTs) lastTs = r.ts;
      daySet.add(ds(r.ts));
      if (r.ex && exIds.has(r.ex)) exSeen.add(r.ex);
      const d = new Date(r.ts), mk = d.getFullYear() + '-' + d.getMonth();
      monthAcc[mk] = (monthAcc[mk] || 0) + 1;
    });
    let bmKey = null, bmN = 0;
    Object.keys(monthAcc).forEach(k => { if (monthAcc[k] > bmN) { bmN = monthAcc[k]; bmKey = k; } });
    let busiestMonth = null;
    if (bmKey) { const p = bmKey.split('-'); busiestMonth = { y: +p[0], m: +p[1], sessions: bmN, label: p[0] + '年' + (+p[1] + 1) + '月' }; }
    return {
      sessions, points, calories: Math.round(calories), secs: Math.round(secs),
      activeDays: daySet.size, distinctEx: exSeen.size, exTotal: EXERCISES.length,
      firstTs: sessions ? firstTs : 0, lastTs, months: Object.keys(monthAcc).length, busiestMonth
    };
  }

  /* ================= 纠错改善趋势（v2.9）=================
   * 把有合法 ts 的记录按时间升序对半分成“之前 / 最近”，逐条累加 r.issues 里的错误次数，
   * 比较两个半区“每节平均犯几次”的频率，判每个常见问题是改善/加重/消失/新出现。
   * 与教练记忆同一思路，但拉成时间轴上的趋势。纯函数可离线单测。 */
  function issueTrend(records) {
    const rs = (Array.isArray(records) ? records : []).filter(r => r && Number.isFinite(r.ts));
    rs.sort((a, b) => a.ts - b.ts);
    const n = rs.length;
    if (n < 2) return { items: [], enough: false, olderN: 0, recentN: 0 };
    const half = Math.floor(n / 2);
    const older = rs.slice(0, half), recent = rs.slice(half);
    const tally = g => { const o = {}; g.forEach(r => Object.entries(r.issues || {}).forEach(([k, v]) => { const c = Number(v) || 0; if (c > 0) o[k] = (o[k] || 0) + c; })); return o; };
    const oT = tally(older), rT = tally(recent);
    const keys = new Set([...Object.keys(oT), ...Object.keys(rT)]);
    const items = [...keys].map(k => {
      const oC = oT[k] || 0, rC = rT[k] || 0;
      const oRate = older.length ? oC / older.length : 0;
      const rRate = recent.length ? rC / recent.length : 0;
      let trend;
      if (oC === 0 && rC > 0) trend = 'new';
      else if (rC === 0 && oC > 0) trend = 'gone';
      else if (rRate <= oRate * 0.7) trend = 'better';
      else if (rRate >= oRate * 1.3) trend = 'worse';
      else trend = 'flat';
      return { key: k, total: oC + rC, older: oC, recent: rC, oRate, rRate, trend };
    }).filter(x => x.total > 0).sort((a, b) => b.total - a.total);
    return { items, enough: true, olderN: older.length, recentN: recent.length };
  }

  /* ================= 训练构成（v3.0）=================
   * 按练法把记录分入四类：计次力量 / 计时静力 / 体感关卡 / 循环跟练，
   * 统计各节数与训练点占比，看你是“力量型”还是“玩家型”。点数仍复用 recPoints。 */
  const MODE_SPLIT = [
    { key: 'reps',    name: '计次训练', ico: '\ud83d\udcaa' },
    { key: 'time',    name: '计时静力', ico: '\u23f3' },
    { key: 'game',    name: '体感关卡', ico: '\ud83c\udfae' },
    { key: 'circuit', name: '循环跟练', ico: '\ud83d\udd01' }
  ];
  function modeClassify(r) {
    if (r.ex === 'circuit') return 'circuit';
    if (r.mode === 'game') return 'game';
    if (r.mode === 'time') return 'time';
    return 'reps';
  }
  function modeSplit(records) {
    const rs = Array.isArray(records) ? records : [];
    const acc = {}; MODE_SPLIT.forEach(c => { acc[c.key] = { sessions: 0, points: 0 }; });
    let totalSessions = 0, totalPoints = 0;
    rs.forEach(r => {
      if (!r || !Number.isFinite(r.ts)) return;
      const k = modeClassify(r), p = recPoints(r);
      acc[k].sessions++; acc[k].points += p;
      totalSessions++; totalPoints += p;
    });
    const cats = MODE_SPLIT.map(c => ({
      key: c.key, name: c.name, ico: c.ico, sessions: acc[c.key].sessions, points: acc[c.key].points,
      pct: totalSessions ? Math.round(acc[c.key].sessions / totalSessions * 100) : 0
    }));
    let dominant = null;
    cats.forEach(c => { if (c.sessions && (!dominant || c.sessions > dominant.sessions || (c.sessions === dominant.sessions && c.points > dominant.points))) dominant = c; });
    return { cats, totalSessions, totalPoints, dominantKey: dominant ? dominant.key : null, dominantName: dominant ? dominant.name : '' };
  }

  /* ================= 表现走势（v3.1）=================
   * 把有评分的记录按时间升序等分成最多 5 段，逐段算平均表现分，看动作质量整体是
   * 在上升还是下降。与纠错趋势（v2.9）正交：那个看逐个问题的频率轨迹，这个看总体评分
   * 质量的轨迹；与周环比（v2.3）也不同：那个比训练量（点数），这个比质量（评分）。 */
  const SCORE_TREND_MAX_SEG = 5;
  function scoreTrend(records) {
    const rs = (Array.isArray(records) ? records : []).filter(r => r && Number.isFinite(r.ts) && Number.isFinite(r.score) && r.score > 0);
    rs.sort((a, b) => a.ts - b.ts);
    const n = rs.length;
    if (n < 2) return { enough: false, segments: [], n };
    const segCount = Math.min(SCORE_TREND_MAX_SEG, n);
    const base = Math.floor(n / segCount), rem = n % segCount;
    const segments = [];
    let idx = 0;
    for (let s = 0; s < segCount; s++) {
      const size = base + (s < rem ? 1 : 0);
      const slice = rs.slice(idx, idx + size); idx += size;
      const avg = Math.round(slice.reduce((a, r) => a + r.score, 0) / slice.length);
      segments.push({ i: s, n: slice.length, avg, fromTs: slice[0].ts, toTs: slice[slice.length - 1].ts });
    }
    const firstAvg = segments[0].avg, lastAvg = segments[segments.length - 1].avg;
    const overallAvg = Math.round(rs.reduce((a, r) => a + r.score, 0) / n);
    const delta = lastAvg - firstAvg;
    let trend = 'flat';
    if (delta >= 5) trend = 'up'; else if (delta <= -5) trend = 'down';
    let best = segments[0];
    segments.forEach(x => { if (x.avg > best.avg) best = x; });
    return { enough: true, n, segments, firstAvg, lastAvg, overallAvg, delta, trend, bestAvg: best.avg, bestIdx: best.i };
  }

  /* ================= 训练节奏（v3.2）=================
   * 把活跃自然日按时间排序，看相邻训练日隔了几天：平均间隔、最长空档、
   * 距今几天没练、折算每周频次，判你是“高频规律 / 隔天一练 / 随缘型”。
   * 与热力图的“连续打卡”不同视角：那个看最长连续，这个看整体节奏均匀度。 */
  const DAYMS = 864e5;
  function trainingCadence(records, opts) {
    const o = opts || {};
    const now = Number(o.today) || Date.now();
    const rs = (Array.isArray(records) ? records : []).filter(r => r && Number.isFinite(r.ts));
    const ds = t => { const x = new Date(t); x.setHours(0, 0, 0, 0); return x.getTime(); };
    const daySet = new Set(rs.map(r => ds(r.ts)));
    const days = [...daySet].sort((a, b) => a - b);
    const activeDays = days.length;
    const gaps = [];
    for (let i = 1; i < days.length; i++) gaps.push(Math.round((days[i] - days[i - 1]) / DAYMS));
    const totalSpan = activeDays > 1 ? Math.round((days[activeDays - 1] - days[0]) / DAYMS) : 0;
    const avgGap = gaps.length ? Math.round(totalSpan / gaps.length * 10) / 10 : 0;
    let longestGap = 0; gaps.forEach(g => { if (g > longestGap) longestGap = g; });
    const daysSinceLast = activeDays ? Math.round((ds(now) - days[activeDays - 1]) / DAYMS) : null;
    const perWeek = avgGap > 0 ? Math.round(7 / avgGap * 10) / 10 : 0;
    let rhythm = 'new';
    if (activeDays >= 2) { if (avgGap <= 2) rhythm = 'steady'; else if (avgGap <= 4) rhythm = 'regular'; else rhythm = 'casual'; }
    return { activeDays, gapCount: gaps.length, avgGap, longestGap, daysSinceLast, perWeek, rhythm, totalSpan };
  }

  window.DJX = {
    LAND, ang, mid, vis, visAll, pickSide, torsoH, uniq, HAND_CONNS,
    ISSUES, EXERCISES, analyzePosture, analyzePostureSide, mergePosture, planFromText, GAME_KINDS, makeGame,
    makeWeekPlan, WEEK_PLAN, TPL_MAX, templateOf, tplAdd, tplRemove, tplSafe, tplEstimate, tplName, exRoundSec,
    BACKUP_APP, BACKUP_VER, exportPayload, parseImport, sanitizeRecords, mergeRecords,
    recPoints, buildHeatmap, achStreaks, computeAchievements, weekCompare, daypartStats, DAYPARTS, personalBests, weekdayRhythm, WEEKDAY_NAMES, bodyCoverage, BODY_REGIONS, lifetimeStats, issueTrend, modeSplit, MODE_SPLIT, scoreTrend, trainingCadence,
    makeTracker(id) {
      return { squat: squatTracker, jack: jackTracker, highknees: highkneesTracker,
               pushup: pushupTracker, lunge: lungeTracker, plank: plankTracker,
               sidraise: sidRaiseTracker, sidestretch: sideStretchTracker, wallsit: wallSitTracker,
               headshake: headshakeTracker, wave: waveTracker, grasp: graspTracker,
               shrug: shrugTracker }[id]();
    }
  };
})();
