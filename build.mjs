// dist/: esm + cjs + iife (global `html5vim`). site/: the demo, plus the lyrics-editor
// submodule patched to load the keybindings (patches/lyrics-editor-vim.patch).
import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const lib = { entryPoints: ['src/index.js'], bundle: true, minify: true, sourcemap: true, target: 'es2022' }
const site = { entryPoints: ['demo/demo.js'], bundle: true, minify: true, outdir: 'site', target: 'es2022' }
const SUB = 'lyrics-editor', PATCH = `patches/${SUB}-vim.patch`

const clean = d => { try { rmSync(d, { recursive: true, force: true }) } catch {} } // stale output only
clean('dist')
clean('site')
mkdirSync('site', { recursive: true })
writeFileSync('site/index.html', readFileSync('demo/index.html')) // overwrite in place

// The patch imports ../src/index.js, the same path that works in the repo itself.
if (existsSync(`${SUB}/index.html`)) {
  const skip = /(^|[\\/])(\.git|node_modules|site|dist)([\\/]|$)/
  cpSync(SUB, `site/${SUB}`, { recursive: true, filter: p => !skip.test(p) })
  cpSync('src', 'site/src', { recursive: true })
  execFileSync('git', ['apply', '--whitespace=nowarn', `--directory=site`, PATCH], { stdio: 'inherit' })
  console.log(`site/${SUB}: patched`)
} else console.log(`site/${SUB}: skipped (submodule not checked out)`)

if (process.argv.includes('--serve')) {
  const ctx = await esbuild.context(site)
  await ctx.watch()
  const { port } = await ctx.serve({ servedir: 'site' })
  console.log(`demo: http://localhost:${port}`)
} else await Promise.all([
  esbuild.build({ ...lib, format: 'esm', outfile: 'dist/html5-vim.mjs' }),
  esbuild.build({ ...lib, format: 'cjs', outfile: 'dist/html5-vim.cjs' }),
  esbuild.build({ ...lib, format: 'iife', globalName: 'html5vim', outfile: 'dist/html5-vim.min.js' }),
  esbuild.build(site),
])
