#!/usr/bin/env node
'use strict';

var argv = require('yargs')
  .alias('p', 'port')
  .alias('e', 'env')
  .argv
var c1 = argv._[0]
var c2 = argv._[1]

var broCliArgv = global.broCliArgv = {}
broCliArgv.dist = argv.dist || process.env.BUILD_DIST || '.dist'
process.env.NODE_ENV = broCliArgv.env = argv.env || (c1 === 'build' ? 'production' : 'development')

if (c1 === 'build') {
  var gulp = require('./gulp-tasks')
  gulp.start('build')
} else if (c1 === 'server') {
  require('./server').start(argv.port)
}
