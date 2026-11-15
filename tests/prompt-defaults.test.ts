import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { PromptPreset } from '../shared/ai/index.js';
import { forgetEdited, initialPromptState, presetFingerprint, refreshDefaults, restoreDefault } from '../server/ai/prompt-defaults.js';
import { PromptPresetManager } from '../server/ai/prompt-presets.js';

/** 虚构的默认提示词；每次调用条目编号都是新的，和程序里的默认一样 */
const preset = (name: string, contents: string[], id = randomUUID()): PromptPreset => ({
  id,
  name,
  entries: contents.map((content, i) => ({ id: randomUUID(), name: '虚构条目' + i, enabled: true, content })),
});
const fixedId = randomUUID();
const oldDefault = () => preset('虚构默认', ['旧规则甲', '旧规则乙'], fixedId);
const newDefault = () => preset('虚构默认', ['新规则甲', '新规则乙', '新规则丙'], fixedId);

test('默认指纹：只看条目名称、启停和内容，不看编号和预设名字', () => {
  assert.equal(presetFingerprint(oldDefault()), presetFingerprint(oldDefault()));
  assert.notEqual(presetFingerprint(oldDefault()), presetFingerprint(newDefault()));
  const off = oldDefault();
  off.entries[0].enabled = false;
  assert.notEqual(presetFingerprint(off), presetFingerprint(oldDefault()), '停用条目也算改过');
  assert.equal(presetFingerprint(Object.assign(oldDefault(), { name: '虚构改名' })), presetFingerprint(oldDefault()), '预设名字归用户，改名不算改过条目');
});

test('新库：只有一份当前默认，记着它的指纹', () => {
  const latest = oldDefault(),
    state = initialPromptState(latest);
  assert.equal(state.revision, 0);
  assert.equal(state.activeId, latest.id);
  assert.deepEqual(state.presets, [latest]);
  assert.deepEqual(state.defaults, { [latest.id]: presetFingerprint(latest) });
  assert.equal(refreshDefaults(state, oldDefault()).changed, false, '默认没变就不用写回');
});

test('刷新：没改过的换成新默认（条目编号按位置沿用），改过的不动也不为此写库；写库前清理改过的和删掉的记录', () => {
  const untouched = initialPromptState(oldDefault());
  const firstEntryId = untouched.presets[0].entries[0].id;
  const upgraded = refreshDefaults(untouched, newDefault());
  assert.equal(upgraded.changed, true);
  const [first] = upgraded.state.presets;
  assert.deepEqual(first.entries.map((e) => e.content), ['新规则甲', '新规则乙', '新规则丙']);
  assert.equal(first.entries[0].id, firstEntryId, '原有位置的条目编号不变');
  assert.equal(upgraded.state.defaults?.[first.id], presetFingerprint(newDefault()));

  const edited = initialPromptState(oldDefault());
  edited.presets[0].entries[1].content = '虚构：用户改过的规则';
  const kept = refreshDefaults(edited, newDefault());
  assert.equal(kept.changed, false, '只是改过、没换新：不写库，版本号不动');
  assert.equal(kept.state.presets[0].entries[1].content, '虚构：用户改过的规则', '改过的整份不动');
  assert.deepEqual(forgetEdited(kept.state).defaults, {}, '写库时不再跟踪改过的');

  const start = initialPromptState(oldDefault());
  const gone = { ...start, defaults: { ...start.defaults, [randomUUID()]: presetFingerprint(oldDefault()) } };
  assert.equal(refreshDefaults(gone, oldDefault()).changed, false);
  assert.deepEqual(Object.keys(forgetEdited(gone).defaults ?? {}), [gone.presets[0].id],'写库时去掉不存在的预设的记录');
});

test('恢复默认：条目换成当前默认、名字不动，重新跟着默认走', () => {
  const state = initialPromptState(oldDefault());
  state.presets[0].name = '虚构改名';
  state.presets[0].entries[0].content = '虚构：改过';
  state.defaults = {};
  const restored = restoreDefault(state, state.presets[0].id, newDefault());
  assert.equal(restored.presets[0].name, '虚构改名', '名字归用户，不动');
  assert.deepEqual(restored.presets[0].entries.map((e) => e.content), ['新规则甲', '新规则乙', '新规则丙']);
  assert.equal(restored.defaults?.[state.presets[0].id],presetFingerprint(newDefault()));
});

test('提示词库：取默认、存、程序默认变了自动换新、恢复默认、删除，重开后都在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-prompt-defaults-'));
  const file = join(dir, 'assistant.sqlite');
  try {
    let manager = new PromptPresetManager(file, oldDefault);
    let view = manager.view();
    assert.equal(manager.snapshot().preset.entries[0].content, '旧规则甲', '新库取的是当前默认');
    const copy = manager.change('copy', { expectedRevision: view.revision, id: fixedId });
    const copied = copy.presets[1];
    assert.notEqual(copied.id, fixedId, '复制出来的预设编号是新的');
    assert.notEqual(copied.entries[0].id, copy.presets[0].entries[0].id, '条目编号也是新的');
    const mine = structuredClone(copied);
    mine.entries[0].content = '虚构：我自己的规则';
    mine.entries[1].enabled = false;
    view = manager.change('save', { expectedRevision: copy.revision, preset: mine, activate: true });
    assert.equal(manager.snapshot().preset.entries[0].content, '虚构：我自己的规则');
    manager.close();

    // 程序升级，默认文字变了：没动过的默认换新、版本号加一；自己存的不动
    manager = new PromptPresetManager(file, newDefault);
    view = manager.view();
    assert.equal(view.revision, 3);
    assert.deepEqual(view.presets[0].entries.map((e) => e.content), ['新规则甲', '新规则乙', '新规则丙']);
    assert.equal(view.presets[1].entries[0].content, '虚构：我自己的规则');
    assert.equal(view.presets[1].entries[1].enabled, false, '停用的条目重开后还是停用');
    assert.equal(view.activeId, copied.id);

    // 改过默认后恢复默认：内容回到当前默认，以后继续跟着升级
    const changed = structuredClone(view.presets[0]);
    changed.entries[2].content = '虚构：临时改动';
    view = manager.change('save', { expectedRevision: view.revision, preset: changed });
    assert.throws(() => manager.change('restore', { expectedRevision: view.revision, id: fixedId }), /请确认/);
    view = manager.change('restore', { expectedRevision: view.revision, id: fixedId, confirmed: true });
    assert.equal(view.presets[0].entries[2].content, '新规则丙');
    assert.ok(view.defaults?.[fixedId]);

    // 删除自己的预设：要确认，记录一起去掉；最后一份不能删
    assert.throws(() => manager.change('delete', { expectedRevision: view.revision, id: copied.id }));
    view = manager.change('delete', { expectedRevision: view.revision, id: copied.id, confirmed: true });
    assert.equal(view.presets.length, 1);
    assert.equal(view.activeId, fixedId);
    assert.throws(() => manager.change('delete', { expectedRevision: view.revision, id: fixedId, confirmed: true }), /至少保留/);
    assert.throws(() => manager.change('activate', { expectedRevision: view.revision - 1, id: fixedId }), /其他页面修改/);
    manager.close();

    manager = new PromptPresetManager(file, newDefault);
    assert.deepEqual(manager.view(), view, '重开后内容原样，没有多余写入');
    manager.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
