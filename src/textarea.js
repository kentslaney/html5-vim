import { Vim } from './vim.js'

const IGNORE = /^(Shift|Control|Alt|AltGraph|Meta|CapsLock|NumLock|ScrollLock|Fn|FnLock|Hyper|Super|OS|Dead|Unidentified|Process|Compose)$/
const ARROWS = { ArrowLeft: 'h', ArrowRight: 'l', ArrowUp: 'k', ArrowDown: 'j', Home: '0', End: '$' }
const INPUTS = { insertLineBreak: 'Enter', insertParagraph: 'Enter', deleteContentBackward: 'Backspace' }

// Styles the caret mirror has to share with the textarea to lay text out the same way.
const MIRROR = ['boxSizing', 'width', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontStyle', 'fontVariant', 'fontWeight',
  'fontStretch', 'fontSize', 'fontFamily', 'lineHeight', 'letterSpacing', 'wordSpacing', 'textIndent',
  'textTransform', 'whiteSpace', 'wordBreak', 'overflowWrap', 'tabSize', 'direction']

let ctx, mirror
/** Where the character at `pos` sits inside the textarea's border box. */
const caretBox = (el, pos) => {
  const s = getComputedStyle(el)
  if (!mirror) {
    mirror = document.body.appendChild(document.createElement('div'))
    Object.assign(mirror.style, { position: 'absolute', top: '0', left: '-9999px', visibility: 'hidden' })
    mirror.setAttribute('aria-hidden', 'true')
  }
  for (const k of MIRROR) mirror.style[k] = s[k]
  mirror.textContent = el.value.slice(0, pos)
  const span = mirror.appendChild(document.createElement('span'))
  const ch = el.value[pos]
  span.textContent = ch === undefined || ch === '\n' ? ' ' : ch
  const fs = parseFloat(s.fontSize)
  let lh = parseFloat(s.lineHeight) || 1.2
  if (lh < fs / 2) lh *= fs // unitless line-height
  const h = Math.min(lh, fs * 1.35)
  const box = { x: span.offsetLeft, y: span.offsetTop + span.offsetHeight / 2 - h / 2, w: span.offsetWidth, h }
  mirror.textContent = ''
  return box
}

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
 *   cursor:                     how the normal-mode block cursor is drawn (default 'auto')
 *     'behind'    a positioned element under the (transparent) textarea, so text paints over it
 *     'over'      the same element on top, inverting the character it covers
 *     'auto'      'behind' when the textarea's background is transparent, else 'over'
 *     'selection' select the character instead, with no extra element
 *     'none'      leave the native caret alone
 *   cursorColor: string         fill for the cursor element (default: a wash of the text color)
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
  const style = opts.cursor ?? 'auto'
  let vim
  // The cursor is its own element so the selection stays free for visual mode.
  const cursor = style === 'selection' || style === 'none' ? null : document.createElement('div')
  if (cursor) {
    cursor.className = 'vim-cursor'
    Object.assign(cursor.style, { position: 'fixed', display: 'none', pointerEvents: 'none' })
    document.body.appendChild(cursor)
  }
  // Every scroll box between the caret and the viewport, innermost first.
  const scrollers = () => {
    const out = []
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (/auto|scroll|overlay/.test(cs.overflowY + cs.overflowX) &&
        (p.scrollHeight > p.clientHeight || p.scrollWidth > p.clientWidth)) out.push(p)
    }
    return [...out, null] // null: the window
  }
  // Scroll the caret into view the way the browser does for the native one.
  const revealBox = (b, align) => {
    const s = getComputedStyle(el)
    // Scroll the textarea's own box first, as the browser does even when overflow is hidden;
    // a textarea sized to its content (lyrics-editor) has none, so the page scrolls instead.
    if (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) {
      const y = b.y - parseFloat(s.borderTopWidth), x = b.x - parseFloat(s.borderLeftWidth)
      const vh = el.clientHeight, vw = el.clientWidth
      el.scrollTop = align === 'center' ? y - (vh - b.h) / 2 : align === 'top' ? y
        : align === 'bottom' ? y - vh + b.h : Math.min(Math.max(el.scrollTop, y + b.h - vh), y)
      el.scrollLeft = Math.min(Math.max(el.scrollLeft, x + b.w - vw), x)
      align = 'auto' // an explicit alignment applies to the caret's own scroll box only
    }
    const r = el.getBoundingClientRect()
    let top = r.top + b.y - el.scrollTop, left = r.left + b.x - el.scrollLeft
    for (const p of scrollers()) {
      const v = p ? p.getBoundingClientRect() : { top: 0, left: 0, bottom: innerHeight, right: innerWidth }
      const vh = v.bottom - v.top
      const dy = align === 'auto' ? Math.min(0, top - v.top) + Math.max(0, top + b.h - v.bottom)
        : top - v.top - (align === 'center' ? (vh - b.h) / 2 : align === 'bottom' ? vh - b.h : 0)
      const dx = Math.min(0, left - v.left) + Math.max(0, left + b.w - v.right)
      if (dx || dy) { // clamped at the ends, so measure what actually moved
        const [x0, y0] = p ? [p.scrollLeft, p.scrollTop] : [scrollX, scrollY]
        if (p) p.scrollLeft += dx, p.scrollTop += dy
        else scrollBy(dx, dy)
        left -= (p ? p.scrollLeft : scrollX) - x0
        top -= (p ? p.scrollTop : scrollY) - y0
      }
      align = 'auto'
    }
  }
  const place = (reveal) => {
    if (!vim) return
    if (vim.mode === 'insert' || !focused()) { // the browser scrolls for the native caret
      if (cursor) cursor.style.display = 'none'
      el.style.caretColor = ''
      return
    }
    // In visual mode it marks the moving end of the selection; line-wise, the line it's on.
    const at = vim.mode === 'vline' ? vim.ls(vim.pos) : vim.pos
    const b = caretBox(el, at) // content coordinates: unaffected by scrolling
    if (reveal) revealBox(b, 'auto')
    if (!cursor) return
    const s = getComputedStyle(el), r = el.getBoundingClientRect()
    const x = b.x - el.scrollLeft, y = b.y - el.scrollTop, top = parseFloat(s.borderTopWidth)
    const under = style === 'behind' || style === 'auto' && /^(transparent|rgba\(0, 0, 0, 0\))$/.test(s.backgroundColor)
    el.style.caretColor = 'transparent'
    Object.assign(cursor.style, {
      display: y + b.h < top || y > top + el.clientHeight ? 'none' : 'block', // scrolled out of view
      left: `${r.left + x}px`, top: `${r.top + y}px`, width: `${b.w}px`, height: `${b.h}px`,
      color: s.color, zIndex: under ? '-1' : '2147483000', mixBlendMode: under ? 'normal' : 'difference',
      background: opts.cursorColor ?? (under ? 'color-mix(in srgb, currentColor 30%, transparent)' : 'currentColor'),
    })
  }
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
    reveal(pos, align) { revealBox(caretBox(el, pos), align); place(false) },
    /** Buffer position on the top / middle / bottom visible line, for H, M and L. */
    screenPos(where) {
      const s = getComputedStyle(el), r = el.getBoundingClientRect(), bt = parseFloat(s.borderTopWidth)
      const top = Math.max(r.top + bt, 0), bottom = Math.min(r.top + bt + el.clientHeight, innerHeight)
      const y = where === 'top' ? top : where === 'bottom' ? bottom : (top + bottom) / 2
      const target = y - r.top + el.scrollTop
      let lo = 0, hi = el.value.length // caretBox().y only grows with pos
      if (where === 'top') { // first line starting at or below the top edge
        while (lo < hi) { const mid = (lo + hi) >> 1; if (caretBox(el, mid).y >= target) hi = mid; else lo = mid + 1 }
        return lo
      }
      const limit = where === 'bottom' ? target - caretBox(el, 0).h : target // last line fully in view
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (caretBox(el, mid).y <= limit) lo = mid; else hi = mid - 1 }
      return lo
    },
    emit(s) {
      el.dataset.vim = s.mode
      place(true)
      opts.onStatus?.(s)
      el.dispatchEvent(new CustomEvent('vim:status', { bubbles: true, detail: s }))
    },
  }
  vim = new Vim(host, { ...opts, block: style === 'selection' })
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

  // The cursor is positioned in viewport coordinates, so anything that moves the
  // textarea moves it too: page or container scrolling, resizes, font loads.
  const redraw = () => place(false) // never scrolls: these fire *because* something moved
  const observer = cursor && new ResizeObserver(redraw)
  el.addEventListener('keydown', keydown)
  el.addEventListener('beforeinput', beforeinput)
  el.addEventListener('mouseup', settle)
  el.addEventListener('focus', settle)
  el.addEventListener('blur', redraw)
  el.addEventListener('scroll', redraw, { passive: true })
  addEventListener('scroll', redraw, { capture: true, passive: true })
  addEventListener('resize', redraw)
  observer?.observe(el)
  document.fonts?.ready.then(redraw)
  el.dataset.vim = vim.mode
  redraw()
  vim.detach = () => {
    observer?.disconnect()
    cursor?.remove()
    el.style.caretColor = ''
    el.removeEventListener('blur', redraw)
    el.removeEventListener('scroll', redraw)
    removeEventListener('scroll', redraw, { capture: true })
    removeEventListener('resize', redraw)
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
