'use strict'

var fs = require('fs')
var path = require('path')
var http = require('http')
var debounce = require('lodash.debounce')

var APP_ROOT = process.cwd()
var SRC_ROOT = path.join(APP_ROOT, 'src')
var express = require('express')
var ecstatic = require('ecstatic')
var xtend = require('xtend')
var Promise = require('bluebird')
var through = require('through2');

var _ = require('lodash');
var socketio = require('socket.io');
var has = require('./browserify-hmr/lib/has');
var pkginfo = require(path.join(APP_ROOT, 'package.json'))

var chokidar = require('chokidar')
var watcher = chokidar.watch(SRC_ROOT, {
  cwd: SRC_ROOT,
  ignored: [
    /[\/\\]\./
  ],
  ignoreInitial: true
})

var bundle = require('./bundle')
var args = {
  fullPaths: true,
  cache: {},
  packageCache: {}
}

var EventEmitter = require('events').EventEmitter
var _hmr = global._hmr = {
  transformCache: {},
}
var hmrPlugin = require('./browserify-hmr')({basedir: SRC_ROOT})
var cacheModuleData = {}

var globalCache = {}
watcher.on('all', (event, onPath) => {
  if (['change', 'unlink', 'unlinkDir'].indexOf(event) === -1) {
    return
  }
  if (onPath === 'global.js' || onPath === 'global.libs.json') {
    globalCache = {}
  } else {
    update(onPath)
  }
})
var reload = debounce(function () {
  if (browserSync && typeof browserSync.reload === 'function') {
    browserSync.reload()
  }
}, 300)
var globalRegExp = /[\\\/]node_modules[\\\/]|[\\\/]src[\\\/]global\.(?:js|libs\.json)$/i
var hmrModuleReg = /\.(jsx?|vue)$/i
var cacheLibs
function findAffectedModule(affectsMap, updatedFiles) {
  if (!Array.isArray(updatedFiles)) {
    updatedFiles = [updatedFiles]
  }
  if (_.every(updatedFiles, f => hmrModuleReg.test(f))) {
    return updatedFiles
  }
  return Array.prototype.concat.apply(
    updatedFiles.filter(f => hmrModuleReg.test(f)),
    updatedFiles.filter(f => !hmrModuleReg.test(f)).map(f => affectsMap[f])
  )
}
function getAffectsMap(modules) {
  var affects = {}
  var ignoreRegExp = /[\\\/]__hmr_manager.js$|\/brocode\/node_modules\//
  _.each(modules, function (row, id) {
    _.each(row.deps, function (dep) {
      var af = affects[dep] || (affects[dep] = [])
      if (!ignoreRegExp.test(dep) && !ignoreRegExp.test(id)) {
        af.push(id)
      }
    })
  })
  return affects
}
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
    toBeDeleted.forEach(p => {
      delete args.cache[p]
      delete args.packageCache[p]
      delete args.packageCache[p + '/package.json']
      delete args.packageCache[p + '\\package.json']
    })
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
    bundle([], af, getOpts(false, true, true)).then(passForGood(af), handleError(af)).then(function () {
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
var globalLibsPath = path.join(SRC_ROOT, 'global.libs.json')
function emitNewModules(socket, moduleData, chunkOnly) {
  if (!socket.moduleData) {
    return
  }
  var currentModuleData = socket.moduleData
  var newModuleData = _.chain(moduleData)
    .toPairs()
    .filter(function(pair) {
      return pair[1].isNew && (!currentModuleData[pair[0]] || currentModuleData[pair[0]].hash !== pair[1].hash)
    })
    .map(function(pair) {
      return [pair[0], {
        index: pair[1].index,
        hash: pair[1].hash,
        source: pair[1].source,
        parents: chunkOnly && currentModuleData[pair[0]]
          ? currentModuleData[pair[0]].parents // inherit previous parents
          : pair[1].parents,
        deps: pair[1].deps
      }];
    })
    .fromPairs()
    .value();
  _.assign(socket.moduleData, newModuleData)
  var removedModules = _.chain(currentModuleData)
    .keys()
    .filter(function(name) {
      return !has(moduleData, name);
    })
    .value();
  if (Object.keys(newModuleData).length || removedModules.length) {
    log('[HMR]', 'Emitting updates');
    socket.emit('new modules', {newModuleData: newModuleData, removedModules: removedModules});
  }
}
function syncModules(chunkOnly) {
  _.each(io.sockets.connected, function(socket) {
    emitNewModules(socket, cacheModuleData, chunkOnly)
  })
}
function getOpts(isGlobal, isHmr, chunkOnly) {
  var opts = xtend(pkginfo.brocode || {}, { hmr: !!isHmr })
  var globalLibs = cacheLibs
  if (!globalLibs) {
    globalLibs = []
    try {
      globalLibs = JSON.parse(fs.readFileSync(globalLibsPath, 'utf-8'))
    } catch (e) {}
    cacheLibs = globalLibs
  }
  if (isGlobal) {
    opts.global = true
    opts.alterb = function (b) {
      globalLibs.forEach(function (x) {
        b.require(x[0], {expose: x[1] || x[0]})
      })
    }
  } else {
    opts.alterb = function (b) {
      b.on('setNewModuleData', function(moduleData) {
        _.assign(cacheModuleData, moduleData)
        syncModules(chunkOnly)
      })
    }
    opts.externals = globalLibs.map(function (x) {
      return x[1] || x[0]
    }).filter(Boolean)
  }
  opts.args = xtend(args, {basedir: SRC_ROOT}, (!isGlobal && isHmr ? {plugin: [hmrPlugin]} : {}))
  return opts
}
app.get(/.*\.js$/i, function (req, res, next) {
  var isHmr = false
  if (req.serverPort > app.port + 2) {
    return next()
  } else if (req.serverPort === app.port + 2) {
    isHmr = true
  }
  if (!(req.url === '/js/main.js' || req.url === '/global.js' || req.url.indexOf('/js/main/') > -1)) {
    return next()
  }
  var filePath = path.join(SRC_ROOT, req.url)
  var isGlobal = false

  if (req.url === '/global.js') {
    isGlobal = true
    if (globalCache.b) {
      res.type('js')
      res.send(globalCache.b)
      log('(bundle)', path.sep + path.relative(SRC_ROOT, filePath), `from cache`)
      return
    }
  }
  var opts = getOpts(isGlobal, isHmr, false)

  log('(bundle)', path.sep + path.relative(SRC_ROOT, filePath), `starting...`)
  var start = Date.now()

  var b = (exists) => (exists
                       ? bundle([filePath], [], opts).then(passForGood(filePath), handleError(filePath))
                       : bundle([], [], opts)).then(passForGood(filePath), handleError(filePath)).then(b => {
    log('(bundle)', path.sep + path.relative(SRC_ROOT, filePath), `${Date.now() - start}ms`)
    if (isGlobal) {
      globalCache.b = b
    }
    res.type('js')
    res.send(b)
  })

  if (isGlobal) {
    fs.exists(filePath, b)
  } else fs.exists(filePath, function (exists) {
    if (!exists) {
      next()
      return
    }
    b(true)
  })
})

app.use(function (req, res, next) {
  var sod = req.pathSOD = req.serverPort > app.port + 2 ? '/.dist' : '/src'
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
var io
Object.defineProperty(exports, 'io', {
  get: function() {
    return io
  }
})

exports.app = app
exports.start = function (port) {
  port = port || 8000
  app.port = port
  var server = http.createServer(app)
  var distServer = http.createServer(app)
  var hmrServer = http.createServer(app)
  io = socketio(hmrServer)
  io.on('connection', function(socket) {
    function log() {
      console.log.apply(console, [new Date().toTimeString(), '[HMR]'].concat(_.toArray(arguments)));
    }
    socket.on('sync', function(syncMsg) {
      log('User connected, syncing');
      var oldModuleData = _.pick(cacheModuleData, _.keys(syncMsg))
      var mainScripts = _.keys(syncMsg).filter(function(name) {
        return name.startsWith('js/main/') || name === 'js/main.js'
      })
      log('(sync)', mainScripts, 'starting...')
      var start = Date.now()
      ;(mainScripts.length
      ? Promise.all(mainScripts.map((name) => path.join(SRC_ROOT, name)).map((p) => bundle([p], [], getOpts(false, true, false)).then(passForGood(p), handleError(p))))
      : Promise.resolve([])).then(function (results) {
        log('(sync)', mainScripts, `${Date.now() - start}ms`)
        socket.moduleData = oldModuleData
        socket.emit('sync confirm', null);
        emitNewModules(socket, cacheModuleData, false)
      });
    });
  });

  server.listen(port, '0.0.0.0', function () {
    console.log('development server listening at http://0.0.0.0:%d', this.address().port)
  })

  browserSync = require('browser-sync').create()
  // 使用 browser-sync
  browserSync.init({
    proxy: 'localhost:' + port,
    port: port + 1,
    ui: false,
    open: false
  }, function() {
    console.log('development server with browsersync listening at http://0.0.0.0:%d', port + 1)
  })

  hmrServer.listen(port + 2, '0.0.0.0', function () {
    console.log('hot module reload server listening at http://0.0.0.0:%d, run `brocode build` to update', this.address().port)
  })

  distServer.listen(port + 3, '0.0.0.0', function () {
    console.log('production preview server listening at http://0.0.0.0:%d, run `brocode build` to update', this.address().port)
  })
}
