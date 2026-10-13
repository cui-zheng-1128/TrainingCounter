/**
 * 计时引擎单元测试（node:test，ES Module）。
 * 运行方式：node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../js/timer-engine.js';

// 默认测试配置：三段、训练 20 秒、休息 10 秒
function defaultConfig(overrides = {}) {
	return {
		segments: [
			{ id: 'a', name: '训练 1' },
			{ id: 'b', name: '训练 2' },
			{ id: 'c', name: '训练 3' },
		],
		segmentDuration: 20,
		restDuration: 10,
		startIndex: 0,
		...overrides,
	};
}

test('默认从第一段开始：准备 10 秒后进入第一段训练，并触发阶段事件', () => {
	const events = [];
	const engine = createEngine({ onPhaseChange: (info) => events.push(info) });
	const t0 = 1000;
	engine.start(defaultConfig());
	// start 时触发准备阶段事件
	assert.equal(events.length, 1);
	assert.equal(events[0].phase, 'preCountdown');
	assert.equal(events[0].segmentIndex, 0);
	// 首次 tick 锚定阶段起点
	let vm = engine.tick(t0);
	assert.equal(vm.state, 'preCountdown');
	assert.equal(vm.remainingSeconds, 10);
	assert.equal(vm.segmentName, '训练 1');
	// 距结束恰好 0.001 秒时仍在准备阶段
	vm = engine.tick(t0 + 9999);
	assert.equal(vm.state, 'preCountdown');
	// 10 秒整进入第一段训练
	vm = engine.tick(t0 + 10000);
	assert.equal(vm.state, 'work');
	assert.equal(vm.currentSegmentIndex, 0);
	assert.equal(vm.segmentName, '训练 1');
	assert.equal(vm.phaseTotalSeconds, 20);
	assert.ok(events.some((e) => e.phase === 'work' && e.segmentIndex === 0));
});

test('非最后段训练结束进入休息，休息结束进入下一段，最后一段结束进入完成', () => {
	const events = [];
	const engine = createEngine({ onPhaseChange: (info) => events.push(info) });
	const t0 = 0;
	engine.start(defaultConfig());
	engine.tick(t0);
	// 准备 10 秒 + 第一段训练 20 秒 → 休息
	let vm = engine.tick(t0 + 30000);
	assert.equal(vm.state, 'rest');
	assert.equal(vm.currentSegmentIndex, 0);
	assert.equal(vm.phaseTotalSeconds, 10);
	// 休息 10 秒结束 → 第二段训练
	vm = engine.tick(t0 + 40000);
	assert.equal(vm.state, 'work');
	assert.equal(vm.currentSegmentIndex, 1);
	assert.equal(vm.segmentName, '训练 2');
	// 快进到最后一段训练结束（10+20+10+20+10+20 = 90 秒）→ 完成
	vm = engine.tick(t0 + 90000);
	assert.equal(vm.state, 'done');
	assert.equal(vm.remainingSeconds, 0);
	assert.equal(vm.progress, 1);
	assert.equal(vm.isLastSegment, true);
	assert.ok(events.some((e) => e.phase === 'done'));
});

test('暂停冻结剩余时间，继续后按剩余时间恢复', () => {
	const engine = createEngine();
	const t0 = 0;
	engine.start(defaultConfig({ segmentDuration: 30, restDuration: 10 }));
	engine.tick(t0);
	engine.tick(t0 + 10000); // 进入第一段训练
	// 训练进行 5 秒，剩余 25 秒
	const vm1 = engine.tick(t0 + 15000);
	assert.equal(vm1.state, 'work');
	assert.ok(Math.abs(vm1.remainingSeconds - 25) < 1e-6);
	// 训练进行 7 秒时暂停，剩余 23 秒
	engine.pause(t0 + 17000);
	let vm = engine.tick(t0 + 1000000);
	assert.equal(vm.state, 'paused');
	assert.ok(Math.abs(vm.remainingSeconds - 23) < 1e-6); // 剩余时间冻结
	// 继续后剩余时间从 23 秒连续向下
	engine.resume(t0 + 1000000);
	vm = engine.tick(t0 + 1000000 + 2000);
	assert.equal(vm.state, 'work');
	assert.ok(Math.abs(vm.remainingSeconds - 21) < 1e-6);
});

test('跳过：训练中直接进入下一段（无休息），最后一段跳过结束，休息中跳过进入下一段', () => {
	const events = [];
	const t0 = 0;
	// 两段配置：第一段训练中跳过 → 第二段；最后一段跳过 → 完成
	const engine = createEngine({ onPhaseChange: (info) => events.push(info) });
	engine.start(defaultConfig({ segments: defaultConfig().segments.slice(0, 2) }));
	engine.tick(t0);
	engine.tick(t0 + 10000); // 进入第一段训练
	engine.skip(t0 + 12000);
	let vm = engine.tick(t0 + 12000);
	assert.equal(vm.state, 'work');
	assert.equal(vm.currentSegmentIndex, 1);
	assert.equal(vm.phaseTotalSeconds, 20);
	engine.skip(t0 + 13000); // 最后一段跳过 → 完成
	vm = engine.tick(t0 + 13000);
	assert.equal(vm.state, 'done');
	// 休息中跳过 → 直接下一段
	const engine2 = createEngine({ onPhaseChange: (info) => events.push(info) });
	engine2.start(defaultConfig());
	engine2.tick(t0);
	engine2.tick(t0 + 30000); // 处于休息段
	assert.equal(engine2.tick(t0 + 30000).state, 'rest');
	engine2.skip(t0 + 31000);
	const vm2 = engine2.tick(t0 + 31000);
	assert.equal(vm2.state, 'work');
	assert.equal(vm2.currentSegmentIndex, 1);
});

test('指定起始段时从该段开始', () => {
	const events = [];
	const engine = createEngine({ onPhaseChange: (info) => events.push(info) });
	const t0 = 0;
	engine.start(defaultConfig({ startIndex: 2 }));
	let vm = engine.tick(t0);
	assert.equal(vm.state, 'preCountdown');
	assert.equal(vm.currentSegmentIndex, 2);
	assert.equal(vm.segmentName, '训练 3');
	vm = engine.tick(t0 + 10000);
	assert.equal(vm.state, 'work');
	assert.equal(vm.currentSegmentIndex, 2);
	assert.equal(vm.isLastSegment, true);
	assert.ok(events.some((e) => e.phase === 'work' && e.segmentIndex === 2));
});

test('后台恢复：连续跨过多个阶段只触发一次阶段事件', () => {
	const events = [];
	const engine = createEngine({ onPhaseChange: (info) => events.push(info) });
	const t0 = 100;
	engine.start(defaultConfig());
	engine.tick(t0); // 锚定
	const countBefore = events.length; // 1（准备阶段事件）
	// 后台经过 3 个阶段时长（准备 10 + 训练 20 + 休息 10 = 40 秒），落在第二段训练起点
	engine.reconcile(t0 + 40000);
	assert.equal(events.length, countBefore + 1); // 只触发一次
	const last = events[events.length - 1];
	assert.equal(last.phase, 'work');
	assert.equal(last.segmentIndex, 1);
	const vm = engine.tick(t0 + 40000);
	assert.equal(vm.state, 'work');
	assert.equal(vm.currentSegmentIndex, 1);
	assert.ok(Math.abs(vm.remainingSeconds - 20) < 1e-6);
});

test('剩余时间边界：最后 0.001 秒内不越界', () => {
	const t0 = 0;
	const engine = createEngine();
	engine.start(defaultConfig({ startIndex: 2 })); // 最后一段，结束即完成
	engine.tick(t0);
	const workStart = t0 + 10000;
	// 距离结束还有 0.0005 秒（小于阈值 0.001）→ 已结束
	let vm = engine.tick(workStart + 20000 - 0.5);
	assert.equal(vm.state, 'done');
	assert.equal(vm.remainingSeconds, 0);
	assert.equal(vm.progress, 1);
	// 大幅越过边界不产生负剩余时间
	vm = engine.tick(workStart + 30000);
	assert.equal(vm.state, 'done');
	assert.ok(vm.remainingSeconds >= 0);
	// 非最后段：剩余恰好 0.001 秒时仍处于训练
	const engine2 = createEngine();
	engine2.start(defaultConfig());
	engine2.tick(t0);
	let vm2 = engine2.tick(workStart + 20000 - 1);
	assert.equal(vm2.state, 'work');
	assert.ok(Math.abs(vm2.remainingSeconds - 0.001) < 1e-6);
	// 越过边界进入休息，剩余时间不为负且不越界
	vm2 = engine2.tick(workStart + 20000 + 0.5);
	assert.equal(vm2.state, 'rest');
	assert.ok(vm2.remainingSeconds >= 0);
	assert.ok(vm2.remainingSeconds <= vm2.phaseTotalSeconds);
});

test('准备阶段跳过直接进入起始段训练；重置回到空闲', () => {
	const engine = createEngine();
	const t0 = 0;
	engine.start(defaultConfig({ startIndex: 1 }));
	engine.tick(t0);
	engine.skip(t0 + 5000); // 准备中跳过
	const vm = engine.tick(t0 + 5000);
	assert.equal(vm.state, 'work');
	assert.equal(vm.currentSegmentIndex, 1);
	assert.equal(vm.segmentName, '训练 2');
	engine.reset();
	const after = engine.tick(t0 + 999999);
	assert.equal(after.state, 'idle');
	assert.equal(after.remainingSeconds, 0);
});
