'use strict'

var fs = require('fs')
var path = require('path')

var browserify = require('browserify')
var through = require('through2')
var Promise = require('bluebird')
var xtend = require('xtend')
var bpack = require('browser-pack')
var envify = require('envify/custom')
var rollupify = require('rollupify');
var uglifyify = require('uglifyify')

var qasSrc = fs.readFileSync(require.resolve('qas/qas.min.js'), 'utf-8').trim()
var qasWrapperHeader = fs.readFileSync(require.resolve('qas/loader-wrapper-header.js'), 'utf-8')
var qasWrapperFooter = fs.readFileSync(require.resolve('qas/loader-wrapper-footer.js'), 'utf-8')

var APP_ROOT = global.APP_ROOT || process.cwd()

var env = process.env.NODE_ENV || 'development'
var isProd = env === 'production'

var args = {
  debug: !isProd,
  basedir: APP_ROOT,
  paths: ['.'],
  cache: {},
  packageCache: {},
  extensions: ['.js', '.jsx', '.vue']
}
function getBabelRc () {
  var babelRcPath = path.resolve(process.cwd(), '.babelrc')
  if (!fs.existsSync(babelRcPath)) {
    return false
  }
  var rc
  try {
    rc = JSON.parse(fs.readFileSync(babelRcPath, 'utf-8'))
  } catch (e) {
      console.log(e);
    throw new Error('Your .babelrc seems to be incorrectly formatted.')
  }
  return rc
}
var babelrc = getBabelRc()

var bundle = function (entries, requires, opts) {
  opts = opts || {}
  var bopts = xtend(args, opts.args || {})
  var babelifyOpts
  if (opts.babelify || babelrc) {
    babelifyOpts = xtend({}, babelrc, opts.babelify)
  }
  var b = browserify(bopts)
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
  b.transform(rollupify, {
    config: {
      plugins: [
        require('rollup-plugin-json')(),
      ]
    }
  })
  if (opts.envify !== false) {
    b.transform(envify(opts.envify || {
      _: 'purge',
      NODE_ENV: env
    }))
  }
  if (opts.transforms) {
    b.transform(opts.transforms)
  }
  if (opts.uglifyify !== false && isProd) {
    b.transform(uglifyify, {exts: ['.js', '.jsx']})
  }
  if (opts.externals && !opts.global) {
    if (opts.externals) {
      b.external(opts.externals)
    }
  }
  return bundlePromise(b).then(src => {
    if (opts.global) {
      return new Buffer(src + '}); QAS.ready()', 'utf-8')
    } else {
      return new Buffer(src + '}); if (!document.querySelector("script[brocode-global]")) { QAS.ready() };', 'utf-8')
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
  console.log(opts);
  opts = opts || {}
  opts.args = opts.args || {}
  if (b.pipeline.get('dedupe') && b.pipeline.get('dedupe').length) {
    b.pipeline.get('dedupe').splice(0, 1) // arguments[4] bug
  }
  b.pipeline.get('pack')
    .splice(0, 1, bpack(xtend(args, {
      raw: true,
      hasExports: true,
      externalRequireName: 'if (!this.QAS) {' + qasSrc + '}QAS' +
        (opts.global ? '.sync' : '') + '(function () { var require = QAS.require; QAS.require'
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
  if (opts.args.packageCache) {
    b.on('package', function (pkg) {
      var file = path.join(pkg.__dirname, 'package.json')
      opts.args.packageCache[file] = pkg
    })
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
