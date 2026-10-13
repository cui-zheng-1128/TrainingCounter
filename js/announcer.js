/**
 * 语音播报调度器：负责数字报数、提示音与中文语音合成。
 * 所有短音频通过同一个 Audio 元素顺序播放，避免 iOS 上多元素快速切换
 * 引发的音频会话抖动（参见 WebKit bug 278598：iOS 上 speechSynthesis
 * 会压低网页媒体音量）。
 */

// 音频资源目录（相对本模块定位，适配任意部署路径）
const AUDIO_DIR = new URL('../assets/audio/', import.meta.url).href;
// 数字报数音频文件
const NUMBER_FILES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
// 提示音（休息 / 训练完成 / 过半）
const CUE_FILES = ['rest', 'done', 'half'];
// 语音分块最大长度（字）
const CHUNK_MAX_LENGTH = 50;

/** 按标点或长度上限切分文本 */
function splitChunks(text) {
  const chunks = [];
  let current = '';
  for (const ch of text) {
    current += ch;
    if (/[，。！？；、,.!?;]/.test(ch) || current.length >= CHUNK_MAX_LENGTH) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export class Announcer {
  constructor() {
    // 唯一音频元素：所有短音频共用，避免多元素并发播放互相打断
    this._audio = new Audio();
    this._audio.preload = 'auto';
    // 预加载缓存：文件名 -> blob 地址（全部就绪后播放零网络等待）
    this._clips = new Map();
    // 预加载任务（幂等：重复调用复用同一 Promise）
    this._preloadPromise = null;
    // 播放请求代际标记：过期的失败重试直接丢弃
    this._playToken = 0;
    // 语音合成队列与代际标记（防止取消后旧任务续播）
    this._speechQueue = [];
    this._speechToken = 0;
    // 缓存的中文语音
    this._zhVoice = null;
    if (typeof speechSynthesis !== 'undefined') {
      this._resolveVoice();
      if (typeof speechSynthesis.addEventListener === 'function') {
        speechSynthesis.addEventListener('voiceschanged', () => this._resolveVoice());
      }
    }
  }

  /** 播放短音频：新片段会自然打断旧片段 */
  _playClip(file) {
    const token = ++this._playToken;
    try {
      // 优先使用已预加载的 blob 地址，避免播放瞬间的网络等待
      this._audio.src = this._clips.get(file) || `${AUDIO_DIR}${file}`;
    } catch {
      /* 忽略 */
    }
    try {
      this._audio.currentTime = 0;
    } catch {
      /* 忽略 */
    }
    const p = this._audio.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // 已被更新的播放请求取代时不再重试，避免旧音频复活
        if (token !== this._playToken) return;
        setTimeout(() => {
          if (token !== this._playToken) return;
          try {
            this._audio.load();
          } catch {
            /* 忽略 */
          }
          const retry = this._audio.play();
          if (retry && typeof retry.catch === 'function') retry.catch(() => { /* 忽略 */ });
        }, 120);
      });
    }
  }

  /** 停止当前短音频（语音播报前调用，避免两类声音互相干扰） */
  stopAudio() {
    this._playToken += 1;
    try {
      this._audio.pause();
    } catch {
      /* 忽略 */
    }
  }

  /** 等待中文语音列表就绪（iOS 上首次 getVoices 可能为空） */
  _ensureVoicesReady(timeoutMs = 1500) {
    if (typeof speechSynthesis === 'undefined') return Promise.resolve();
    if (this._resolveVoice()) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      let done = false;
      const finish = () => {
      	if (done) return;
      	done = true;
      	if (timer) clearTimeout(timer);
      	if (typeof speechSynthesis.removeEventListener === 'function') {
      		speechSynthesis.removeEventListener('voiceschanged', finish);
      	}
      	resolve();
      };
      if (typeof speechSynthesis.addEventListener === 'function') {
      	speechSynthesis.addEventListener('voiceschanged', finish);
      } else {
      	finish();
      }
      timer = setTimeout(finish, timeoutMs);
    });
  }

  /** 静音预热语音引擎，缩短 iOS 首次播报的启动延迟 */
  _warmSpeech() {
    if (typeof speechSynthesis === 'undefined') return Promise.resolve();
    try {
      const utterance = new SpeechSynthesisUtterance('好');
      utterance.volume = 0;
      const voice = this._resolveVoice();
      if (voice) {
      	utterance.voice = voice;
      	utterance.lang = voice.lang;
      } else {
      	utterance.lang = 'zh-CN';
      }
      speechSynthesis.speak(utterance);
    } catch {
      /* 忽略 */
    }
    // 给语音引擎留出初始化时间后取消，避免预热残留影响后续播报
    return new Promise((resolve) => {
      setTimeout(() => {
      	try {
      		speechSynthesis.cancel();
      	} catch {
      		/* 忽略 */
      	}
      	resolve();
      }, 600);
    });
  }

  /** 下载单个音频并转为 blob 地址；失败或超时返回 null */
  async _fetchClip(file) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer = null;
    if (controller) timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(
      	`${AUDIO_DIR}${file}`,
      	controller ? { signal: controller.signal } : undefined
      );
      if (!response.ok) return null;
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } catch {
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 预加载全部短音频并预热语音引擎，完成后播放不再等待网络。
   * 幂等：重复调用复用同一任务。返回是否全部就绪。
   */
  async preloadAll() {
    if (this._preloadPromise) return this._preloadPromise;
    this._preloadPromise = (async () => {
      const files = [
      	...NUMBER_FILES.map((n) => `${n}.wav`),
      	...CUE_FILES.map((name) => `${name}.wav`),
      ];
      const results = await Promise.allSettled(files.map((file) => this._fetchClip(file)));
      results.forEach((result, index) => {
      	if (result.status === 'fulfilled' && result.value) {
      		this._clips.set(files[index], result.value);
      	}
      });
      await this._ensureVoicesReady();
      await this._warmSpeech();
      return this._clips.size === files.length;
    })();
    return this._preloadPromise;
  }

  /** 取消进行中与待播的语音合成 */
  _cancelSpeech() {
    this._speechToken += 1;
    this._speechQueue = [];
    if (typeof speechSynthesis !== 'undefined') {
      try {
        speechSynthesis.cancel();
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 挑选中文语音（优先 zh-CN，兼容 zh_CN 与 cmn） */
  _resolveVoice() {
    if (typeof speechSynthesis === 'undefined') return null;
    const voices = speechSynthesis.getVoices();
    const find = (predicate) => voices.find(predicate) || null;
    this._zhVoice =
      find((v) => /^zh[-_]CN/i.test(v.lang)) ||
      find((v) => /cmn/i.test(v.lang)) ||
      find((v) => /^zh/i.test(v.lang));
    return this._zhVoice;
  }

  /**
   * 解锁音频：必须在用户手势内调用。
   * 播放一次真实片段即可解锁整页媒体与语音权限，无需逐个元素解锁。
   */
  unlockAudio() {
    try {
      this._audio.src = `${AUDIO_DIR}1.wav`;
      const p = this._audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => { /* 忽略 */ });
      this._audio.pause();
      this._audio.currentTime = 0;
    } catch {
      /* 忽略 */
    }
    if (typeof speechSynthesis !== 'undefined') {
      this._resolveVoice();
      try {
        const warmUp = new SpeechSynthesisUtterance(' ');
        warmUp.volume = 0;
        speechSynthesis.speak(warmUp);
        speechSynthesis.cancel();
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 播放数字报数（n 为 0~10 整数）。不取消语音，避免 iOS 音频会话反复切换压声。 */
  playNumber(n) {
    const num = Math.max(0, Math.min(10, Math.round(n)));
    this._playClip(`${num}.wav`);
  }

  /** 播放提示音：rest / done / half */
  playCue(name) {
    if (!CUE_FILES.includes(name)) return;
    this._playClip(`${name}.wav`);
  }

  /** 中文语音播报文本：先停止短音频，再按标点或每 50 字分块依次播报 */
  speakText(text) {
    if (typeof speechSynthesis === 'undefined') return;
    const source = String(text || '').trim();
    if (!source) return;
    this.stopAudio();
    this._cancelSpeech();
    const chunks = splitChunks(source);
    if (chunks.length === 0) return;
    this._speechQueue = chunks.slice();
    const token = ++this._speechToken;
    this._speakNext(token);
  }

  /** 依次播报队列中的文本块；iOS 上 onend 可能不触发，用计时兜底推进 */
  _speakNext(token) {
    if (token !== this._speechToken || this._speechQueue.length === 0) return;
    const chunk = this._speechQueue.shift();
    const utterance = new SpeechSynthesisUtterance(chunk);
    const voice = this._resolveVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    } else {
      utterance.lang = 'zh-CN';
    }
    let settled = false;
    let fallback = null;
    const advance = () => {
      if (settled) return;
      settled = true;
      if (fallback) clearTimeout(fallback);
      this._speakNext(token);
    };
    // 按文本长度估算时长，超过后强制推进队列
    fallback = setTimeout(advance, Math.max(1500, chunk.length * 400 + 1200));
    utterance.onend = advance;
    utterance.onerror = advance;
    try {
      speechSynthesis.speak(utterance);
    } catch {
      advance();
    }
  }
}
