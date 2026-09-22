import { attach } from '../src/index.js'

const ed = document.getElementById('ed'), $ = id => document.getElementById(id)
const opts = {
  onStatus: s => {
    $('mode').textContent = s.cmd ? '' : s.mode === 'vline' ? 'v-line' : s.mode
    $('keys').textContent = s.cmd || s.keys
    $('msg').textContent = s.msg
  },
  commands: { w: () => `"demo" ${ed.value.split('\n').length}L written (not really)` },
}
let vim = attach(ed, opts)
const rebind = () => {
  vim?.detach()
  vim = $('on').checked ? attach(ed, { ...opts, block: $('block').checked, clipboard: $('clip').checked }) : null
  if (!vim) $('mode').textContent = $('keys').textContent = ''
  ed.focus()
}
for (const id of ['on', 'block', 'clip']) $(id).addEventListener('change', rebind)
ed.focus()
ed.setSelectionRange(0, 0)
