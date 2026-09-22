import test from 'node:test'
import assert from 'node:assert/strict'
import { Vim } from '../src/vim.js'

// `|` marks the cursor. Keys: <Esc> <CR> <BS> <C-x>; other chars are literal.
function vim(text, keys, opts) {
  const at = text.indexOf('|')
  const h = {
    text: text.replace('|', ''), s: at, e: at,
    get sel() { return [this.s, this.e] },
    select(s, e) { this.s = s; this.e = e },
    edit(f, t, x) { this.text = this.text.slice(0, f) + x + this.text.slice(t); this.s = this.e = f + x.length },
    cols: () => 10,
  }
  const v = new Vim(h, opts)
  for (const k of keys.match(/<(?:Esc|CR|BS|C-.)>|./gs)) {
    const key = { '<Esc>': 'Escape', '<CR>': 'Enter', '<BS>': 'Backspace' }[k] ?? k
    if (!v.feed(key) && v.mode === 'insert') h.edit(h.s, h.e, key === 'Enter' ? '\n' : key)
  }
  const p = v.mode === 'insert' ? h.s : v.pos
  return v.mode === 'visual' || v.mode === 'vline'
    ? h.text.slice(0, h.s) + '[' + h.text.slice(h.s, h.e) + ']' + h.text.slice(h.e)
    : h.text.slice(0, p) + '|' + h.text.slice(p)
}
const cases = [
  // motions
  ['|foo bar.baz qux', 'w', 'foo |bar.baz qux'],
  ['|foo bar.baz qux', '3w', 'foo bar.|baz qux'],
  ['|foo bar.baz qux', 'W', 'foo |bar.baz qux'],
  ['|foo bar.baz qux', '2W', 'foo bar.baz |qux'],
  ['|foo bar', 'e', 'fo|o bar'],
  ['foo bar|', 'b', 'foo |bar'],
  ['foo |bar', 'ge', 'fo|o bar'],
  ['|a,b,c,d', 'f,;', 'a,b|,c,d'],
  ['|a,b,c,d', 't,;', 'a,|b,c,d'],
  ['a,b,c,|d', 'F,,', 'a,b,c|,d'],
  ['|(a (b) c)', '%', '(a (b) c|)'],
  ['|ab\ncd\n\nef', '}', 'ab\ncd\n|\nef'],
  ['a|bcd\nx\nabcd', 'jj', 'abcd\nx\na|bcd'],
  ['ab|c\nabcdef', '$j', 'abc\nabcde|f'],
  ['|1\n2\n3', 'G', '1\n2\n|3'],
  ['1\n2\n|3', '2G', '1\n|2\n3'],
  ['|aaaa bbbb cccc', 'gj', 'aaaa bbbb |cccc'],
  ['aaaa bbbb |cccc', 'gk', '|aaaa bbbb cccc'],
  ['|foo bar foo', '/foo<CR>', 'foo bar |foo'],
  ['|foo bar foo', '/foo<CR>n', '|foo bar foo'],
  ['|foo bar foo', '*', 'foo bar |foo'],
  ['foo bar |foo', '#', '|foo bar foo'],
  // operators
  ['|foo bar', 'dw', '|bar'],
  ['foo |bar\nbaz', 'dw', 'foo| \nbaz'],
  ['|foo bar', 'cwbaz<Esc>', 'ba|z bar'],
  ['|foo bar baz', 'd2w', '|baz'],
  ['|foo bar baz', '2dw', '|baz'],
  ['foo |bar', 'd0', '|bar'],
  ['f|oo bar', 'D', '|f'],
  ['a\n|b\nc', 'dd', 'a\n|c'],
  ['a\nb\n|c', 'dd', 'a\n|b'],
  ['|a\nb\nc', '2dd', '|c'],
  ['|a\nb\nc', 'dj', '|c'],
  ['a\n|b\nc', 'ddp', 'a\nc\n|b'],
  ['a\n|b\nc', 'yyP', 'a\n|b\nb\nc'],
  ['|ab\ncd\n\nef', 'd}', '|\nef'],
  ['|foo', 'yiwP', 'fo|ofoo'],
  ['|a b', 'xp', ' |ab'],
  ['|abc', '3x', '|'],
  ['|abcd', '2~', 'AB|cd'],
  ['|foo bar', 'gUiw', '|FOO bar'],
  ['|a', '>>', '    |a'],
  ['    |a', '<<', '|a'],
  ['|a\nb', '>j', '    |a\n    b'],
  ['|a\n  b', 'J', 'a| b'],
  ['|a\nb\nc', '3J', 'a b| c'],
  ['|abc', 'rx', '|xbc'],
  ['|abc', '2rx', 'x|xc'],
  // text objects
  ['f(a, |b)', 'ci(x<Esc>', 'f(|x)'],
  ['f(a, |b)', 'da(', '|f'],
  ['say "he|llo" now', 'ci"x<Esc>', 'say "|x" now'],
  ['say "he|llo" now', 'da"', 'say |now'],
  ['foo |bar baz', 'daw', 'foo |baz'],
  ['{\n  a|\n  b\n}', 'ci{x<Esc>', '{\n|x\n}'],
  ['{\n  a|\n  b\n}', 'di{', '{\n|}'],
  ['a\n|b\n\nc', 'dap', '|c'],
  ['a\n\n|b\n\nc', 'dap', 'a\n\n|c'],
  ['a\n|b\n\nc', 'dip', '|\nc'],
  // insert, repeat, undo
  ['|b', 'ia<Esc>', '|ab'],
  ['|b', 'ax<Esc>', 'b|x'],
  ['  |a', 'ob<Esc>', '  a\n  |b'],
  ['|a', 'Ob<Esc>', '|b\na'],
  ['|b', '3ia<Esc>', 'aa|ab'],
  ['a |b', 'Ac<Esc>', 'a b|c'],
  ['|a a a', 'x..', '| a'],
  ['|foo foo', 'ciwbar<Esc>w.', 'bar ba|r'],
  ['|a b c d', 'dw2.', '|d'],
  ['a\n|b', 'ddu', 'a\n|b'],
  ['a\n|b', 'ddu<C-r>', '|a'],
  ['|abc', 'xxxuu', '|bc'],
  ['|b', 'ifoo<Esc>u', '|b'],
  // visual
  ['|hello world', 've', '[hello] world'],
  ['|hello world', 'vey', '|hello world'],
  ['|hello world', 'veyP', 'hell|ohello world'],
  ['|hello world', 'vwd', '|orld'],
  ['|a\nb\nc', 'Vjd', '|c'],
  ['|a\nb\nc', 'Vj>', '    |a\n    b\nc'],
  ['foo |bar', 'viwU', 'foo |BAR'],
  ['|x foo', 'yiwwviwp', 'x |x'],
  ['|abc', 'vlrz', '|zzc'],
  ['a|bc', 'vho', '[ab]c'],
  ['a|bc', 'vlohd', '|'],
  // registers, ex
  ['|a\nb', '"ayyj"ap', 'a\nb\n|a'],
  ['|a\nb', '"ayyj"Ayy"ap', 'a\nb\n|a\nb'],
  ['a a\na a', ':%s/a/b/g<CR>', 'b b\n|b b'],
  ['|a a\na a', ':s/a/b<CR>', '|b a\na a'],
  ['|foo', ':s/o/[&]/g<CR>', '|f[o][o]'],
  ['|1\n2\n3', ':3<CR>', '1\n2\n|3'],
  ['|1\n2\n3', ':2,3d<CR>', '|1'],
  ['|a\nb\nc', 'Vj:s/$/!/<CR>', 'a!\n|b!\nc'],
]
for (const [src, keys, want] of cases) test(`${JSON.stringify(src)} ${keys}`, () => assert.equal(vim(src, keys), want))

test('unknown named keys pass through, printable keys are swallowed', () => {
  const h = { text: 'a', sel: [0, 0], select() {}, edit() { throw 0 } }, v = new Vim(h)
  assert.equal(v.feed('Tab'), false)
  assert.equal(v.feed('<C-c>'), false)
  assert.equal(v.feed('Q'), true)
  assert.equal(v.mode, 'normal')
})
test('ex commands reach the host', () => {
  let got
  const h = { text: 'a', sel: [0, 0], select() {}, edit() {}, command: (n, a) => (got = [n, a], true) }
  const v = new Vim(h)
  for (const k of ':w out.txt') v.feed(k)
  v.feed('Enter')
  assert.deepEqual(got, ['w', 'out.txt'])
})
