/**
 * 应用入口：UI 绑定与主流程编排。
 * 计时由 requestAnimationFrame 驱动，每秒边界触发语音报数。
 */

import { createEngine } from './timer-engine.js';
import { Announcer } from './announcer.js';
import * as wakeLock from './wake-lock.js';
import * as storage from './storage.js';

// 准备与训练最后 N 秒报数窗口
const WORK_NUMBER_WINDOW = 10;
// 休息段最后 N 秒报数窗口
const REST_NUMBER_WINDOW = 5;

// 各阶段报数窗口（秒）
const WINDOW_BY_PHASE = {
	preCountdown: WORK_NUMBER_WINDOW,
	work: WORK_NUMBER_WINDOW,
	rest: REST_NUMBER_WINDOW,
};

// 过半播报后该时段（毫秒）内跳过紧跟其后的首个报数，避免两段音频互相截断。
// 过半音频约 1.8 秒且提前 1 秒播放：20 秒段时"10"在其播放中途触发（+1 秒）需跳过，"9"（+2 秒）正常播放。
const HALFWAY_GUARD_MS = 1900;

// 各阶段的界面标签
const PHASE_LABELS = {
	idle: '未开始',
	preCountdown: '准备中',
	work: '训练',
	rest: '休息',
	done: '已完成',
};

// 应用版本号（页脚展示）
const APP_VERSION = 'v1.0.0';

// 应用状态（持久化部分）
let appState = storage.load();
// 是否处于运行状态（控制设置与列表编辑禁用）
let running = false;
// 是否正在加载语音资源（加载动画显示期间拦截重复操作）
let loadingAssets = false;
// 本阶段上次播报的数字（去重）
let lastSpokenNumber = null;
// 本阶段是否已播报"过半"
let halfAnnounced = false;
// 播报"过半"的时刻（单调毫秒时间戳）
let halfAnnouncedAt = 0;
// 上次高亮的训练下标与样式类（避免每帧重复操作 DOM）
let lastHighlight = { index: -1, className: '' };
// 上次自动居中的训练下标（阶段切换时触发平滑滚动）
let lastAutoAnchor = -1;
// 自动居中后的校验定时器（iOS 触摸会打断平滑滚动，需二次校正）
let autoScrollCheckTimer = null;
// 是否支持原生平滑滚动（老内核降级为立即跳转）
const supportsSmoothScroll = typeof document !== 'undefined'
	&& 'scrollBehavior' in document.documentElement.style;
// 轻提示隐藏定时器
let toastTimer = null;
// SortableJS 实例
let sortable = null;

/* ---------- 阶段切换回调 ---------- */

function onPhaseChange(info) {
	lastSpokenNumber = null; // 新阶段重置报数去重
	halfAnnounced = false; // 新阶段重置过半标记
	if (info.phase === 'work') {
		announcer.speakText(info.segmentName); // 进入训练播报段名
	} else if (info.phase === 'rest') {
		announcer.playCue('rest'); // 训练结束播报"休息"
	} else if (info.phase === 'done') {
		announcer.playCue('done'); // 全部结束播报"训练完成"
		wakeLock.disable();
	}
}

// 引擎与播报器（播报器需先于引擎创建，供回调引用）
const announcer = new Announcer();
const engine = createEngine({ onPhaseChange });

/* ---------- DOM 引用 ---------- */

const els = {
	hintBar: document.getElementById('hint-bar'),
	btnHintClose: document.getElementById('btn-hint-close'),
	cardSettings: document.getElementById('card-settings'),
	inputDuration: document.getElementById('input-duration'),
	inputRest: document.getElementById('input-rest'),
	settingsError: document.getElementById('settings-error'),
	segmentList: document.getElementById('segment-list'),
	listEmpty: document.getElementById('list-empty'),
	btnAddSegment: document.getElementById('btn-add-segment'),
	btnExport: document.getElementById('btn-export'),
	btnImport: document.getElementById('btn-import'),
	importFile: document.getElementById('import-file'),
	planSummary: document.getElementById('plan-summary'),
	runProgress: document.getElementById('run-progress'),
	phaseLabel: document.getElementById('phase-label'),
	runSegmentName: document.getElementById('run-segment-name'),
	runTime: document.getElementById('run-time'),
	progressFill: document.getElementById('progress-fill'),
	btnStart: document.getElementById('btn-start'),
	btnPause: document.getElementById('btn-pause'),
	btnResume: document.getElementById('btn-resume'),
	btnSkip: document.getElementById('btn-skip'),
	btnReset: document.getElementById('btn-reset'),
	donePanel: document.getElementById('done-panel'),
	btnDoneReset: document.getElementById('btn-done-reset'),
	toast: document.getElementById('toast'),
	loadingOverlay: document.getElementById('loading-overlay'),
};

/* ---------- 工具函数 ---------- */

/** HTML 转义（用于行内渲染训练名称） */
function escapeHtml(text) {
	return String(text)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** 显示轻提示 */
function showToast(message) {
	els.toast.textContent = message;
	els.toast.hidden = false;
	if (toastTimer) clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		els.toast.hidden = true;
	}, 2600);
}

/** 将秒数格式化为 mm:ss（UI 用 Math.ceil 显示） */
function formatTime(seconds) {
	const total = Math.max(0, Math.ceil(seconds - 1e-6));
	const mm = String(Math.floor(total / 60)).padStart(2, '0');
	const ss = String(total % 60).padStart(2, '0');
	return `${mm}:${ss}`;
}

/* ---------- 设置 ---------- */

/** 读取输入框数值，非法时返回 NaN */
function readDuration(input) {
	const value = Number(input.value);
	return Number.isFinite(value) ? value : NaN;
}

/** 校验设置；showError 为 true 时弹出提示，返回是否合法 */
function validateSettings(showError) {
	const errors = [];
	const duration = readDuration(els.inputDuration);
	const rest = readDuration(els.inputRest);
	if (!Number.isFinite(duration) || duration < 20) errors.push('训练时长最短 20 秒');
	if (!Number.isFinite(rest) || rest < 10) errors.push('休息时长最短 10 秒');
	els.settingsError.textContent = errors.join('；');
	els.settingsError.hidden = errors.length === 0;
	if (errors.length > 0 && showError) showToast(errors.join('；'));
	return errors.length === 0;
}

/** 提交合法设置并持久化 */
function commitSettings() {
	if (!validateSettings(false)) return false;
	appState.segmentDuration = readDuration(els.inputDuration);
	appState.restDuration = readDuration(els.inputRest);
	storage.save(appState);
	updatePlanSummary(); // 设置变化后刷新总时长
	return true;
}

/* ---------- 列表 ---------- */

/** 按运行状态刷新列表的编辑禁用态 */
function refreshSegmentDisabled() {
	els.segmentList.querySelectorAll('input, button').forEach((el) => {
		el.disabled = running;
	});
}

/** 重建列表 DOM */
function renderSegmentList() {
	els.segmentList.innerHTML = '';
	lastHighlight = { index: -1, className: '' }; // 重建后清空高亮缓存
	const isEmpty = appState.segments.length === 0;
	els.listEmpty.hidden = !isEmpty;
	els.btnStart.disabled = isEmpty; // 列表为空时禁用开始
	appState.segments.forEach((segment, index) => {
		const row = document.createElement('div');
		row.className = 'segment-row';
		row.dataset.index = String(index);
		row.innerHTML = `
      <span class="drag-handle" aria-hidden="true">≡</span>
      <span class="segment-index">${index + 1}</span>
      <input class="segment-name" type="text" maxlength="30" value="${escapeHtml(segment.name)}" aria-label="训练名称">
      <label class="start-label">
        <input type="radio" name="start-segment" value="${index}" ${index === appState.startIndex ? 'checked' : ''}>
        <span>设为起始</span>
      </label>
      <button type="button" class="btn-delete" aria-label="删除训练">×</button>`;
		els.segmentList.appendChild(row);
	});
	refreshSegmentDisabled();
	updatePlanSummary();
}

/** 将秒数格式化为时长文本（分：秒，超过一小时带小时位） */
function formatDurationText(seconds) {
	const total = Math.max(0, Math.round(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
	return `${m}:${String(s).padStart(2, '0')}`;
}

/** 按给定时长渲染总时长汇总 */
function renderPlanSummary(segmentDuration, restDuration) {
	const n = appState.segments.length;
	if (n === 0) {
		els.planSummary.textContent = '总时长：请先添加训练训练';
		return;
	}
	const workSeconds = n * segmentDuration;
	const restSeconds = (n - 1) * restDuration;
	els.planSummary.textContent =
		`总时长 ${formatDurationText(workSeconds + restSeconds)}（训练 ${formatDurationText(workSeconds)} + 休息 ${formatDurationText(restSeconds)}）`;
}

/** 实时汇总训练计划总时长（训练 + 段间休息，不含准备倒计时） */
function updatePlanSummary() {
	renderPlanSummary(appState.segmentDuration, appState.restDuration);
}

/** 设置输入过程中实时预览总时长（不持久化） */
function previewPlanSummary() {
	const duration = readDuration(els.inputDuration);
	const rest = readDuration(els.inputRest);
	if (!Number.isFinite(duration) || !Number.isFinite(rest)) return;
	renderPlanSummary(duration, rest);
}

/** 添加训练 */
function addSegment() {
	if (running) return;
	const count = appState.segments.length;
	appState.segments.push({ id: storage.newId(), name: `训练 ${count + 1}` });
	storage.save(appState);
	renderSegmentList();
}

/** 删除训练 */
function deleteSegment(index) {
	if (running) return;
	appState.segments.splice(index, 1);
	// 修正起始段下标，防止越界
	appState.startIndex = Math.max(0, Math.min(appState.startIndex, appState.segments.length - 1));
	storage.save(appState);
	renderSegmentList();
}

/* ---------- 拖拽排序 ---------- */

function initSortable() {
	if (typeof Sortable === 'undefined') return; // SortableJS 未加载时降级为普通列表
	sortable = new Sortable(els.segmentList, {
		handle: '.drag-handle',
		animation: 150,
		ghostClass: 'sortable-ghost',
		onEnd(evt) {
			const { oldIndex, newIndex } = evt;
			if (oldIndex == null || newIndex == null || oldIndex === newIndex) return;
			// 同步模型顺序
			const [moved] = appState.segments.splice(oldIndex, 1);
			if (!moved) return;
			appState.segments.splice(newIndex, 0, moved);
			// 修正起始段下标
			if (appState.startIndex === oldIndex) appState.startIndex = newIndex;
			else if (oldIndex < appState.startIndex && newIndex >= appState.startIndex) appState.startIndex -= 1;
			else if (oldIndex > appState.startIndex && newIndex <= appState.startIndex) appState.startIndex += 1;
			storage.save(appState);
			renderSegmentList();
		},
	});
}

/* ---------- 运行面板 ---------- */

/** 刷新运行面板显示 */
function syncRunPanel(vm) {
	// 阶段标签：暂停时显示"已暂停"
	els.phaseLabel.textContent = vm.state === 'paused' ? '已暂停' : (PHASE_LABELS[vm.phase] || '未开始');
	// 当前段名称
	if (vm.phase === 'preCountdown') els.runSegmentName.textContent = `即将开始：${vm.segmentName}`;
	else if (vm.phase === 'work') els.runSegmentName.textContent = vm.segmentName;
	else if (vm.phase === 'rest') els.runSegmentName.textContent = '休息';
	else els.runSegmentName.textContent = '';
	// 大号剩余时间（Math.ceil 秒）
	els.runTime.textContent = formatTime(vm.remainingSeconds);
	// 运行进度标注（第几段 / 总段数）
	const total = appState.segments.length;
	if (vm.phase === 'preCountdown') {
		els.runProgress.textContent = `第 ${vm.currentSegmentIndex + 1} / ${total} 段 · 即将开始`;
	} else if (vm.phase === 'work') {
		els.runProgress.textContent = `第 ${vm.currentSegmentIndex + 1} / ${total} 段`;
	} else if (vm.phase === 'rest') {
		els.runProgress.textContent = `休息中 · 第 ${vm.currentSegmentIndex + 2} / ${total} 段`;
	} else if (vm.phase === 'done') {
		els.runProgress.textContent = '全部完成';
	} else {
		els.runProgress.textContent = '';
	}
	// 进度条（本阶段 progress）
	els.progressFill.style.width = `${(vm.progress * 100).toFixed(2)}%`;
	// 按钮按状态显隐
	const active = vm.state === 'preCountdown' || vm.state === 'work' || vm.state === 'rest';
	els.btnStart.hidden = vm.state !== 'idle';
	els.btnPause.hidden = !active;
	els.btnResume.hidden = vm.state !== 'paused';
	els.btnSkip.hidden = !(active || vm.state === 'paused');
	els.btnReset.hidden = vm.state === 'idle';
	els.donePanel.hidden = vm.state !== 'done';
}

/** 运行状态变化时同步编辑禁用（CSS pointer-events + disabled 双保险） */
function syncRunning(vm) {
	const isRunning = vm.state !== 'idle' && vm.state !== 'done';
	if (isRunning === running) return;
	running = isRunning;
	document.body.classList.toggle('running', running);
	els.inputDuration.disabled = running;
	els.inputRest.disabled = running;
	els.btnAddSegment.disabled = running;
	els.btnExport.disabled = running;
	els.btnImport.disabled = running;
	els.cardSettings.classList.toggle('disabled', running);
	els.segmentList.classList.toggle('disabled', running);
	// 运行中列表切换为固定高度滚动容器，允许滑动查看全部训练
	els.segmentList.classList.toggle('scroll-locked', running);
	refreshSegmentDisabled();
	if (sortable) sortable.option('disabled', running);
}

/** 每秒边界检测与报数（同一数字只播一次） */
function syncAnnounce(vm, now) {
	const window = WINDOW_BY_PHASE[vm.phase];
	if (!window || vm.state === 'paused') return;
	const display = Math.max(0, Math.ceil(vm.remainingSeconds - 1e-6));
	// "过半"刚播完不久且正值报数窗口首秒（如 20 秒段过半与报"10"重合）时跳过该数字，避免音频截断
	if (display === window && halfAnnounced && now - halfAnnouncedAt < HALFWAY_GUARD_MS) {
		lastSpokenNumber = display;
		return;
	}
	if (display >= 1 && display <= window && display !== lastSpokenNumber) {
		lastSpokenNumber = display;
		announcer.playNumber(display);
	}
}

/** 训练到达中点前 1 秒播报一次"过半"（仅训练；暂停期间不播） */
function syncHalfway(vm, now) {
	if (vm.phase !== 'work' || vm.state === 'paused' || halfAnnounced) return;
	if (vm.remainingSeconds <= vm.phaseTotalSeconds / 2 + 1) {
		halfAnnounced = true;
		halfAnnouncedAt = now;
		announcer.playCue('half');
	}
}

/** 计算运行中应居中的训练下标（休息时指向即将开始的下一段） */
function anchorIndex(vm) {
	if (vm.state === 'idle' || vm.state === 'done') return -1;
	if (vm.phase === 'rest') return vm.currentSegmentIndex + 1;
	return vm.currentSegmentIndex;
}

/** 计算行相对容器内容顶部的精确偏移（不依赖 offsetParent 链） */
function rowOffsetInContainer(container, row) {
	return row.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
}

/** 计算让行在容器视口内垂直居中的目标滚动位置 */
function centeredScrollTop(container, row) {
	const offset = rowOffsetInContainer(container, row);
	const target = offset - (container.clientHeight - row.clientHeight) / 2;
	return Math.max(0, Math.min(target, container.scrollHeight - container.clientHeight));
}

/** 将行滚动到容器视口中央 */
function scrollRowToCenter(container, row, smooth) {
	const target = centeredScrollTop(container, row);
	if (smooth) {
		container.scrollTo({ top: target, behavior: 'smooth' });
	} else {
		container.scrollTop = target; // 老内核降级为立即跳转
	}
}

/** 阶段切换时将当前训练平滑滚动到列表视口中央 */
function syncAutoScroll(vm) {
	const anchor = anchorIndex(vm);
	if (anchor === lastAutoAnchor) return;
	lastAutoAnchor = anchor;
	const container = els.segmentList;
	// 仅在运行中的滚动容器内居中
	if (anchor < 0 || !container.classList.contains('scroll-locked')) return;
	const row = container.querySelector(`.segment-row[data-index="${anchor}"]`);
	if (!row) return;
	scrollRowToCenter(container, row, supportsSmoothScroll);
	// iOS 上触摸会打断程序化平滑滚动：稍后校验，未到位则直接校正
	if (autoScrollCheckTimer) clearTimeout(autoScrollCheckTimer);
	autoScrollCheckTimer = setTimeout(() => {
		const currentRow = container.querySelector(`.segment-row[data-index="${anchor}"]`);
		if (!currentRow || !container.classList.contains('scroll-locked')) return;
		const target = centeredScrollTop(container, currentRow);
		if (Math.abs(container.scrollTop - target) > 8) {
			container.scrollTop = target; // 硬修正，确保当前段居中可见
		}
	}, 600);
}

/** 按运行状态高亮列表：训练中当前段、休息中下一段、准备中起始段 */
function syncSegmentHighlight(vm) {
	let index = -1;
	let className = '';
	if (vm.phase === 'work') {
		index = vm.currentSegmentIndex;
		className = 'seg-active';
	} else if (vm.phase === 'rest') {
		// 休息阶段 currentSegmentIndex 指向刚结束的段，高亮即将开始的下一段
		index = vm.currentSegmentIndex + 1;
		className = 'seg-next';
	} else if (vm.phase === 'preCountdown') {
		index = vm.currentSegmentIndex;
		className = 'seg-next';
	}
	if (index === lastHighlight.index && className === lastHighlight.className) return;
	const oldRow = lastHighlight.index >= 0
		? els.segmentList.querySelector(`.segment-row[data-index="${lastHighlight.index}"]`)
		: null;
	if (oldRow) oldRow.classList.remove('seg-active', 'seg-next');
	const row = index >= 0 ? els.segmentList.querySelector(`.segment-row[data-index="${index}"]`) : null;
	if (row) row.classList.add(className);
	lastHighlight = { index, className };
}

/* ---------- 计划导出 / 导入 ---------- */

/** 导出训练计划为 JSON 文件下载 */
function exportPlan() {
	const payload = {
		app: '训练倒计时',
		version: 1,
		exportedAt: new Date().toISOString(),
		segmentDuration: appState.segmentDuration,
		restDuration: appState.restDuration,
		segments: appState.segments.map((segment) => ({ name: segment.name })),
		startIndex: appState.startIndex,
	};
	const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	const date = new Date();
	const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
	link.href = url;
	link.download = `训练计划-${stamp}.json`;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 3000); // 延迟释放，确保下载开始
	showToast('计划已导出，请在下载中保存到"文件"');
}

/** 处理导入的计划文件 */
function handleImportFile(file) {
	if (!file) return;
	const reader = new FileReader();
	reader.onload = () => {
		const result = storage.parseImportedPlan(String(reader.result || ''));
		if (!result.ok) {
		  showToast(result.error);
		  return;
		}
		appState.segmentDuration = result.state.segmentDuration;
		appState.restDuration = result.state.restDuration;
		appState.segments = result.state.segments;
		appState.startIndex = result.state.startIndex;
		storage.save(appState);
		els.inputDuration.value = appState.segmentDuration;
		els.inputRest.value = appState.restDuration;
		renderSegmentList();
		showToast('计划已导入');
	};
	reader.onerror = () => showToast('文件读取失败');
	reader.readAsText(file);
}

/* ---------- 控制按钮 ---------- */

/** 开始流程：先加载全部语音资源，加载完成后再启动训练 */
async function onStart() {
	if (running || loadingAssets) return;
	if (!validateSettings(true)) return; // 校验失败时提示
	if (appState.segments.length === 0) {
		showToast('请先添加训练训练');
		return;
	}
	commitSettings(); // 读取并持久化合法设置
	// 用户手势内同步解锁音频并启用防熄屏（异步等待后手势上下文会失效，必须先同步执行）
	announcer.unlockAudio();
	const wakeOk = wakeLock.enable();
	if (!wakeOk) showToast('防熄屏不可用，运行期间请保持屏幕常亮');
	// 显示加载动画，等待全部语音就绪后再开始
	loadingAssets = true;
	els.loadingOverlay.hidden = false;
	let ready = false;
	try {
		ready = await announcer.preloadAll();
	} catch {
		ready = false;
	}
	els.loadingOverlay.hidden = true;
	loadingAssets = false;
	if (!ready) showToast('部分语音未能加载，播报可能受影响');
	engine.start({
		segments: appState.segments.slice(),
		segmentDuration: appState.segmentDuration,
		restDuration: appState.restDuration,
		startIndex: appState.startIndex,
	});
	lastSpokenNumber = null;
}

function onReset() {
	engine.reset();
	wakeLock.disable();
	lastSpokenNumber = null;
	lastAutoAnchor = -1;
	if (autoScrollCheckTimer) {
		clearTimeout(autoScrollCheckTimer);
		autoScrollCheckTimer = null;
	}
	els.segmentList.scrollTop = 0; // 恢复列表滚动位置
	syncRunPanel(engine.tick(performance.now()));
}

/* ---------- 主循环 ---------- */

function frame(now) {
	const vm = engine.tick(now);
	syncRunPanel(vm);
	syncRunning(vm);
	syncAutoScroll(vm);
	syncSegmentHighlight(vm);
	syncHalfway(vm, now);
	syncAnnounce(vm, now);
	requestAnimationFrame(frame);
}

/* ---------- 后台恢复 ---------- */

document.addEventListener('visibilitychange', () => {
	if (document.visibilityState !== 'visible') return;
	wakeLock.restore(); // 先恢复防熄屏
	engine.reconcile(performance.now()); // 再按真实时间戳推进阶段
	// 回到前台不补播错过的报数：把当前显示秒数记为已播报
	const vm = engine.tick(performance.now());
	const window = WINDOW_BY_PHASE[vm.phase];
	if (window && vm.state !== 'paused') {
		lastSpokenNumber = Math.max(0, Math.ceil(vm.remainingSeconds - 1e-6));
	}
	// 过半播报点（中点前 1 秒）已越过时同样不补播"过半"
	if (vm.phase === 'work' && vm.remainingSeconds <= vm.phaseTotalSeconds / 2 + 1) {
		halfAnnounced = true;
	}
});

/* ---------- 初始化 ---------- */

function init() {
	// 回填设置输入框
	els.inputDuration.value = appState.segmentDuration;
	els.inputRest.value = appState.restDuration;
	// 静音拨片提示条：首次显示，关闭状态持久化
	els.hintBar.hidden = appState.hintDismissed;
	// 注册 Service Worker（仅 https 或 localhost；失败静默）
	if ('serviceWorker' in navigator &&
		(location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
		window.addEventListener('load', () => {
			navigator.serviceWorker.register('./sw.js').catch(() => { /* 注册失败静默 */ });
		});
	}
	// iOS 独立模式适配
	if (navigator.standalone) document.body.classList.add('standalone');
	// 页脚版本号
	const versionEl = document.getElementById('app-version');
	if (versionEl) versionEl.textContent = APP_VERSION;
	// 绑定事件
	els.btnStart.addEventListener('click', onStart);
	els.btnPause.addEventListener('click', () => engine.pause(performance.now()));
	els.btnResume.addEventListener('click', () => engine.resume(performance.now()));
	els.btnSkip.addEventListener('click', () => engine.skip(performance.now()));
	els.btnReset.addEventListener('click', onReset);
	els.btnDoneReset.addEventListener('click', onReset);
	els.btnAddSegment.addEventListener('click', addSegment);
	els.btnExport.addEventListener('click', exportPlan);
	els.btnImport.addEventListener('click', () => els.importFile.click());
	els.importFile.addEventListener('change', () => {
	  handleImportFile(els.importFile.files && els.importFile.files[0]);
	  els.importFile.value = ''; // 清空以允许重复导入同一文件
	});
	els.btnHintClose.addEventListener('click', () => {
		appState.hintDismissed = true;
		storage.save(appState);
		els.hintBar.hidden = true;
	});
	// 设置输入框：失焦时校验并提示
	els.inputDuration.addEventListener('blur', () => {
		if (validateSettings(false)) commitSettings();
	});
	els.inputRest.addEventListener('blur', () => {
		if (validateSettings(false)) commitSettings();
	});
	// 设置输入过程中实时预览总时长
	els.inputDuration.addEventListener('input', previewPlanSummary);
	els.inputRest.addEventListener('input', previewPlanSummary);
	// 列表事件委托
	els.segmentList.addEventListener('input', (event) => {
		const row = event.target.closest('.segment-row');
		if (!row || !event.target.classList.contains('segment-name')) return;
		appState.segments[Number(row.dataset.index)].name = event.target.value;
	});
	els.segmentList.addEventListener('change', (event) => {
		const row = event.target.closest('.segment-row');
		if (!row) return;
		const index = Number(row.dataset.index);
		if (event.target.classList.contains('segment-name')) {
			// 空名称回退为默认名
			if (!appState.segments[index].name.trim()) appState.segments[index].name = `训练 ${index + 1}`;
			storage.save(appState);
		} else if (event.target.name === 'start-segment') {
			appState.startIndex = index;
			storage.save(appState);
		}
		renderSegmentList();
	});
	els.segmentList.addEventListener('click', (event) => {
		if (!event.target.closest('.btn-delete')) return;
		const index = Number(event.target.closest('.segment-row').dataset.index);
		deleteSegment(index);
	});
	initSortable();
	renderSegmentList();
	// 页面加载后后台预加载语音资源，缩短点击开始后的等待
	announcer.preloadAll().catch(() => { /* 忽略后台预加载失败 */ });
	// 启动计时循环
	requestAnimationFrame(frame);
}

init();
