/**
 * System tray icon + status menu (via systray2).
 *
 * Degrades gracefully: if the tray helper binary can't start (headless
 * environment, missing binary), the agent keeps running without a tray and
 * logs state changes instead.
 */

import { exec } from 'node:child_process'
import { log } from '../utils/logger'
import { APP_DIR } from '../config'
import type { AgentState } from '../session/lifecycle'

export type TrayState = AgentState | 'SYNCED' | 'WARNING' | 'ERROR'

export interface TrayCallbacks {
  onSyncNow: () => void
  onOpenLogs: () => void
  onOpenSettings: () => void
  onQuit: () => void
  getPendingCount: () => number
  getSessionDetail: () => string | null
  onFinishInterruptedCapture?: () => void
  canFinishInterruptedCapture?: () => boolean
}

// 16×16 solid-colour PNGs, base64 — grey/green/red/amber/red-exclaim states.
const ICONS: Record<string, string> = {
  grey:  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJElEQVR4AWMYWmDU/z9DGIz6/2cIg1H//wxhMOr/nyEMRgcAAF9nD/HC2uHTAAAAAElFTkSuQmCC',
  green: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4AWMY0mDU/79CGIz6/1cIg1H//wphMOr/XyEMRocAAJ4BUrLK08CQAAAAAElFTkSuQmCC',
  red:   'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4AWMYqmDU/z8oGIz6/wcFg1H//6BgMOr/HxQMRkcAAAgOX/GAcCBjAAAAAElFTkSuQmCC',
  amber: 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAJUlEQVR4AWMYimDU/38gGIz6/w8Eg1H//4FgMOr/PxAMRkcAAJ3TXvFWy8xnAAAAAElFTkSuQmCC',
}

function stateIcon(state: TrayState): string {
  switch (state) {
    case 'IDLE': return ICONS.grey
    case 'CONNECTED': return ICONS.green
    case 'SESSION_STARTING':
    case 'SESSION_ACTIVE': return ICONS.red
    case 'SESSION_ENDING':
    case 'SYNCING': return ICONS.amber
    case 'SYNCED': return ICONS.green
    case 'WARNING': return ICONS.amber
    case 'ERROR': return ICONS.red
    default: return ICONS.grey
  }
}

function stateLabel(state: TrayState): string {
  const labels: Record<string, string> = {
    IDLE: 'Idle — waiting for F1 game',
    CONNECTED: 'Game detected',
    SESSION_STARTING: 'Session starting…',
    SESSION_ACTIVE: 'Session active',
    SESSION_ENDING: 'Session ending…',
    SYNCING: 'Syncing…',
    SYNCED: 'Synced',
    WARNING: 'Sessions queued — not synced',
    ERROR: 'Sync error',
  }
  return labels[state] ?? state
}

export class TrayManager {
  private systray: any = null
  private available = false
  private version: string

  constructor(private callbacks: TrayCallbacks, version: string) {
    this.version = version
  }

  async start(): Promise<void> {
    try {
      // Optional dependency — the agent must run fine headless
      const SysTray = (await import('systray2')).default
      this.systray = new SysTray({
        menu: this.buildMenu('IDLE'),
        debug: false,
        copyDir: true,
      })
      await this.systray.ready()
      this.available = true

      this.systray.onClick((action: any) => {
        switch (action.item?.uid) {
          case 'sync': this.callbacks.onSyncNow(); break
          case 'logs': this.callbacks.onOpenLogs(); break
          case 'settings': this.callbacks.onOpenSettings(); break
          case 'quit': this.callbacks.onQuit(); break
          case 'finish-interrupted': this.callbacks.onFinishInterruptedCapture?.(); break
        }
      })
      log.info('System tray started')
    } catch (err) {
      this.available = false
      log.warn(`System tray unavailable — continuing headless (${(err as Error).message})`)
    }
  }

  setState(state: TrayState): void {
    if (!this.available || !this.systray) return
    try {
      this.systray.sendAction({
        type: 'update-menu',
        menu: this.buildMenu(state),
      })
    } catch { /* tray died — ignore */ }
  }

  /** Windows toast notification via PowerShell — used sparingly. */
  notify(title: string, message: string): void {
    if (process.platform !== 'win32') return
    const script = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t.GetElementsByTagName('text').Item(0).AppendChild($t.CreateTextNode('${title.replace(/'/g, "''")}')) | Out-Null
$t.GetElementsByTagName('text').Item(1).AppendChild($t.CreateTextNode('${message.replace(/'/g, "''")}')) | Out-Null
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('PitWall Agent').Show([Windows.UI.Notifications.ToastNotification]::new($t))
`.trim()
    exec(`powershell -NoProfile -NonInteractive -Command "${script.replace(/"/g, '\\"').replace(/\n/g, '; ')}"`, () => { /* best-effort */ })
    log.info(`Notification · ${title} — ${message}`)
  }

  private buildMenu(state: TrayState) {
    const pending = this.callbacks.getPendingCount()
    const detail = this.callbacks.getSessionDetail()
    const item = (title: string, enabled: boolean, uid: string) => ({ title, tooltip: title, enabled, uid })
    return {
      icon: stateIcon(state),
      title: '',
      tooltip: `PitWall Agent — ${stateLabel(state)}`,
      items: [
        item(`PitWall Agent v${this.version} · ${stateLabel(state)}`, false, 'status'),
        item('<SEPARATOR>', false, ''),
        item(detail ? `Session active · ${detail}` : 'No active session', false, 'session'),
        item('Finish interrupted session', this.callbacks.canFinishInterruptedCapture?.() ?? false, 'finish-interrupted'),
        item('<SEPARATOR>', false, ''),
        item('Sync now', pending > 0, 'sync'),
        item(`View sync queue (${pending} pending)`, pending > 0, 'queue'),
        item('<SEPARATOR>', false, ''),
        item('Settings', true, 'settings'),
        item('View logs', true, 'logs'),
        item('<SEPARATOR>', false, ''),
        item('Quit PitWall Agent', true, 'quit'),
      ],
    }
  }
}

export function openLogsInNotepad(): void {
  if (process.platform === 'win32') {
    exec(`notepad "${APP_DIR}\\logs\\agent.log"`)
  }
}

export function openSettingsFile(): void {
  if (process.platform === 'win32') {
    exec(`notepad "${APP_DIR}\\.env"`)
  }
}
