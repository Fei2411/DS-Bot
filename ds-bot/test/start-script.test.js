import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const scriptPath = fileURLToPath(new URL('../../start.ps1', import.meta.url))
const script = readFileSync(scriptPath, 'utf8')

// The param block, with any parentheses inside the defaults ignored.
function parameterBlock(text) {
  const start = text.indexOf('param(')
  assert.notEqual(start, -1, 'start.ps1 has no param block')
  let depth = 0
  for (let i = start + 'param('.length; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      if (depth === 0) return text.slice(start + 'param('.length, i)
      depth -= 1
    }
  }
  throw new Error('start.ps1 has an unterminated param block')
}

const parameters = parameterBlock(script)

test('start.ps1 does not evaluate $PSScriptRoot while binding -DataRoot', () => {
  // An advanced script evaluates parameter defaults in the caller's scope, where
  // $PSScriptRoot is empty. The default must be assigned in the script body.
  assert.match(parameters, /\[string\]\$DataRoot\s*=\s*''/)
  assert.doesNotMatch(parameters, /\$PSScriptRoot/)
})

test('start.ps1 assigns and resolves the default data root in the body', () => {
  const body = script.slice(script.indexOf('$ErrorActionPreference'))
  assert.match(body, /if\s*\(\s*-not\s+\$DataRoot\s*\)\s*\{\s*\$DataRoot\s*=\s*'\.ds-bot-local'\s*\}/)
  assert.match(body, /\[IO\.Path\]::IsPathRooted\(\$DataRoot\)/)
  assert.match(body, /\$DataRoot\s*=\s*\[IO\.Path\]::GetFullPath\(\$DataRoot\)/)
})

const powershell = ['pwsh', 'powershell'].find(command => spawnSync(command, ['-NoProfile', '-Command', 'exit 0']).status === 0)
test('start.ps1 parses with PowerShell when available', { skip: powershell === undefined ? 'PowerShell is not installed' : false }, () => {
  const result = spawnSync(powershell, ['-NoProfile', '-Command', [
    '$tokens = $null',
    '$errors = $null',
    '[void][System.Management.Automation.Language.Parser]::ParseFile($env:START_PS1, [ref]$tokens, [ref]$errors)',
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
  ].join('; ')], { env: { ...process.env, START_PS1: scriptPath }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr || result.stdout)
})
