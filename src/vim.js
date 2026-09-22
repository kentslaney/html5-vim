// DOM-free vim state machine. The host owns the text and selection:
//   text, sel -> [start, end], select(s, e, backward), edit(from, to, text)
// and optionally cols(), rows(), clip(text), paste() -> Promise<string>,
// command(name, args, vim) -> handled, emit(status).
const MORE = Symbol('more'), FAIL = Symbol('fail')
const fail = () => { throw FAIL }
const OPS = new Set(['d', 'c', 'y', '>', '<', 'g~', 'gu', 'gU'])
const ALIAS = { x: 'dl', X: 'dh', s: 'cl', S: 'cc', C: 'c$', D: 'd$', Y: 'yy' }
const VOPS = { d: 'd', x: 'd', y: 'y', c: 'c', s: 'c', '>': '>', '<': '<', '~': 'g~', u: 'gu', U: 'gU', 'g~': 'g~', gu: 'gu', gU: 'gU' }
const VLINE = { D: 'd', X: 'd', Y: 'y', C: 'c', S: 'c', R: 'c' }
const BR = { '(': '()', ')': '()', b: '()', '[': '[]', ']': '[]', '{': '{}', '}': '{}', B: '{}', '<': '<>', '>': '<>' }
const NAMED = new Set(['Escape', 'Enter', 'Backspace', '<C-r>', '<C-d>', '<C-u>'])
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const kind = (c, big) => c === undefined ? -1 : /\s/.test(c) ? 0 : big || /\w/.test(c) ? 1 : 2
const swap = s => s.replace(/./g, c => c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())
const diff = (a, b) => {
  let p = 0, s = 0
  while (p < a.length && a[p] === b[p]) p++
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return [p, s]
}

export class Vim {
  mode = 'normal' // normal | insert | visual | vline | cmd
  keys = []; cmd = ''; msg = ''
  pos = 0; anchor = 0; want = null
  regs = { '"': { text: '', line: false } }
  undo = []; redo = []
  last = null; lastFind = null; lastSearch = null; lastVis = null
  ins = null; shown = null

  constructor(host, opts = {}) {
    this.host = host
    this.opts = { block: true, indent: '    ', ...opts }
    if (this.opts.mode === 'insert') this.setMode('insert')
  }

  get v() { return this.host.text }
  get status() { return { mode: this.mode, keys: this.keys.join(''), cmd: this.cmd, msg: this.msg } }
  ls(p) { return p > 0 ? this.v.lastIndexOf('\n', p - 1) + 1 : 0 }
  le(p) { const i = this.v.indexOf('\n', p); return i < 0 ? this.v.length : i }
  fnb(p) { const v = this.v, e = this.le(p); p = this.ls(p); while (p < e && (v[p] === ' ' || v[p] === '\t')) p++; return p }
  lineFrom(p, dn) {
    let s = this.ls(p)
    for (; dn > 0 && this.le(s) < this.v.length; dn--) s = this.le(s) + 1
    for (; dn < 0 && s > 0; dn++) s = this.ls(s - 1)
    return s
  }
  lineOf(p) { return (this.v.slice(0, p).match(/\n/g) || []).length }
  clamp(p) {
    p = Math.max(0, Math.min(p, this.v.length))
    const s = this.ls(p), e = this.le(p)
    return e > s ? Math.min(p, e - 1) : s
  }

  // ---- public ----
  feed(key) {
    this.msg = ''
    if (this.mode === 'insert') {
      if (key !== 'Escape') return false
      this.esc(); this.render(); return true
    }
    if (this.mode === 'cmd') { this.cmdKey(key); this.render(); return true }
    if (!this.keys.length && key.length > 1 && !NAMED.has(key)) return false
    this.sync()
    this.keys.push(key)
    try { this.run(this.keys); this.keys = [] }
    catch (e) { if (e !== MORE) { this.keys = []; if (e !== FAIL) throw e } }
    this.render()
    return true
  }
  setMode(m) {
    if (m === this.mode) return
    if (this.mode === 'insert') this.esc()
    if (m === 'insert') { this.pos = this.host.sel[1]; this.snap(); this.insert(1, '', false) }
    else if (m === 'normal') this.mode = 'normal'
    this.render()
  }
  sync() {
    const [s, e] = this.host.sel, sh = this.shown
    if (sh && s === sh[0] && e === sh[1]) return
    if (e - s > 1) { if (this.mode === 'normal') this.mode = 'visual'; this.anchor = s; this.pos = e - 1 }
    else { if (this.mode !== 'normal') this.mode = 'normal'; this.pos = s }
  }
  render() {
    let s, e, back = false
    if (this.mode === 'cmd') return this.host.emit?.(this.status)
    if (this.mode === 'visual' || this.mode === 'vline') {
      ({ from: s, to: e } = this.vrange()); back = this.pos < this.anchor
    } else {
      this.pos = this.mode === 'normal' ? this.clamp(this.pos) : Math.max(0, Math.min(this.pos, this.v.length))
      s = e = this.pos
      if (this.mode === 'normal' && this.opts.block && s < this.v.length && this.v[s] !== '\n') e++
    }
    this.host.select(s, e, back)
    this.shown = [s, e]
    this.host.emit?.(this.status)
  }

  // ---- parsing ----
  run(k) {
    let i = 0
    const R = {
      next: () => { if (i >= k.length) throw MORE; return k[i++] },
      num: () => {
        let s = ''
        for (;;) {
          const c = R.next()
          if (c >= '1' && c <= '9' || s && c === '0') s += c
          else { i--; return +s }
        }
      },
    }
    let reg = '"'
    if (k[0] === '"') { R.next(); reg = R.next() }
    const n1 = R.num(), n = n1 || 1
    let c = R.next()
    if (c === 'g') c += R.next()
    if (this.mode === 'visual' || this.mode === 'vline') return this.visual(c, n, n1, reg, R)
    if (OPS.has(c)) return this.operate(c, n1, reg, R, null, k)
    if (c in ALIAS) return this.operate(ALIAS[c][0], n1, reg, R, ALIAS[c][1], k)
    const v = this.v, p = this.pos, ls = this.ls(p), le = this.le(p)
    switch (c) {
      case 'Escape': return
      case 'i': case 'a': case 'I': case 'gI': case 'A':
        this.change(k); this.snap()
        this.pos = { i: p, a: Math.min(p + 1, le), I: this.fnb(p), gI: ls, A: le }[c]
        return this.insert(n)
      case 'o': case 'O': {
        const ind = v.slice(ls, this.fnb(p)), at = c === 'o' ? le : ls
        this.change(k); this.snap()
        this.edit(at, at, c === 'o' ? '\n' + ind : ind + '\n')
        this.pos = at + ind.length + (c === 'o')
        return this.insert(n, '\n' + ind)
      }
      case 'r': {
        const ch = R.next()
        if (p + n > le || ch.length > 1 && ch !== 'Enter') fail()
        this.change(k); this.snap()
        this.edit(p, p + n, ch === 'Enter' ? '\n' : ch.repeat(n))
        this.pos = ch === 'Enter' ? p + 1 : p + n - 1
        return
      }
      case '~': {
        const e = Math.min(p + n, le)
        if (e === p) return
        this.change(k); this.snap(); this.edit(p, e, swap(v.slice(p, e))); this.pos = e
        return
      }
      case 'J': case 'gJ': this.change(k); this.snap(); return this.join(p, Math.max(n - 1, 1), c === 'J')
      case 'p': case 'P': this.change(k); return this.paste(reg, c === 'P', n)
      case 'u': return this.hist(n, this.undo, this.redo)
      case '<C-r>': return this.hist(n, this.redo, this.undo)
      case '.': return this.dot(n1)
      case 'v': case 'V': this.mode = c === 'v' ? 'visual' : 'vline'; this.anchor = p; return
      case 'gv': if (!this.lastVis) fail(); Object.assign(this, this.lastVis); return
      case '/': case '?': case ':': this.mode = 'cmd'; this.cmd = c; return
    }
    const r = this.motion(c, R, n, !!n1)
    this.pos = r.to
    if (!r.keep) this.want = null
  }

  operate(op, n1, reg, R, m, k) {
    const n2 = m ? 0 : R.num(), n = (n1 || 1) * (n2 || 1)
    m ??= R.next()
    if (m === 'g') m += R.next()
    let r
    if (m === op || m === op[1]) r = { to: this.lineFrom(this.pos, n - 1), line: true }
    else if (m === 'i' || m === 'a') r = this.object(m, R.next(), n, op)
    else r = this.motion(m, R, n, !!(n1 || n2), op)
    if (op !== 'y') this.change(k)
    this.apply(op, this.norm(r, op === '>' || op === '<'), reg)
  }

  visual(c, n, n1, reg, R) {
    const line = this.mode === 'vline'
    if (c === 'Escape' || c === (line ? 'V' : 'v')) return this.exitVis()
    if (c === 'v' || c === 'V') { this.mode = c === 'v' ? 'visual' : 'vline'; return }
    if (c === 'o') { [this.anchor, this.pos] = [this.pos, this.anchor]; return }
    if (c === ':') { this.exitVis(); this.mode = 'cmd'; this.cmd = ":'<,'>"; return }
    if (c === 'i' || c === 'a') {
      const o = this.norm(this.object(c, R.next(), n, 'v'))
      if (this.anchor === this.pos || this.anchor > o.from) this.anchor = o.from
      this.pos = o.to - 1
      if (o.line) this.mode = 'vline'
      return
    }
    const op = VLINE[c] ?? VOPS[c]
    if (op || 'JpPr'.includes(c)) {
      const r = this.vrange(c in VLINE), ch = c === 'r' ? R.next() : null
      this.exitVis(); this.last = null
      if (c === 'J') { this.snap(); return this.join(r.from, Math.max(1, (this.v.slice(r.from, r.to).match(/\n(?!$)/g) || []).length), true) }
      if (c === 'r') {
        if (ch.length > 1) fail()
        this.snap(); this.edit(r.from, r.to, this.v.slice(r.from, r.to).replace(/[^\n]/g, ch)); this.pos = r.from
        return
      }
      if (c === 'p' || c === 'P') {
        const saved = this.regs[reg.toLowerCase()]
        if (!saved) fail()
        this.apply('d', r, c === 'P' ? '_' : '"')
        this.put(saved, !(saved.line && !r.line), n)
        this.undo.pop() // collapse delete+put into one undo step
        return
      }
      return this.apply(op, r, reg)
    }
    const m = this.motion(c, R, n, !!n1)
    this.pos = Math.min(m.to, Math.max(0, this.v.length - 1))
    if (!m.keep) this.want = null
  }
  exitVis() { this.lastVis = { mode: this.mode, anchor: this.anchor, pos: this.pos }; this.mode = 'normal' }
  vrange(forceLine) {
    const a = Math.min(this.anchor, this.pos), b = Math.max(this.anchor, this.pos), len = this.v.length
    if (this.mode === 'vline' || forceLine) return { from: this.ls(a), to: Math.min(this.le(b) + 1, len), line: true }
    return { from: a, to: Math.min(b + 1, len) }
  }

  // ---- motions: { to, incl?, line?, keep? } ----
  motion(m, R, n, has, op) {
    const v = this.v, len = v.length, p = this.pos, ls = this.ls(p), le = this.le(p)
    switch (m) {
      case 'h': case 'Backspace': return { to: Math.max(ls, p - n) }
      case 'l': case ' ': return { to: Math.min(le, p + n) }
      case '0': return { to: ls }
      case '^': return { to: this.fnb(p) }
      case '$': {
        const e = this.le(this.lineFrom(p, n - 1)), s = this.ls(e)
        this.want = Infinity
        return { to: Math.max(s, e - 1), incl: e > s, keep: true }
      }
      case 'j': case 'k': case '<C-d>': case '<C-u>': {
        const half = Math.max(1, (this.host.rows?.() || 30) >> 1)
        const s = this.lineFrom(p, { j: n, k: -n, '<C-d>': half, '<C-u>': -half }[m])
        this.want ??= p - ls
        return { to: Math.min(s + this.want, Math.max(s, this.le(s) - 1)), line: true, keep: true }
      }
      case '+': case '-': case 'Enter': case '_':
        return { to: this.fnb(this.lineFrom(p, m === '-' ? -n : m === '_' ? n - 1 : n)), line: true }
      case 'G': case 'gg':
        return { to: this.fnb(has ? this.lineFrom(0, n - 1) : m === 'G' ? this.ls(len) : 0), line: true }
      case 'w': case 'W': case 'e': case 'E': case 'b': case 'B': case 'ge': case 'gE': {
        const big = /[WEB]$/.test(m), C = i => kind(v[i], big)
        const blank = i => v[i] === '\n' && v[i - 1] === '\n'
        let q = p
        if (op === 'c' && C(p) > 0 && (m === 'w' || m === 'W')) m = big ? 'E' : 'e', q = p - 1 // cw == ce
        if (m === 'w' || m === 'W') {
          let w0 = q
          for (let r = 0; r < n; r++) {
            const c = C(q)
            if (c > 0) while (C(q) === c) q++
            w0 = q
            while (C(q) === 0) { q++; if (blank(q)) break }
          }
          // an operator never eats the newline after the last word it moved over
          if (op && this.ls(q) !== this.ls(w0) && w0 > this.ls(w0)) q = this.le(w0)
          return { to: Math.min(q, len) }
        }
        if (m === 'e' || m === 'E') {
          for (let r = 0; r < n; r++) {
            q++
            while (C(q) === 0) q++
            const c = C(q)
            if (c > 0) while (C(q + 1) === c) q++
          }
          return { to: Math.min(q, len - 1), incl: true }
        }
        if (m === 'b' || m === 'B') {
          for (let r = 0; r < n; r++) {
            q--
            while (q > 0 && C(q) === 0 && !blank(q)) q--
            const c = C(q)
            if (c > 0) while (C(q - 1) === c) q--
          }
          return { to: Math.max(q, 0) }
        }
        for (let r = 0; r < n; r++) { // ge, gE
          const c = C(q)
          if (c > 0) while (C(q) === c) q--
          while (q > 0 && C(q) === 0 && !blank(q)) q--
        }
        return { to: Math.max(q, 0), incl: true }
      }
      case 'f': case 'F': case 't': case 'T': case ';': case ',': {
        const rep = m === ';' || m === ','
        let f
        if (!rep) this.lastFind = f = [m, R.next()]
        else if (!(f = this.lastFind)) fail()
        else if (m === ',') f = [f[0] === f[0].toLowerCase() ? f[0].toUpperCase() : f[0].toLowerCase(), f[1]]
        const [t, ch] = f, fwd = t === 'f' || t === 't', till = t === 't' || t === 'T'
        let q = p
        for (let r = 0; r < n; r++) {
          const skip = till && rep && !r ? 1 : 0
          const from = fwd ? q + 1 + skip : q - 1 - skip
          q = fwd ? v.indexOf(ch, from) : from < 0 ? -1 : v.lastIndexOf(ch, from)
          if (q < ls || q >= le) fail()
        }
        return { to: till ? q + (fwd ? -1 : 1) : q, incl: fwd }
      }
      case '%': {
        let q = p
        while (q < le && !'()[]{}'.includes(v[q])) q++
        if (q >= le) fail()
        return { to: this.pair(q), incl: true }
      }
      case '{': case '}': {
        const E = i => v[i] === '\n' && (i === 0 || v[i - 1] === '\n')
        let q = p
        for (let r = 0; r < n; r++) {
          if (m === '}') { q++; while (q < len && E(q)) q++; while (q < len && !E(q)) q++ }
          else { q--; while (q > 0 && E(q)) q--; while (q > 0 && !E(q)) q-- }
        }
        return { to: Math.max(0, Math.min(q, len)) }
      }
      case 'gj': case 'gk': {
        const cols = this.host.cols?.()
        if (!cols) return this.motion(m[1], R, n, has, op)
        let q = p
        for (let r = 0; r < n; r++) {
          const s = this.ls(q), segs = this.wrap(s, cols), i = segs.findLastIndex(x => x <= q), col = q - segs[i]
          let a, b
          if (m === 'gj') {
            if (i + 1 < segs.length) [a, b] = [segs[i + 1], segs[i + 2] ?? this.le(s)]
            else {
              const e = this.le(s)
              if (e >= len) break
              const t = this.wrap(e + 1, cols); [a, b] = [t[0], t[1] ?? this.le(e + 1)]
            }
          } else if (i > 0) [a, b] = [segs[i - 1], segs[i]]
          else {
            if (!s) break
            const t = this.wrap(this.ls(s - 1), cols); [a, b] = [t.at(-1), s - 1]
          }
          q = Math.min(a + col, Math.max(a, b - 1))
        }
        return { to: q }
      }
      case 'n': case 'N': case '*': case '#': {
        let from = p
        if (m === '*' || m === '#') {
          const o = this.object('i', 'w', 1), w = v.slice(o.from, o.to)
          if (!/\w/.test(w)) fail()
          this.lastSearch = { pat: `\\b${esc(w)}\\b`, back: m === '#' }
          if (m === '#') from = o.from
        }
        const S = this.lastSearch
        if (!S) fail()
        for (let r = 0; r < n; r++) from = this.search(S.pat, S.back !== (m === 'N'), from)
        return { to: from }
      }
    }
    fail()
  }
  wrap(s, cols) { // soft-wrap starts of the line at s, for a monospace pre-wrap box
    const v = this.v, e = this.le(s), out = [s]
    while (e - s > cols) {
      let b = v.lastIndexOf(' ', s + cols)
      b = b >= s ? b + 1 : s + cols
      while (v[b] === ' ') b++
      if (b >= e) break
      out.push(s = b)
    }
    return out
  }
  pair(q) {
    const v = this.v, c = v[q], [o, cl] = BR[c], d = c === o ? 1 : -1, other = c === o ? cl : o
    for (let i = q, depth = 0; i >= 0 && i < v.length; i += d) {
      if (v[i] === c) depth++
      else if (v[i] === other && !--depth) return i
    }
    fail()
  }
  search(pat, back, from) {
    const hits = [...this.v.matchAll(this.regex(pat, 'g'))].map(m => m.index)
    if (!hits.length) { this.msg = 'Pattern not found: ' + pat; fail() }
    return back ? hits.findLast(i => i < from) ?? hits.at(-1) : hits.find(i => i > from) ?? hits[0]
  }
  regex(pat, f = '') {
    const flags = f + (/[A-Z]/.test(pat.replace(/\\./g, '')) ? '' : 'i') // smartcase
    pat = pat.replace(/\\[<>]/g, '\\b')
    try { return new RegExp(pat, flags) } catch { return new RegExp(esc(pat), flags) }
  }

  // ---- text objects: { from, to (exclusive), line? } ----
  object(ai, t, n, op) {
    const v = this.v, p = this.pos, ls = this.ls(p), le = this.le(p), inner = ai === 'i'
    if (t === 'w' || t === 'W') {
      const C = i => i < ls || i >= le ? -1 : kind(v[i], t === 'W'), c = C(p)
      if (c < 0) fail()
      let s = p, e = p
      while (C(s - 1) === c) s--
      while (C(e) === c) e++
      if (!inner) {
        if (!c) { const d = C(e); if (d > 0) while (C(e) === d) e++ }
        else if (C(e) === 0) while (C(e) === 0) e++
        else while (C(s - 1) === 0) s--
      }
      return { from: s, to: e }
    }
    if ('"\'`'.includes(t)) {
      const q = []
      for (let i = ls; i < le; i++) if (v[i] === t && v[i - 1] !== '\\') q.push(i)
      let j = 0
      while (j + 1 < q.length && q[j + 1] < p) j += 2
      if (j + 1 >= q.length) fail()
      let s = q[j], e = q[j + 1] + 1
      if (inner) return { from: s + 1, to: e - 1 }
      if (v[e] === ' ') while (v[e] === ' ') e++
      else while (s > ls && v[s - 1] === ' ') s--
      return { from: s, to: e }
    }
    if (t === 'p') {
      const len = v.length, blank = i => i >= len || v[i] === '\n', E = blank(ls)
      let s = ls, e = ls
      while (s > 0 && blank(this.ls(s - 1)) === E) s = this.ls(s - 1)
      while (this.le(e) < len && blank(this.le(e) + 1) === E) e = this.le(e) + 1
      if (!inner) while (this.le(e) < len && blank(this.le(e) + 1) !== E) e = this.le(e) + 1
      return { from: s, to: e, line: true }
    }
    if (!BR[t]) fail()
    const [o, c] = BR[t]
    let s = p
    for (let r = 0; r < n; r++) {
      if (r || v[s] !== o) {
        if (!r && v[s] === c) s = this.pair(s)
        else for (let d = 0, i = s - 1; ; i--) {
          if (i < 0) fail()
          if (v[i] === c) d++
          else if (v[i] === o && !d--) { s = i; break }
        }
      }
    }
    const e = this.pair(s)
    if (!inner) return { from: s, to: e + 1 }
    let a = s + 1, b = e
    if (v[a] === '\n') { // multi-line block: keep the brace lines intact
      a++
      if (/^[ \t]*$/.test(v.slice(this.ls(e), e))) b = Math.max(a, this.ls(e) - (op === 'c' ? 1 : 0))
    }
    return { from: a, to: b }
  }

  // motion result -> { from, to (exclusive), line }
  norm(r, forceLine) {
    const len = this.v.length
    let a = r.from ?? this.pos, b = r.to
    if (a > b) [a, b] = [b, a]
    if (!r.line && !r.incl && r.from == null && b > a && b === this.ls(b)) {
      b-- // exclusive motion ending at column 0 stops at the previous line's end
      if (a <= this.fnb(a)) forceLine = true
    }
    if (r.line || forceLine) return { from: this.ls(a), to: Math.min(this.le(b) + 1, len), line: true }
    return { from: a, to: Math.min(b + !!r.incl, len) }
  }

  // ---- edits ----
  snap() { this.undo.push({ v: this.v, pos: this.pos }); this.redo = [] }
  edit(from, to, text) { this.host.edit(from, to, text) }
  change(k) { this.last = { keys: [...k] } }
  insert(n = 1, sep = '', rec = true) { this.mode = 'insert'; this.ins = { v: this.v, n, sep, rec } }
  esc() {
    const I = this.ins || { v: this.v, n: 1, sep: '' }, v = this.v, [p, s] = diff(I.v, v)
    const text = v.slice(p, v.length - s)
    this.pos = this.host.sel[1]
    if (I.rec && this.last) this.last.text = text
    if (text && I.n > 1) {
      const t = (I.sep + text).repeat(I.n - 1)
      this.edit(this.pos, this.pos, t); this.pos += t.length
    }
    if (this.undo.at(-1)?.v === this.v) this.undo.pop()
    this.mode = 'normal'; this.ins = null
    this.pos = Math.max(this.ls(this.pos), this.pos - 1)
  }
  hist(n, src, dst) {
    for (; n > 0 && src.length; n--) {
      const { v, pos } = src.pop(), [p, s] = diff(this.v, v)
      dst.push({ v: this.v, pos: this.pos })
      this.edit(p, this.v.length - s, v.slice(p, v.length - s))
      this.pos = src === this.undo ? pos : p
    }
  }
  dot(n1) {
    const L = this.last
    if (!L) fail()
    let keys = L.keys
    if (n1) {
      let j = keys[0] === '"' ? 2 : 0
      const pre = keys.slice(0, j)
      while (/^\d$/.test(keys[j])) j++
      keys = [...pre, ...String(n1), ...keys.slice(j)]
    }
    this.run(keys)
    if (this.mode === 'insert') {
      const t = L.text || ''
      this.edit(this.pos, this.pos, t); this.pos += t.length
      this.render(); this.esc()
    }
  }
  yank(reg, text, line) {
    if (reg === '_') return
    const lo = reg.toLowerCase(), r = { text, line }
    if (reg !== lo && this.regs[lo]) r.text = this.regs[lo].text + text, r.line ||= this.regs[lo].line
    this.regs[lo] = this.regs['"'] = r
    if (reg === '+' || reg === '*' || this.opts.clipboard) this.host.clip?.(r.text)
  }
  paste(reg, before, n) {
    if ((reg === '+' || reg === '*') && this.host.paste) {
      Promise.resolve(this.host.paste()).then(t => {
        if (t) { this.put({ text: t, line: t.endsWith('\n') }, before, n); this.render() }
      })
      return
    }
    const r = this.regs[reg.toLowerCase()]
    if (!r) fail()
    this.put(r, before, n)
  }
  put(r, before, n) {
    this.snap()
    const v = this.v, p = this.pos, t = r.text.repeat(n)
    if (r.line) {
      const at = before ? this.ls(p) : this.le(p) + 1
      if (at > v.length) this.edit(v.length, v.length, '\n' + t.slice(0, -1))
      else this.edit(at, at, t)
      this.pos = this.fnb(at)
    } else {
      const at = before || p >= this.le(p) ? p : p + 1
      this.edit(at, at, t)
      this.pos = at + t.length - 1
    }
  }
  join(p, n, space) {
    let e = this.le(p)
    for (; n > 0 && e < this.v.length; n--) {
      const v = this.v
      let q = e + 1
      if (space) while (v[q] === ' ' || v[q] === '\t') q++
      const sep = !space || q >= v.length || v[q] === '\n' || v[q] === ')' || /[ \t]/.test(v[e - 1] ?? '') ? '' : ' '
      this.edit(e, q, sep)
      this.pos = e
      e = this.le(e)
    }
  }
  apply(op, r, reg) {
    const v = this.v
    let { from, to, line } = r
    if (op !== 'y') { if (from === to && op !== 'c') return; this.snap() }
    const text = v.slice(from, to)
    if (op.length === 1 && 'dcy'.includes(op)) this.yank(reg, line && !text.endsWith('\n') ? text + '\n' : text, line)
    switch (op) {
      case 'y':
        if (!line || from < this.ls(this.pos)) this.pos = from
        return
      case 'd':
        if (line && to === v.length && from > 0 && v[to - 1] !== '\n') from--
        this.edit(from, to, '')
        this.pos = line ? this.fnb(Math.min(from, this.v.length)) : from
        return
      case 'c':
        if (line) { from = this.fnb(from); if (v[to - 1] === '\n') to-- }
        this.edit(from, to, ''); this.pos = from
        return this.insert()
      case '>': case '<': {
        const ind = this.opts.indent
        this.edit(from, to, op === '>' ? text.replace(/^(?=[^\n])/gm, ind)
          : text.replace(new RegExp(`^( {1,${ind.replace(/\t/g, '').length || 1}}|\\t)`, 'gm'), ''))
        this.pos = this.fnb(from)
        return
      }
      default:
        this.edit(from, to, op === 'gu' ? text.toLowerCase() : op === 'gU' ? text.toUpperCase() : swap(text))
        this.pos = from
    }
  }

  // ---- command line ----
  cmdKey(key) {
    if (key === 'Escape') return this.cmdEnd()
    if (key === '<C-u>') { this.cmd = this.cmd[0]; return }
    if (key === 'Backspace') { this.cmd = this.cmd.slice(0, -1); if (!this.cmd) this.cmdEnd(); return }
    if (key === 'Enter') {
      const c = this.cmd
      this.cmdEnd()
      try { this.cmdRun(c) } catch (e) { if (e !== FAIL) throw e }
      return
    }
    if (key.length === 1) this.cmd += key
  }
  cmdEnd() { this.mode = 'normal'; this.cmd = '' }
  cmdRun(c) {
    const body = c.slice(1)
    if (c[0] === ':') return this.ex(body)
    const pat = body || this.lastSearch?.pat
    if (!pat) fail()
    this.lastSearch = { pat, back: c[0] === '?' }
    this.pos = this.search(pat, c[0] === '?', this.pos)
    this.want = null
  }
  ex(cmd) {
    const v = this.v, V = this.lastVis, total = this.lineOf(v.length), cur = this.lineOf(this.pos)
    const addr = a => a === '.' ? cur : a === '$' ? total
      : a[0] === "'" ? this.lineOf(V ? (a === "'<" ? Math.min : Math.max)(V.anchor, V.pos) : this.pos) : +a - 1
    const [, range, a, b, rest] = cmd.match(/^\s*(%|([.$]|\d+|'[<>])(?:\s*,\s*([.$]|\d+|'[<>]))?)?\s*(.*)$/)
    let lo = cur, hi = cur
    if (range === '%') lo = 0, hi = total
    else if (a) lo = addr(a), hi = b ? addr(b) : lo
    if (lo > hi) [lo, hi] = [hi, lo]
    lo = Math.max(0, Math.min(lo, total)); hi = Math.max(0, Math.min(hi, total))
    const from = this.lineFrom(0, lo), to = this.le(this.lineFrom(0, hi))
    if (!rest) { if (a) this.pos = this.fnb(this.lineFrom(0, hi)); return }
    const s = rest.match(/^s(\W)((?:\\.|(?!\1).)*)\1((?:\\.|(?!\1).)*)(?:\1([gi]*))?$/)
    if (s) {
      const [, , pat0, rep, fl = ''] = s, pat = pat0 || this.lastSearch?.pat
      if (!pat) fail()
      const re = this.regex(pat, fl.replace('i', '').includes('g') ? 'g' : '')
      const js = rep.replace(/\$|\\(.)|&/g, (t, e) => t === '$' ? '$$' : t === '&' ? '$&'
        : /\d/.test(e) ? '$' + e : e === 'n' ? '\n' : e === 't' ? '\t' : e)
      const old = v.slice(from, to), out = old.split('\n').map(l => l.replace(re, js)).join('\n')
      this.lastSearch = { pat, back: false }
      if (out === old) { this.msg = 'Pattern not found: ' + pat; fail() }
      this.snap(); this.edit(from, to, out)
      this.pos = this.fnb(Math.min(from + out.length, this.v.length))
      return
    }
    if (rest === 'd' || rest === 'y') {
      return this.apply(rest, { from, to: Math.min(to + 1, v.length), line: true }, '"')
    }
    const [name, ...args] = rest.split(/\s+/)
    const r = this.host.command?.(name, args.join(' '), this) // true, or a message to show
    if (!r) { this.msg = 'Not an editor command: ' + rest; fail() }
    if (typeof r === 'string') this.msg = r
  }
}
