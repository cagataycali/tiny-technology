/**
 * Composer keyboard predicate — pure and shared by every text field that
 * sends on Enter (main chat composer, DM thread input).
 *
 * isComposing guard: a CJK user pressing Enter to CONFIRM an IME candidate
 * must not send the (half-composed) draft. The browser fires that Enter
 * with isComposing=true (some report keyCode 229 instead); only a real
 * Enter should send. Shift+Enter always means "newline", never send.
 */
export type ComposerKeyEvent = {
  key: string
  shiftKey?: boolean
  keyCode?: number
  nativeEvent?: { isComposing?: boolean }
}

export function shouldSendOnEnter(e: ComposerKeyEvent): boolean {
  if (e.key !== 'Enter' || e.shiftKey) return false
  if (e.nativeEvent?.isComposing) return false
  if (e.keyCode === 229) return false
  return true
}
