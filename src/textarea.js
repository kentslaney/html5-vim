import { Vim } from './vim.js'

const IGNORE = /^(Shift|Control|Alt|AltGraph|Meta|CapsLock|NumLock|ScrollLock|Fn|FnLock|Hyper|Super|OS|Dead|Unidentified|Process|Compose)$/
const ARROWS = { ArrowLeft: 'h', ArrowRight: 'l', ArrowUp: 'k', ArrowDown: 'j', Home: '0', End: '$' }
const INPUTS = { insertLineBreak: 'Enter', insertParagraph: 'Enter', deleteContentBackward: 'Backspace' }

let ctx
const width = (el, text) => {
  const s = getComputedStyle(el)
  ctx ??= document.createElement('canvas').getContext('2d')
  ctx.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
  return ctx.measureText(text).width + text.length * (parseFloat(s.letterSpacing) || 0)
}

/** True when the element's computed font renders `i` and `W` at the same width. */
export const isMonospace = el => Math.abs(width(el, 'i'.repeat(10)) - width(el, 'W'.repeat(10))) < 0.5

/**
 * Bind vim keys to a <textarea> (or text <input>). Returns the Vim instance,
 * with `.detach()` to unbind. Options:
 *   mode: 'normal' | 'insert'   initial mode (default 'normal')
 *   block: boolean              one-char selection as a block cursor (default true)
 *   indent: string              what >> inserts (default 4 spaces)
 *   clipboard: boolean          mirror every yank to the system clipboard
 *   commands: { name(args, vim) }  extra :ex commands; return a string to show it,
 *                               false for "not a command". Unknown names fire a
 *                               cancelable `vim:command` (set detail.message to show one)
 *   onStatus(status)            { mode, keys, cmd, msg } after every key; also `vim:status`
 */
export function attach(el, opts = {}) {
  if (el.vim) return el.vim
  const focused = () => el.getRootNode().activeElement === el
  const host = {
    get text() { return el.value },
    get sel() { return [el.selectionStart, el.selectionEnd] },
    select(s, e, back) {
      if (focused() && (el.selectionStart !== s || el.selectionEnd !== e))
        el.setSelectionRange(s, e, back ? 'backward' : 'forward')
    },
    edit(from, to, text) {
      el.setRangeText(text, from, to, 'end')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    },
    cols() {
      const s = getComputedStyle(el)
      const w = el.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight)
      return Math.floor(w / (width(el, '0'.repeat(64)) / 64))
    },
    rows() {
      const s = getComputedStyle(el), fs = parseFloat(s.fontSize)
      let lh = parseFloat(s.lineHeight) || 1.2
      if (lh < fs / 2) lh *= fs // unitless line-height
      return Math.floor(Math.min(el.clientHeight, innerHeight) / lh)
    },
    clip: t => navigator.clipboard?.writeText(t).catch(() => {}),
    paste: () => navigator.clipboard?.readText().catch(() => null),
    command(name, args, vim) {
      const f = opts.commands?.[name]
      if (f) { const r = f(args, vim); return r ?? true }
      const detail = { name, args, vim, message: undefined }
      const ev = new CustomEvent('vim:command', { bubbles: true, cancelable: true, detail })
      el.dispatchEvent(ev)
      return ev.defaultPrevented && (detail.message ?? true)
    },
    emit(s) {
      el.dataset.vim = s.mode
      opts.onStatus?.(s)
      el.dispatchEvent(new CustomEvent('vim:status', { bubbles: true, detail: s }))
    },
  }
  const vim = new Vim(host, opts)
  const cmdish = () => vim.mode === 'insert' || vim.mode === 'cmd'

  const keydown = e => {
    if (e.isComposing || e.metaKey || IGNORE.test(e.key)) return
    let k = e.key
    if (e.ctrlKey) {
      if (k.length !== 1) return
      k = k === '[' ? 'Escape' : `<C-${k.toLowerCase()}>`
    } else if (!cmdish()) k = ARROWS[k] ?? k
    if (vim.feed(k)) e.preventDefault()
  }
  // Soft keyboards send keydown 'Unidentified'; the text only shows up here.
  const beforeinput = e => {
    if (vim.mode === 'insert') return
    const keys = e.inputType === 'insertText' ? [...(e.data || '')] : INPUTS[e.inputType] ? [INPUTS[e.inputType]] : null
    if (!keys) return
    e.preventDefault()
    keys.forEach(k => vim.feed(k))
  }
  const settle = () => setTimeout(() => { if (!cmdish()) { vim.sync(); vim.render() } })

  el.addEventListener('keydown', keydown)
  el.addEventListener('beforeinput', beforeinput)
  el.addEventListener('mouseup', settle)
  el.addEventListener('focus', settle)
  el.dataset.vim = vim.mode
  vim.detach = () => {
    el.removeEventListener('keydown', keydown)
    el.removeEventListener('beforeinput', beforeinput)
    el.removeEventListener('mouseup', settle)
    el.removeEventListener('focus', settle)
    delete el.dataset.vim
    delete el.vim
  }
  return el.vim = vim
}

/** Attach to every monospace textarea under `root`. Call after `document.fonts.ready`. */
export const attachAll = (root = document, opts = {}, selector = 'textarea') =>
  [...root.querySelectorAll(selector)].filter(isMonospace).map(el => attach(el, opts))
