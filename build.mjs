// dist/: esm + cjs + iife (global `html5vim`). site/: static demo (GitHub Pages ready).
import * as esbuild from 'esbuild'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

const lib = { entryPoints: ['src/index.js'], bundle: true, minify: true, sourcemap: true, target: 'es2022' }
const site = { entryPoints: ['demo/demo.js'], bundle: true, minify: true, outdir: 'site', target: 'es2022' }

const clean = d => { try { rmSync(d, { recursive: true, force: true }) } catch {} } // stale output only
clean('dist')
clean('site')
mkdirSync('site', { recursive: true })
writeFileSync('site/index.html', readFileSync('demo/index.html')) // overwrite in place

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
