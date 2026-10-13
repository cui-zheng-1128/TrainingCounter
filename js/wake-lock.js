/**
 * 防熄屏管理：优先使用 Screen Wake Lock API，
 * 不可用或申请失败时回退到隐藏静音视频（iOS/WebKit 用 mp4，其余内核用 webm）。
 */

// 是否期望保持防熄屏（由 enable/disable 维护）
let desired = false;
// 当前模式：'native' | 'video' | null
let mode = null;
// 原生屏幕锁实例（申请中为 Promise）
let lock = null;
// 视频回退元素
let video = null;
// 视频回退是否失败
let videoFailed = false;

/** 是否处于 WebKit 内核环境（iOS 全系浏览器均为 WebKit） */
function isWebKit() {
	return /WebKit/i.test(navigator.userAgent);
}

/** 创建隐藏的静音循环视频 */
function createVideo() {
	const el = document.createElement('video');
	el.muted = true;
	el.setAttribute('playsinline', '');
	el.setAttribute('loop', '');
	el.setAttribute('autoplay', '');
	el.setAttribute('aria-hidden', 'true');
	el.width = 1;
	el.height = 1;
	el.style.position = 'fixed';
	el.style.right = '0';
	el.style.bottom = '0';
	el.style.width = '1px';
	el.style.height = '1px';
	el.style.opacity = '0';
	el.style.pointerEvents = 'none';
	el.src = isWebKit() ? 'assets/nosleep.mp4' : 'assets/nosleep.webm';
	return el;
}

/** 销毁视频元素并释放资源 */
function destroyVideo() {
	if (!video) return;
	try {
		video.pause();
	} catch {
		/* 忽略 */
	}
	if (video.parentNode) video.parentNode.removeChild(video);
	try {
		video.removeAttribute('src');
		video.load();
	} catch {
		/* 忽略 */
	}
	video = null;
}

/** 绑定原生锁的释放事件：运行期间锁被系统回收且页面可见时重新申请 */
function bindLock(lockInstance) {
	if (!lockInstance || typeof lockInstance.addEventListener !== 'function') return;
	lockInstance.addEventListener('release', () => {
		if (lock === lockInstance) lock = null;
		if (desired && document.visibilityState === 'visible') requestNative();
	});
}

/** 申请原生屏幕锁，受理成功返回 true（异步失败时转视频回退） */
function requestNative() {
	if (!('wakeLock' in navigator) || typeof navigator.wakeLock.request !== 'function') return false;
	try {
		const pending = navigator.wakeLock.request('screen');
		if (pending && typeof pending.then === 'function') {
			lock = pending;
			pending
				.then((instance) => {
					lock = instance;
					bindLock(instance);
				})
				.catch(() => {
					lock = null;
					if (desired) {
						mode = 'video';
						enableVideo();
					}
				});
			return true;
		}
	} catch {
		/* 继续回退视频方案 */
	}
	return false;
}

/** 启用视频回退方案，返回是否成功 */
function enableVideo() {
	if (video) {
		// 已有视频：若被系统暂停则恢复播放
		if (video.paused && desired) {
			try {
				const p = video.play();
				if (p && typeof p.catch === 'function') p.catch(() => { videoFailed = true; });
			} catch {
				videoFailed = true;
			}
		}
		return !videoFailed;
	}
	video = createVideo();
	document.body.appendChild(video);
	try {
		const p = video.play();
		if (p && typeof p.catch === 'function') {
			p.catch(() => {
				videoFailed = true;
				destroyVideo();
			});
		}
	} catch {
		videoFailed = true;
		destroyVideo();
	}
	return !videoFailed;
}

/**
 * 启用防熄屏：需在"开始"按钮的用户手势内调用。
 * 返回是否启用成功；全部方案失败时返回 false，供 UI 提示。
 */
export function enable() {
	desired = true;
	videoFailed = false;
	if (requestNative()) {
		mode = 'native';
		return true;
	}
	mode = 'video';
	return enableVideo();
}

/** 停用防熄屏并释放全部资源 */
export function disable() {
	desired = false;
	if (lock) {
		try {
			lock.release();
		} catch {
			/* 忽略 */
		}
		lock = null;
	}
	destroyVideo();
	mode = null;
}

/** 页面重新可见时恢复防熄屏：原生锁丢失则重新申请，视频暂停则重新播放 */
export function restore() {
	if (!desired) return;
	if (mode === 'native') {
		if (!lock) requestNative();
	} else if (mode === 'video') {
		enableVideo();
	}
}

/** 当前是否处于防熄屏激活状态 */
export function isActive() {
	if (!desired) return false;
	if (mode === 'native') return lock !== null;
	if (mode === 'video') return Boolean(video && !video.paused && !videoFailed);
	return false;
}

// 监听页面可见性：重新可见时自动恢复防熄屏
if (typeof document !== 'undefined') {
	document.addEventListener('visibilitychange', () => {
		if (document.visibilityState === 'visible') restore();
	});
}
