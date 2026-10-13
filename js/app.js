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

  /* ---------------- 设备与环境探测（移动端 / iOS Safari / 微信内 专项） ----------------
   * 手机是“办公室即练”的主入口，而这些坑不处理就是直接打不开：
   * 微信内置浏览器无 getUserMedia；iOS 要用户手势才允许发音；移动端满分辨率+高帧率会发热降帧。 */
  const UA = navigator.userAgent || '';
  const IS_IOS = /iP(hone|ad|od)/.test(UA) || (/Macintosh/.test(UA) && navigator.maxTouchPoints > 1);
  const IS_ANDROID = /Android/i.test(UA);
  const IS_MOBILE = IS_IOS || IS_ANDROID || (navigator.maxTouchPoints > 1 && innerWidth < 900);
  const IN_WX = /MicroMessenger|WeChat|wxwork/i.test(UA);
  const DETECT_GAP = IS_MOBILE ? 55 : 28;      // 移动端 ~18fps 保续航，桌面 ~35fps 保跟手

  /* ---------------- 存储 ---------------- */
  const KEY = 'dongjing_v1';
  const DEF = { records: [], posture: [], quota: { month: '', used: 0 }, set: { voice: true, sfx: true, mirror: true, weight: 60, dailyGoal: 30 }, pro: false, templates: [] };
  let DB = load();
  function load() {
    try {
      const o = Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY) || '{}'));
      o.set = Object.assign({}, DEF.set, o.set || {});   // 旧数据补齐新增设置项（dailyGoal 等）
      if (!Array.isArray(o.templates)) o.templates = []; // v1.9 迁移：旧 DB 无 templates 字段
      return o;
    } catch (e) { return JSON.parse(JSON.stringify(DEF)); }
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
  let lastSpeak = 0, zhVoice = null, speechUnlocked = false, kbIv = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices ? speechSynthesis.getVoices() : [];
    zhVoice = vs.find(v => /zh|CN/i.test(v.lang) && /female|xiaoxiao|yun|hiu/i.test(v.name))
      || vs.find(v => /zh|CN/i.test(v.lang)) || null;
  }
  if (window.speechSynthesis) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  /* iOS/Safari：只有在用户手势里说过话，之后程序触发的语音才肯响——第一次点击时静默解锁 */
  function unlockSpeech() {
    if (speechUnlocked || !window.speechSynthesis) return;
    speechUnlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0; u.lang = 'zh-CN';
      speechSynthesis.speak(u);
      document.removeEventListener('click', unlockSpeech, true);
      document.removeEventListener('touchstart', unlockSpeech, true);
    } catch (e) {}
  }
  document.addEventListener('click', unlockSpeech, true);
  document.addEventListener('touchstart', unlockSpeech, true);
  /* iOS 会在长句中途静挂起语音：朗读期间做一次 pause/resume 心跳保活 */
  function keepAliveSpeak(on) {
    clearInterval(kbIv); kbIv = null;
    if (!on || !window.speechSynthesis) return;
    kbIv = setInterval(() => {
      try { if (speechSynthesis.speaking && !speechSynthesis.paused) { speechSynthesis.pause(); speechSynthesis.resume(); } } catch (e) {}
    }, 9000);
  }
  function speak(txt, force) {
    if (!DB.set.voice || !window.speechSynthesis) return;
    const now = Date.now();
    if (!force && now - lastSpeak < 1900) return;
    lastSpeak = now;
    try {
      speechSynthesis.cancel();
      if (speechSynthesis.paused) speechSynthesis.resume();
      const u = new SpeechSynthesisUtterance(txt);
      u.lang = 'zh-CN'; u.rate = 1.15; u.volume = 1;
      if (zhVoice) u.voice = zhVoice;
      u.onend = () => { clearInterval(kbIv); kbIv = null; };
      speechSynthesis.speak(u);
      keepAliveSpeak(true);
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
    if (T.phase === 'game') { endTrain('discard'); return; }   // 关卡中途离开：半局成绩没意义
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
      video: IS_MOBILE
        ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }   // 手机：降分辨率跑满帧，不发热
        : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false
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
  /* 示范小人模板（归一化坐标，按动作类型选站姿/坐姿/侧面俯撑） */
  function ghostPose(ex) {
    const P = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0 }));
    const put = (i, x, y) => { P[i] = { x, y, v: 1 }; };
    if (ex && ex.seated) {                       // 坐姿：手放膝上
      put(0, .5, .2); put(7, .46, .19); put(8, .54, .19);
      put(11, .43, .32); put(12, .57, .32);
      put(13, .39, .43); put(14, .61, .43);
      put(15, .43, .52); put(16, .57, .52);
      put(23, .44, .56); put(24, .56, .56);
      put(25, .42, .68); put(26, .58, .68);
      put(27, .41, .8); put(28, .59, .8);
    } else if (ex && ex.view === 'side') {       // 侧面：俯撑/平板姿态
      put(0, .3, .24); put(7, .28, .23); put(8, .32, .23);
      put(11, .4, .36); put(12, .42, .36);
      put(13, .48, .48); put(14, .5, .48);
      put(15, .54, .62); put(16, .56, .62);
      put(23, .44, .56); put(24, .46, .56);
      put(25, .6, .66); put(26, .62, .66);
      put(27, .76, .78); put(28, .78, .78);
    } else {                                     // 正面站立
      put(0, .5, .13); put(7, .46, .12); put(8, .54, .12);
      put(11, .42, .27); put(12, .58, .27);
      put(13, .37, .39); put(14, .63, .39);
      put(15, .34, .5); put(16, .66, .5);
      put(23, .44, .53); put(24, .56, .53);
      put(25, .43, .69); put(26, .57, .69);
      put(27, .42, .86); put(28, .58, .86);
    }
    /* v1.8 新动作的起始姿态覆盖：小人是“机位引导”的一部分，画错比不画更误导 */
    const OVER = {
      sidraise: [[13, .40, .41], [14, .60, .41], [15, .40, .53], [16, .60, .53]],        // 坐姿双臂直垂体侧（拿水瓶），不是手放膝上
      sidestretch: [[13, .40, .39], [14, .60, .39], [15, .39, .51], [16, .61, .51]],      // 双手贴裤缝，躯干竖直
      wallsit: [[23, .44, .60], [24, .56, .60], [25, .42, .62], [26, .58, .62],           // 屁股往下滑到大腿接近平放（正面看膝≈高）
               [15, .43, .53], [16, .57, .53]]                                            // 手自然搭在大腿上
    };
    (OVER[(ex && ex.id) || ''] || []).forEach(o => put(o[0], o[1], o[2]));
    return P;
  }
  function drawGhost(canvas, tMs) {
    const ctx = canvas.getContext('2d');
    const P = ghostPose(T.ex);
    const bob = Math.sin((tMs || 0) / 700) * 0.005;      // 轻微呼吸浮动，表明"我在等你"
    ctx.save();
    if (DB.set.mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }   // 与镜像后的摄像头画面对齐
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(141,180,232,.45)';
    ctx.shadowColor = 'rgba(141,180,232,.3)'; ctx.shadowBlur = 10;
    BONES.forEach(([a, b]) => {
      const pa = P[a], pb = P[b];
      if (!pa.v || !pb.v) return;
      ctx.beginPath();
      ctx.moveTo(pa.x * canvas.width, (pa.y + bob) * canvas.height);
      ctx.lineTo(pb.x * canvas.width, (pb.y + bob) * canvas.height);
      ctx.stroke();
    });
    ctx.shadowBlur = 0; ctx.fillStyle = 'rgba(207,233,255,.5)';
    P.forEach((p, i) => {
      if (!p.v || i > 28) return;
      ctx.beginPath(); ctx.arc(p.x * canvas.width, (p.y + bob) * canvas.height, i < 11 ? 3.5 : 5, 0, 7); ctx.fill();
    });
    ctx.restore();
  }
  let flashAt = 0;            // 刚识别到人的高亮脉冲（示范小人 → 真实骨架的"点亮"瞬间）
  function drawSkel(canvas, lm, tint, hands) {
    const ctx = canvas.getContext('2d');
    if (!lm && (!hands || !hands.length)) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      /* 未识到人：训练 setup/校准阶段画灰色示范小人占位；识到人后自然切换为绿色骨架"高亮"跟随 */
      if (curScreen === 'train' && T.ex && (T.phase === 'setup' || T.phase === 'calib')) drawGhost(canvas, performance.now());
      return;
    }
    const fl = performance.now() - flashAt < 700;      // 点亮瞬间加粗发光，之后回落常态
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    if (DB.set.mirror) { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
    ctx.lineWidth = fl ? 6 : 3.5;
    ctx.strokeStyle = tint || (fl ? '#a6ffd0' : 'rgba(57,217,138,.9)');
    ctx.shadowColor = fl ? 'rgba(125,255,192,.95)' : 'rgba(57,217,138,.6)';
    ctx.shadowBlur = fl ? 20 : 8;
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
      if (ts - lastDetectTs < DETECT_GAP) return;               // 桌面 ~35fps / 移动端 ~18fps
      lastDetectTs = ts;
      let res;
      try { res = state.engine.detectForVideo(video, ts); }
      catch (e) { console.warn('[dongjing] detectForVideo 异常:', e); return; }
      const lm = toPixels(res.poseLandmarks && res.poseLandmarks.length ? res.poseLandmarks : null, video);
      if (lm && !state.lastLm) flashAt = ts;            // 由"无人"变"有人"：触发一次高亮
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
    liveAt: {}, fbAt: {}, clip: [], clipNext: 0, clipSize: null,
    seq: null, seqIdx: 0, circuitStats: null, briefed: {}   // 循环模式：动作序列/当前第几个/各动作成绩；briefed=教练记忆已提醒过的动作
  };
  function findEx(id) { return X.EXERCISES.find(e => e.id === id); }

  async function openTrain(id) {
    const ex = findEx(id);
    if (!ex) return;
    if (!ex.free && !DB.pro) { openPro('「' + ex.name + '」是 Pro 动作，升级后不限次练习'); return; }
    if (!DB.pro && quotaUsed() >= FREE_QUOTA) { openPro('本月免费训练次数已用完，升级 Pro 不限次'); return; }
    Object.assign(T, { ex, tracker: X.makeTracker(id), phase: 'setup', setIdx: 0, validSet: 0, validTot: 0,
      attempts: 0, issues: {}, timeSec: 0, badSec: 0, activeMs: 0, poseOkMs: 0, liveAt: {}, fbAt: {},
      clip: [], clipNext: 0, clipSize: null, seq: null, seqIdx: 0, circuitStats: null, briefed: {} });
    go('train');
    state.lastHands = null;
    $('#hud').hidden = true; $('#mask-rest').hidden = true;
    fillTrainChrome(ex);
    $('#mask-setup').hidden = false;
    startTipRotator();
    bootPreview();
  }
  /* 训练页初始 chrome（单动作与循环共用） */
  function fillTrainChrome(ex) {
    $('#setup-ico').textContent = ex.view === 'side' ? '📐' : (ex.seated ? '🪑' : '📷');
    $('#setup-title').textContent = (ex.view === 'side' ? '机位：侧面' : '机位：正面') + (ex.seated ? ' · 坐姿即可' : '');
    $('#setup-txt').textContent = ex.setup + (IS_MOBILE && !ex.game ? '（手机建议横屏放置，全身更容易入镜）' : '');
    $('#side-name').textContent = ex.name + ' · 要领';
    $('#side-tips').innerHTML = ex.tips.map(t => '<li>' + t + '</li>').join('');
    $('#side-issues').textContent = '暂无';
    $('#hud-name').textContent = ex.name;
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
  /* 机位引导阶段的 ✕：#btn-quit 在尚未显示的 HUD 里，引导阶段看得见却点不到，不补一个入口就等于只能一路点下去 */
  $('#btn-setup-quit').onclick = () => $('#btn-quit').click();

  function setStatus(txt, ok) {
    const s = $('#hud-person'); s.textContent = txt; s.className = 'hud-status' + (ok ? ' ok' : '');
  }
  function setHud() {
    if (T.ex.mode === 'game') { gameHud(); return; }
    $('#hud-rep').textContent = T.ex.mode === 'time' ? Math.floor(T.timeSec) : T.validSet;
    $('#hud-target').textContent = T.ex.mode === 'time' ? 's /' + T.ex.target + 's' : '/' + T.ex.target;
    const cum = T.seq ? (T.circuitStats || []).reduce((a, r) => a + r.valid, 0) + T.validTot : T.validTot;
    $('#hud-set').textContent = (T.seq ? '循环 ' + (T.seqIdx + 1) + ' / ' + T.seq.length : '第 ' + (T.setIdx + 1) + ' / ' + T.ex.sets + ' 组') + ' · 累计有效 ' + cum;
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
      el.textContent = ok ? '✓ 已检测到人，骨架已亮起，点下方按钮继续' : (ex.seated ? '未检测到人：请对着灰色示范小人坐好，上半身入镜' : '未检测到人：请对着灰色示范小人站好，全身入镜');
      el.className = 'setup-hint' + (ok ? ' ok' : '');
      return;
    }
    if (T.phase === 'rest') return;
    if (T.phase === 'game') {                       // 关卡：只要求躯干与腿在画面内（手臂甩出画面很常见，不能因此卡住）
      if (!G) return;
      if (!lm || !X.visAll(lm, [11, 12, 23, 24, 25, 26])) {
        setStatus('往后退半步：上半身和膝盖都要在画面里', false);
        drawGame($('#skel'), state.lastLm || lm);   // 保持画面物体继续显示，不因瞬时丢跟踪而闪烁
        return;
      }
      setStatus('已识别 · ' + X.GAME_KINDS[G.S.kind].name, true);
      gameFrame(lm, dt);
      return;
    }
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
          $('#mask-calib').hidden = true; $('#hud').hidden = false;
          if (ex.game) {                             // 关卡不扣额度，直接开局
            T.phase = 'game';
            $('#hud-name').textContent = X.GAME_KINDS[ex.game].ico + ' ' + ex.name;
            gameHud(); sfx.finish();
            speak(X.GAME_KINDS[ex.game].name + '开始！' + ex.tips[0], true);
            return;
          }
          T.phase = 'live';
          if (!DB.pro && (!T.seq || T.seqIdx === 0)) { DB.quota = { month: monthKey(), used: quotaUsed() + 1 }; save(); refreshChip(); }   // 循环整轮只扣 1 次额度
          feedback('开始！目标 ' + (ex.mode === 'time' ? ex.target + ' 秒' : ex.target + ' 次'), 'good', 'start', true);
          briefCoach(ex.id);                                    // 教练记忆：基于历史记录提醒老毛病
          setHud();
        }
      } else T.poseOkMs = 0;
      return;
    }
    if (T.phase !== 'live') return;
    T.activeMs += dt;

    const r = T.tracker.feed(lm, ts, dt, hands);
    /* 回放采样：~11fps 关键点序列（非视频），只保留最近一组，供结果页火柴人回放 */
    if (ts >= T.clipNext) {
      T.clipNext = ts + 90;
      if (!T.clipSize) T.clipSize = { w: $('#cam').videoWidth || 640, h: $('#cam').videoHeight || 480 };
      T.clip.push({ t: ts, p: lm.map(q => ({ x: Math.round(q.x), y: Math.round(q.y), v: q.v })) });
      if (T.clip.length > 400) T.clip.shift();
    }
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
    if (ex.game) return '站在画面正中间，全身入镜';
    return { squat: '自然站直', jack: '双脚并拢、双手垂放', highknees: '原地站直', pushup: '撑起手臂、身体一条直线', lunge: '自然站直', plank: '俯身撑好',
      headshake: '坐在椅上身直目视镜头', wave: '双手垂放准备举起', shrug: '双肩放松下垂', grasp: '举起双手、张开五指' }[ex.id] || '站直';
  }
  function bumpIssue(k, liveOnly) {
    T.issues[k] = (T.issues[k] || 0) + (liveOnly ? 0.34 : 1); // live 预警折算，避免刷屏虚高
  }
  function completeSet() {
    T.phase = 'rest';
    speak('第 ' + (T.setIdx + 1) + ' 组完成，休息', true);
    if (T.seq) { advanceCircuit(); return; }        // 循环模式：切换到下一个动作
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
        T.clip = []; T.clipNext = 0; T.clipSize = null;      // 回放只留当前组
        if (T.ex.mode === 'time') T.timeSec = 0;
        T.phase = 'live'; setHud();
        feedback('开始第 ' + (T.setIdx + 1) + ' 组！', 'good', 'set' + T.setIdx, true);
      }
    }, 1000);
  }

  function endTrain(mode) {   // 'discard' | 'save' | 'saveShow'
    stopLoop(); stopTipRotator();
    if (T.phase === 'game') mode = 'discard';      // 关卡中途退出不记部分成绩
    T.phase = 'off'; G = null;
    $('#hud').hidden = true; $('#mask-calib').hidden = true; $('#mask-rest').hidden = true; $('#mask-setup').hidden = true;
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
    const rec = { ts: Date.now(), ex: ex.id, name: ex.name, mode: ex.mode, target: ex.target,
      valid, attempts: ex.mode === 'time' ? valid : attempts, secs: Math.round(T.activeMs / 1000),
      cal: kcal, score, issues: Object.fromEntries(Object.entries(T.issues).map(([k, v]) => [k, Math.round(v)])) };
    DB.records.unshift(rec);
    DB.records = DB.records.slice(0, 200);
    save();
    return rec;
  }

  function showResult(rec) {
    LAST_REC = rec;
    resLabels(false);
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
    $('#btn-replay').hidden = T.clip.length < 8;          // 帧数太少不值得回放
    $('#btn-save-tpl').hidden = true;                    // 单动作不值得存成课（模板至少 2 段）
    $('#res-review').hidden = true; $('#btn-review').hidden = true;
    renderReview(rec);
    checkGoal();
    go('result');
    sfx.finish();
  }
  function checkGoal() {
    const goal = DB.set.dailyGoal | 0;
    if (goal && todayPoints() >= goal && DB.goalDay !== dayStart(Date.now())) {
      DB.goalDay = dayStart(Date.now()); save();
      setTimeout(() => { toast('🎯 今日目标达成！'); speak('恭喜，达成今日目标', true); }, 900);
    }
  }
  let LAST_REC = null;
  $('#btn-again').onclick = () => {
    if (T.ex && T.ex.game) { openGame(T.ex.game); return; }          // 关卡再来一局
    if (T.seq) { startCircuit(T.seq.map(e => e.id)); return; }   // 循环整轮再来一遍
    openTrain(T.ex ? T.ex.id : 'squat');
  };

  /* ---------------- 教练记忆（跨会话）+ 训练复盘 ----------------
   * 学两个爆款经验：工具自己“记得上次怎么干的”（claude-mem），
   * 干完活还会“复盘全过程讲清楚自己为什么这么做”（REA）。数据源就是本地历史记录。 */
  const ISSUE_ADVICE = {
    sqShallow: '下蹲前先做 5 次半蹲找幅度，感受髋低于膝',
    sqValgus: '空蹲 2 组，找“膝盖对准脚尖”的感觉',
    sqLean: '眼睛盯前方固定一点，胸椎先立起来再动',
    puShallow: '改跪姿俯卧撑，先把幅度做满',
    puSag: '先做平板支撑 30 秒 ×2 组唤醒核心，再回来做俯卧撑',
    puPike: '放慢下放节奏，想象身体是一整块板',
    jkArms: '先靠墙练手臂举过头顶的路径，再并脚步',
    jkLegs: '先只做脚步开合不摆臂，熟练后合并',
    lnShallow: '扶墙做小幅度弓步，站稳了再加深',
    lnAsym: '心里默数“左一右一”控制交替节奏',
    hkLow: '手扶墙做原地高抬腿，先单侧找过髋部的高度',
    hkAlt: '速度降一半，保证左右交替不抢拍',
    pkSlump: '平板分段做：20 秒 ×3，一塌腰就停',
    pkPike: '注意力收到腹部与臀部，不要追时长',
    wvUp: '先做 5 次完整举过肩的挥臂，不追速度',
    hsSmall: '摇头时眼看肩膀方向，幅度自然就大',
    sgLow: '吸气上提停 2 秒、呼气沉肩，把幅度拉开',
    grFind: '双手举到下巴前 20cm，先张开五指再握',
    grHalf: '先做 5 次“用力张手 3 秒”再进入节奏',
    srUp: '先空手练 5 次“手到肩高”，找到位置再上重量',
    srBent: '重量先减半，靠肩发力把手臂伸直，而不是弯手肘甩',
    ssTry: '双手贴裤缝往下滑，眼睛平视，只往侧面倒',
    ssSmall: '侧弯时手往膝盖方向滑，幅度自然就够',
    ssHold: '侧弯到最低点心里数三下，再慢慢回正',
    wsUp: '背靠墙往下滑，直到膝角接近 90°，大腿接近平放',
    wsLean: '收下巴、肩胛贴墙，不要为了蹲低让胸往前塌'
  };
  /* 近 N 天所有动作的问题聚合（用于首页教练笔记） */
  function aggWeak(days) {
    const from = dayStart(Date.now()) - (days - 1) * 864e5;
    const m = {};
    DB.records.filter(r => r.ts >= from).forEach(r =>
      Object.entries(r.issues || {}).forEach(([k, v]) => { m[k] = (m[k] || 0) + v; }));
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }
  /* 某个动作的老毛病：取最近 15 次记录里出现最多且≥ 3 次的问题 */
  function weaknessOf(exId) {
    const recs = DB.records.filter(r => r.ex === exId).slice(0, 15);
    if (recs.length < 2) return null;
    const m = {};
    recs.forEach(r => Object.entries(r.issues || {}).forEach(([k, v]) => { m[k] = (m[k] || 0) + v; }));
    const top = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
    return top && top[1] >= 3 ? { key: top[0], msg: (X.ISSUES[top[0]] || {}).msg || top[0], n: Math.round(top[1]), sessions: recs.length } : null;
  }
  function briefCoach(exId) {         // 训练开始时一句针对性提醒（每组只说一次）
    if (T.briefed[exId]) return;
    T.briefed[exId] = 1;
    const w = weaknessOf(exId);
    if (!w) return;
    const msg = '我记得你上次「' + w.msg + '」出现了 ' + w.n + ' 次';
    setTimeout(() => { if (T.phase === 'live') feedback(msg, 'warn', 'coachmem', true, 9000); }, 1400);
  }
  /* 本次复盘：数据 → 个人最佳对比 → 失分归因 → 下一步建议 */
  function buildReview(rec) {
    if (rec.game) return gameReviewLines(rec);
    const lines = [];
    const isTime = rec.mode === 'time';
    const unit = isTime ? rec.valid + ' 秒' : rec.valid + ' 次';
    const best = isTime ? null : bestOf(rec.ex);
    lines.push('本次' + (rec.name || '训练') + '：标准有效 ' + unit + '，用时 ' + rec.secs + ' 秒，动作评分 ' + rec.score + '。');
    if (best != null && rec.valid > 0) {
      if (rec.valid >= best) lines.push('🎉 这就是你的个人最佳（' + best + ' 次），下一次的目标是稳稳超过它。');
      else lines.push('你的最好一次是 ' + best + ' 次，这次差 ' + (best - rec.valid) + ' 次——差距不大，保持节奏就能追上。');
    }
    const iss = Object.entries(rec.issues || {}).sort((a, b) => b[1] - a[1]);
    const top = iss[0];
    if (!top) lines.push('全程没有明显失分点，动作质量在线 👏');
    else lines.push('失分主要集中在「' + ((X.ISSUES[top[0]] || {}).msg || top[0]) + '」×' + Math.round(top[1]) + ' 次。');
    const adv = top ? ISSUE_ADVICE[top[0]] : null;
    const target = isTime ? 0 : (rec.target || 0);
    if (rec.score >= 85 && (isTime || !target || rec.valid >= target)) {
      lines.push(top ? '质量已经够了，先把量控住，同时注意：' + adv + '。' : '可以直接加量：目标 +2 次或多加 1 组，或者换个组合练。');
    } else if (rec.score >= 60) {
      lines.push((adv || '按语音提示微调') + '。这个问题我会一直记着，下次开练前先提醒你。');
    } else {
      lines.push('这次量先放一边：建议目标减半，宁少不错，把「' + (top ? ((X.ISSUES[top[0]] || {}).msg || top[0]) : '动作幅度') + '」改到再上量。');
    }
    return { lines, text: lines.join(' ') };
  }
  function renderReview(rec) {
    const box = $('#res-review'); if (!box) return;
    const rv = buildReview(rec);
    LAST_REVIEW = rv;
    box.innerHTML = '<div class="rv-h">🧠 本次复盘 · 我记住了这些</div>' +
      rv.lines.map(l => '<div class="rv-l">' + l + '</div>').join('');
    box.hidden = false;
    const vb = $('#btn-review'); if (vb) vb.hidden = false;
  }
  let LAST_REVIEW = null;
  $('#btn-review').onclick = () => { if (LAST_REVIEW) speak(LAST_REVIEW.text, true); };
  function coachNoteHTML() {
    if (!DB.records.length) return '还没有你的训练数据。先随便练 3 分钟，我就开始记住你的动作习惯——下次不用你复述背景，我知道你哪里容易错。';
    const w = aggWeak(14).filter(e => e[1] >= 2);
    const head = '本周训练 ' + weekSessions() + ' 次 · 连续打卡 ' + streakDays() + ' 天';
    if (!w.length) return head + '。近期没有明显失分点，动作质量在线；可以考虑把每日目标调高一点。';
    const tot = w.reduce((a, e) => a + e[1], 0);
    const pct = Math.round(w[0][1] / tot * 100);
    return head + '。最常失分：「' + ((X.ISSUES[w[0][0]] || {}).msg || w[0][0]) + '」占问题次数 ' + pct + '%' +
      (ISSUE_ADVICE[w[0][0]] ? '；' + ISSUE_ADVICE[w[0][0]] : '') + '。';
  }

  /* ---------------- 体感关卡（游戏化：复用同一套姿态引擎） ----------------
   * 健身 App 留存靠“今天想再来玩一局”，所以把动作包成关卡：
   * 左右移动=跨步、举手=挥臂、蹲下=护盾，玩的时候动作幅度比数翻倍。 */
  const GAME_DUR = 60;
  const GAME_PAR = { collect: 22, dodge: 16, guard: 12 };   // 60 秒“标准线”，用于把关卡得分折算成 0-100 表现分
  let G = null;                                             // 当前关卡实例（X.makeGame）
  let GAME_SEL = 'collect';

  function bodyCenter(lm) {                                 // 髋中心在画面上的左右位置（镜像后与用户看到的一致）
    if (!lm) return 0.5;
    const hip = X.mid(lm[L.L_HIP], lm[L.R_HIP]);
    const W = $('#cam').videoWidth || 1280;
    const x = hip.x / W;
    return Math.max(0, Math.min(1, DB.set.mirror ? 1 - x : x));
  }
  function gameInput(lm) {
    const H = $('#cam').videoHeight || 720;
    const shoY = Math.min(lm[L.L_SHO].y, lm[L.R_SHO].y);
    const wriY = Math.min(lm[L.L_WRI].y, lm[L.R_WRI].y);
    const kl = X.ang(lm[L.L_HIP], lm[L.L_KNEE], lm[L.L_AN]);
    const kr = X.ang(lm[L.R_HIP], lm[L.R_KNEE], lm[L.R_AN]);
    return { x: bodyCenter(lm), armsUp: wriY < shoY - H * 0.04, squat: Math.min(kl, kr) < 125 };
  }
  function gameEx(kind) {
    const k = X.GAME_KINDS[kind];
    return {
      id: 'game-' + kind, game: kind, name: k.name, ico: k.ico, view: 'front', seated: false,
      mode: 'game', target: GAME_DUR, sets: 1, met: k.met, free: true, desc: k.desc,
      setup: '留出左右各一步的空间，全身入镜，手机横过来更稳。' + k.desc + '，60 秒一局。',
      tips: [k.desc, '左右跨步就是训练：幅度越大、移动越快，运动量越足',
        '身体中心对准画面中线站好再开始', '不计免费训练额度，玩多久都行'],
      keys: [0, 11, 12, 15, 16, 23, 24, 25, 26, 27, 28],
      start: lm => { const c = bodyCenter(lm); return c > 0.32 && c < 0.68; }   // 校准：站回中间再开局
    };
  }
  function openGame(kind) {
    if (!X.GAME_KINDS[kind]) return;
    const ex = gameEx(kind);
    G = X.makeGame(kind, { duration: GAME_DUR, hp: 3 });
    Object.assign(T, { ex, tracker: null, phase: 'setup', setIdx: 0, validSet: 0, validTot: 0, attempts: 0,
      issues: {}, timeSec: 0, badSec: 0, activeMs: 0, poseOkMs: 0, liveAt: {}, fbAt: {},
      clip: [], clipNext: 0, clipSize: null, seq: null, seqIdx: 0, circuitStats: null, briefed: {} });
    $('#modal-game').hidden = true;
    go('train');
    state.lastHands = null;
    $('#hud').hidden = true; $('#mask-rest').hidden = true;
    fillTrainChrome(ex);
    $('#setup-ico').textContent = ex.ico;
    $('#setup-title').textContent = '体感关卡 · ' + ex.name;
    $('#mask-setup').hidden = false;
    startTipRotator();
    bootPreview();
  }
  function gameHud() {
    if (!G) return;
    const S = G.S;
    $('#hud-rep').textContent = S.score;
    $('#hud-target').textContent = '分 · 剩 ' + Math.ceil(G.left()) + 's';
    $('#hud-set').textContent = '❤'.repeat(S.hp) + '♡'.repeat(Math.max(0, S.hpMax - S.hp)) +
      ' · 连击 ' + S.combo + '（最高 ' + S.best + '）';
    $('#hud-phase').textContent = X.GAME_KINDS[S.kind].desc + ' · 第 ' + S.level + ' 档';
  }
  function drawGame(canvas, lm) {
    if (!canvas || !G) return;
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, S = G.S;
    const zoneY = S.kind === 'collect' ? 0.85 : (S.kind === 'dodge' ? 0.62 : 0.42);
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    S.objs.forEach(q => {
      const x = q.x * W, y = q.y * H;
      if (q.type === 'laser') {
        ctx.fillStyle = 'rgba(255,90,99,.16)';
        ctx.fillRect(x - W * 0.13, 0, W * 0.26, y);
        ctx.strokeStyle = '#ff5a63'; ctx.lineWidth = 4;
        ctx.shadowColor = 'rgba(255,90,99,.9)'; ctx.shadowBlur = 16;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, y); ctx.stroke(); ctx.shadowBlur = 0;
      } else if (q.type === 'bar') {
        ctx.fillStyle = S.shield ? 'rgba(57,217,138,.3)' : 'rgba(255,138,60,.3)';
        ctx.fillRect(0, y - H * 0.028, W, H * 0.056);
        ctx.strokeStyle = S.shield ? '#39d98a' : '#ff8a3c'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      } else {
        ctx.font = Math.round(H * (q.type === 'starHi' ? 0.062 : 0.05)) + 'px serif';
        ctx.fillText(q.type === 'starHi' ? '🌟' : '⭐', x, y);
      }
    });
    /* 判定线 + 玩家接球台（跟随髋中心） */
    ctx.setLineDash([7, 9]); ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,.28)';
    ctx.beginPath(); ctx.moveTo(0, zoneY * H); ctx.lineTo(W, zoneY * H); ctx.stroke();
    ctx.setLineDash([]);
    const px = bodyCenter(lm) * W;
    ctx.shadowColor = 'rgba(37,182,240,.95)'; ctx.shadowBlur = 18; ctx.fillStyle = '#25b6f0';
    roundRect(ctx, px - W * 0.075, zoneY * H - H * 0.012, W * 0.15, H * 0.024, H * 0.012); ctx.fill();
    if (S.kind === 'guard') {
      ctx.strokeStyle = S.shield ? '#39d98a' : 'rgba(255,255,255,.4)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(px, H * 0.52, W * 0.09, Math.PI, 0); ctx.stroke();
    }
    ctx.restore();
  }
  function gameFrame(lm, dt) {
    if (!G) return;
    const evs = G.step(gameInput(lm), dt);
    drawGame($('#skel'), lm);
    gameHud();
    evs.forEach(e => {
      if (e.ev === 'catch' || e.ev === 'shield') {
        sfx.good(); $('#hud-rep').classList.remove('pop'); void $('#hud-rep').offsetWidth;
        $('#hud-rep').classList.add('pop');
        feedback(e.ev === 'shield' ? '🛡 挡住 +2' : (e.hi ? '🌟 高星 +3，举手漂亮' : '⭐ +1'),
          'good', 'g' + e.score, e.combo > 0 && e.combo % 6 === 0, 120);
        if (e.combo === 8) speak('连击 8 个，漂亮', true);
      } else if (e.ev === 'miss') feedback('⭐ 掉了：脚步跟上', 'warn', 'gmiss', false, 1600);
      else if (e.ev === 'near') feedback('🙌 高星要把手举过肩膀', 'warn', 'gnear', true, 4500);
      else if (e.ev === 'dodge') sfx.tick();
      else if (e.ev === 'hurt') { sfx.bad(); feedback('💥 被打中！剩 ' + e.hp + ' 格血', 'bad', 'ghurt', true, 0); }
      else if (e.ev === 'level') feedback('⚡ 提速：第 ' + e.level + ' 档', 'warn', 'glv', true, 0);
      else if (e.ev === 'over') endGame(e.why);
    });
  }
  function bestGame(kind) {
    const rs = DB.records.filter(r => r.game === kind);
    return rs.length ? Math.max(...rs.map(r => r.valid)) : null;
  }
  function endGame(why) {
    if (!G) return;
    const S = G.S, k = X.GAME_KINDS[S.kind], par = GAME_PAR[S.kind] || 20;
    const mins = S.t / 60000;
    const rec = { ts: Date.now(), ex: 'game-' + S.kind, name: k.name, game: S.kind, mode: 'game',
      target: GAME_DUR, valid: S.score, attempts: S.score, secs: Math.round(S.t),
      cal: +(k.met * DB.set.weight * mins).toFixed(1),
      score: Math.max(20, Math.min(100, Math.round(100 * S.score / par))),
      combo: S.best, over: why, issues: {} };
    DB.records.unshift(rec); DB.records = DB.records.slice(0, 200); save();
    stopLoop(); stopTipRotator(); T.phase = 'off'; G = null;
    $('#hud').hidden = true; $('#mask-calib').hidden = true; $('#mask-setup').hidden = true;
    showGameResult(rec);
  }
  function resLabels(game) {              // 结果页的表头随玩法切换，不让关卡分数被误读成有效次数
    $('#lab-reps').textContent = game ? '关卡得分' : '有效次数';
    $('#lab-bad').textContent = game ? '最高连击' : '无效次数';
    $('#btn-again').textContent = game ? '🎮 再来一局' : '再来一组';
  }
  function showGameResult(rec) {
    LAST_REC = rec;
    LAST_REVIEW = null;
    const best = bestGame(rec.game);
    resLabels(true);
    $('#res-emoji').textContent = '🎮';
    $('#res-title').textContent = (rec.over === 'hp' ? '血量耗尽！' : '时间到！') +
      (rec.score >= 85 ? '这局打得漂亮 🏆' : rec.score >= 60 ? '手感不错，还能更高 🔥' : '先把玩法跑顺，分数自然上来 🧱');
    $('#res-score').textContent = rec.score;
    $('#res-reps').textContent = rec.valid;
    $('#res-bad').textContent = rec.combo;
    $('#res-dur').textContent = rec.secs + 's';
    $('#res-cal').textContent = rec.cal;
    $('#res-issues').innerHTML =
      '<div class="ri"><span>关卡得分（标准线 ' + (GAME_PAR[rec.game] || 20) + '）</span><b>' + rec.valid + '</b></div>' +
      '<div class="ri"><span>最高连击</span><b>×' + rec.combo + '</b></div>' +
      '<div class="ri"><span>本局结束方式</span><b>' + (rec.over === 'hp' ? '血量耗尽' : '60 秒到') + '</b></div>' +
      (best != null ? '<div class="ri"><span>' + (rec.valid >= best ? '🎉 新的关卡最佳' : '历史最佳 ' + best + ' 分，差 ' + (best - rec.valid) + ' 分') + '</span></div>' : '');
    $('#btn-replay').hidden = true;
    $('#btn-save-tpl').hidden = true;                    // 关卡不是可保存的“课”
    $('#res-review').hidden = true; $('#btn-review').hidden = true;
    renderReview(rec);
    checkGoal();
    go('result'); sfx.finish();
    speak(X.GAME_KINDS[rec.game].name + '结束，得分 ' + rec.valid + ' 分', true);
  }
  /* 关卡复盘：不卖数字，说清“为什么这个分”与“下一局改什么” */
  function gameReviewLines(rec) {
    const lines = [];
    const par = GAME_PAR[rec.game] || 20;
    const k = X.GAME_KINDS[rec.game];
    lines.push('本局「' + k.name + '」：得分 ' + rec.valid + '，最高连击 ' + rec.combo +
      '，用时 ' + rec.secs + ' 秒（' + (rec.over === 'hp' ? '血量耗尽结束' : '60 秒打满') + '）。');
    const best = bestGame(rec.game);
    if (best != null && rec.valid >= best) lines.push('🎉 这是你的关卡新纪录（' + rec.valid + ' 分），下一局的目标是稳住它再抬高一档。');
    else if (best != null) lines.push('你在这个关卡的最好成绩是 ' + best + ' 分，这次差 ' + (best - rec.valid) + ' 分，差距在连击而不是反应。');
    else lines.push('第一次打这个关卡，' + (rec.valid >= par ? '已经超过标准线 ' + par + ' 分，上手很快。' : '先以超过标准线 ' + par + ' 分为目标。'));
    if (rec.combo >= 8) lines.push('连击能稳到 ' + rec.combo + ' 个，说明身体跟上了节奏；下一局把幅度拉开，移动到位再接。');
    else lines.push('连击只有 ' + rec.combo + ' 个：不要碎步追着物体跑，提前看下一波的位置，一步到位再接。');
    lines.push(k.desc + '；' + (rec.game === 'guard' ? '蹲得越低护盾越稳，膝盖对准脚尖' :
      rec.game === 'dodge' ? '跨步幅度拉开，别停在两栏中间' : '高星要举手过肩，普通星弯腰也要接住') + '。');
    return { lines, text: lines.join(' ') };
  }
  /* 首页 / 弹窗：关卡选择 */
  $('#btn-game').onclick = () => { renderGamePicker(); $('#modal-game').hidden = false; };
  function renderGamePicker() {
    $('#game-kinds').innerHTML = Object.keys(X.GAME_KINDS).map(kind => {
      const k = X.GAME_KINDS[kind], b = bestGame(kind);
      return '<div class="game-card' + (kind === GAME_SEL ? ' on' : '') + '" data-game="' + kind + '">' +
        '<div class="ico">' + k.ico + '</div><h4>' + k.name + '</h4><div class="desc">' + k.desc + '</div>' +
        '<div class="meta"><span>60 秒</span><span>' + (b != null ? '最佳 ' + b + ' 分' : '未挑战') + '</span></div></div>';
    }).join('');
    $('#btn-game-start').textContent = '开始：' + X.GAME_KINDS[GAME_SEL].name;
  }
  $('#game-kinds').onclick = e => {
    const c = e.target.closest('[data-game]'); if (!c) return;
    GAME_SEL = c.dataset.game; renderGamePicker();
  };
  $('#btn-game-start').onclick = () => openGame(GAME_SEL);

  /* ---------------- 循环训练（circuit） ---------------- */
  const CIR_DEFAULT = ['squat', 'jack', 'highknees', 'headshake'];
  let LAST_CIRCUIT_IDS = null;                 // v1.9：循环打完后的选片，供结果页“存为常用课”
  $('#btn-circuit').onclick = () => { renderCircuitPicker(); $('#modal-circuit').hidden = false; };
  function renderCircuitPicker(preset) {
    const sel = (preset && preset.length ? Array.from(new Set(preset)) : CIR_DEFAULT);
    const list = X.EXERCISES.filter(e => e.free || DB.pro);
    $('#cir-chips').innerHTML = list.map(e =>
      '<label class="cir-chip' + (sel.includes(e.id) ? ' on' : '') + '">' +
      '<input type="checkbox" value="' + e.id + '"' + (sel.includes(e.id) ? ' checked' : '') + '>' +
      e.ico + ' ' + e.name + '</label>').join('');
    $('#btn-cir-start').textContent = '开始循环（' + sel.length + ' 动作）';
  }
  $('#cir-chips').addEventListener('change', e => {
    const lab = e.target.closest('.cir-chip'); if (!lab) return;
    lab.classList.toggle('on', e.target.checked);
    const n = $$('#cir-chips input:checked').length;
    $('#btn-cir-start').textContent = n ? '开始循环（' + n + ' 动作）' : '开始循环';
  });
  $('#btn-cir-start').onclick = () => {
    const ids = $$('#cir-chips input:checked').map(i => i.value);
    if (ids.length < 2 || ids.length > 6) { toast('请选 2–6 个动作'); return; }
    startCircuit(ids);
  };
  function startCircuit(ids) {
    const seq = ids.map(findEx).filter(Boolean);
    if (seq.length < 2) { toast('请至少选 2 个动作'); return; }
    if (!DB.pro && quotaUsed() >= FREE_QUOTA) { openPro('本月免费训练次数已用完，升级 Pro 不限次'); return; }
    const first = seq[0];
    Object.assign(T, { ex: first, tracker: X.makeTracker(first.id), phase: 'setup', setIdx: 0, validSet: 0, validTot: 0,
      attempts: 0, issues: {}, timeSec: 0, badSec: 0, activeMs: 0, poseOkMs: 0, liveAt: {}, fbAt: {},
      clip: [], clipNext: 0, clipSize: null, seq, seqIdx: 0, circuitStats: [], briefed: {} });
    $('#modal-circuit').hidden = true;
    go('train');
    state.lastHands = null;
    $('#hud').hidden = true; $('#mask-rest').hidden = true;
    fillTrainChrome(first);
    $('#setup-title').textContent += ' · 循环 1 / ' + seq.length;
    $('#mask-setup').hidden = false;
    startTipRotator();
    bootPreview();
    if (seq.some(e => e.hands)) ensureHandEngine().catch(() => {});   // 含手指级动作时预热手部模型
  }
  function advanceCircuit() {
    T.circuitStats.push(saveResult());          // 每个动作各写一条历史记录
    T.seqIdx++;
    if (T.seqIdx >= T.seq.length) { showCircuitResult(); return; }
    const next = T.seq[T.seqIdx];
    $('#mask-rest').hidden = false;
    $('#rest-txt').textContent = '循环第 ' + (T.seqIdx + 1) + ' / ' + T.seq.length + ' 个：' + next.name +
      (next.seated ? '（坐姿）' : (next.view === 'side' ? '（侧面机位）' : ''));
    let sec = 10;
    $('#rest-num').textContent = sec;
    speak('下一个动作，' + next.name, true);
    const iv = setInterval(() => {
      if (T.phase !== 'rest') { clearInterval(iv); return; }
      sec--; $('#rest-num').textContent = sec; sfx.tick();
      if (sec <= 0) { clearInterval(iv); $('#mask-rest').hidden = true; setupCircuitLeg(next); }
    }, 1000);
  }
  function setupCircuitLeg(ex) {
    Object.assign(T, { ex, tracker: X.makeTracker(ex.id), setIdx: 0, validSet: 0, validTot: 0, attempts: 0,
      issues: {}, timeSec: 0, badSec: 0, activeMs: 0, poseOkMs: 0, liveAt: {}, fbAt: {},
      clip: [], clipNext: 0, clipSize: null });
    fillTrainChrome(ex);
    T.phase = 'calib';
    $('#hud').hidden = true;
    $('#calib-txt').textContent = '请摆好起始姿势：' + calibHint(ex);
    $('#calib-ico').className = 'calib-ico';
    $('#mask-calib').hidden = false;
    if (ex.hands && !state.handEngine) ensureHandEngine().catch(() => {});
    setHud();
    feedback('本轮：' + ex.name + ' × ' + (ex.mode === 'time' ? ex.target + ' 秒' : ex.target), 'good', 'cir' + T.seqIdx, true);
  }
  function showCircuitResult() {
    stopLoop(); stopTipRotator(); T.phase = 'off';
    $('#hud').hidden = true; $('#mask-calib').hidden = true; $('#mask-rest').hidden = true;
    const st = T.circuitStats;
    const totValid = st.reduce((a, r) => a + r.valid, 0);
    const totBad = st.reduce((a, r) => a + (r.mode === 'time' ? 0 : Math.max(0, r.attempts - r.valid)), 0);
    const totSecs = st.reduce((a, r) => a + r.secs, 0);
    const totCal = +st.reduce((a, r) => a + r.cal, 0).toFixed(1);
    const score = Math.round(st.reduce((a, r) => a + r.score * Math.max(1, r.secs), 0) / Math.max(1, totSecs));
    const merged = {};
    st.forEach(r => Object.entries(r.issues || {}).forEach(([k, v]) => merged[k] = (merged[k] || 0) + v));
    LAST_REC = { ts: Date.now(), ex: 'circuit', name: '循环训练', mode: 'reps', target: 0,
      valid: totValid, attempts: totValid + totBad, secs: totSecs, cal: totCal, score, issues: merged };
    resLabels(false);
    $('#res-emoji').textContent = '🔁';
    $('#res-title').textContent = '循环打完！' + st.length + ' 个动作全部完成' + (score >= 85 ? '，动作在线 💪' : '，质量为王 🔥');
    $('#res-score').textContent = score;
    $('#res-reps').textContent = totValid;
    $('#res-bad').textContent = totBad;
    $('#res-dur').textContent = totSecs + 's';
    $('#res-cal').textContent = totCal;
    const iss = Object.entries(merged).sort((a, b) => b[1] - a[1]).slice(0, 4);
    $('#res-issues').innerHTML = '<div class="ri"><span>' +
      st.map(r => r.name + ' ' + (r.mode === 'time' ? r.valid + 's' : r.valid + '次')).join(' · ') + '</span></div>' +
      (iss.length ? iss.map(([k, n]) => '<div class="ri"><span>' + (X.ISSUES[k] ? X.ISSUES[k].msg : k) + '</span><b>×' + n + '</b></div>').join('')
                  : '<div class="ri"><span>本轮没有明显动作问题 👏</span></div>');
    $('#btn-replay').hidden = true;                // 循环回放暂不展示（clip 仅末段）
    LAST_CIRCUIT_IDS = T.seq.map(e => e.id);       // v1.9：记住这一轮的选片，供“存为常用课”
    $('#btn-save-tpl').hidden = false;
    renderReview(LAST_REC);
    checkGoal();
    go('result'); sfx.finish();
  }

  /* ---------------- AI 编排：一句话 → 循环节奏 ----------------
   * 学的是“零门槛输入口”那一招：不让用户学怎么用，用户说人话就行。 */
  const PLAN_PRESET = [
    ['💺 办公室 5 分钟', '在办公室久坐，肩颈发酸，来 5 分钟'],
    ['🔥 出汗燃脂 10 分钟', '想减脂出汗 10 分钟'],
    ['🦵 下肢塑形 10 分钟', '练腿和臀 10 分钟'],
    ['🧘 睡前放松', '睡前放松一下'],
    ['💪 上肢核心', '练上肢和核心 8 分钟']
  ];
  let PLAN = null;
  const PLAN_SAVE_TXT = '💾 存为常用课';       // 空闲文案；存成功后变 “✓ 已存”，重算方案时复位
  const PLAN_SAVED_TXT = '✓ 已存';
  $('#btn-plan').onclick = () => {
    $('#plan-presets').innerHTML = PLAN_PRESET.map(p => '<label class="cir-chip">' + p[0] + '</label>').join('');
    PLAN = null; $('#plan-out').hidden = true; $('#btn-plan-start').hidden = true; $('#btn-plan-edit').hidden = true; $('#btn-plan-save').hidden = true; $('#btn-plan-save').textContent = PLAN_SAVE_TXT;
    $('#plan-text').value = '';
    $('#modal-plan').hidden = false;
    setTimeout(() => { try { $('#plan-text').focus(); } catch (e) {} }, 60);
  };
  $('#plan-presets').onclick = e => {
    const lab = e.target.closest('.cir-chip'); if (!lab) return;
    const p = PLAN_PRESET.find(x => x[0] === lab.textContent); if (!p) return;
    $$('#plan-presets .cir-chip').forEach(c => c.classList.toggle('on', c === lab));
    $('#plan-text').value = p[1];
    makePlan();
  };
  $('#plan-text').oninput = () => {
    $$('#plan-presets .cir-chip').forEach(c => c.classList.remove('on'));
    makePlan();
  };
  function makePlan() {
    const txt = $('#plan-text').value.trim();
    if (!txt) { $('#plan-out').hidden = true; $('#btn-plan-start').hidden = true; $('#btn-plan-edit').hidden = true; $('#btn-plan-save').hidden = true; PLAN = null; return; }
    PLAN = X.planFromText(txt, { pro: DB.pro });
    $('#plan-names').innerHTML = PLAN.ids.map((id, i) => {
      const e = X.EXERCISES.find(x => x.id === id);
      return '<span class="pl-step">' + e.ico + ' ' + e.name + '</span>' + (i < PLAN.ids.length - 1 ? '<i>→</i>' : '');
    }).join('');
    $('#plan-meta').textContent = '约 ' + PLAN.estMin + ' 分钟 · ' + PLAN.ids.length + ' 段' +
      (PLAN.seatedOnly ? ' · 全程坐着就能练' : '') +
      (PLAN.rounds > 1 ? ' · 同一套重复 ' + PLAN.rounds + ' 遍填满时长' : '');
    $('#plan-why').innerHTML = PLAN.why.map(w => '<div class="pw">· ' + w + '</div>').join('') +
      (PLAN.locked.length ? '<div class="pw lock">🔒 你的目标里 ' + PLAN.locked.join(' / ') + ' 是 Pro 动作，升级后自动排进方案</div>' : '');
    $('#plan-out').hidden = false;
    $('#btn-plan-start').hidden = false;
    $('#btn-plan-edit').hidden = false;
    $('#btn-plan-save').hidden = false;
    $('#btn-plan-save').textContent = PLAN_SAVE_TXT;   // 重新生成就复位文案，不能残留上一份的“✓ 已存”
  }
  $('#btn-plan-start').onclick = () => {
    if (!PLAN) return;
    $('#modal-plan').hidden = true;
    startCircuit(PLAN.ids);
  };
  $('#btn-plan-edit').onclick = () => {          // 方案不满意 → 带着推荐结果回 chips 自己改
    $('#modal-plan').hidden = true;
    renderCircuitPicker(PLAN ? PLAN.ids : null);
    $('#modal-circuit').hidden = false;
  };

  /* ---------------- v1.9 我的课程（训练模板） ----------------
   * 把一次循环跟练的选片、或一句话编排的结果存成常用课，下次首页一键复练。
   * 纯数据逻辑全在 DJX（templateOf/tplAdd/tplSafe/tplEstimate），这里只做存取与渲染。 */
  function saveAsTemplate(ids, name) {
    const tpl = X.templateOf(ids, name);
    if (!tpl) { toast('至少选 2 个动作才能存成课'); return false; }
    const r = X.tplAdd(DB.templates, tpl);
    DB.templates = r.list; save();
    if (!r.ok) {
      toast(r.why === 'dup' ? '这门课已经存过啦' : r.why === 'full' ? '最多只能存 ' + X.TPL_MAX + ' 门课' : '这门课存不了');
      return false;
    }
    toast('已存为常用课 ✓');
    return true;
  }
  $('#btn-save-tpl').onclick = () => { if (LAST_CIRCUIT_IDS) { if (saveAsTemplate(LAST_CIRCUIT_IDS, null)) renderTemplates(); } };
  $('#btn-plan-save').onclick = () => {
    if (!PLAN) return;
    if (saveAsTemplate(PLAN.ids, null)) { renderTemplates(); $('#btn-plan-save').textContent = PLAN_SAVED_TXT; }
  };

  function renderTemplates() {
    const box = $('#tpl-section'), list = $('#tpl-list');
    if (!box || !list) return;
    const tpls = X.tplSafe(DB.templates);
    DB.templates = tpls;                       // 顺手把 localStorage 里的脏项清掉再落盘
    if (!tpls.length) { box.hidden = true; list.innerHTML = ''; save(); return; }
    box.hidden = false;
    $('#tpl-sum').textContent = tpls.length + ' / ' + X.TPL_MAX;
    list.innerHTML = tpls.map(t => {
      const est = X.tplEstimate(t);
      const badges = [];
      if (est.seatedOnly) badges.push('<span class="tb seat">全程坐姿</span>');
      if (est.locked.length) badges.push('<span class="tb pro">含 Pro·' + est.locked[0] + (est.locked.length > 1 ? ' 等 ' + est.locked.length + ' 个' : '') + '</span>');
      return '<div class="tpl-item" data-tpl="' + t.id + '">' +
        '<div class="tn"><span class="tname">' + t.name + '</span><button class="tpl-del" title="删除这门课">✕</button></div>' +
        '<div class="tmeta">' + est.segs + ' 段 · 约 ' + est.estMin + ' 分钟</div>' +
        '<div class="tnames">' + est.names.join(' → ') + '</div>' +
        (badges.length ? '<div class="tbadges">' + badges.join('') + '</div>' : '') +
        '<div class="tbtns"><button class="btn primary btn-tpl-run">▶ 开练</button></div>' +
        '</div>';
    }).join('');
  }
  $('#tpl-list').onclick = e => {
    const item = e.target.closest('.tpl-item'); if (!item) return;
    const id = item.getAttribute('data-tpl');
    if (e.target.closest('.tpl-del')) {
      DB.templates = X.tplRemove(DB.templates, id); save(); renderTemplates(); toast('已删除');
      return;
    }
    if (e.target.closest('.btn-tpl-run')) {
      const t = X.tplSafe(DB.templates).find(x => x.id === id);
      if (!t) return;
      const lockedIds = t.ids.filter(i2 => { const ex = findEx(i2); return ex && !ex.free; });
      if (!DB.pro && lockedIds.length) { openPro('这门课含 Pro 动作（' + lockedIds.map(i2 => findEx(i2).name).join(' / ') + '），升级后即可开练'); return; }
      startCircuit(t.ids.slice());
    }
  };

  /* ---------------- 组回放（火柴人序列，非视频） ---------------- */
  const RP = { raf: null, i: 0, clock: 0, lastNow: 0, speed: 1, paused: false };
  $('#btn-replay').onclick = openReplay;
  function openReplay() {
    if (T.clip.length < 8) return;
    $('#replay-name').textContent = T.ex ? T.ex.name : '';
    const c = $('#replay-canvas');
    c.width = (T.clipSize && T.clipSize.w) || 640;
    c.height = (T.clipSize && T.clipSize.h) || 480;
    Object.assign(RP, { i: 0, clock: 0, lastNow: 0, speed: 1, paused: false });
    $('#btn-rp-speed').textContent = '1x'; $('#btn-rp-pause').textContent = '⏸ 暂停';
    $('#modal-replay').hidden = false;
    if (RP.raf) cancelAnimationFrame(RP.raf);
    rpTick();
  }
  function rpTick() {
    RP.raf = requestAnimationFrame(rpTick);
    if ($('#modal-replay').hidden) { cancelAnimationFrame(RP.raf); RP.raf = null; return; }
    const now = performance.now(), d = Math.min(120, now - (RP.lastNow || now)); RP.lastNow = now;
    if (!RP.paused) RP.clock += d * RP.speed;
    const fr = T.clip; if (fr.length < 2) return;
    const total = fr[fr.length - 1].t - fr[0].t;
    while (RP.i + 1 < fr.length && fr[RP.i + 1].t - fr[0].t <= RP.clock) RP.i++;
    drawStick($('#replay-canvas'), fr[RP.i].p);
    $('#rp-time').textContent = (Math.min(RP.clock, total) / 1000).toFixed(1) + ' / ' + (total / 1000).toFixed(1) + 's';
    if (RP.clock >= total + 400) { RP.clock = 0; RP.i = 0; }   // 循环播放
  }
  function drawStick(canvas, lm) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 3.5; ctx.strokeStyle = 'rgba(57,217,138,.95)';
    ctx.shadowColor = 'rgba(57,217,138,.5)'; ctx.shadowBlur = 6;
    BONES.forEach(([a, b]) => {
      const pa = lm[a], pb = lm[b];
      if (!pa || !pb || pa.v < 0.1 || pb.v < 0.1) return;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    });
    ctx.shadowBlur = 0; ctx.fillStyle = '#cfe9ff';
    lm.forEach((p, i) => { if (i > 28 || p.v < 0.1) return; ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, 7); ctx.fill(); });
  }
  $('#btn-rp-pause').onclick = () => { RP.paused = !RP.paused; $('#btn-rp-pause').textContent = RP.paused ? '▶ 播放' : '⏸ 暂停'; };
  $('#btn-rp-speed').onclick = () => { RP.speed = RP.speed === 1 ? 2 : RP.speed === 2 ? 0.5 : 1; $('#btn-rp-speed').textContent = RP.speed + 'x'; };

  /* ---------------- 成绩分享海报（canvas 生成，无后端） ---------------- */
  $('#btn-share').onclick = () => { if (LAST_REC) { buildPoster(LAST_REC); $('#modal-share').hidden = false; } };
  function roundRect(g, x, y, w, h, r) {
    g.beginPath(); g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
  }
  function buildPoster(rec) {
    const c = $('#share-canvas'); c.width = 720; c.height = 1080;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 720, 1080);
    bg.addColorStop(0, '#0c1626'); bg.addColorStop(.55, '#10203a'); bg.addColorStop(1, '#0c1626');
    g.fillStyle = bg; g.fillRect(0, 0, 720, 1080);
    const glow = g.createRadialGradient(360, 340, 20, 360, 340, 460);
    glow.addColorStop(0, 'rgba(57,217,138,.15)'); glow.addColorStop(1, 'rgba(57,217,138,0)');
    g.fillStyle = glow; g.fillRect(0, 60, 720, 640);
    /* 骨架火柴人装饰：本组最后一帧 */
    if (T.clip.length) {
      const fr = T.clip[T.clip.length - 1];
      const sc = 720 / ((T.clipSize && T.clipSize.w) || 1280);
      g.save(); g.translate(0, 150); g.scale(sc * 1.1, sc * 1.1); g.globalAlpha = .34;
      g.lineWidth = 5; g.strokeStyle = '#39d98a';
      g.shadowColor = 'rgba(57,217,138,.6)'; g.shadowBlur = 10;
      BONES.forEach(([a, b]) => {
        const pa = fr.p[a], pb = fr.p[b];
        if (!pa || !pb || pa.v < 0.1 || pb.v < 0.1) return;
        g.beginPath(); g.moveTo(pa.x, pa.y); g.lineTo(pb.x, pb.y); g.stroke();
      });
      g.restore();
    }
    g.textAlign = 'center';
    g.fillStyle = '#8db4e8'; g.font = '600 34px system-ui'; g.fillText('◉ 动镜 DongJing', 360, 96);
    g.fillStyle = '#5c7aa6'; g.font = '20px system-ui'; g.fillText('网页 AI 体感私教 · 只计标准有效次数', 360, 132);
    const ex = X.EXERCISES.find(e => e.id === rec.ex);
    g.font = '72px serif';
    g.fillText(rec.game ? X.GAME_KINDS[rec.game].ico : rec.ex === 'circuit' ? '🔁' : (ex && ex.ico) || '💪', 360, 640);
    g.fillStyle = '#fff'; g.font = 'bold 118px system-ui';
    g.fillText(rec.mode === 'time' ? rec.valid + 's' : String(rec.valid), 360, 782);
    g.fillStyle = '#8db4e8'; g.font = '26px system-ui';
    g.fillText((rec.name || '') + ' · ' + (rec.game ? '关卡得分 / 连击 ×' + rec.combo
      : '标准有效' + (rec.mode === 'time' ? '时长' : '次数')), 360, 822);
    [['动作评分', rec.score], ['千卡', rec.cal], ['时长', rec.secs + 's']].forEach((it, i) => {
      const x = 140 + i * 220;
      g.fillStyle = 'rgba(255,255,255,.06)'; roundRect(g, x - 92, 856, 184, 108, 16); g.fill();
      g.fillStyle = '#39d98a'; g.font = 'bold 40px system-ui'; g.fillText(String(it[1]), x, 914);
      g.fillStyle = '#7d99c4'; g.font = '20px system-ui'; g.fillText(String(it[0]), x, 948);
    });
    g.fillStyle = '#ffc94d'; g.font = '24px system-ui';
    g.fillText('🔥 连续打卡 ' + streakDays() + ' 天 · 本周训练 ' + weekSessions() + ' 次', 360, 1006);
    /* 把复盘的最后一句（下一步建议）印上海报：分享的不只是数字，还有教练的判断 */
    const tip = LAST_REVIEW && LAST_REVIEW.lines.length > 1 ? LAST_REVIEW.lines[LAST_REVIEW.lines.length - 1] : '打开摄像头，马上就能练';
    const cut = tip.length > 26 ? tip.slice(0, 25) + '…' : tip;
    g.fillStyle = '#e6f0ff'; g.font = '600 24px system-ui'; g.fillText(cut, 360, 1042);
    g.fillStyle = '#5c7aa6'; g.font = '19px system-ui';
    g.fillText('shixingya.github.io/dongjing · ' + fmtDate(rec.ts), 360, 1070);
  }
  $('#btn-save-img').onclick = () => {
    const a = document.createElement('a');
    a.download = 'dongjing_' + (LAST_REC ? LAST_REC.ex + '_' + LAST_REC.score : 'result') + '.png';
    a.href = $('#share-canvas').toDataURL('image/png'); a.click();
    toast('图片已保存');
  };
  $('#btn-copy-img').onclick = async () => {
    try {
      const blob = await new Promise(r => $('#share-canvas').toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('已复制到剪贴板，去粘贴吧 ✦');
    } catch (e) { toast('当前浏览器不支持复制图片，请用「保存图片」'); }
  };

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

  /* ---------------- 体态评估（两步：正面 + 侧面）----------------
   * 正面看得到左右偏差，侧面才看得到矢状面（头前倾/圆肩/骨盆前倾/膝过伸）。
   * 采完正面会请用户转身；不想配合也能“跳过侧面”，回到只出正面 4 项的老口径。 */
  const P = { on: false, samples: [], needLeft: 6, iv: null, tick: 0, view: 'front', front: null };
  const PST_N = 6;
  function pstStepUI() {
    $('#pst-step').textContent = '体态评估 · 第 ' + (P.view === 'front' ? '1/2' : '2/2') + ' 步 ' + (P.view === 'front' ? '正面' : '侧面');
    $('#pst-count').textContent = P.needLeft;
  }
  $('#btn-pst-start').onclick = async () => {
    if (P.on) return;
    $('#pst-intro').hidden = true; $('#pst-result').hidden = true; $('#pst-stage').hidden = false; $('#pst-turn').hidden = true;
    $('#pst-cam').classList.toggle('no-mirror', !DB.set.mirror);
    try { await ensureCam(); } catch (e) { toast('摄像头开启失败：' + e.message); return; }
    try { await ensureEngine(); } catch (e) { toast('模型加载失败，请检查网络'); return; }
    Object.assign(P, { view: 'front', front: null, samples: [], needLeft: PST_N, tick: 0, on: true });
    pstStepUI();
    startLoop($('#pst-cam'), $('#pst-skel'), onPostureFrame);
  };
  function onPostureFrame(lm, ts, dt) {
    if (!P.on) return;
    const side = P.view === 'side';
    const legsOn = X.vis(lm, L.L_AN) || X.vis(lm, L.R_AN) || X.vis(lm, L.L_KNEE) || X.vis(lm, L.R_KNEE);
    const okKeys = side
      ? X.visAll(lm, [L.L_SHO, L.R_SHO]) && X.visAll(lm, [L.L_HIP, L.R_HIP]) &&
        (X.vis(lm, L.NOSE) || X.vis(lm, L.L_EAR) || X.vis(lm, L.R_EAR)) && legsOn
      : X.visAll(lm, [0, 11, 12, 23, 24]) && legsOn;
    $('#pst-txt').textContent = okKeys
      ? (side ? '侧身站好，双臂自然垂在体侧…' : '保持自然站直，目视前方…')
      : (side ? '请侧身 90° 朝向镜头，头顶到脚踝都要在画面内' : '请全身入镜（至少到膝盖），正面朝向镜头');
    if (!okKeys) return;
    P.tick += dt;
    if (P.tick >= 250) { P.tick = 0; P.samples.push(lm); P.needLeft--; $('#pst-count').textContent = Math.max(0, P.needLeft); sfx.tick(); }
    if (P.needLeft > 0) return;
    P.on = false; stopLoop();
    if (!side) { P.front = P.samples; P.samples = []; $('#pst-turn').hidden = false; return; }   // 第一步完成 → 请转身
    finishPosture(X.analyzePosture(P.front), X.analyzePostureSide(P.samples));
  }
  $('#btn-pst-side').onclick = () => {
    $('#pst-turn').hidden = true; $('#pst-intro').hidden = true; $('#pst-result').hidden = true; $('#pst-stage').hidden = false;
    Object.assign(P, { view: 'side', samples: [], needLeft: PST_N, tick: 0, on: true });
    pstStepUI(); startLoop($('#pst-cam'), $('#pst-skel'), onPostureFrame);
  };
  $('#btn-pst-skip').onclick = () => { $('#pst-turn').hidden = true; finishPosture(X.analyzePosture(P.front), null); };

  function finishPosture(fr, sd) {
    const r = X.mergePosture(fr, sd);
    $('#pst-stage').hidden = true; $('#pst-turn').hidden = true; P.view = 'front'; P.front = null;
    if (!r) { toast('没采到有效姿态：需从头到膝盖入镜，并站够 6 拍'); $('#pst-result').hidden = true; $('#pst-intro').hidden = false; return; }
    $('#pst-result').hidden = false;
    $('#pst-score').textContent = r.score;
    $('#pst-items').innerHTML = r.items.map(it =>
      '<div class="pst-item"><span>' + (r.twoView ? '<em class="pv">' + it.view + '</em>' : '') + it.name + '</span>' +
      '<span class="lvl ' + it.cls + '">' + it.level + ' · ' + it.pct + '%' + (it.dir ? '（' + it.dir + '）' : '') + '</span></div>').join('');
    const bad = r.items.filter(it => it.cls !== 'a');
    $('#pst-advice').innerHTML = (bad.length ? bad.map(it => '· <b>' + it.name.split('（')[0] + '</b>：' + it.advice).join('<br>')
      : '· 所有项目都在良好范围内，保持就行 👏') + '<br><span class="tiny">' + r.note + '</span>';
    DB.posture.unshift({ ts: Date.now(), score: r.score, twoView: r.twoView, items: r.items });
    DB.posture = DB.posture.slice(0, 30); save();
    drawPostureTrend();
    speak('评估完成，体面评分 ' + r.score + ' 分' + (r.twoView ? '，正面与侧面共 ' + r.items.length + ' 项' : ''), true);
  }
  /* 体面评分趋势：canvas 手绘折线，不引入任何图表库 */
  function drawPostureTrend() {
    const box = $('#pst-trend-box'), cv = $('#pst-trend');
    const hist = DB.posture.slice(0, 12).reverse().map(p => p.score);
    if (hist.length < 2) { box.hidden = true; return; }
    box.hidden = false;
    const g = cv.getContext('2d'), W = cv.width, H = cv.height;
    g.clearRect(0, 0, W, H);
    const lo = Math.max(0, Math.min.apply(null, hist) - 8), hi = Math.min(100, Math.max.apply(null, hist) + 8), rg = Math.max(1, hi - lo);
    const px = i => 24 + i * (W - 48) / (hist.length - 1);
    const py = v => H - 20 - (v - lo) / rg * (H - 40);
    g.strokeStyle = 'rgba(139,160,188,.32)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(18, H - 20); g.lineTo(W - 18, H - 20); g.stroke();
    g.strokeStyle = '#39d98a'; g.lineWidth = 2.5; g.beginPath();
    hist.forEach((v, i) => i ? g.lineTo(px(i), py(v)) : g.moveTo(px(i), py(v)));
    g.stroke();
    g.fillStyle = '#39d98a';
    hist.forEach((v, i) => { g.beginPath(); g.arc(px(i), py(v), 3.5, 0, 7); g.fill(); });
    g.fillStyle = '#8ba0bc'; g.font = '13px system-ui'; g.textAlign = 'center';
    hist.forEach((v, i) => { if (i === 0 || i === hist.length - 1 || hist.length <= 6) g.fillText(String(v), px(i), py(v) - 10); });
    const d = hist[hist.length - 1] - hist[0];
    $('#pst-trend-txt').textContent = '近 ' + hist.length + ' 次：' + hist[0] + ' → ' + hist[hist.length - 1] +
      '（' + (d > 0 ? '↑ 进步 ' + d : d < 0 ? '↓ 下降 ' + (-d) : '持平') + '）· 同一机位同一站姿的对比才有意义';
  }
  $('#btn-pst-quit').onclick = () => { P.on = false; stopLoop(); endPosture(); pstStepUI(); $('#pst-txt').textContent = '请自然站直，目视前方…'; $('#pst-turn').hidden = true; $('#pst-stage').hidden = true; $('#pst-result').hidden = true; $('#pst-intro').hidden = false; };
  $('#btn-pst-again').onclick = () => { $('#pst-result').hidden = true; $('#pst-intro').hidden = false; go('posture'); };
  function endPosture() { Object.assign(P, { on: false, samples: [], front: null, tick: 0, view: 'front', needLeft: PST_N }); }

  /* ---------------- 本周课表（v1.6）----------------
   * 课表不是另一个“计划工具”：它直接读本机历史记录重算，点一下就能开练。
   * 逻辑全在 DJX.makeWeekPlan（纯函数），这里只管渲染与路由到循环/关卡。 */
  let PLAN_SEL = null, PLAN_TODAY_I = null;
  function weekPlan() {
    return X.makeWeekPlan(DB.records, {
      pro: DB.pro, dailyGoal: DB.set.dailyGoal,
      quotaLeft: DB.pro ? undefined : Math.max(0, FREE_QUOTA - quotaUsed())   // 免费版才需要按额度排课
    });
  }
  function planSelDay(p) {
    const i = PLAN_SEL == null ? p.todayI : PLAN_SEL;
    return p.days[Math.max(0, Math.min(6, i))];
  }
  function renderPlan() {
    const box = $('#plan-card'); if (!box) return;
    const p = weekPlan();
    if (PLAN_TODAY_I !== p.todayI) { PLAN_SEL = null; PLAN_TODAY_I = p.todayI; }   // 隔了一天就回到“今天”
    const sel = planSelDay(p);
    $('#plan-sum').textContent = '自动按你的记录重算 · 本周 ' + p.weekPts + '/' + p.weekTarget + ' 点'
      + (p.missed ? ' · 已漏 ' + p.missed + ' 天' : '') + (p.plannedSessions ? ' · 待练 ' + p.plannedSessions + ' 次' : '');
    $('#plan-days').innerHTML = p.days.map(d =>
      '<button class="wk-day ' + d.status + ' k-' + d.kind + (d.i === sel.i ? ' on' : '') + '" data-wk="' + d.i + '">' +
      '<span class="wd">周' + d.wd + '</span><span class="wt">' + d.theme + '</span>' +
      '<span class="wp">' + (d.kind === 'rest' ? '😴' : d.done ? d.donePts + '点' + (d.met ? ' ✓' : '') : d.kind === 'game' ? '🎮' : d.targetPts + '点') + '</span></button>').join('');
    const body = sel.kind === 'train'
      ? '<p>' + sel.names.map(n => '<b>' + n + '</b>').join(' / ') + ' · 约 ' + sel.estMin + ' 分钟 · ' + sel.targetPts + ' 点</p>'
      : sel.kind === 'game'
        ? '<p>' + X.GAME_KINDS[sel.game].name + ' · 60 秒一局 · 不扣训练额度</p>'
        : '<p>今天不排课，让肌肉长回来</p>';
    $('#plan-detail').innerHTML = '<b>' + sel.theme + ' · 周' + sel.wd + ' ' + sel.date + '</b>' + body +
      '<p class="tiny muted">' + sel.why + (sel.note ? '（' + sel.note + '）' : '') + '</p>' +
      (sel.i === p.todayI ? '<p class="wk-tip">' + p.tip + '</p>'
        : sel.done ? '<p class="wk-tip">这天已完成 ' + sel.donePts + '/' + sel.targetPts + ' 点</p>' : '');
    const btn = $('#btn-plan-go');
    if (sel.kind === 'rest') { btn.textContent = '今天休息 😴'; btn.dataset.act = 'rest'; }
    else if (sel.kind === 'game') { btn.textContent = '玩这一局 🎮'; btn.dataset.act = 'game'; }
    else { btn.textContent = (sel.i === p.todayI ? '照课表开练' : '练这天') + ' ▶'; btn.dataset.act = 'train'; }
  }
  $('#plan-days').onclick = e => {
    const b = e.target.closest('[data-wk]'); if (!b) return;
    PLAN_SEL = +b.dataset.wk; renderPlan();
  };
  $('#btn-plan-go').onclick = () => {
    const d = planSelDay(weekPlan());
    if (d.kind === 'game') { openGame(d.game); return; }
    if (d.kind !== 'train' || !d.ids.length) { toast('休息日不用练，明天再说 💪'); speak('今天是休息日', true); return; }
    if (d.ids.length < 2) { openTrain(d.ids[0]); return; }   // 极端情况（动作库被收缩）退化为单动作
    startCircuit(d.ids);
  };

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
    const cn = $('#coach-card'); if (cn) cn.innerHTML = '<b>🧠 教练笔记</b><span>' + coachNoteHTML() + '</span>';
    renderPlan();
    renderGoal();
    renderTemplates();
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
    /* 关卡分数不是“有效次数”，不计进动作统计，只算训练次数 */
    return DB.records.filter(r => r.ts >= from && r.mode !== 'game').reduce((s, r) => s + r.valid, 0);
  }
  function streakDays() {
    const days = new Set(DB.records.map(r => dayStart(r.ts)));
    let n = 0, d = dayStart(Date.now());
    if (!days.has(d)) d -= 864e5;                     // 今天没练则从昨天起算
    while (days.has(d)) { n++; d -= 864e5; }
    return n;
  }
  /* 训练点口径统一走 X.recPoints（exercises.js），与热力图共用同一算法 */
  function todayPoints() {
    const s = dayStart(Date.now());
    return DB.records.filter(r => r.ts >= s).reduce((a, r) => a + X.recPoints(r), 0);
  }
  function renderGoal() {
    const goal = DB.set.dailyGoal | 0, p = todayPoints();
    const ring = $('#goal-ring'); if (!ring) return;
    const ratio = goal ? Math.min(1, p / goal) : 1;
    ring.style.strokeDashoffset = String(163.4 * (1 - ratio));
    $('#goal-num').textContent = goal ? (p >= goal ? '✓' : Math.round(ratio * 100) + '%') : '∞';
    $('#goal-txt').textContent = goal ? (p >= goal ? '今日目标达成 🎉' : '今日 ' + p + '/' + goal + ' 点') : '未设每日目标';
  }

  /* ---------------- 报告页 ---------------- */
  function renderReport() {
    renderHeatmap();
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
    $('#pst-hist-tip').textContent = DB.posture.length === 0 ? '还没有评估过' :
      DB.posture.length === 1 ? '1 次记录 · 再做一次就能看到趋势' : '共 ' + DB.posture.length + ' 次 · 下面为最近 ' + Math.min(5, DB.posture.length) + ' 次';
    $('#pst-hist').innerHTML = DB.posture.length
      ? '<div class="hist-row head"><span>时间</span><span>体面评分</span><span>覆盖</span><span>最差一项</span></div>' +
        DB.posture.slice(0, 5).map(p => {
          const w = (p.items || []).filter(it => it.cls !== 'a').sort((a, b) => a.cls < b.cls ? 1 : -1)[0];
          return '<div class="hist-row"><span>' + fmtDate(p.ts) + '</span><b>' + p.score + '</b><span>' +
            (p.twoView ? '正面+侧面 8 项' : '仅正面 4 项') + '</span><span>' +
            (w ? w.name.split('（')[0] + ' ' + w.level : '全部良好') + '</span></div>';
        }).join('') + (DB.posture.length > 1
          ? '<p class="tiny muted">趋势：' + DB.posture.slice(0, 6).reverse().map(p => p.score).join(' → ') + '（体态评分只在同一机位、同一站姿下可比）</p>' : '')
      : '<div class="empty-tip">还没做过体态评估：首页「体态评估」两步各 6 秒</div>';
    $('#hist-list').innerHTML = DB.records.length
      ? '<div class="hist-row head"><span>时间</span><span>动作</span><span>有效</span><span>评分</span><span>千卡</span></div>' +
        DB.records.slice(0, 40).map(r =>
          '<div class="hist-row"><span>' + fmtDate(r.ts) + '</span><span>' + r.name + (r.mode === 'game' ? ' 🎮' : (r.mode === 'time' ? '（' + r.valid + 's）' : '')) + '</span><b>' + (r.mode === 'game' ? r.valid + ' 分' : r.mode === 'time' ? r.valid + 's' : r.valid + '/' + r.attempts) + '</span><span>' + r.score + '</span><span>' + r.cal + '</span></div>').join('')
      : '<div class="empty-tip">暂无记录，去首页开始第一次训练吧</div>';
  }

  /* 训练热力图：DOM 网格（每列一周、上到下周一~周日），hover 用 title 提示日期与点数 */
  function renderHeatmap() {
    const colsEl = $('#heatmap'); if (!colsEl) return;
    const hm = X.buildHeatmap(DB.records, { today: Date.now(), weeks: 12, dailyGoal: DB.set.dailyGoal | 0 });
    const dlab = ts => { const d = new Date(ts); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; };
    $('#hm-months').innerHTML = hm.weeks.map(c => '<span class="hm-mc">' + (c.month ? c.month + '月' : '') + '</span>').join('');
    colsEl.innerHTML = hm.weeks.map(c =>
      '<div class="hm-col">' + c.days.map(d => {
        const cls = d.future ? 'future' : ('l' + d.level);
        const tip = d.future ? dlab(d.ts) + ' · 未到期'
          : dlab(d.ts) + ' · ' + (d.points > 0 ? d.points + ' 训练点' : '休息');
        return '<i class="hm-cell ' + cls + (d.isToday ? ' today' : '') + '" title="' + tip + '"></i>';
      }).join('') + '</div>').join('');
    const sum = $('#hm-sum');
    if (sum) sum.textContent = hm.total > 0
      ? '近 ' + hm.windowDays + ' 天 · 累计 ' + hm.total + ' 训练点 · 活跃 ' + hm.active + ' 天 · 连续打卡 ' + hm.streak + ' 天'
      : '近 ' + hm.windowDays + ' 天还没有训练记录，练一次这里就会亮起来 ✦';
  }

  /* ---------------- 我的 / Pro ---------------- */
  function renderMe() {
    $('#me-plan').innerHTML = DB.pro ? '<span class="plan-badge pro">动镜 Pro ✦</span>' : '<span class="plan-badge free">免费版</span>';
    $('#me-quota').textContent = DB.pro ? '全部动作 · 不限训练次数'
      : '本月已训练 ' + quotaUsed() + ' / ' + FREE_QUOTA + ' 次 · 基础 7 动作免费（含坐姿系与体侧伸展）';
    $('#chk-demo-pro').checked = !!DB.pro;
    $('#inp-weight').value = DB.set.weight;
    $('#inp-goal').value = DB.set.dailyGoal;
    $('#chk-voice2').checked = DB.set.voice;
    $('#btn-voice').textContent = DB.set.voice ? '🔊' : '🔇';
    $('#chk-sfx').checked = DB.set.sfx;
    $('#chk-mirror').checked = DB.set.mirror;
    const bs = $('#bk-sum');
    if (bs) bs.textContent = '本机现有 ' + DB.records.length + ' 条训练记录 · ' + (DB.posture ? DB.posture.length : 0) + ' 次体态评估 · ' + X.tplSafe(DB.templates).length + ' 门常用课';
  }
  function openPro(reason) {
    // 只说真的卡点：Pro 锁的是动作与次数；报表、体态评估、关卡都是全量免费，不能当成付费卖点
    const PRO = X.EXERCISES.filter(e => !e.free);
    $('#modal-pro').querySelector('p.muted').textContent = (reason || '') + ' 解锁 ' + PRO.length + ' 个 Pro 动作（' + PRO.map(e => e.name).join(' / ') + '）· 不限训练次数';
    $('#modal-pro').hidden = false;
  }
  $$('[data-close]').forEach(b => b.onclick = () => { const m = b.closest('.modal'); if (m) m.hidden = true; });
  $$('.modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) m.hidden = true; }));
  $('#btn-pro-demo').onclick = () => {
    DB.pro = true; save(); $('#modal-pro').hidden = true; renderHome(); renderMe();
    toast('已本地激活 Pro（演示模式，支付通道 P1 接入）');
  };
  $('#btn-upgrade').onclick = () => openPro(DB.pro ? '你已在演示 Pro 状态' : '升级 Pro');
  $('#chk-demo-pro').onchange = e => { DB.pro = e.target.checked; save(); renderMe(); renderHome(); toast(DB.pro ? '演示 Pro 已激活' : '已切回免费版'); };
  $('#inp-weight').onchange = e => { DB.set.weight = Math.min(200, Math.max(30, +e.target.value || 60)); save(); };
  $('#inp-goal').onchange = e => {
    DB.set.dailyGoal = Math.min(500, Math.max(0, +e.target.value || 0)); save();
    renderGoal(); toast(DB.set.dailyGoal ? '每日目标已设为 ' + DB.set.dailyGoal + ' 训练点' : '每日目标已关闭');
  };
  const bindSet = (sel, key, cb) => { $(sel).onchange = e => { DB.set[key] = e.target.checked; save(); if (cb) cb(e.target.checked); }; };
  bindSet('#chk-voice2', 'voice', v => { $('#btn-voice').textContent = v ? '🔊' : '🔇'; if (!v) window.speechSynthesis && speechSynthesis.cancel(); });
  bindSet('#chk-sfx', 'sfx');
  bindSet('#chk-mirror', 'mirror', v => { $('#cam').classList.toggle('no-mirror', !v); $('#pst-cam').classList.toggle('no-mirror', !v); });
  $('#btn-voice').onclick = () => { DB.set.voice = !DB.set.voice; save(); renderMe(); toast(DB.set.voice ? '语音纠错已开启' : '语音纠错已关闭'); };

  /* ---------------- v2.0 数据备份：导出 / 导入 ----------------
   * 无后端 = 清缓存就全丢且无法补救；把 localStorage 导成一份可存走/换机器的 JSON。
   * 序列化与校验全在 DJX（exportPayload/parseImport/mergeRecords），这里只碰文件 IO。 */
  function downloadJSON(filename, text) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
      return true;
    } catch (e) { return false; }
  }
  $('#btn-export').onclick = () => {
    const d = new Date(), pad = n => String(n).padStart(2, '0');
    const fn = 'dongjing-backup-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json';
    if (downloadJSON(fn, JSON.stringify(X.exportPayload(DB), null, 2))) toast('已导出 ' + DB.records.length + ' 条训练记录');
    else toast('导出失败：浏览器不支持下载');
  };
  $('#inp-import').onchange = e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    const rd = new FileReader();
    rd.onload = () => {
      const input = e.target; input.value = '';              // 先清空，允许重复导入同一文件
      const res = X.parseImport(String(rd.result || ''));
      if (!res.ok) { toast(res.why === 'json' ? '文件不是有效的 JSON' : res.why === 'app' ? '这不是动镜导出的备份文件' : '备份文件结构不对'); return; }
      const p = res.payload, merge = $('#chk-merge').checked;
      DB.records = merge ? X.mergeRecords(DB.records, p.records) : p.records;
      DB.posture = p.posture; DB.quota = p.quota; DB.set = p.set; DB.pro = p.pro; DB.templates = p.templates;
      save(); renderMe(); renderHome();
      toast('导入成功：' + DB.records.length + ' 条记录 · ' + DB.templates.length + ' 门课');
    };
    rd.onerror = () => { e.target.value = ''; toast('读取文件失败'); };
    rd.readAsText(f);
  };

  /* ---------------- 移动端可用性：环境预检 + 后台暂停 + 关页释放 ---------------- */
  function envCheck() {
    const el = $('#env-warn'); if (!el) return;
    const hasCam = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
    const secure = location.protocol === 'https:' || location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1';
    if (!IN_WX && hasCam && secure) { el.hidden = true; return; }
    el.textContent = IN_WX
      ? '⚠️ 微信内置浏览器无法调用摄像头：点右上角「···」→ 选择在 Safari / Chrome 浏览器中打开，体验完整功能'
      : !hasCam
        ? '⚠️ 当前浏览器不支持摄像头识别（无 getUserMedia）：请换较新版本的 Chrome / Safari / Edge'
        : location.protocol === 'file:'
          ? '⚠️ 双击本地文件打开时浏览器禁用摄像头：在 dongjing 目录下执行 python -m http.server 8790，再访问 http://localhost:8790'
          : '⚠️ 当前是 ' + location.protocol + ' 环境，浏览器为安全禁用摄像头：请通过 HTTPS 链接或 localhost 访问';
    el.hidden = false;
  }
  let autoPaused = null;                    // 因切后台而停掉的那条循环，回来自动接上
  document.addEventListener('visibilitychange', () => {
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) {}
    if (document.hidden) {
      const trainOn = (T.phase === 'setup' || T.phase === 'calib' || T.phase === 'live' ||
        T.phase === 'rest' || T.phase === 'game') && curScreen === 'train';
      if (trainOn && rafId) { autoPaused = 'train'; stopLoop(); }            // 省电，且不把后台冻结的 rAF 误当成“没识到人”
      else if (P.on && rafId) { autoPaused = 'posture'; stopLoop(); }
      else autoPaused = null;
    } else if (autoPaused === 'train') {
      autoPaused = null; lastDetectTs = 0;
      startLoop($('#cam'), $('#skel'), onTrainFrame);
      if (T.phase === 'live' || T.phase === 'game') feedback('回来了，继续！', 'good', 'resume', true, 0);
    } else if (autoPaused === 'posture') {
      autoPaused = null; lastDetectTs = 0;
      startLoop($('#pst-cam'), $('#pst-skel'), onPostureFrame);
    } else autoPaused = null;
  });
  /* 关页/切走：释放摄像头，手机上的相机指示灯不该一直亮着 */
  window.addEventListener('pagehide', () => {
    try {
      if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; state.camPromise = null; }
    } catch (e) {}
  });

  /* ---------------- 启动 ---------------- */
  renderHome(); renderMe(); refreshChip(); envCheck();
  window.__dongjing = {          // 调试句柄：控制台可读 lastLm/训练/关卡/课表/体态/环境状态做远程诊断
    state, DB, T, get G() { return G; }, get raf() { return rafId; },
    openGame, openTrain, startCircuit, envCheck,
    weekPlan, renderPlan, selectPlan(i) { PLAN_SEL = i; renderPlan(); },
    get P() { return P; }, pst(fr, sd) { finishPosture(fr, sd); },   // 体态两步：无摄像头时也能用合成帧验证结果页
    env: { IS_IOS, IS_ANDROID, IS_MOBILE, IN_WX, DETECT_GAP, get speechUnlocked() { return speechUnlocked; } }
  };
  document.addEventListener('keydown', e => {
    const openModal = $$('.modal').find(m => !m.hidden);
    if (e.key === 'Escape' && openModal) { openModal.hidden = true; return; }
    if (e.key === 'Escape' && curScreen === 'train' && (T.validTot || T.attempts || T.timeSec)) { endTrain('save'); go('home'); toast('已保存本次成绩并退出'); }
    else if (e.key === 'Escape' && curScreen === 'train') go('home');
  });
})();
