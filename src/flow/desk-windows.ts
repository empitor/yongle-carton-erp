import { useRef, useState } from 'react';
import type { FlowDocView, flowUndoActions } from '../../shared/business/index';
import type { FlowReview } from './flow-api';
import type { FlowEditing } from './flow-prefill';
import type { CorrectableKind } from './flow-words';

/** 撤销、取消这类确认窗：做哪件事、哪几张 */
export type FlowUndoing = { type: (typeof flowUndoActions)[number]; rows: FlowDocView[] };

/**
 * 单据办理的窗口开关：每个窗口一个状态（开着的是哪张单据），外加打开编辑窗时要用的请求号。
 * 怎么办理在 flow-desk-actions.ts，把这些装起来的是 useFlowDesk。
 */
export function useDeskWindows() {
  // 从别处弹出时：打开过窗口（或说过打不开的原因）以后，窗口全关了就退出
  const [opened, setOpened] = useState(false);
  // 正在为编辑窗读档案（可能同时有几次）。
  const [opening, setOpening] = useState(0);
  const [editor, setEditor] = useState<FlowEditing | null>(null),
    [view, setView] = useState<FlowDocView | null>(null),
    [preview, setPreview] = useState<FlowReview | null>(null),
    // 撤销、取消这类确认窗：哪几张、做什么，和要写的原因
    [action, setAction] = useState<FlowUndoing | null>(null),
    [reason, setReason] = useState('');
  // 登记完工窗口带哪几张任务；空数组是从页头进来，列出全部没做完的任务
  const [batch, setBatch] = useState<{ taskIds: number[] } | null>(null);
  const [contextId, setContextId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<FlowDocView[] | null>(null);
  const [delivering, setDelivering] = useState<FlowDocView<'delivery'> | null>(null);
  const [exporting, setExporting] = useState<FlowDocView<'delivery'> | null>(null);
  // 更正已生效的到货、送货、完工单：哪张（id 和种类）
  const [correcting, setCorrecting] = useState<{ id: number; kind: CorrectableKind } | null>(null);
  // 调整排程：哪张单，改到哪天几点
  const [scheduling, setScheduling] = useState<FlowDocView<'task' | 'delivery'> | null>(null);
  const [newPlanDate, setNewPlanDate] = useState('');
  const [newPlanTime, setNewPlanTime] = useState('');
  const [returning, setReturning] = useState<FlowDocView<'arrival'> | null>(null),
    [returnRevision, setReturnRevision] = useState(0),
    // 已生效的到货、送货、完工单的“编辑”（只改说明）
    [editingInfo, setEditingInfo] = useState<FlowDocView<CorrectableKind> | null>(null);
  const saveRequest = useRef(crypto.randomUUID()),
    scheduleRequest = useRef(crypto.randomUUID());
  /** 有没有窗口开着（从别处弹出时，全关了就退出） */
  const anyOpen = !!(
    opening ||
    editor ||
    view ||
    preview ||
    action ||
    correcting ||
    batch ||
    scheduling ||
    delivering ||
    exporting ||
    deleting ||
    returning ||
    editingInfo ||
    contextId !== null
  );
  return {
    opened, setOpened, opening, setOpening, editor, setEditor, view, setView, preview, setPreview,
    action, setAction, reason, setReason, batch, setBatch, contextId, setContextId, deleting, setDeleting,
    delivering, setDelivering, exporting, setExporting, correcting, setCorrecting,
    scheduling, setScheduling, newPlanDate, setNewPlanDate, newPlanTime, setNewPlanTime,
    returning, setReturning, returnRevision, setReturnRevision, editingInfo, setEditingInfo,
    saveRequest, scheduleRequest, anyOpen,
  };
}
