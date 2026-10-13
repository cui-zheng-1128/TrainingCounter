/**
 * localStorage 持久化：读写应用状态，加载时做合法性校验与回退。
 */

// 存储键名
const STORAGE_KEY = 'training-counter-state-v1';
// 设置最小值（与界面校验保持一致）
const MIN_SEGMENT_DURATION = 20;
const MIN_REST_DURATION = 10;

/** 生成训练 id：优先 crypto.randomUUID，不支持时用时间戳兜底 */
export function newId() {
	try {
		if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
			return crypto.randomUUID();
		}
	} catch {
		/* 继续使用兜底方案 */
	}
	return `seg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 默认三段 */
export function defaultSegments() {
	return [1, 2, 3].map((i) => ({ id: newId(), name: `训练 ${i}` }));
}

/** 构造全新默认状态 */
function freshState() {
	return {
		segmentDuration: 30,
		restDuration: 15,
		segments: defaultSegments(),
		startIndex: 0,
		hintDismissed: false,
	};
}

/** 校验单个时长数值：非法或低于最小值时回退默认值 */
function validDuration(value, min, fallback) {
	const num = Number(value);
	if (!Number.isFinite(num) || num < min) return fallback;
	return num;
}

/** 校验并修复状态 */
function sanitize(state) {
	const result = freshState();
	result.segmentDuration = validDuration(state.segmentDuration, MIN_SEGMENT_DURATION, 30);
	result.restDuration = validDuration(state.restDuration, MIN_REST_DURATION, 15);
	if (Array.isArray(state.segments)) {
		const cleaned = state.segments
			.filter((item) => item && typeof item === 'object' && typeof item.id === 'string' && item.id)
			.map((item, index) => ({
				id: item.id,
				name: typeof item.name === 'string' && item.name.trim() ? item.name : `训练 ${index + 1}`,
			}));
		// 原列表有数据但全部非法时回退默认；空数组保留（用户主动清空）
		result.segments = cleaned.length > 0 || state.segments.length === 0 ? cleaned : defaultSegments();
	}
	// 起始段下标越界时回退 0
	const maxIndex = result.segments.length - 1;
	const si = Number(state.startIndex);
	result.startIndex = Number.isInteger(si) && si >= 0 && si <= maxIndex ? si : 0;
	result.hintDismissed = Boolean(state.hintDismissed);
	return result;
}

/** 从 localStorage 读取状态（带校验回退） */
export function load() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return freshState();
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return freshState();
		return sanitize(parsed);
	} catch {
		return freshState();
	}
}

/** 将状态写入 localStorage */
export function save(state) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		/* 存储不可用时静默失败 */
	}
}

/**
 * 解析导入的训练计划 JSON 文本。
 * 导出文件允许不含训练 id，导入时为每段重新生成；字段非法时回退默认值。
 * @param {string} text JSON 文本
 * @returns {{ ok: true, state: object } | { ok: false, error: string }}
 */
export function parseImportedPlan(text) {
	try {
		const parsed = JSON.parse(String(text));
		if (!parsed || typeof parsed !== 'object') throw new Error('文件内容不是有效的训练计划');
		const source = Array.isArray(parsed.segments) ? parsed.segments : null;
		if (!source || source.length === 0) throw new Error('训练计划中没有训练');
		const state = freshState();
		state.segmentDuration = validDuration(parsed.segmentDuration, MIN_SEGMENT_DURATION, 30);
		state.restDuration = validDuration(parsed.restDuration, MIN_REST_DURATION, 15);
		state.segments = source.map((item, index) => {
		  // 兼容两种格式：字符串名称或 { name } 对象
		  const rawName = typeof item === 'string' ? item : item && item.name;
		  const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : `训练 ${index + 1}`;
		  return { id: newId(), name };
		});
		const maxIndex = state.segments.length - 1;
		const si = Number(parsed.startIndex);
		state.startIndex = Number.isInteger(si) && si >= 0 && si <= maxIndex ? si : 0;
		return { ok: true, state };
	} catch (error) {
		return { ok: false, error: error && error.message ? error.message : '文件读取失败' };
	}
}
