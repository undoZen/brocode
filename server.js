'use strict'

var fs = require('fs')
var path = require('path')
var http = require('http')
var debounce = require('lodash.debounce')
var globby = require('globby');

var APP_ROOT = process.cwd()
var SRC_ROOT = path.join(APP_ROOT, 'src')
var express = require('express')
var ecstatic = require('ecstatic')
var xtend = require('xtend')
var Promise = require('bluebird')
var co = Promise.coroutine
var through = require('through2');

var _ = require('lodash');
var pkginfo = require(path.join(APP_ROOT, 'package.json'))

var chokidar = require('chokidar')
var watcher = chokidar.watch(SRC_ROOT, {
  cwd: SRC_ROOT,
  ignored: [
    /[\/\\]\./
  ],
  ignoreInitial: true
})

var bundle = require('./browserify')
var rollup = require('./rollup')

var rollupCache = {}

var args = {
  fullPaths: true,
  cache: {},
  packageCache: {}
}

var EventEmitter = require('events').EventEmitter
var cacheModuleData = {}

var globalCache = {}
var globalCacheValid = Promise.resolve(true)
watcher.on('all', (event, onPath) => {
  if (['change', 'unlink', 'unlinkDir'].indexOf(event) === -1) {
    return
  }
  if (onPath === 'global.js' || onPath === 'global.libs.json') {
    globalCache = {}
    cacheLibs = void 0
    hitCache(path.resolve(SRC_ROOT, 'global.js')).forEach(removeCache)
  } else {
    if (globalCacheValid.isPending()) {
      globalCacheValid.resolve(true) //resolve previous lock
    }
    var r
    globalCacheValid = new Promise((resolve) => { //lock until main built
      r = resolve
    })
    globalCacheValid.resolve = r
    update(onPath)
  }
})
var reload = debounce(function () {
  if (browserSync && typeof browserSync.reload === 'function') {
    browserSync.reload()
  }
}, 300)
var globalRegExp = /[\\\/]node_modules[\\\/]|[\\\/]src[\\\/]global\.(?:js|libs\.json)$/i
var hmrModuleReg = /\.(jsx?|ls|coffee|vue)$/i
var cacheLibs
var fsCaseInsensitive = false
try {
  fsCaseInsensitive = require('./caseinsensitive')
} catch (e) {}
var hitCache = !fsCaseInsensitive
  ? p => !!args.cache[p] ? [p] : []
  : p => Object.keys(args.cache).filter(k => p.toUpperCase() === k.toUpperCase())
var errored = {}
function passForGood(p) {
  return function (v) {
    if (errored[p]) {
      delete errored[p]
    }
    return v
  }
}
function handleError(p) {
  return function recordError(err) {
    errored[p] = 1
    throw err
  }
}
function removeCache(p) {
  delete args.cache[p]
  delete args.packageCache[p]
  delete args.packageCache[p + '/package.json']
  delete args.packageCache[p + '\\package.json']
}
function update (onPath) {
  var p = path.resolve(SRC_ROOT, onPath)
  var toBeDeleted = hitCache(p)
  var matchGlobal = p.match(globalRegExp)
  var af = []
  if (matchGlobal) {
    cacheLibs = void 0
  } else if (toBeDeleted.length) {
    p = toBeDeleted[0]
    var affectedFiles = findAffectedModule(getAffectsMap(args.cache), p)
    toBeDeleted.forEach(removeCache)
    af = affectedFiles
      .filter(p => hmrModuleReg.test(p))
      .filter(p => !(/\/js\/main(\/|\.js$)/.test(p)))
      .filter(p => fs.existsSync(p))
    if (p.indexOf('/js/main/') > -1 || p.indexOf('/js/main.js') > -1) {
      af.push(p)
    }
  } else if (errored[p]) {
    af = [p]
  }
  if (af.length) {
    log('(update)', af, 'starting...')
    var start = Date.now()
    bundle([], af, getOpts(false, true)).then(passForGood(af), handleError(af)).then(function () {
      log('(update)', af, `${Date.now() - start}ms`)
    })
  }
    /*
    var ks = Object.keys(args.cache).filter(k => k.indexOf('/brocode/') === -1)
    ks.forEach(console.log.bind(console))
    var dd = ks.map(k => Object.keys(args.cache[k].deps))
    console.log(JSON.stringify(dd))
    var _ = require('lodash');
    var ibm = require('is-builtin-module');
    var df = _(d).flatten().unique()
    .filter(n => /^[a-z0-9][a-z0-9-_]*$/.test(n) && !ibm(n))
    .value()
    */
  reload()
}

var app = express()
function log () {
  var args = Array.prototype.slice.call(arguments)
  args.unshift((new Date()).toTimeString())
  console.log.apply(console, args)
}

app.use(function (req, res, next) {
  req.serverPort = req.connection.server.address().port
  next()
})
var browserify = require('browserify');
var globalLibsPath = path.join(SRC_ROOT, 'global.libs.json')
var usedExternals = {}
function getOpts(isGlobal, chunkOnly) {
  var opts = xtend(pkginfo.brocode || {})
  var globalLibs = cacheLibs
  if (!globalLibs) {
    globalLibs = []
    try {
      globalLibs = JSON.parse(fs.readFileSync(globalLibsPath, 'utf-8'))
    } catch (e) {}
    cacheLibs = globalLibs
  }
  opts.global = true
  opts.alterb = function (b) {
    Object.keys(usedExternals).forEach(function (x) {
      b.require(x, {expose: x})
    })
  }
  opts.args = xtend(args, {basedir: SRC_ROOT})
  if (!isGlobal) 
  return opts
}
function exists(filePath) {
  return new Promise((resolve) => fs.exists(filePath, (e) => resolve(e)))
}
var getGlobalBundle = (function () {
  var cache
  var lastExternals = []
  return co(function * () {
    if (!cache || !cache.isPending()) {
      var start = Date.now()
      var globalPath = path.join(SRC_ROOT, 'js', 'global.js')
      var externals = yield getExternals()
      if (cache && !_.xor(externals, lastExternals).length) {
        return cache
      }
      lastExternals = externals
      console.log('(re)generating global bundle at ' + start)
      var globalExists = yield exists(globalPath)
      const source = 'window.EXTERNALS = {}\n' + externals.map((external) =>
        `EXTERNALS['${external}'] = require('${external}')\n`)
      var b = browserify()
      b.add(path.join(SRC_ROOT, 'js', 'externals.js'), {
        source,
      })
      if (globalExists) {
        b.add(globalPath)
      }
      cache = Promise.fromCallback(b.bundle.bind(b)).then((bundled) => {
        console.log('global generated in ' + (Date.now() - start) + 'ms');
        return bundled
      })
    }
    return cache
  })
}())

app.get(/.*\.js$/i, function (req, res, next) {
  if (req.serverPort === app.port) {
    return next()
  }
  if (!(req.url === '/js/main.js' || req.url === '/js/global.js' || req.url.indexOf('/js/main/') > -1)) {
    return next()
  }
  var filePath = path.join(SRC_ROOT, req.url)
  var isGlobal = false

  if (req.url === '/js/global.js') {
    globalCacheValid
    .then(() => getGlobalBundle())
    .then((b) => {
      res.type('js')
      res.send(b.toString())
    })
    return
  }

  var start = Date.now()
  var cache = rollupCache[filePath]
  if (!cache || !cache.isPending()) {
    cache = rollupCache[filePath] = (cache || Promise.resolve({})).then((bundle) => rollup(filePath, bundle.imports, bundle))
  }
  cache.then(rollupResolved)
  function rollupResolved(bundle) {
    if (typeof globalCacheValid.resolve === 'function') {
      globalCacheValid.resolve(true)
    }
    log('(bundle)', path.sep + path.relative(SRC_ROOT, filePath), (Date.now() - start))
    res.type('js')
    res.send(bundle.code)
  }
})

app.use(function (req, res, next) {
  var sod = req.pathSOD = req.serverPort === app.port ? '/.dist' : '/src'
  req.url = sod + req.url
  log('[static]', req.url)
  next()
})

app.use(ecstatic({
  cache: 'no-cache',
  showDir: false,
  showDotfiles: true,
  root: APP_ROOT,
}))

app.use(function (req, res, next) {
  var url = req.url.replace(/^\/+\.*/, '')
  if (req.method === 'GET' && (!url.match(/\./) || url.match(/\.html?$/i))) {
    var t200path = path.join(APP_ROOT, req.pathSOD, '200.html')
    fs.exists(t200path, (exists) => {
      if (exists) {
        res.status = 200
        res.sendFile(t200path)
      } else next()
    })
  } else next()
})

var browserSync
function getExternals() {
  return Promise.all(_.values(rollupCache)).then((cached) =>
    _(cached).map('imports').flatten().uniq().filter(e => e[0] !== '.').value())
}

exports.app = app
exports.start = function (port) {
  var mainFiles = globby.sync(['js/main.js', 'js/**/*.main.js'], {cwd: SRC_ROOT})
  co(function * () {
    var opts
    for (var main, i = -1; main = mainFiles[++i];) {
      console.log('pre-compiling ' + main + ' ...');
      opts = getOpts(false, false)
      const filePath = path.join(SRC_ROOT, main)
      rollupCache[filePath] = rollup(filePath)
    }
    usedExternals = yield getExternals()
    const source = 'window.EXTERNALS = {}\n' + usedExternals.map((external) =>
      `EXTERNALS['${external}'] = require('${external}')\n`)

    console.log('bundling global with auto-detected externals:\n  ' + usedExternals.join('\n  '));
    var b = yield getGlobalBundle()

  })().then(function() {

  port = port || 8000
  app.port = port
  var server = http.createServer(app)
  var distServer = http.createServer(app)

  server.listen(port + 1, '0.0.0.0', function () {
    console.log('development server listening at http://0.0.0.0:%d', this.address().port)
  })

  browserSync = require('browser-sync').create()
  // 使用 browser-sync
  browserSync.init({
    proxy: 'localhost:' + (port + 1),
    port: port + 2,
    ui: false,
    open: false
  }, function() {
    console.log('development server with browsersync listening at http://0.0.0.0:%d', port + 2)
  })

  distServer.listen(port, '0.0.0.0', function () {
    console.log('production preview server listening at http://0.0.0.0:%d, run `brocode build` to update', this.address().port)
  })

  })
}
