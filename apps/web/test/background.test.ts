import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BackgroundTask, ScheduledPrompt } from '@agenthouse/protocol';
import { clock, scheduleText, scheduleTitle, SHOWN_ENDED, taskNote, taskRows, taskStatusText, taskTitle, taskType } from '../src/workspace/background';

const task = (id: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({ id, type: 'shell', description: `task ${id}`, command: 'sleep 20', state: 'running', exitCode: null, lastEvent: null, startedAt: 0, endedAt: null, ...extra });
const done = (id: string) => task(id, { state: 'done', exitCode: 0, endedAt: 1 });
const job = (schedule: string, extra: Partial<ScheduledPrompt> = {}) => ({ schedule, recurring: true, nextAt: null, ...extra });
// Local times, as the page shows them.
const at = (hour: number, minute: number, day = 16) => new Date(2026, 10, day, hour, minute).getTime();
const now = at(15, 0);

test('ended tasks beyond a few fold away; the running ones and the latest ended stay, in the order they started', () => {
  const tasks = [done('a'), task('b'), done('c'), done('d'), done('e'), task('f'), done('g')];
  assert.equal(SHOWN_ENDED, 3);
  assert.deepEqual(taskRows(tasks, false), { rows: [tasks[1], tasks[3], tasks[4], tasks[5], tasks[6]], folded: 2 });
  assert.deepEqual(taskRows(tasks, true), { rows: tasks, folded: 0 }, 'opened: all of them');
  assert.deepEqual(taskRows(tasks.slice(1, 5), false), { rows: tasks.slice(1, 5), folded: 0 }, 'three ended ones need no folding');
});

test('a task row: what it is for, its kind, and what is worth a glance', () => {
  assert.equal(taskTitle(task('a')), 'task a');
  assert.equal(taskTitle(task('a', { description: null })), 'sleep 20', 'without a description, its command');
  assert.deepEqual([taskType(task('a')), taskType(task('a', { type: 'monitor' })), taskType(task('a', { type: 'workflow' }))], ['셸', '모니터', 'workflow']);
  assert.equal(taskStatusText(task('a')), '실행 중');
  assert.equal(taskStatusText(done('a')), '완료');
  assert.equal(taskStatusText(task('a', { state: 'failed', exitCode: 2 })), '실패 · 종료 코드 2');
  assert.equal(taskNote(task('a', { type: 'monitor', lastEvent: 'deployed 3 of 5' })), 'deployed 3 of 5', "a monitor's latest line");
  assert.equal(taskNote(task('a', { state: 'failed', exitCode: 1, lastEvent: 'x' })), '실패 · 종료 코드 1', 'how it went wrong comes first');
  assert.equal(taskNote(done('a')), null);
});

test('a schedule reads in words where it is a common one, else as the expression it is', () => {
  const words = (schedule: string) => scheduleText(job(schedule), now);
  assert.equal(words('*/1 * * * *'), '1분마다');
  assert.equal(words('* * * * *'), '1분마다');
  assert.equal(words('*/15 * * * *'), '15분마다');
  assert.equal(words('30 * * * *'), '매시 30분');
  assert.equal(words('0 */2 * * *'), '2시간마다');
  assert.equal(words('5 9 * * *'), '매일 09:05');
  assert.equal(words('0 9 * * 1-5'), '0 9 * * 1-5', 'weekdays only: no words for it');
  assert.equal(words('0 9 1 * *'), '0 9 1 * *');
  assert.equal(words('nonsense'), 'nonsense');
});

test('a prompt that runs once shows the time it is set for', () => {
  assert.equal(scheduleText(job('14 15 * * *', { recurring: false, nextAt: at(15, 14) }), now), '15:14 한 번');
  assert.equal(scheduleText(job('14 15 * * *', { recurring: false }), now), '15:14 한 번', 'from the expression when the time was not told');
  assert.equal(scheduleText(job('5 9 * * *', { recurring: false, nextAt: at(9, 5, 17) }), now), '11월 17일 09:05 한 번', 'another day: with the date');
});

test('times show as the clock has them today, with the date on another day', () => {
  assert.equal(clock(at(9, 5), now), '09:05');
  assert.equal(clock(at(9, 5, 17), now), '11월 17일 09:05');
  assert.equal(scheduleTitle({ prompt: '  check the deploy\nand say so  ' }), 'check the deploy');
});
