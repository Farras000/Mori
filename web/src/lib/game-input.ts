import { api } from './api'

export interface InputState {
  left: boolean
  right: boolean
  jump: boolean
  down: boolean
}

export class GameInputManager {
  private botId: number
  private currentInput: InputState = {
    left: false,
    right: false,
    jump: false,
    down: false,
  }
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null
  private isAttached = false
  private isSuspended = false

  constructor(botId: number) {
    this.botId = botId
  }

  setBotId(nextBotId: number) {
    if (this.botId !== nextBotId) {
      this.releaseAll()
      this.botId = nextBotId
      if (this.isAttached) {
        api.sendCmd(this.botId, { type: 'set_interactive', enabled: true }).catch(() => {})
      }
    }
  }

  setSuspended(suspended: boolean) {
    this.isSuspended = suspended
    if (suspended) {
      this.releaseAll()
    }
  }

  start() {
    if (this.isAttached) return
    this.isAttached = true

    // Enable interactive mode on backend
    api.sendCmd(this.botId, { type: 'set_interactive', enabled: true }).catch(() => {})

    // Send heartbeat every 1 second
    this.heartbeatInterval = setInterval(() => {
      if (this.isAttached) {
        api.sendCmd(this.botId, { type: 'interactive_heartbeat' }).catch(() => {})
      }
    }, 1000)

    window.addEventListener('keydown', this.handleKeyDown, true)
    window.addEventListener('keyup', this.handleKeyUp, true)
    window.addEventListener('blur', this.handleBlur)
    document.addEventListener('visibilitychange', this.handleVisibilityChange)
  }

  stop() {
    if (!this.isAttached) return
    this.isAttached = false

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }

    window.removeEventListener('keydown', this.handleKeyDown, true)
    window.removeEventListener('keyup', this.handleKeyUp, true)
    window.removeEventListener('blur', this.handleBlur)
    document.removeEventListener('visibilitychange', this.handleVisibilityChange)

    this.releaseAll()
    // Disable interactive mode on backend
    api.sendCmd(this.botId, { type: 'set_interactive', enabled: false }).catch(() => {})
  }

  private handleKeyDown = (e: KeyboardEvent) => {
    if (this.isSuspended) return
    const target = e.target as HTMLElement
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return
    }

    let changed = false
    const next = { ...this.currentInput }

    if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
      if (!next.left) {
        next.left = true
        changed = true
      }
      e.preventDefault()
    } else if (e.code === 'KeyD' || e.code === 'ArrowRight') {
      if (!next.right) {
        next.right = true
        changed = true
      }
      e.preventDefault()
    } else if (e.code === 'KeyW' || e.code === 'ArrowUp' || e.code === 'Space') {
      if (!next.jump) {
        next.jump = true
        changed = true
      }
      e.preventDefault()
    } else if (e.code === 'KeyS' || e.code === 'ArrowDown') {
      if (!next.down) {
        next.down = true
        changed = true
      }
      e.preventDefault()
    }

    if (changed) {
      this.currentInput = next
      this.syncInput()
    }
  }

  private handleKeyUp = (e: KeyboardEvent) => {
    let changed = false
    const next = { ...this.currentInput }

    if (e.code === 'KeyA' || e.code === 'ArrowLeft') {
      if (next.left) {
        next.left = false
        changed = true
      }
    } else if (e.code === 'KeyD' || e.code === 'ArrowRight') {
      if (next.right) {
        next.right = false
        changed = true
      }
    } else if (e.code === 'KeyW' || e.code === 'ArrowUp' || e.code === 'Space') {
      if (next.jump) {
        next.jump = false
        changed = true
      }
    } else if (e.code === 'KeyS' || e.code === 'ArrowDown') {
      if (next.down) {
        next.down = false
        changed = true
      }
    }

    if (changed) {
      this.currentInput = next
      this.syncInput()
    }
  }

  private handleBlur = () => {
    this.releaseAll()
  }

  private handleVisibilityChange = () => {
    if (document.hidden) {
      this.releaseAll()
    }
  }

  releaseAll() {
    if (this.currentInput.left || this.currentInput.right || this.currentInput.jump || this.currentInput.down) {
      this.currentInput = { left: false, right: false, jump: false, down: false }
      this.syncInput()
    }
  }

  private syncInput() {
    api.sendCmd(this.botId, {
      type: 'set_input',
      left: this.currentInput.left,
      right: this.currentInput.right,
      jump: this.currentInput.jump,
      down: this.currentInput.down,
    }).catch(() => {})
  }
}
