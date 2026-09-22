# html5-vim

Vim keybindings for a plain `<textarea>`. It drives the native element's value and
selection, and doesn't swap in an editor, so anything layered on the textarea
(overlays, `input` listeners, autosave) keeps working. No dependencies. Ships as
unbuilt ES modules.

```sh
npm run dev     # live demo at http://localhost:8000
npm run build   # dist/ (esm, cjs, iife) + site/ (static demo)
npm test
```

## Use

```js
import { attach, attachAll } from 'html5-vim'

const vim = attach(textarea, { onStatus: s => bar.textContent = s.cmd || s.mode })
vim.detach()

// or every textarea whose font is monospace
document.fonts.ready.then(() => attachAll())
```

As a **git submodule**, no build step is needed. Webpack, Vite, and esbuild all resolve
the directory through `package.json` `exports`:

```sh
git submodule add git@github.com:kentslaney/html5-vim.git vendor/html5-vim
```
```js
import { attach } from './vendor/html5-vim'
```

With no bundler (e.g. lyrics-editor), use a module script:

```html
<script type="module">
  import { attach } from './html5-vim/src/index.js'
  addEventListener('load', () => attach(document.querySelector('textarea.foreground')))
</script>
```

or `dist/html5-vim.min.js`, which exposes the global `html5vim.attach`.

### Options

| option | default | |
|---|---|---|
| `mode` | `'normal'` | starting mode (`'insert'` also works) |
| `block` | `true` | in normal mode the cursor is a one-character selection; set `false` for a plain caret and style `textarea[data-vim=normal]` yourself |
| `indent` | 4 spaces | what `>>` inserts |
| `clipboard` | `false` | copy every yank to the system clipboard (`"+y` always does) |
| `commands` | `{}` | `:name args` handlers `(args, vim) => string \| void \| false`; a returned string is shown as the message |
| `onStatus` | | `({ mode, keys, cmd, msg }) => …` after every key |

The textarea gets `data-vim="normal|insert|visual|vline|cmd"` and emits the `vim:status`
and `vim:command` events. `vim:command` is cancelable; it fires for unknown ex
commands, so `:w` can be wired up with `preventDefault()`.

## Supported

- **motions** `h j k l w W b B e E ge gE 0 ^ $ gg G f F t T ; , % { } + - _ gj gk * # n N <C-d> <C-u>`. Arrow keys and Home/End map to motions.
- **operators** `d c y > < g~ gu gU`, with counts, doubled (`dd`, `gUU`), or in visual mode
- **text objects** `iw aw iW aW ip ap` quotes `" ' \`` brackets `( ) b [ ] { } B < >`
- **edits** `i a I A gI o O x X s S C D Y r J gJ ~ p P u <C-r> .`, count-repeated inserts, and auto-indent on `o`/`O`
- **registers** `"a`–`"z`, `"A` appends, `"_` discards, `"+`/`"*` use the system clipboard
- **visual** `v V o gv` plus operators, `r`, `J`, `p`, and `:'<,'>`
- **command line** `/ ?` search (smartcase, JS regex, `\<` `\>`), `:N`, `:[range]s/pat/rep/[g]` (`&`, `\1`, `\n`), `:[range]d`, `:[range]y`

`gj`/`gk` move by *display* line. They need monospace text: the wrap points come from
the textarea's width divided by the character width.

Not supported: macros, marks, `<C-v>` block mode, `:set`, and soft-keyboard IMEs that
only send composition events in normal mode.

## Layout

- `src/vim.js`: DOM-free state machine over a small host interface (`text`, `sel`, `select`, `edit`), so it's testable in Node
- `src/textarea.js`: the textarea binding (`keydown`, `beforeinput` for soft keyboards, mouse sync, monospace measurement)
- `demo/`: the static demo that `npm run build` bundles into `site/`
