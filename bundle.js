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

var qasSrc = fs.readFileSync(require.resolve('qas/qas.min.js'), 'utf-8').trim()
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
var reactBeUsed
if ((pkginfo.dependencies || {})['react'] || (pkginfo.devDependencies || {})['react']) {
  reactBeUsed = true
}
var reactHotLoaderBeUsed = (function () {
  var m, version
  if ( (version = (pkginfo.dependencies || {})['react-hot-loader'] || (pkginfo.devDependencies || {})['react-hot-loader']) ) {
    if ( !(m = /(\d)\./.exec(version)) ) {
      return false
    }
    if (m[1] === '3') {
      return true
    } else {
      console.warn('[CAUTION!] you are using react-hot-loader but not version 3')
    }
  }
  return false
}())
var vueBeUsed = (function () {
  var m, version
  if ( (version = (pkginfo.dependencies || {})['vue'] || (pkginfo.devDependencies || {})['vue']) ) {
    if ( !(m = /(\d)(\.|$)/.exec(version)) ) {
      return false
    }
    if (m[1] === '1' || m[1] === '2') {
      return m[1]
    }
  }
  return false
}())

var env = process.env.NODE_ENV || 'development'
var isDev = env === 'development'

var args = {
  debug: isDev,
  basedir: APP_ROOT,
  paths: ['.'],
  cache: {},
  packageCache: {},
  extensions: ['.js', '.jsx', '.vue']
}
function getBabelRc () {
  var babelRcPath = path.resolve(process.cwd(), '.babelrc')
  var babelRcJsPath = path.resolve(process.cwd(), 'babelrc.js')
  var e1, e2
  if (!(e1 = fs.existsSync(babelRcPath)) && !(e2 = fs.existsSync(babelRcJsPath))) {
    return false
  }
  var rc
  try {
    if (e1) {
      rc = JSON.parse(fs.readFileSync(babelRcPath, 'utf-8'))
    } else {
      rc = {
        presets: (require(babelRcJsPath).presets || []).slice(),
        plugins: (require(babelRcJsPath).plugins || []).slice()
      }
    }
  } catch (e) {
    throw new Error('[vueify] Your .babelrc or babelrc.js seems to be incorrectly formatted.')
  }
  return rc
}

var bundle = function (entries, requires, opts) {
  opts = opts || {}
  var bopts = xtend(args, opts.args || {})
  var babelifyOpts
  if (opts.babelify !== false && !pkgBabelify) {
    babelifyOpts = xtend({}, opts.babelify, getBabelRc ())
    babelifyOpts.presets = babelifyOpts.presets || []
    babelifyOpts.plugins = babelifyOpts.plugins || []
    if (!babelifyOpts.presets || (Array.isArray(babelifyOpts.presets) && !babelifyOpts.presets.length)) {
      babelifyOpts.presets = [require('babel-preset-bro')]
      if (reactBeUsed) {
        babelifyOpts.presets.push(require('babel-preset-react'))
        if (opts.hmr && !opts.global) {
          if (reactHotLoaderBeUsed) {
            console.log('[HMR] using local react-hot-loader');
            var rhlb = require('module')._findPath('react-hot-loader/babel', [
              path.join(bopts.basedir, 'node_modules'),
              path.join(APP_ROOT, 'node_modules')
            ])
            babelifyOpts.plugins.push(require(rhlb))
          }
        }
        bopts.paths = [
          path.join(bopts.basedir, 'node_modules'),
          path.join(APP_ROOT, 'node_modules'),
          (bopts.paths || process.env.NODE_PATH || '')
        ].join((process.platform === 'win32' ? ';' : ':'))
      }
    }
    if (!babelifyOpts.ignore || (Array.isArray(babelifyOpts.ignore) && !babelifyOpts.ignore.length)) {
      babelifyOpts.ignore = /[\\\/]node_modules[\\\/]/
    }
  }
  bopts.paths = [
    path.join(bopts.basedir, 'node_modules'),
    path.join(APP_ROOT, 'node_modules'),
    path.join(__dirname, 'node_modules'),
    (bopts.paths || process.env.NODE_PATH || '')
  ].join((process.platform === 'win32' ? ';' : ':'))
  var vueify
  if (vueBeUsed) {
    babelifyOpts = babelifyOpts || {}
    babelifyOpts.presets = babelifyOpts.presets || []
    babelifyOpts.plugins = babelifyOpts.plugins || []
    //babelifyOpts.plugins.push(require('babel-plugin-transform-runtime'))
    if (vueBeUsed === '1') {
      throw new Error('vue 1 is not being supported by brocode@2')
      process.exit(1)
    } else {
      vueify = [require('vueify'), {
        // customCompilers: {
          babel: {
            presets: babelifyOpts.presets.slice(),
            plugins: babelifyOpts.plugins.slice()
          }
        // }
      }]
    }
  }
  var b = browserify(bopts)
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
  if (babelifyOpts) {
    b.transform(babelify, babelifyOpts)
  }
  if (vueify) {
    b.transform(vueify)
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
  opts = opts || {}
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
