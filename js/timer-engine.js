/**
 * 训练倒计时核心状态机（纯逻辑，零 DOM 依赖，可被 Node 测试）。
 * 引擎以"阶段起点时间戳 + 阶段时长"为基准推进，不自行计时。
 */

// 准备倒计时固定时长（秒）
const PRECOUNTDOWN_SECONDS = 10;
// 剩余时间小于该值（秒）视为阶段结束，避免浮点误差导致越界
const PHASE_END_EPSILON_SECONDS = 0.001;

/**
 * 创建引擎实例。
 * @param {{ onPhaseChange?: (info: object) => void }} options 阶段切换回调
 * @returns 引擎实例
 */
export function createEngine({ onPhaseChange } = {}) {
	// 运行状态：idle / preCountdown / work / rest / paused / done
	let state = 'idle';
	// 逻辑阶段：暂停时保留暂停前阶段，便于恢复
	let phase = 'idle';
	let pausedPhase = 'idle';
	// 训练配置
	let segments = [];
	let segmentDuration = 30;
	let restDuration = 15;
	let startIndex = 0;
	let currentSegmentIndex = 0;
	// 当前阶段起点锚点（单调毫秒时间戳）；首次 tick 时锚定
	let phaseStartAt = null;
	let phaseDurationMs = 0;
	// 暂停时冻结的剩余毫秒数
	let pausedRemainingMs = 0;

	/** 触发阶段切换事件 */
	function fireEvent(ph) {
		if (typeof onPhaseChange !== 'function') return;
		onPhaseChange({
			phase: ph,
			segmentIndex: currentSegmentIndex,
			segmentName: (segments[currentSegmentIndex] && segments[currentSegmentIndex].name) || '',
			isLast: currentSegmentIndex === segments.length - 1,
		});
	}

	/** 数值夹取 */
	function clamp(value, min, max) {
		return Math.min(max, Math.max(min, value));
	}

	/** 切换逻辑阶段并同步运行状态 */
	function setPhase(ph) {
		phase = ph;
		if (ph === 'idle') state = 'idle';
		else if (ph === 'done') state = 'done';
		else state = ph;
	}

	/** 计算指定阶段时长（毫秒） */
	function durationFor(ph) {
		if (ph === 'preCountdown') return PRECOUNTDOWN_SECONDS * 1000;
		if (ph === 'work') return segmentDuration * 1000;
		if (ph === 'rest') return restDuration * 1000;
		return 0;
	}

	/**
	 * 推进到下一阶段。
	 * 阶段链：preCountdown→work(段 i)→rest→work(段 i+1)→…→最后一段 work→done。
	 * 返回是否推进成功；已处于 done/idle 时返回 false。
	 */
	function advance() {
		const prevMs = phaseDurationMs;
		if (phase === 'preCountdown') {
			currentSegmentIndex = startIndex;
			setPhase('work');
		} else if (phase === 'work') {
			if (currentSegmentIndex >= segments.length - 1) setPhase('done');
			else setPhase('rest');
		} else if (phase === 'rest') {
			currentSegmentIndex += 1;
			setPhase('work');
		} else {
			return false;
		}
		phaseDurationMs = durationFor(phase);
		// 沿用上一阶段锚点累加，越过阶段时自然结转多余时间
		if (phaseStartAt !== null) phaseStartAt += prevMs;
		return true;
	}

	/** 构造视图模型 */
	function buildView(now) {
		const totalSeconds = phaseDurationMs / 1000;
		let remainingSeconds;
		if (state === 'paused') {
			remainingSeconds = pausedRemainingMs / 1000;
		} else if (state === 'idle' || state === 'done') {
			remainingSeconds = 0;
		} else {
			remainingSeconds = (phaseDurationMs - (now - phaseStartAt)) / 1000;
		}
		// 夹取剩余时间，避免浮点误差产生负数或越界
		remainingSeconds = clamp(remainingSeconds, 0, totalSeconds);
		const progress = totalSeconds > 0
			? clamp(1 - remainingSeconds / totalSeconds, 0, 1)
			: (state === 'done' ? 1 : 0);
		return {
			state,
			phase,
			currentSegmentIndex,
			segmentName: (segments[currentSegmentIndex] && segments[currentSegmentIndex].name) || '',
			remainingSeconds,
			phaseTotalSeconds: totalSeconds,
			progress,
			isLastSegment: currentSegmentIndex === segments.length - 1,
		};
	}

	/** 判断当前阶段是否已结束（剩余时间小于阈值） */
	function isPhaseOver(now) {
		return now - phaseStartAt > phaseDurationMs - PHASE_END_EPSILON_SECONDS * 1000;
	}

	/**
	 * 开始训练。
	 * @param {object} config 配置：训练数组、训练时长、休息时长、起始段下标
	 */
	function start({ segments: segs, segmentDuration: sd, restDuration: rd, startIndex: si = 0 } = {}) {
		segments = Array.isArray(segs) && segs.length > 0 ? segs : [{ id: 'segment-1', name: '训练 1' }];
		segmentDuration = Number.isFinite(sd) && sd > 0 ? sd : 30;
		restDuration = Number.isFinite(rd) && rd > 0 ? rd : 15;
		startIndex = clamp(Number.isFinite(si) ? Math.floor(si) : 0, 0, segments.length - 1);
		currentSegmentIndex = startIndex;
		setPhase('preCountdown');
		phaseDurationMs = durationFor('preCountdown');
		phaseStartAt = null; // 首次 tick 时锚定阶段起点
		pausedRemainingMs = 0;
		fireEvent('preCountdown');
	}

	/**
	 * 以当前时间推进引擎，返回视图模型。
	 * @param {number} now 单调毫秒时间戳（如 performance.now()）
	 */
	function tick(now) {
		if (state === 'idle' || state === 'done' || state === 'paused') return buildView(now);
		if (phaseStartAt === null) phaseStartAt = now;
		// 按阶段链连续推进直到追上当前时间，每次切换触发一次事件
		while (isPhaseOver(now)) {
			if (!advance()) break;
			fireEvent(phase);
			if (state === 'done') break;
		}
		return buildView(now);
	}

	/** 暂停：冻结当前剩余时间 */
	function pause(now) {
		if (state === 'idle' || state === 'done' || state === 'paused') return;
		const total = phaseDurationMs;
		const remaining = phaseStartAt === null ? total : Math.max(0, total - (now - phaseStartAt));
		pausedPhase = phase;
		pausedRemainingMs = remaining;
		state = 'paused';
	}

	/** 继续：以剩余时间重新锚定阶段起点，回到原阶段 */
	function resume(now) {
		if (state !== 'paused') return;
		phase = pausedPhase;
		state = pausedPhase;
		phaseStartAt = now - (phaseDurationMs - pausedRemainingMs);
		pausedRemainingMs = 0;
	}

	/**
	 * 跳过：直接进入下一训练（不经过休息）。
	 * 准备中→起始段训练；训练中→下一段（最后一段→完成）；休息中→下一段；完成中忽略。
	 */
	function skip(now) {
		if (state === 'idle' || state === 'done') return;
		const p = state === 'paused' ? pausedPhase : phase;
		if (p === 'preCountdown') {
			currentSegmentIndex = startIndex;
			setPhase('work');
		} else if (p === 'work') {
			if (currentSegmentIndex >= segments.length - 1) setPhase('done');
			else {
				currentSegmentIndex += 1;
				setPhase('work');
			}
		} else if (p === 'rest') {
			currentSegmentIndex += 1;
			setPhase('work');
		} else {
			return;
		}
		phaseDurationMs = durationFor(phase);
		phaseStartAt = now;
		pausedPhase = 'idle';
		fireEvent(phase);
	}

	/**
	 * 后台恢复：按真实经过时间连续推进阶段，直至追上当前时间。
	 * 跨过多个阶段时不逐个触发中间阶段事件，推进结束后只触发一次。
	 */
	function reconcile(now) {
		if (state === 'idle' || state === 'done' || state === 'paused') return;
		if (phaseStartAt === null) {
			phaseStartAt = now;
			return;
		}
		let advanced = false;
		while (isPhaseOver(now)) {
			if (!advance()) break;
			advanced = true;
			if (state === 'done') break;
		}
		if (advanced) fireEvent(phase);
	}

	/** 重置回空闲状态 */
	function reset() {
		state = 'idle';
		phase = 'idle';
		pausedPhase = 'idle';
		phaseStartAt = null;
		phaseDurationMs = 0;
		pausedRemainingMs = 0;
		currentSegmentIndex = 0;
		fireEvent('idle');
	}

	return { start, tick, pause, resume, skip, reconcile, reset };
}
