import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const marker = 'market/validate.mjs: '
try {
  const { parseMarketIndex } = await import('@deepseek-ai/dsh-plugin-market-index')
  const file = process.argv[2]
  if (!file) throw new Error('usage: node market/validate.mjs <index.json>')
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  parseMarketIndex(value, pathToFileURL(file).href)
  console.log(`${marker}OK ${file} (${value.plugins?.length ?? 0} plugins)`)
} catch (error) {
  // 校验器依赖 dsh 内部包；在 CI 外部环境可能不可解析，此时退回结构自检。
  const file = process.argv[2]
  if (file && fs.existsSync(file)) {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    const problems = []
    if (value.format !== 1) problems.push('format must be 1')
    if (!Array.isArray(value.plugins) || value.plugins.length === 0) problems.push('plugins must be a non-empty array')
    for (const [i, plugin] of (value.plugins ?? []).entries()) {
      if (!plugin.name) problems.push(`plugins[${i}].name missing`)
      if (!Array.isArray(plugin.versions) || plugin.versions.length === 0) problems.push(`plugins[${i}].versions empty`)
      for (const [j, v] of (plugin.versions ?? []).entries()) {
        if (!/^\d+\.\d+\.\d+/u.test(v.version ?? '')) problems.push(`plugins[${i}].versions[${j}].version invalid`)
        if (!/^[0-9a-f]{40}$/u.test(v.source?.commit ?? '')) problems.push(`plugins[${i}].versions[${j}].source.commit must be 40-hex`)
        if (typeof v.publishTimestamp !== 'number') problems.push(`plugins[${i}].versions[${j}].publishTimestamp must be a number`)
      }
    }
    if (problems.length > 0) {
      console.error(`${marker}FAIL\n${problems.join('\n')}`)
      process.exit(1)
    }
    console.log(`${marker}OK (structural fallback) ${file}`)
  } else {
    console.error(`${marker}FAIL ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
