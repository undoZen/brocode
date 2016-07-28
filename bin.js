#!/usr/bin/env node
'use strict';

var argv = require('yargs')
  .alias('p', 'port')
  .argv
var c1 = argv._[0]
var c2 = argv._[1]

if (c1 === 'build') {
  var gulp = require('./gulp-tasks')
  gulp.start('build')
} else if (c1 === 'server') {
  require('./server').start(argv.port)
}
