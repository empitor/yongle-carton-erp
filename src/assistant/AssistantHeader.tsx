import { GripHorizontal, Plus, X } from 'lucide-react';
import { MenuItem, MoreMenu } from '../ui/index';
import { pageHref } from '../../shared/core/index';
import { assistantManagementHash, type AssistantSpeaker } from '../../shared/assistant/index';
import { assistantDisplayName, saveLauncherIsFloating } from './assistant-launcher';
import type { AssistantPanelMode } from './floating-assistant';
import type { useFloatingAssistant } from './useFloatingAssistant';
import YlSpirits from './YlSpirits';

/**
 * 聊天窗口头部（只显示）：小甬小勒、浮动时的拖动把手、新会话、“更多”菜单（停靠/浮动、放大、收起方式、
 * 插件与工具、管理提示词（只给超级管理员账号）、清空会话、删除会话）、关闭。
 */
export default function AssistantHeader({
  docked,
  phone,
  large,
  floatingLauncher,
  signedIn,
  superAdmin,
  busy,
  newDisabled,
  sessionLocked,
  speaker,
  speakTick,
  dragBind,
  onNew,
  onPanelMode,
  onToggleLarge,
  onClear,
  onMemory,
  onRemove,
  onClose,
}: {
  docked: boolean;
  phone: boolean;
  large: boolean;
  floatingLauncher: boolean;
  signedIn: boolean;
  /** 超级管理员账号：菜单里才有“插件与工具”“管理提示词” */
  superAdmin: boolean;
  busy: boolean;
  /** 正在发送、执行、上传时不能新建会话 */
  newDisabled: boolean;
  /** 没有会话或正在发送、执行、上传时不能清空、删除会话 */
  sessionLocked: boolean;
  speaker: AssistantSpeaker | undefined;
  speakTick: number;
  /** 浮动窗口拖头部移动（useFloatingAssistant 的 bind） */
  dragBind: ReturnType<typeof useFloatingAssistant>['bind'];
  onNew: () => void;
  onPanelMode: (next: AssistantPanelMode) => void;
  onToggleLarge: () => void;
  onClear: () => void;
  onMemory: () => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  return (
    <header
      className="ga-header"
      {...(docked
        ? {}
        : {
            tabIndex: 0,
            'aria-label': '拖动聊天窗口，方向键也可移动',
            ...dragBind,
          })}
    >
      <span className="ga-duo">
        <YlSpirits compact busy={busy} speaker={speaker} speakTick={speakTick} />
      </span>
      <strong>{assistantDisplayName}</strong>
      {!docked && <GripHorizontal size={16} aria-hidden="true" />}
      {/* 头部只留新会话、更多、关闭；不用 div 包，手机样式会把头部的 div 整个藏起来 */}
      <span className="ga-head-actions" onPointerDown={(e) => e.stopPropagation()}>
        {signedIn && (
          <button type="button" className="ga-head-new" disabled={newDisabled} onClick={onNew}>
            <Plus size={15} aria-hidden="true" />
            新会话
          </button>
        )}
        <MoreMenu label="小甬小勒更多操作">
          {!phone && (
            <MenuItem
              onClick={() => onPanelMode(docked ? 'floating' : 'docked')}
            >
              {docked ? '改为浮动窗口' : '停靠到右侧'}
            </MenuItem>
          )}
          {!phone && (
            <MenuItem onClick={onToggleLarge}>
              {large ? '恢复窗口大小' : '放大窗口'}
            </MenuItem>
          )}
          {!phone && (
            <MenuItem
              onClick={() => saveLauncherIsFloating(!floatingLauncher)}
            >
              {floatingLauncher ? '收起后放到顶栏' : '收起后显示悬浮小人'}
            </MenuItem>
          )}
          {signedIn && (
            <MenuItem onClick={onMemory}>
              记忆
            </MenuItem>
          )}
          {/* 这两页在设置里只给超级管理员账号 */}
          {superAdmin && (
            <MenuItem
              onClick={() => {
                location.hash = assistantManagementHash;
              }}
            >
              插件与工具
            </MenuItem>
          )}
          {superAdmin && (
            <MenuItem
              onClick={() => {
                location.hash = pageHref('ai-settings', { tab: 'prompts', assistant: true });
              }}
            >
              管理提示词
            </MenuItem>
          )}
          {signedIn && <hr className="more-menu-sep" />}
          {signedIn && (
            <MenuItem
              danger
              disabled={sessionLocked}
              onClick={onClear}
            >
              清空会话
            </MenuItem>
          )}
          {signedIn && (
            <MenuItem
              danger
              disabled={sessionLocked}
              onClick={onRemove}
            >
              删除会话
            </MenuItem>
          )}
        </MoreMenu>
        <button
          type="button"
          className="ga-head-close"
          aria-label="关闭聊天窗口"
          title="关闭（Esc）"
          onClick={onClose}
        >
          <X size={17} aria-hidden="true" />
        </button>
      </span>
    </header>
  );
}

/** 头部下面的会话下拉：有会话时才显示；正在发送、执行、上传时不能切。 */
export function ThreadSwitcher({
  threads,
  current,
  disabled,
  onPick,
}: {
  threads: { id: string; title: string }[] | undefined;
  current: string | undefined;
  disabled: boolean;
  onPick: (id: string) => void;
}) {
  if (!threads?.length) return null;
  return (
    <div className="ga-toolbar">
      <select
        aria-label="切换会话"
        value={current || ''}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value);
        }}
      >
        {!current && (
          <option value="" disabled>
            新会话
          </option>
        )}
        {threads.map((t) => (
          <option key={t.id} value={t.id}>
            {t.title}
          </option>
        ))}
      </select>
    </div>
  );
}
