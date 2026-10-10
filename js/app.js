/* 动镜 DongJing v1.0 · 主应用
 * 纯前端：MediaPipe PoseLandmarker 本地推理（浏览器内运算，画面不上传）。
 * 数据全部内联，localStorage 持久化；file:// 双击可跑（模型走 https CDN）。
 */
(function () {
  'use strict';
  const X = window.DJX;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const L = X.LAND;

  /* ---------------- 存储 ---------------- */
  const KEY = 'dongjing_v1';
  const DEF = { records: [], posture: [], quota: { month: '', used: 0 }, set: { voice: true, sfx: true, mirror: true, weight: 60 }, pro: false };
  let DB = load();
  function load() {
    try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch (e) { return JSON.parse(JSON.stringify(DEF)); }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) {} }
  const monthKey = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1); };
  const FREE_QUOTA = 6;                       // 免费：每月完整训练次数
  const quotaUsed = () => (DB.quota.month === monthKey() ? DB.quota.used : 0);

  /* ---------------- 小工具 ---------------- */
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2200);
  }
  const fmtDate = ts => { const d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };

  /* ---------------- 音效（Web Audio 合成，无外部文件） ---------------- */
  let AC = null;
  function ac() { if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)(); return AC; }
  function tone(f0, f1, dur, type, gain) {
    if (!DB.set.sfx) return;
    try {
      const c = ac(), o = c.createOscillator(), g = c.createGain(), t = c.currentTime;
      o.type = type || 'sine'; o.frequency.setValueAtTime(f0, t);
      o.frequency.exponentialRampToValueAtTime(Math.max(40, f1), t + dur);
      g.gain.setValueAtTime(gain || 0.12, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
      o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + dur + 0.02);
    } catch (e) {}
  }
  const sfx = {
    good() { tone(880, 1400, 0.12, 'sine', 0.14); },
    bad() { tone(200, 130, 0.22, 'square', 0.06); },
    tick() { tone(600, 600, 0.06, 'sine', 0.08); },
    finish() { [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, f, 0.16, 'triangle', 0.14), i * 130)); }
  };

  /* ---------------- 语音纠错（Web Speech，节流） ---------------- */
  let lastSpeak = 0, zhVoice = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices ? speechSynthesis.getVoices() : [];
    zhVoice = vs.find(v => /zh|CN/i.test(v.lang) && /female|xiaoxiao|yun|hiu/i.test(v.name))
      || vs.find(v => /zh|CN/i.test(v.lang)) || null;
  }
  if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function speak(txt, force) {
    if (!DB.set.voice || !window.speechSynthesis) return;
    const now = Date.now();
    if (!force && now - lastSpeak < 1900) return;
    lastSpeak = now;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(txt);
      u.lang = 'zh-CN'; u.rate = 1.15; u.volume = 1;
      if (zhVoice) u.voice = zhVoice;
      speechSynthesis.speak(u);
    } catch (e) {}
  }

  /* ---------------- 路由 ---------------- */
  let curScreen = 'home';
  function go(name) {
    if (name !== 'train') stopTrainIfNeeded();
    if (name !== 'posture') endPosture();
    curScreen = name;
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.go === name));
    if (name === 'home') renderHome();
    if (name === 'report') renderReport();
    if (name === 'me') renderMe();
    refreshChip();
    releaseCam();
  }
  /* 离开训练/评估页时释放摄像头（相机灯熄灭） */
  function releaseCam() {
    if (curScreen !== 'train' && curScreen !== 'posture' && state.stream) {
      state.stream.getTracks().forEach(t => t.stop());
      state.stream = null; state.camPromise = null;
    }
  }
  function stopTrainIfNeeded() {
    const active = T.phase === 'live' || T.phase === 'rest' || T.phase === 'calib';
    if (!active) { endTrain('discard'); return; }
    if (T.validTot > 0 || T.attempts > 0 || T.timeSec > 3) endTrain('save');   // 导航离开：静默存成绩
    else endTrain('discard');
  }
  document.addEventListener('click', e => {
    const g = e.target.closest('[data-go]');
    if (g) { go(g.dataset.go); return; }
    const exb = e.target.closest('[data-ex]');
    if (exb) openTrain(exb.dataset.ex);
  });

  function refreshChip() {
    const c = $('#quota-chip');
    if (DB.pro) { c.textContent = 'PRO ✦'; c.className = 'chip pro'; }
    else { c.textContent = '免费 ' + quotaUsed() + '/' + FREE_QUOTA + ' 次本月'; c.className = 'chip'; }
  }

  /* ---------------- AI 引擎与摄像头 ---------------- */
  const state = { engine: null, enginePromise: null, vision: null, visionFiles: null,
    handEngine: null, handPromise: null, stream: null, camPromise: null, lastLm: null, lastHands: null, personOk: false };
  async function ensureEngine() {
    if (state.engine) return state.engine;
    if (state.enginePromise) return state.enginePromise;
    state.enginePromise = (async () => {
      const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
      const files = await vision.FilesetResolver.forVisionTasks(
        'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm');
      state.vision = vision; state.visionFiles = files;   // 供手部模型复用
      const model = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
      const mk = delegate => vision.PoseLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: model, delegate }, runningMode: 'VIDEO',
        minPoseDetectionConfidence: 0.4, minPosePresenceConfidence: 0.4, minTrackingConfidence: 0.4
      });
      try { state.engine = await mk('GPU'); }
      catch (e) { state.engine = await mk('CPU'); }
      return state.engine;
    })();
    state.enginePromise.catch(err => {
      state.enginePromise = null;                    // 允许重试：失败的 promise 不缓存
      $('#model-err-txt').textContent = '模型下载失败：' + (err.message || err) + '。请检查网络后重试（首次需联网约 5MB）。';
    });
    return state.enginePromise;
  }
  /* 手掌抓握专用：HandLandmarker 21 点，懒加载（仅抓握动作才下载 ~8MB） */
  async function ensureHandEngine() {
    if (state.handEngine) return state.handEngine;
    if (state.handPromise) return state.handPromise;
    state.handPromise = (async () => {
      await ensureEngine();
      const vision = state.vision;
      const model = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
      const mk = delegate => vision.HandLandmarker.createFromOptions(state.visionFiles, {
        baseOptions: { modelAssetPath: model, delegate }, runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4
      });
      try { state.handEngine = await mk('GPU'); }
      catch (e) { state.handEngine = await mk('CPU'); }
      return state.handEngine;
    })();
    state.handPromise.catch(() => { state.handPromise = null; });
    return state.handPromise;
  }
  async function ensureCam() {
    if (state.stream) return state.stream;
    if (state.camPromise) return state.camPromise;
    state.camPromise = navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false
    }).then(st => {
      state.stream = st;
      [$('#cam'), $('#pst-cam')].forEach(v => { v.srcObject = st; v.play().catch(() => {}); });
      return st;
    }).finally(() => { state.camPromise = null; });
    return state.camPromise;
  }
  function toPixels(lms, video) {
    if (!lms || !lms.length) return null;
    const out = lms.map(p => ({ x: p.x * video.videoWidth, y: p.y * video.videoHeight, v: p.visibility != null ? p.visibility : 1 }));
    /* 关键兼容：pose_landmarker lite 在 VIDEO 模式下常把所有 visibility 返回 0，
     * 但"检出了 landmarks"本身就意味着有人——此时整体回退为 1，否则骨架/校准全被可见度门槛误杀 */
    if (out.every(p => p.v <= 0.05)) out.forEach(p => { p.v = 1; });
    return out;
  }
  function toHands(res, video) {
    if (!res || !res.landmarks || !res.landmarks.length) return [];
    return res.landmarks.map((lm, i) => ({
      label: (res.handedness && res.handedness[i] && res.handedness[i][0]) ? res.handedness[i][0].categoryName : 'H' + i,
      lm: lm.map(p => ({ x: p.x * video.videoWidth, y: p.y * video.videoHeight }))
    }));
  }

  /* 骨骼连线 */
  const BONES = [[11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [24, 26], [26, 28], [0, 11], [0, 12], [27, 28]];
  function drawSkel(canvas, lm, tint, hands) {
    const ctx = canvas.getContext('2d');
    if (!lm && (!hands || !hands.length)) { ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    if (DB.set.mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.lineWidth = 3.5; ctx.strokeStyle = tint || 'rgba(57,217,138,.9)';
    ctx.shadowColor = 'rgba(57,217,138,.6)'; ctx.shadowBlur = 8;
    BONES.forEach(([a, b]) => {
      const pa = lm && lm[a], pb = lm && lm[b];
      if (!pa || !pb || pa.v < 0.1 || pb.v < 0.1) return;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    });
    ctx.fillStyle = '#fff';
    (lm || []).forEach((p, i) => {
      if (i > 28 || p.v < 0.1) return;
      ctx.beginPath(); ctx.arc(p.x, p.y, i < 11 ? 2.5 : 4, 0, 7); ctx.fill();
    });
    /* 手部 21 点细节骨骼（抓握等手指级动作） */
    if (hands && hands.length) {
      ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(37,182,240,.95)';
      ctx.shadowColor = 'rgba(37,182,240,.7)';
      hands.forEach(h => {
        X.HAND_CONNS.forEach(([a, b]) => {
          ctx.beginPath(); ctx.moveTo(h.lm[a].x, h.lm[a].y); ctx.lineTo(h.lm[b].x, h.lm[b].y); ctx.stroke();
        });
        ctx.fillStyle = '#7ef0ff';
        h.lm.forEach((p, i) => { ctx.beginPath(); ctx.arc(p.x, p.y, i === 0 ? 4 : 2.6, 0, 7); ctx.fill(); });
      });
    }
    ctx.restore();
  }

  /* ---------------- 主检测循环（训练 & 评估共用） ---------------- */
  let rafId = null, lastDetectTs = 0, fpsCnt = 0, fpsT = 0;
  function startLoop(video, canvas, onFrame) {
    stopLoop();
    let localT = 0;
    const step = async () => {
      rafId = requestAnimationFrame(step);
      if (!state.engine || video.readyState < 2 || !video.videoWidth) return;
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const ts = performance.now();
      if (ts - lastDetectTs < 28) return;               // ~35fps 上限
      lastDetectTs = ts;
      let res;
      try { res = state.engine.detectForVideo(video, ts); }
      catch (e) { console.warn('[dongjing] detectForVideo 异常:', e); return; }
      const lm = toPixels(res.poseLandmarks && res.poseLandmarks.length ? res.poseLandmarks : null, video);
      state.lastLm = lm;
      /* 手指级动作：同帧跑 HandLandmarker，结果沿用到下一帧（隔帧降本） */
      if (T.ex && T.ex.hands && (T.phase === 'live' || T.phase === 'calib') && state.handEngine) {
        if (!step.handHop) {
          try { state.lastHands = toHands(state.handEngine.detectForVideo(video, ts), video); } catch (e) {}
        }
        step.handHop = !step.handHop;
      } else state.lastHands = null;
      drawSkel(canvas, lm, null, state.lastHands);
      fpsCnt++; if (ts - fpsT > 1000) { hudFps(fpsCnt); fpsCnt = 0; fpsT = ts; }
      onFrame(lm, ts, localT = Math.min(0.2, Math.max(0.004, (ts - (onFrame._last || ts)) / 1000)) * 1000, state.lastHands, onFrame._last = ts);
    };
    step();
  }
  function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = null; }
  function hudFps(n) { const el = $('#hud-fps'); if (el) el.textContent = n + ' fps'; }

  /* ---------------- 训练流程 ---------------- */
  const T = {
    ex: null, tracker: null, phase: 'off',       // off|setup|calib|live|rest|done
    setIdx: 0, validSet: 0, validTot: 0, attempts: 0,
    issues: {}, timeSec: 0, badSec: 0, activeMs: 0, poseOkMs: 0,
    liveAt: {}, fbAt: {}
  };
  function findEx(id) { return X.EXERCISES.find(e => e.id === id); }

  async function openTrain(id) {
    const ex = findEx(id);
    if (!ex) return;
    if (!ex.free && !DB.pro) { openPro('「' + ex.name + '」是 Pro 动作，升级后不限次练习'); return; }
    if (!DB.pro && quotaUsed() >= FREE_QUOTA) { openPro('本月免费训练次数已用完，升级 Pro 不限次'); return; }
    Object.assign(T, { ex, tracker: X.makeTracker(id), phase: 'setup', setIdx: 0, validSet: 0, validTot: 0,
      attempts: 0, issues: {}, timeSec: 0, badSec: 0, activeMs: 0, poseOkMs: 0, liveAt: {}, fbAt: {} });
    go('train');
    state.lastHands = null;
    $('#hud').hidden = true; $('#mask-rest').hidden = true;
    $('#setup-ico').textContent = ex.view === 'side' ? '📐' : (ex.seated ? '🪑' : '📷');
    $('#setup-title').textContent = (ex.view === 'side' ? '机位：侧面' : '机位：正面') + (ex.seated ? ' · 坐姿即可' : '');
    $('#setup-txt').textContent = ex.setup;
    $('#side-name').textContent = ex.name + ' · 要领';
    $('#side-tips').innerHTML = ex.tips.map(t => '<li>' + t + '</li>').join('');
    $('#side-issues').textContent = '暂无';
    $('#hud-name').textContent = ex.name;
    $('#mask-setup').hidden = false;
    startTipRotator();
    bootPreview();
  }
  /* 进页即预热摄像头+模型：检测到人立刻骨架伴随（半透明引导遮罩下可见） */
  async function bootPreview() {
    try {
      await ensureCam();
      $('#cam').classList.toggle('no-mirror', !DB.set.mirror);
      if (T.phase === 'setup') {
        const start = () => { if (T.phase === 'setup') startLoop($('#cam'), $('#skel'), onTrainFrame); };
        if (state.engine) { start(); }
        else {
          const el = $('#setup-person');
          el.textContent = '正在加载 AI 模型（首次约 5MB）…';
          el.className = 'setup-hint';
          ensureEngine().then(start).catch(() => {});
        }
      }
    } catch (e) { /* 失败不阻断，bootTrainStage 会统一引导 */ }
  }
  $('#btn-setup-ok').onclick = bootTrainStage;
  $('#btn-retry-model').onclick = bootTrainStage;
  /* 相机 → 模型 → 校准，遮罩互斥逐步推进；任一步失败停在对应遮罩上可重试 */
  async function bootTrainStage() {
    $('#mask-setup').hidden = true; $('#mask-cam').hidden = true; $('#mask-calib').hidden = true;
    $('#btn-retry-model').hidden = true;
    $('#model-err-txt').textContent = '首次使用需联网下载姿态模型（约 5MB，之后走缓存）。';
    $('#mask-model').hidden = false;
    try {
      await ensureCam();
      $('#cam').classList.toggle('no-mirror', !DB.set.mirror);
    } catch (e) {
      $('#mask-model').hidden = true;
      $('#mask-cam').hidden = false;
      $('#cam-err-txt').textContent = '摄像头开启失败：' + e.message + '。请允许权限，或检查是否有其他程序占用。';
      return;
    }
    try { await ensureEngine(); } catch (e) { /* 错误文案已在 ensureEngine 内写 */ }
    if (!state.engine) { $('#btn-retry-model').hidden = false; return; }
    if (T.ex && T.ex.hands) {
      $('#model-err-txt').textContent = '抓握动作需额外加载手部精细模型（约 8MB，仅首次）…';
      try { await ensureHandEngine(); } catch (e) { /* 下方统一处理 */ }
      if (!state.handEngine) {
        $('#model-err-txt').textContent = '手部模型下载失败：请检查网络后重试（约 8MB）。';
        $('#btn-retry-model').hidden = false; return;
      }
      $('#model-err-txt').textContent = '首次使用需联网下载姿态模型（约 5MB，之后走缓存）。';
    }
    $('#mask-model').hidden = true;
    $('#mask-calib').hidden = false;
    T.phase = 'calib';
    startLoop($('#cam'), $('#skel'), onTrainFrame);
  }
  $('#btn-retry-cam').onclick = () => { state.camPromise = null; state.stream = null; bootTrainStage(); };
  $('#btn-quit').onclick = () => {
    if (T.validTot > 0 || T.attempts > 0 || T.timeSec > 3) endTrain('saveShow');
    else { endTrain('discard'); go('home'); toast('已退出训练'); }
  };

  function setStatus(txt, ok) {
    const s = $('#hud-person'); s.textContent = txt; s.className = 'hud-status' + (ok ? ' ok' : '');
  }
  function setHud() {
    $('#hud-rep').textContent = T.ex.mode === 'time' ? Math.floor(T.timeSec) : T.validSet;
    $('#hud-target').textContent = T.ex.mode === 'time' ? 's /' + T.ex.target + 's' : '/' + T.ex.target;
    $('#hud-set').textContent = '第 ' + (T.setIdx + 1) + ' / ' + T.ex.sets + ' 组 · 累计有效 ' + T.validTot;
  }
  function feedback(msg, cls, key, voice, interval) {
    const now = Date.now();
    const gate = key || msg;
    const min = interval || (cls === 'warn' ? 2100 : 400);
    if (T.fbAt[gate] && now - T.fbAt[gate] < min) return;
    T.fbAt[gate] = now;
    const box = $('#feedback');
    const el = document.createElement('div');
    el.className = 'fb-item ' + (cls || 'good'); el.textContent = msg;
    box.appendChild(el);
    while (box.children.length > 2) box.removeChild(box.firstChild);
    setTimeout(() => el.remove(), 1600);
    if (voice) speak(msg, cls === 'bad');
  }

  function onTrainFrame(lm, ts, dt, hands) {
    const ex = T.ex;
    if (T.phase === 'setup') {
      const ok = !!lm && X.visAll(lm, ex.keys);
      const el = $('#setup-person');
      el.textContent = ok ? '✓ 已检测到人，骨架已跟上，点下方按钮继续' : (ex.seated ? '未检测到人：请正对镜头，上半身入镜' : '未检测到人：请调整机位，让全身入镜');
      el.className = 'setup-hint' + (ok ? ' ok' : '');
      return;
    }
    if (T.phase === 'rest') return;
    if (!lm || !X.visAll(lm, ex.keys)) {
      setStatus(ex.seated ? '请正对镜头，上半身入镜' : '退后一步，全身入镜', false);
      return;
    }
    setStatus('已识别 · ' + ex.name, true);

    if (T.phase === 'calib') {
      const ok = ex.start(lm, hands);
      $('#calib-txt').textContent = ok ? '姿势正确，即将开始…' : '请先摆好起始姿势：' + calibHint(ex);
      $('#calib-ico').className = 'calib-ico' + (ok ? ' ok' : '');
      if (ok) {
        T.poseOkMs += dt;
        if (T.poseOkMs > 900) {
          T.phase = 'live'; $('#mask-calib').hidden = true; $('#hud').hidden = false;
          if (!DB.pro) { DB.quota = { month: monthKey(), used: quotaUsed() + 1 }; save(); refreshChip(); }
          feedback('开始！目标 ' + (ex.mode === 'time' ? ex.target + ' 秒' : ex.target + ' 次'), 'good', 'start', true);
          setHud();
        }
      } else T.poseOkMs = 0;
      return;
    }
    if (T.phase !== 'live') return;
    T.activeMs += dt;

    const r = T.tracker.feed(lm, ts, dt, hands);
    $('#hud-phase').textContent = r.phase || '';
    /* 实时预警（不扣次数） */
    (r.live || []).forEach(k => {
      const it = X.ISSUES[k]; if (!it) return;
      feedback('⚠ ' + it.msg, 'warn', k, true);
      const now = Date.now();                     // 计数节流：同一问题 3s 内只记一次，避免逐帧虚高
      if (!T.liveAt[k] || now - T.liveAt[k] > 3000) { T.liveAt[k] = now; bumpIssue(k, true); }
    });

    if (ex.mode === 'time') {
      if (r.rep) {
        if (r.rep.valid) T.timeSec += r.rep.seconds;
        else {
          T.badSec += dt / 1000;
          (r.rep.issues || []).forEach(k => {
            feedback('⚠ ' + X.ISSUES[k].msg, 'warn', k, true);
            const now = Date.now();
            if (!T.liveAt[k] || now - T.liveAt[k] > 3000) { T.liveAt[k] = now; bumpIssue(k, true); }
          });
        }
      }
      setHud();
      if (T.timeSec >= ex.target) completeSet();
      return;
    }

    if (r.rep) {
      T.attempts++;
      if (r.rep.valid) {
        T.validSet++; T.validTot++;
        $('#hud-rep').classList.remove('pop'); void $('#hud-rep').offsetWidth; $('#hud-rep').classList.add('pop');
        sfx.good();
        const minor = r.rep.issues.filter(k => !X.ISSUES[k].severe);
        feedback(minor.length ? '✓ 计入，但 ' + X.ISSUES[minor[0]].msg : '✓ 标准 +1', minor.length ? 'warn' : 'good', 'rep' + T.validTot, minor.length ? true : false, 250);
      } else {
        sfx.bad();
        const severe = r.rep.issues.filter(k => X.ISSUES[k].severe);
        (r.rep.issues || []).forEach(k => bumpIssue(k, false));
        feedback('✗ ' + (severe[0] ? X.ISSUES[severe[0]].msg : '动作不计入'), 'bad', 'bad' + T.attempts, true, 0);
      }
      setHud();
      if (T.validSet >= ex.target) completeSet();
    }
  }
  function calibHint(ex) {
    return { squat: '自然站直', jack: '双脚并拢、双手垂放', highknees: '原地站直', pushup: '撑起手臂、身体一条直线', lunge: '自然站直', plank: '俯身撑好',
      headshake: '坐在椅上身直目视镜头', wave: '双手垂放准备举起', grasp: '举起双手、张开五指' }[ex.id] || '站直';
  }
  function bumpIssue(k, liveOnly) {
    T.issues[k] = (T.issues[k] || 0) + (liveOnly ? 0.34 : 1); // live 预警折算，避免刷屏虚高
  }
  function completeSet() {
    T.phase = 'rest';
    speak('第 ' + (T.setIdx + 1) + ' 组完成，休息', true);
    if (T.setIdx + 1 >= T.ex.sets) { endTrain('saveShow'); return; }
    $('#mask-rest').hidden = false;
    $('#rest-txt').textContent = '下一组：第 ' + (T.setIdx + 2) + ' / ' + T.ex.sets + ' 组';
    let sec = 15;
    $('#rest-num').textContent = sec;
    const iv = setInterval(() => {
      if (T.phase !== 'rest') { clearInterval(iv); return; }
      sec--; $('#rest-num').textContent = sec; sfx.tick();
      if (sec <= 0) {
        clearInterval(iv); $('#mask-rest').hidden = true;
        T.setIdx++; T.validSet = 0; T.tracker = X.makeTracker(T.ex.id);
        if (T.ex.mode === 'time') T.timeSec = 0;
        T.phase = 'live'; setHud();
        feedback('开始第 ' + (T.setIdx + 1) + ' 组！', 'good', 'set' + T.setIdx, true);
      }
    }, 1000);
  }

  function endTrain(mode) {   // 'discard' | 'save' | 'saveShow'
    stopLoop(); stopTipRotator();
    T.phase = 'off';
    $('#hud').hidden = true; $('#mask-calib').hidden = true; $('#mask-rest').hidden = true;
    if (mode === 'save' || mode === 'saveShow') {
      const rec = saveResult();
      if (mode === 'saveShow') showResult(rec);
    }
  }

  function saveResult() {
    const ex = T.ex;
    const attempts = ex.mode === 'time' ? Math.max(1, Math.round(T.timeSec)) : T.attempts;
    const valid = ex.mode === 'time' ? Math.floor(T.timeSec) : T.validTot;
    let score;
    if (ex.mode === 'time') {
      score = Math.max(40, Math.round(100 * T.timeSec / (T.timeSec + T.badSec * 0.8 + 0.001)));
    } else score = attempts ? Math.round(100 * valid / attempts) : 0;
    const mins = T.activeMs / 60000;
    const kcal = +(ex.met * DB.set.weight * mins).toFixed(1);
    const rec = { ts: Date.now(), ex: ex.id, name: ex.name, mode: ex.mode,
      valid, attempts: ex.mode === 'time' ? valid : attempts, secs: Math.round(T.activeMs / 1000),
      cal: kcal, score, issues: Object.fromEntries(Object.entries(T.issues).map(([k, v]) => [k, Math.round(v)])) };
    DB.records.unshift(rec);
    DB.records = DB.records.slice(0, 200);
    save();
    return rec;
  }

  function showResult(rec) {
    $('#res-title').textContent = rec.score >= 85 ? '漂亮！动作很标准 💪' : rec.score >= 60 ? '完成！注意动作质量 🔥' : '完成！先把动作做对再冲量 🧱';
    $('#res-emoji').textContent = rec.score >= 85 ? '🏆' : '💪';
    $('#res-score').textContent = rec.score;
    $('#res-reps').textContent = rec.mode === 'time' ? rec.valid + 's' : rec.valid;
    $('#res-bad').textContent = rec.mode === 'time' ? '—' : Math.max(0, rec.attempts - rec.valid);
    $('#res-dur').textContent = rec.secs + 's';
    $('#res-cal').textContent = rec.cal;
    const iss = Object.entries(rec.issues).sort((a, b) => b[1] - a[1]).slice(0, 4);
    $('#res-issues').innerHTML = iss.length
      ? iss.map(([k, n]) => '<div class="ri"><span>' + (X.ISSUES[k] ? X.ISSUES[k].msg : k) + '</span><b>×' + n + '</b></div>').join('')
      : '<div class="ri"><span>本次没有明显动作问题 👏</span></div>';
    go('result');
    sfx.finish();
  }
  $('#btn-again').onclick = () => openTrain(T.ex ? T.ex.id : 'squat');

  /* 训练侧栏小贴士轮播 */
  const TIPS = [
    '<b>办公室 5 分钟：</b>开合跳 30 次 + 高抬腿 20 次，心率上来效率翻倍。',
    '<b>先做对，再做多：</b>动镜只计标准次数，错误动作不计入，正是这个逻辑。',
    '<b>呼吸节奏：</b>发力时呼气，还原时吸气，全程不憋气。',
    '<b>膝内扣是自损第一名：</b>深蹲时想象"把地板向两侧拧开"。',
    '<b>久坐警报：</b>每 60 分钟起身做 10 个深蹲，腰不酸。',
    '<b>平板关键在骨盆：</b>微微收尾骨、夹紧臀部，比撑得久更重要。'
  ];
  let tipTimer = null;
  function startTipRotator() {
    stopTipRotator();
    let i = Math.floor(Math.random() * TIPS.length);
    const upd = () => { $('#tip-rotator').innerHTML = '💡 ' + TIPS[i % TIPS.length]; i++; };
    upd(); tipTimer = setInterval(upd, 9000);
  }
  function stopTipRotator() { if (tipTimer) { clearInterval(tipTimer); tipTimer = null; } }

  /* ---------------- 体态评估 ---------------- */
  const P = { on: false, samples: [], needLeft: 6, iv: null };
  $('#btn-pst-start').onclick = async () => {
    if (P.on) return;
    $('#pst-intro').hidden = true; $('#pst-result').hidden = true; $('#pst-stage').hidden = false;
    $('#pst-cam').classList.toggle('no-mirror', !DB.set.mirror);
    try { await ensureCam(); } catch (e) { toast('摄像头开启失败：' + e.message); return; }
    try { await ensureEngine(); } catch (e) { toast('模型加载失败，请检查网络'); return; }
    P.on = true; P.samples = []; P.needLeft = 6;
    startLoop($('#pst-cam'), $('#pst-skel'), onPostureFrame);
  };
  function onPostureFrame(lm, ts, dt) {
    if (!P.on) return;
    const okKeys = X.visAll(lm, [0, 11, 12, 23, 24]) && (X.vis(lm, L.L_AN) || X.vis(lm, L.R_AN) || X.vis(lm, L.L_KNEE));
    $('#pst-txt').textContent = okKeys ? '保持自然站直，目视前方…' : '请全身入镜（至少到膝盖），正面朝向镜头';
    if (!okKeys) return;
    if (!P.tick) P.tick = 0;
    P.tick += dt;
    if (P.tick >= 250) { P.tick = 0; P.samples.push(lm); P.needLeft--; $('#pst-count').textContent = Math.max(0, P.needLeft); sfx.tick(); }
    if (P.needLeft <= 0) {
      P.on = false; stopLoop();
      const r = X.analyzePosture(P.samples);
      $('#pst-stage').hidden = true; $('#pst-result').hidden = false;
      if (!r) { toast('未捕捉到完整姿态，请重试'); $('#pst-intro').hidden = false; $('#pst-result').hidden = true; return; }
      $('#pst-score').textContent = r.score;
      $('#pst-items').innerHTML = r.items.map(it =>
        '<div class="pst-item"><span>' + it.name + '</span><span class="lvl ' + it.cls + '">' + it.level + ' · ' + it.pct + '</span></div>').join('');
      $('#pst-advice').innerHTML = r.items.map(it => '· ' + it.advice).join('<br>') + '<br><span class="tiny">' + r.note + '</span>';
      DB.posture.unshift({ ts: Date.now(), score: r.score, items: r.items });
      DB.posture = DB.posture.slice(0, 30); save();
      speak('评估完成，体面评分 ' + r.score + ' 分', true);
    }
  }
  $('#btn-pst-quit').onclick = () => { P.on = false; stopLoop(); endPosture(); $('#pst-stage').hidden = true; $('#pst-intro').hidden = false; };
  $('#btn-pst-again').onclick = () => { $('#pst-result').hidden = true; $('#pst-intro').hidden = false; go('posture'); };
  function endPosture() { P.on = false; P.samples = []; P.tick = 0; }

  /* ---------------- 首页 ---------------- */
  function bestOf(exId) {
    const rs = DB.records.filter(r => r.ex === exId && r.mode === 'reps');
    return rs.length ? Math.max(...rs.map(r => r.valid)) : null;
  }
  function renderHome() {
    $('#ex-grid').innerHTML = X.EXERCISES.map(ex => {
      const locked = !ex.free && !DB.pro;
      const best = bestOf(ex.id);
      return '<div class="card ex-card' + (locked ? ' locked' : '') + '" data-ex="' + ex.id + '">' +
        (locked ? '<span class="lock">🔒 Pro</span>' : best != null ? '<span class="best">最佳 ' + best + '</span>' : '') +
        '<div class="ico">' + ex.ico + '</div><h4>' + ex.name + '</h4>' +
        '<div class="desc">' + ex.desc + '</div>' +
        '<div class="meta"><span>' + (ex.seated ? '坐姿可练' : (ex.view === 'side' ? '侧面机位' : '正面机位')) + '</span>' +
        (ex.hands ? '<span>手指级</span>' : '') +
        '<span>' + (ex.mode === 'time' ? ex.target + 's×' + ex.sets : ex.target + '×' + ex.sets) + '</span>' +
        '<span>' + '★'.repeat(ex.diff) + '</span></div></div>';
    }).join('');
    $('#hs-week').textContent = weekSessions();
    $('#hs-reps').textContent = weekValidReps();
    $('#hs-days').textContent = streakDays();
    refreshChip();
  }

  /* ---------------- 统计 ---------------- */
  const dayStart = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
  function weekSessions() {
    const from = dayStart(Date.now()) - 6 * 864e5;
    return DB.records.filter(r => r.ts >= from).length;
  }
  function weekValidReps() {
    const from = dayStart(Date.now()) - 6 * 864e5;
    return DB.records.filter(r => r.ts >= from).reduce((s, r) => s + r.valid, 0);
  }
  function streakDays() {
    const days = new Set(DB.records.map(r => dayStart(r.ts)));
    let n = 0, d = dayStart(Date.now());
    if (!days.has(d)) d -= 864e5;                     // 今天没练则从昨天起算
    while (days.has(d)) { n++; d -= 864e5; }
    return n;
  }

  /* ---------------- 报告页 ---------------- */
  function renderReport() {
    const WD = ['日', '一', '二', '三', '四', '五', '六'];
    const today = dayStart(Date.now());
    const bars = [];
    for (let i = 6; i >= 0; i--) {
      const d = today - i * 864e5;
      const rs = DB.records.filter(r => dayStart(r.ts) === d);
      bars.push({ label: WD[new Date(d).getDay()], n: rs.length, reps: rs.reduce((s, r) => s + r.valid, 0) });
    }
    const max = Math.max(1, ...bars.map(b => b.n));
    $('#week-bars').innerHTML = bars.map(b =>
      '<div class="wbar' + (b.n ? '' : ' zero') + '"><b>' + (b.n || '') + '</b><i style="height:' + (b.n / max * 100) + '%"></i><span>' + b.label + '</span></div>').join('');
    const agg = {};
    DB.records.forEach(r => Object.entries(r.issues || {}).forEach(([k, v]) => agg[k] = (agg[k] || 0) + v));
    const top = Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 5);
    $('#top-issues').innerHTML = top.length
      ? top.map(([k, n]) => '<div class="ti"><span>' + (X.ISSUES[k] ? X.ISSUES[k].msg : k) + '</span><b>×' + n + '</b></div>').join('')
      : '<div class="empty-tip">还没有动作问题记录，继续保持 ✦</div>';
    $('#hist-list').innerHTML = DB.records.length
      ? '<div class="hist-row head"><span>时间</span><span>动作</span><span>有效</span><span>评分</span><span>千卡</span></div>' +
        DB.records.slice(0, 40).map(r =>
          '<div class="hist-row"><span>' + fmtDate(r.ts) + '</span><span>' + r.name + (r.mode === 'time' ? '（' + r.valid + 's）' : '') + '</span><b>' + (r.mode === 'time' ? r.valid + 's' : r.valid + '/' + r.attempts) + '</span><span>' + r.score + '</span><span>' + r.cal + '</span></div>').join('')
      : '<div class="empty-tip">暂无记录，去首页开始第一次训练吧</div>';
  }

  /* ---------------- 我的 / Pro ---------------- */
  function renderMe() {
    $('#me-plan').innerHTML = DB.pro ? '<span class="plan-badge pro">动镜 Pro ✦</span>' : '<span class="plan-badge free">免费版</span>';
    $('#me-quota').textContent = DB.pro ? '全部动作 · 不限训练次数'
      : '本月已训练 ' + quotaUsed() + ' / ' + FREE_QUOTA + ' 次 · 基础 3 动作免费';
    $('#chk-demo-pro').checked = !!DB.pro;
    $('#inp-weight').value = DB.set.weight;
    $('#chk-voice2').checked = DB.set.voice;
    $('#btn-voice').textContent = DB.set.voice ? '🔊' : '🔇';
    $('#chk-sfx').checked = DB.set.sfx;
    $('#chk-mirror').checked = DB.set.mirror;
  }
  function openPro(reason) {
    $('#modal-pro').querySelector('p.muted').textContent = (reason || '') + ' 解锁全部动作 · 不限次数 · 体态趋势 · 报表详情';
    $('#modal-pro').hidden = false;
  }
  $$('[data-close]').forEach(b => b.onclick = () => $('#modal-pro').hidden = true);
  $('#modal-pro').addEventListener('click', e => { if (e.target.id === 'modal-pro') $('#modal-pro').hidden = true; });
  $('#btn-pro-demo').onclick = () => {
    DB.pro = true; save(); $('#modal-pro').hidden = true; renderHome(); renderMe();
    toast('已本地激活 Pro（演示模式，支付通道 P1 接入）');
  };
  $('#btn-upgrade').onclick = () => openPro(DB.pro ? '你已在演示 Pro 状态' : '升级 Pro');
  $('#chk-demo-pro').onchange = e => { DB.pro = e.target.checked; save(); renderMe(); renderHome(); toast(DB.pro ? '演示 Pro 已激活' : '已切回免费版'); };
  $('#inp-weight').onchange = e => { DB.set.weight = Math.min(200, Math.max(30, +e.target.value || 60)); save(); };
  const bindSet = (sel, key, cb) => { $(sel).onchange = e => { DB.set[key] = e.target.checked; save(); if (cb) cb(e.target.checked); }; };
  bindSet('#chk-voice2', 'voice', v => { $('#btn-voice').textContent = v ? '🔊' : '🔇'; if (!v) window.speechSynthesis && speechSynthesis.cancel(); });
  bindSet('#chk-sfx', 'sfx');
  bindSet('#chk-mirror', 'mirror', v => { $('#cam').classList.toggle('no-mirror', !v); $('#pst-cam').classList.toggle('no-mirror', !v); });
  $('#btn-voice').onclick = () => { DB.set.voice = !DB.set.voice; save(); renderMe(); toast(DB.set.voice ? '语音纠错已开启' : '语音纠错已关闭'); };

  /* ---------------- 启动 ---------------- */
  renderHome(); renderMe(); refreshChip();
  window.__dongjing = { state, DB };   // 调试句柄：控制台可读 lastLm/visibility 做远程诊断
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#modal-pro').hidden) $('#modal-pro').hidden = true;
    if (e.key === 'Escape' && curScreen === 'train' && (T.validTot || T.attempts || T.timeSec)) { endTrain(true); }
    else if (e.key === 'Escape' && curScreen === 'train') go('home');
  });
})();
