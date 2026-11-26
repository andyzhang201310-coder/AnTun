const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const pkgPath = path.join(root, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
const current = pkg.version

function nextVersion(arg) {
  if (!arg) {
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
    if (!m) throw new Error(`Unsupported current version: ${current}`)
    return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
  }
  if (/^\d+\.\d+\.\d+$/.test(arg)) return arg
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!m) throw new Error(`Unsupported current version: ${current}`)
  const [major, minor, patch] = m.slice(1).map(Number)
  if (arg === 'major') return `${major + 1}.0.0`
  if (arg === 'minor') return `${major}.${minor + 1}.0`
  if (arg === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`Usage: node scripts/bump-version.cjs [patch|minor|major|x.y.z]`)
}

const next = nextVersion(process.argv[2])
if (next === current) {
  console.log(`version already ${current}`)
  process.exit(0)
}

function replace(file, pattern, replacement, label) {
  const target = path.join(root, file)
  const before = fs.readFileSync(target, 'utf8')
  const after = before.replace(pattern, replacement)
  if (before === after) throw new Error(`Version pattern not found in ${file} (${label})`)
  fs.writeFileSync(target, after, 'utf8')
  console.log(`updated ${file}`)
}

replace('package.json', /"version":\s*"[^"]+"/, `"version": "${next}"`, 'package')
replace('package-lock.json', /"version":\s*"[^"]+"/, `"version": "${next}"`, 'lock root')
replace('package-lock.json', /("":\s*\{[\s\S]{0,160}?"version":\s*)"[^"]+"/, `$1"${next}"`, 'lock root package')
replace('src-tauri/tauri.conf.json', /"version":\s*"[^"]+"/, `"version": "${next}"`, 'tauri')
replace('src-tauri/tauri.conf.json', /"copyright":\s*"AnTun [^"]+ - MIT License"/, `"copyright": "AnTun ${next} - MIT License"`, 'tauri copyright')
replace('src-tauri/Cargo.toml', /version\s*=\s*"[^"]+"/, `version = "${next}"`, 'cargo package')
replace('src-tauri/Cargo.lock', /(name\s*=\s*"antun"\s*\nversion\s*=\s*)"[^"]+"/, `$1"${next}"`, 'cargo lock')
replace('src/pages/AboutPage.tsx', /info\?\.version \|\| '[^']+'/, `info?.version || '${next}'`, 'about fallback')

const readmePath = path.join(root, 'README.md')
const readmeBefore = fs.readFileSync(readmePath, 'utf8')
const readmeAfter = readmeBefore
  .replace(new RegExp(`AnTun_${current.replace(/\./g, '\\.')}_`, 'g'), `AnTun_${next}_`)
  .replace(new RegExp(`v${current.replace(/\./g, '\\.')}`, 'g'), `v${next}`)
  .replace(new RegExp(`当前版本：\\*\\*${current.replace(/\./g, '\\.')}\\*\\*`, 'g'), `当前版本：**${next}**`)
if (readmeAfter !== readmeBefore) {
  fs.writeFileSync(readmePath, readmeAfter, 'utf8')
  console.log('updated README.md')
}

console.log(`version: ${current} -> ${next}`)
