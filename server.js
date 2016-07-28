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
  cache: {},
  packageCache: {}
}
var globalCache = {}
watcher.on('all', (event, onPath) => {
  if (['change', 'unlink', 'unlinkDir'].indexOf(event) === -1) {
    return
  }
  removeCache(onPath)
})
var reload = debounce(function () {
  if (browserSync && typeof browserSync.reload === 'function') {
    browserSync.reload()
  }
}, 300)
var globalRegExp = /[\\\/]node_modules[\\\/]|[\\\/]src[\\\/]global\.(?:js|libs\.json)$/
var cache = {}
function removeCache (onPath) {
  var p = path.resolve(SRC_ROOT, onPath)
  delete args.cache[p]
  delete args.packageCache[p]
  delete args.packageCache[p + '/package.json']
  delete args.packageCache[p + '\\package.json']
  var match = p.match(globalRegExp)
  if (match) {
    cache = {}
  }
  reload()
}

var app = express()
var log = function () {
  var args = Array.prototype.slice.call(arguments)
  args.unshift((new Date()).toLocaleString())
  console.log.apply(console, args)
}

app.use(function (req, res, next) {
  req.serverPort = req.connection.server.address().port
  next()
})
app.get(/.*\.js$/i, function (req, res, next) {
  if (req.serverPort > app.port + 2) {
    return next()
  }
  if (!(req.url === '/global.js' || req.url.indexOf('/js/main/') > -1)) {
    return next()
  }
  var filePath = path.join(SRC_ROOT, req.url)
  var opts = {}

  if (req.url === '/global.js') {
    opts.global = true
  }

  if (opts.global && cache.global) {
    log('(bundle)', path.sep + path.relative(SRC_ROOT, filePath), 'from cache')
    send(cache.global)
    return
  }

  var globalLibsPath = path.join(SRC_ROOT, 'global.libs.json')
  var globalLibs = cache.libs
  if (!globalLibs) {
    globalLibs = []
    try {
      globalLibs = JSON.parse(fs.readFileSync(globalLibsPath, 'utf-8'))
    } catch (e) {}
    cache.libs = globalLibs
  }
  if (opts.global) {
    opts.alterb = function (b) {
      globalLibs.forEach(function (x) {
        b.require(x[0], {expose: x[1] || x[0]})
      })
    }
  } else {
    opts.externals = globalLibs.map(function (x) {
      return x[1] || x[0]
    }).filter(Boolean)
  }
  function send (b) {
    res.type('js')
    res.send(b)
  }
  opts.args = xtend(args, {basedir: SRC_ROOT})
  var start = Date.now()
  var b = (exists) => (exists ? bundle(filePath, opts) : bundle(null, opts)).then(b => {
    log('(bundle)', path.sep + path.relative(SRC_ROOT, filePath), `${Date.now() - start}ms`)
    if (opts.global) {
      cache.global = b
    }
    send(b)
  })
  fs.exists(filePath, (exists) => {
    if (!exists) {
      if (opts.global) {
        b(false)
      } else {
        next()
      }
    } else {
      b(true)
    }
  })
})

app.use(function (req, res, next) {
  var sod = req.serverPort > app.port + 2 ? '/.dist' : '/src'
  req.url = sod + req.url
  log('[static]', req.url)
  next()
})

app.use(st({
  path: APP_ROOT,
  index: 'index.html'
}))

var browserSync
exports.app = app
exports.start = function (port) {
  port = port || 8000
  app.port = port
  var server = http.createServer(app)
  var distServer = http.createServer(app)

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

  distServer.listen(port + 3, '0.0.0.0', function () {
    console.log('production preview server listening at http://0.0.0.0:%d, run `brocode build` to update', this.address().port)
  })
}
