'use strict'

var fs = require('fs')
var path = require('path')

var browserify = require('browserify')
var through = require('through2')
var Promise = require('bluebird')
var babelify = require('babelify')
var xtend = require('xtend')
var bpack = require('browser-pack')
var envify = require('envify/custom')
var uglifyify = require('uglifyify')

var qasSrc = fs.readFileSync(require.resolve('qas/qas.min.js'), 'utf-8')
var qasWrapperHeader = fs.readFileSync(require.resolve('qas/loader-wrapper-header.js'), 'utf-8')
var qasWrapperFooter = fs.readFileSync(require.resolve('qas/loader-wrapper-footer.js'), 'utf-8')

var APP_ROOT = global.APP_ROOT || process.cwd()
var pkginfo = require(path.join(APP_ROOT, 'package.json'))
var pkgBabelify
if (pkginfo.browserify && pkginfo.browserify.transform && pkginfo.browserify.transform.length) {
  if (pkginfo.browserify.transform.filter(t => t[0] === 'babelify').length) {
    pkgBabelify = true
  }
}

var env = process.env.NODE_ENV || 'development'
var isDev = env === 'development'

var args = {
  debug: isDev,
  basedir: APP_ROOT,
  paths: ['.'],
  cache: {},
  packageCache: {},
  extensions: ['jsx']
}

var bundle = function (entries, requires, opts) {
  opts = opts || {}
  var b = browserify(xtend(args, opts.args || {}))
  if (opts.args.packageCache) {
    b.on('package', function (pkg) {
      var file = path.join(pkg.__dirname, 'package.json')
      opts.args.packageCache[file] = pkg
    })
  }
  b = alterPipeline(b, opts)
  if (typeof opts.alterb === 'function') {
    opts.alterb(b)
  }
  if (entries && entries.length) {
    entries.forEach(fullPath => b.add(fullPath))
  }
  if (requires && requires.length) {
    requires.forEach(fullPath => b.require(fullPath))
  }
  if (opts.babelify !== false && !pkgBabelify) {
    var babelifyOpts = xtend({}, opts.babelify)
    if (!babelifyOpts.presets || (Array.isArray(babelifyOpts.presets) && !babelifyOpts.presets.length)) {
      babelifyOpts.presets = [require('babel-preset-dysonshell'), require('babel-preset-react')]
      if (opts.hmr) {
        babelifyOpts.presets.push(require('babel-preset-react-hmre'))
      }
    }
    if (!babelifyOpts.ignore || (Array.isArray(babelifyOpts.ignore) && !babelifyOpts.ignore.length)) {
      babelifyOpts.ignore = /[\\\/]node_modules[\\\/]/
    }
    b.transform(babelify, babelifyOpts)
  }
  if (opts.envify !== false) {
    b.transform(envify(opts.envify || {
      _: 'purge',
      NODE_ENV: env
    }))
  }
  if (opts.transforms) {
    b.transform(opts.transforms)
  }
  if (opts.uglifyify !== false && !isDev) {
    b.transform(uglifyify, {exts: ['.js', '.jsx']})
  }
  if (opts.externals && !opts.global) {
    if (opts.externals) {
      b.external(opts.externals)
    }
  }
  return bundlePromise(b).then(src => {
    if (opts.global) {
      return new Buffer(qasSrc + 'QAS.sync(function () { ' + src + '}); QAS.ready()', 'utf-8')
    } else {
      return new Buffer(qasWrapperHeader + src + qasWrapperFooter + 'if (!document.querySelector("script[brocode-global]")) { ' + qasSrc + 'QAS.ready() };', 'utf-8')
    }
  }).catch(err => {
    if (err._babel) {
      console.error(err.message);
      console.error(err.codeFrame);
    }
    throw err
  })
}

function alterPipeline (b, opts) {
  opts = opts || {}
  if (b.pipeline.get('dedupe') && b.pipeline.get('dedupe').length) {
    b.pipeline.get('dedupe').splice(0, 1) // arguments[4] bug
  }
  b.pipeline.get('pack')
    .splice(0, 1, bpack(xtend(args, {
      raw: true,
      hasExports: true,
      externalRequireName: 'var require = QAS.require; QAS.require'
    })))
  if (opts.args.cache) {
    var cache = opts.args.cache
    b.pipeline.get('deps').push(through.obj(function (row, enc, next) {
      var file = row.expose ? b._expose[row.id] : row.file
      cache[file] = {
        source: row.source,
        deps: xtend(row.deps)
      }
      this.push(row)
      next()
    }))
  }
  return b
}

function bundlePromise (b) { // because b.bundle checks arity :(
  return new Promise(function (resolve, reject) {
    return b.bundle(function (err, src) {
      if (err) {
        return reject(err)
      }
      resolve(src)
    })
  })
}

module.exports = bundle
