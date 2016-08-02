#!/usr/bin/env node
'use strict'

var fs = require('fs')
var path = require('path')
var http = require('http')
var debounce = require('lodash.debounce')

var APP_ROOT = process.cwd()
var SRC_ROOT = path.join(APP_ROOT, 'src')
var express = require('express')
var st = require('st')
var xtend = require('xtend')
var Promise = require('bluebird')
var through = require('through2');

var _ = require('lodash');
var socketio = require('socket.io');
var has = require('./browserify-hmr/lib/has');

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
  update(onPath)
})
var reload = debounce(function () {
  if (browserSync && typeof browserSync.reload === 'function') {
    browserSync.reload()
  }
}, 300)
var globalRegExp = /[\\\/]node_modules[\\\/]|[\\\/]src[\\\/]global\.(?:js|libs\.json)$/
var cacheLibs
function update (onPath) {
  var p = path.resolve(SRC_ROOT, onPath)
  var hitCache = !!args.cache[p]
  delete args.cache[p]
  delete args.packageCache[p]
  delete args.packageCache[p + '/package.json']
  delete args.packageCache[p + '\\package.json']
  var matchGlobal = p.match(globalRegExp)
  if (matchGlobal) {
    cacheLibs = void 0
  }
  if (!matchGlobal && hitCache) {
    bundle([], [p], getOpts(false, true))
  }
  reload()
}

var app = express()
var log = function () {
  var args = Array.prototype.slice.call(arguments)
  args.unshift((new Date()).toLocaleString())
}

app.use(function (req, res, next) {
  req.serverPort = req.connection.server.address().port
  next()
})
var globalLibsPath = path.join(SRC_ROOT, 'global.libs.json')
function emitNewModules(socket, moduleData) {
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
        parents: pair[1].parents,
        deps: pair[1].deps
      }];
    })
    .fromPairs()
    .value();
  var removedModules = _.chain(currentModuleData)
    .keys()
    .filter(function(name) {
      return !has(moduleData, name);
    })
    .value();
  //console.log(Object.keys(newModuleData), removedModules)
  if (Object.keys(newModuleData).length || removedModules.length) {
    socket.emit('new modules', {newModuleData: newModuleData, removedModules: removedModules});
  }
}
function syncModules() {
  _.each(io.sockets.connected, function(socket) {
    emitNewModules(socket, cacheModuleData)
  })
}
function getOpts(isGlobal, isHmr) {
  var opts = { hmr: !!isHmr }
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
        syncModules()
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
  if (!(req.url === '/global.js' || req.url.indexOf('/js/main/') > -1)) {
    return next()
  }
  var filePath = path.join(SRC_ROOT, req.url)
  var isGlobal = false

  if (req.url === '/global.js') {
    isGlobal = true
  }
  var opts = getOpts(isGlobal, isHmr)

  var start = Date.now()
  var b = (exists) => (exists ? bundle([filePath], [], opts) : bundle([], [], opts)).then(b => {
    log('(bundle)', path.sep + path.relative(SRC_ROOT, filePath), `${Date.now() - start}ms`)
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
  var sod = req.serverPort > app.port + 2 ? '/.dist' : '/src'
  req.url = sod + req.url
  log('[static]', req.url)
  next()
})

app.use(st({
  cache: false,
  dot: true,
  path: APP_ROOT,
  index: 'index.html'
}))

var browserSync
var io
Object.defineProperty(exports, 'io', {
  get: function() {
    return io
  }
})

function setNewModuleData(newModuleData, removedModules) {
  _.assign(currentModuleData, newModuleData);
  removedModules.forEach(function(name) {
    delete currentModuleData[name];
  });
  if (Object.keys(newModuleData).length || removedModules.length) {
    log('Emitting updates');
    io.emit('new modules', {newModuleData: newModuleData, removedModules: removedModules});
  }
}

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
        return name.startsWith('js/main/')
      })
      log('debug mainScripts', mainScripts)
      ;(mainScripts.length
      ? Promise.all(mainScripts.map((name) => bundle([path.join(SRC_ROOT, name)], [], getOpts(false, true))))
      : Promise.resolve([])).then(function (results) {
        socket.moduleData = oldModuleData
        socket.emit('sync confirm', null);
        emitNewModules(socket, cacheModuleData)
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
