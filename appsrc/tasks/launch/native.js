
import path from 'path'
import invariant from 'invariant'

import {sortBy} from 'underline'
import Promise from 'bluebird'
import shellQuote from 'shell-quote'

import sandboxTemplate from '../../constants/sandbox-template'

import os from '../../util/os'
import sf from '../../util/sf'
import spawn from '../../util/spawn'
import pathmaker from '../../util/pathmaker'

import mklog from '../../util/log'
const log = mklog('tasks/launch')

import {Crash} from '../errors'

async function sh (exePath, fullCommand, opts) {
  log(opts, `sh ${fullCommand}`)

  const cwd = path.dirname(exePath)
  log(opts, `Working directory: ${cwd}`)

  const args = shellQuote.parse(fullCommand)
  const command = args.shift()

  const code = await spawn({
    command,
    args,
    onToken: (tok) => log(opts, `stdout: ${tok}`),
    onErrToken: (tok) => log(opts, `stderr: ${tok}`),
    opts: {cwd}
  })

  if (code !== 0) {
    const error = `process exited with code ${code}`
    throw new Crash({exePath, error})
  }
  return 'child completed successfully'
}

function escape (arg) {
  return `"${arg.replace(/"/g, '\\"')}"`
}

async function computeWeight (appPath, execs) {
  const output = []

  const f = async function (exe) {
    const exePath = path.join(appPath, exe.path)
    let stats
    try {
      stats = await sf.stat(exePath)
    } catch (err) {
      // entering the ultra hat dimension
    }

    if (stats) {
      exe.weight = stats.size
      output.push(exe)
    }
  }
  await Promise.resolve(execs).map(f, {concurrency: 4})

  return output
}

function computeDepth (execs) {
  for (const exe of execs) {
    exe.depth = path.normalize(exe.path).split(path.sep).length
  }

  return execs
}

function computeScore (execs) {
  const output = []

  for (const exe of execs) {
    let score = 100

    if (/unins.*\.exe$/i.test(exe.path)) {
      score -= 50
    }
    if (/^kick\.bin/i.test(exe.path)) {
      score -= 50
    }
    if (/nwjc\.exe$/i.test(exe.path)) {
      score -= 20
    }
    if (/dxwebsetup\.exe$/i.test(exe.path)) {
      score = 0
    }
    if (/vcredist.*\.exe$/i.test(exe.path)) {
      score = 0
    }
    if (/\.(so|dylib)/.test(exe.path)) {
      score = 0
    }
    if (/\.sh/.test(exe.path)) {
      score += 20
    }
    exe.score = score

    if (score > 0) {
      output.push(exe)
    }
  }

  return output
}

function isAppBundle (exePath) {
  return /\.app\/?$/.test(exePath.toLowerCase())
}

async function getFullExec (opts, exePath) {
  const plistPath = path.join(exePath, 'Contents', 'Info.pList')
  let out = ''
  let err = ''
  const plutilCode = await spawn({
    command: 'plutil',
    args: [ '-convert', 'json', '-o', '-', plistPath ],
    onToken: (tok) => { out += tok + '\n' },
    onErrToken: (tok) => { err += tok + '\n' }
  })
  if (plutilCode !== 0) {
    log(opts, `plutil failed:\n${err}`)
    throw new Error(`plutil failed with code ${plutilCode}`)
  }

  log(opts, `plutil in json: ${out}`)
  let exec = ''
  try {
    const plObj = JSON.parse(out)
    exec = plObj['CFBundleExecutable']
  } catch (err) {
    throw new Error(`invalid app bundle ${exePath}: couldn't parse metadata`)
  }
  return path.join(exePath, 'Contents', 'MacOS', exec)
}

async function launchExecutable (exePath, args, opts) {
  const platform = os.platform()
  log(opts, `launching '${exePath}' on '${platform}' with args '${args.join(' ')}'`)
  const argString = args.map((x) => escape(x)).join(' ')

  if (platform === 'darwin' && isAppBundle(exePath)) {
    const {isolateApps} = opts.preferences

    const fullExec = await getFullExec(opts, exePath)
    log(opts, `full exec path: ${fullExec}`)
    const cmd = `${escape(fullExec)} ${argString}`

    if (isolateApps) {
      log(opts, 'app isolation enabled')

      log(opts, 'writing sandbox file')
      const {cave} = opts
      const appPath = pathmaker.appPath(cave)
      const sandboxProfilePath = path.join(appPath, '.itch', 'isolate-app.sb')

      const sandboxSource = sandboxTemplate
        .replace(/{{INSTALL_LOCATION}}/, appPath)
      await sf.writeFile(sandboxProfilePath, sandboxSource)

      return sh(fullExec, `sandbox-exec -f ${escape(sandboxProfilePath)} ${cmd}}`, opts)
    } else {
      log(opts, 'no app isolation')
      return sh(exePath, cmd, opts)
    }
  } else {
    let cmd = `${escape(exePath)}`
    if (argString.length > 0) {
      cmd += ` ${argString}`
    }
    return sh(exePath, cmd, opts)
  }
}

export default async function launch (out, opts) {
  const {cave} = opts
  invariant(cave, 'launch-native has cave')

  const appPath = pathmaker.appPath(cave)

  let candidates = cave.executables.map((path) => ({path}))
  log(opts, `initial candidate set: ${JSON.stringify(candidates, null, 2)}`)

  candidates = await computeWeight(appPath, candidates)
  candidates = computeScore(candidates)
  candidates = computeDepth(candidates)

  candidates = candidates::sortBy((x) => -x.weight)
  log(opts, `candidates after weight sorting: ${JSON.stringify(candidates, null, 2)}`)

  candidates = candidates::sortBy((x) => -x.score)
  log(opts, `candidates after score sorting: ${JSON.stringify(candidates, null, 2)}`)

  candidates = candidates::sortBy((x) => x.depth)
  log(opts, `candidates after depth sorting: ${JSON.stringify(candidates, null, 2)}`)

  if (candidates.length === 0) {
    const err = new Error('After weighing/sorting, no executables left')
    err.reason = ['game.install.no_executables_found']
    throw err
  }

  if (candidates.length > 1) {
    // TODO: figure this out. We want to let people choose, but we also don't
    // want to confuse them — often there are 2 or 3 executables and the app already
    // picks the best way to start the game.
  }

  let exePath = path.join(appPath, candidates[0].path)
  const args = []

  if (/\.jar$/i.test(exePath)) {
    log(opts, 'Launching .jar')
    args.push('-jar')
    args.push(exePath)
    exePath = 'java'
  }

  return await launchExecutable(exePath, args, opts)
}
