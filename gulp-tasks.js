'use strict';

var path = require('path')
var fs = require('fs');

var gulp = require('gulp')
var xtend = require('xtend')
var through = require('through2')
var combineStream = require('stream-combiner')
var es = require('event-stream');
var VFile = require('vinyl')
var gutil = require('gulp-util')
var gulpif = require('gulp-if')
var uglify = require('gulp-uglify')
var insert = require('gulp-insert')
var RevAll = require('gulp-rev-all')
var nano = require('gulp-cssnano');

var bundle = require('./bundle')

var APP_ROOT = process.cwd()
var arparts = APP_ROOT.split(path.sep)
if (arparts[arparts.length-1] === 'framework') {
  arparts.pop()
  APP_ROOT = arparts.join(path.sep)
}
var mRoot = path.join(APP_ROOT, 'src')
var revAll = RevAll({
  debug: true,
  dontRenameFile: [/\.html$/],
  replacer: function(fragment, re, nr, file) {
    fragment.contents = fragment.contents.replace(re, function(a, p1, p2, p3, p4) {
      if (p3 !== ".html" && (p2[0] === '.' || p2[0] === '/' || (p2 === "global" && p3 === ".js"))) {
        return p1 + nr + p3 + p4
      } else {
        return a
      }
    })
  }
})

function src(glob, opts) {
  opts = opts || {}
  var xopts = {
    cwd: mRoot,
    base: mRoot,
  }
  opts = xtend(xopts, opts)
  return gulp.src.call(gulp, glob, opts)
}

function dest() {
  var destPath = path.join.apply(path, [mRoot.replace(/src$/, '.dist')].concat([].slice.call(arguments)))
  return gulp.dest(destPath)
}

function tFakeRoot(prefix) {
  var args = [].slice.call(arguments).filter(Boolean)
  return through.obj(function (file, enc, cb) {
    var relativePath = path.relative(file.base, file.path)
    file.base = path.sep + 'fakeSrcRoot'
    file.path = path.join(file.base, relativePath)
    this.push(file)
    cb()
  })
}

var qasWrapperHeader = fs.readFileSync(require.resolve('qas/loader-wrapper-header.js'), 'utf-8')
var qasWrapperFooter = fs.readFileSync(require.resolve('qas/loader-wrapper-footer.js'), 'utf-8')

var globalLibsPath = path.join(mRoot, 'global.libs.json')
var globalPreloadPath = path.join(mRoot, 'global.js')
var globalLibs = []

if (fs.existsSync(globalLibsPath)) {
  globalLibs = JSON.parse(fs.readFileSync(globalLibsPath, 'utf-8'))
}

gulp.task('build', function() {
  return es.merge(src(['**/*', '!js/**']),
                  src(['js/dist/**/*.js', 'js/raw/**/*.js', 'js/main/**/*.js']))
    .pipe(gulpif(function (file) {
      return path.relative(file.base, file.path) === 'global.js'
    }, through.obj(function(file, enc, done) {
      var opts = {}
      opts.global = true
      opts.alterb = function (b) {
        globalLibs.forEach(function (x) {
          b.require(x[0], {expose: x[1] || x[0]})
        })
      }
      opts.args = {basedir: mRoot.replace(/[\/]src$/, '')}
      bundle([file.path], [], opts).then(b => {
        file.contents = b
        this.push(file)
        done()
      })
    })))
    .pipe(gulpif(function (file) {
      return /\.js$/i.test(file.path) && file.path.indexOf('/js/raw/') > -1
    }, combineStream(
      insert.prepend(qasWrapperHeader),
      insert.append(qasWrapperFooter)
    )))
    .pipe(gulpif(function (file) {
      return /\.js$/i.test(file.path) && file.path.indexOf('/js/main/') > -1
    }, through.obj(function(file, enc, done) {
      var opts = {}
      opts.externals = globalLibs.map(function (x) {
        return x[1] || x[0]
      }).filter(Boolean)
      opts.args = {basedir: mRoot.replace(/[\/]src$/, '')}
      bundle([file.path], [], opts).then(b => {
        file.contents = b
        this.push(file)
        done()
      })
    })))
    .pipe(tFakeRoot())
    .pipe(revAll.revision())
    .pipe(gulpif(function (file) {
      return /\.js$/i.test(file.path) && !(/\.min\.[a-f0-9]{8}\.js$/i.test(file.path)) &&
        ((/^\/fakeSrcRoot\/global\.[a-f0-9]{8}\.js$/i.test(file.path)) || file.path.match(/\/js\/(main|raw|dist)\//))
    }, uglify({
      compress: {
        drop_console: true
      },
      output: {
        ascii_only: true,
        quote_keys: true
      }
    })))
    .pipe(gulpif(function (file) {
      return /\.css/i.test(file.path) && file.path.indexOf('/css/') > -1
    }, nano()))
    .pipe(dest())
})

module.exports = gulp
